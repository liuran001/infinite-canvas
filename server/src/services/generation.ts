import type { StoredFile } from "../db/entities";
import { fail } from "../lib/errors";
import { upstreamBinary, upstreamJson, upstreamMessage, upstreamStream } from "../lib/upstream";
import { storedObjectOf } from "./files";
import { getObject } from "./storage";
import { buildChannelUrl, isArkPlanChannel, isSeedanceModel, type ModelChannel } from "./settings";

/**
 * 前端已经把尺寸、时长等参数归一化好再提交，服务端直接透传，
 * 避免在两侧重复实现同一套归一化规则。
 */
export type GenerationParams = {
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    ratio?: string;
    resolution?: string;
    generateAudio?: boolean;
    watermark?: boolean;
    voice?: string;
    format?: string;
    speed?: number;
    instructions?: string;
    reasoningEffort?: string;
};

export type VideoProvider = "openai" | "seedance";
export type VideoTaskState = { status: "pending" } | { status: "completed"; url?: string; body?: Buffer; mimeType?: string } | { status: "failed"; error: string };

type ImagePayload = { data?: Array<Record<string, unknown>>; images?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>> };
type GeminiPart = { text?: string; inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; mimeType?: string; data?: string }; fileData?: { fileUri?: string } };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>; promptFeedback?: { blockReason?: string } };
type VideoPayload = { id?: string; status?: string; error?: { message?: string } | null; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type TextStreamEvent = { type?: string; delta?: string; text?: string; error?: { message?: string }; response?: { error?: { message?: string } } };

const GEMINI_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

function authHeaders(channel: ModelChannel, contentType?: string) {
    return { Authorization: `Bearer ${channel.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) };
}

async function readFileBuffer(file: StoredFile) {
    const stored = await storedObjectOf(file);
    const object = await getObject(stored.path, undefined, stored.storage);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

export async function fileToDataUrl(file: StoredFile) {
    return `data:${file.mimeType};base64,${(await readFileBuffer(file)).toString("base64")}`;
}

/** Gemini 的 inlineData 要的是裸 base64 而不是 data url，单独给一个出口，免得调用方再去拆 data url 前缀。 */
export async function fileToBase64(file: StoredFile) {
    return (await readFileBuffer(file)).toString("base64");
}

function withSystemPrompt(systemPrompt: string, prompt: string) {
    return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
}

/** 把上游返回的图片统一解析成 data url 或直链，交由调用方落盘。 */
function parseImagePayload(payload: ImagePayload): string[] {
    const list = payload.data || payload.images || payload.results || [];
    const images = list
        .map((item) => {
            if (typeof item.b64_json === "string" && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
            if (typeof item.url === "string" && item.url) return item.url;
            return null;
        })
        .filter((value): value is string => Boolean(value));
    if (!images.length) throw fail("接口没有返回图片，请检查提示词是否触发安全审核或模型是否支持该操作");
    return images;
}

function parseGeminiImages(payload: GeminiPayload): string[] {
    if (payload.promptFeedback?.blockReason) throw fail(`Gemini 拒绝了该请求：${payload.promptFeedback.blockReason}`);
    const images = (payload.candidates || [])
        .flatMap((candidate) => candidate.content?.parts || [])
        .map((part) => {
            const inline = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
            if (inline?.data) return `data:${inline.mimeType || "image/png"};base64,${inline.data}`;
            return part.fileData?.fileUri || null;
        })
        .filter((value): value is string => Boolean(value));
    if (!images.length) throw fail("Gemini 接口没有返回图片");
    return images;
}

function geminiUrl(channel: ModelChannel, model: string, action: "generateContent" | "streamGenerateContent") {
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const lower = baseUrl.toLowerCase();
    const versioned = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
    return `${versioned}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${action}`;
}

function geminiImageConfig(params: GenerationParams) {
    const size = (params.size || "").trim();
    if (!size || size.toLowerCase() === "auto") return {};
    const dimensions = /^(\d+)x(\d+)$/i.exec(size);
    const ratio = dimensions ? `${dimensions[1]}:${dimensions[2]}` : size;
    const [width, height] = ratio.split(":").map(Number);
    if (!width || !height) return {};
    const target = width / height;
    const aspectRatio = GEMINI_RATIOS.reduce((best, item) => {
        const [bw, bh] = best.split(":").map(Number);
        const [cw, ch] = item.split(":").map(Number);
        return Math.abs(cw / ch - target) < Math.abs(bw / bh - target) ? item : best;
    });
    return { responseFormat: { image: { aspectRatio } } };
}

async function generateGeminiImages(channel: ModelChannel, model: string, prompt: string, params: GenerationParams, references: StoredFile[], signal: AbortSignal) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const file of references) {
        parts.push({ inlineData: { mimeType: file.mimeType, data: (await readFileBuffer(file)).toString("base64") } });
    }
    const body = JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...geminiImageConfig(params) },
    });
    const count = Math.max(1, Math.min(15, params.count || 1));
    const requests = Array.from({ length: count }, () =>
        upstreamJson<GeminiPayload>(geminiUrl(channel, model, "generateContent"), { method: "POST", headers: { "x-goog-api-key": channel.apiKey, "Content-Type": "application/json" }, body, signal }, "图片生成失败"),
    );
    return (await Promise.all(requests)).flatMap(parseGeminiImages);
}

/** 返回图片的 data url 或直链列表。 */
export async function generateImages(channel: ModelChannel, model: string, systemPrompt: string, prompt: string, params: GenerationParams, references: StoredFile[], signal: AbortSignal): Promise<string[]> {
    const fullPrompt = withSystemPrompt(systemPrompt, prompt);
    if (channel.apiFormat === "gemini") return generateGeminiImages(channel, model, fullPrompt, params, references, signal);

    const count = Math.max(1, Math.min(15, params.count || 1));
    const shared = {
        model,
        prompt: fullPrompt,
        n: count,
        response_format: "b64_json",
        output_format: "png",
        ...(params.quality ? { quality: params.quality } : {}),
        ...(params.size ? { size: params.size } : {}),
        ...(params.background ? { background: params.background } : {}),
    };

    if (!references.length) {
        const payload = await upstreamJson<ImagePayload>(
            buildChannelUrl(channel, "/images/generations"),
            { method: "POST", headers: authHeaders(channel, "application/json"), body: JSON.stringify(shared), signal },
            "图片生成失败",
        );
        return parseImagePayload(payload);
    }

    if (channel.apiFormat === "ark") {
        const image = await Promise.all(references.map(fileToDataUrl));
        const payload = await upstreamJson<ImagePayload>(
            buildChannelUrl(channel, "/images/generations"),
            { method: "POST", headers: authHeaders(channel, "application/json"), body: JSON.stringify({ ...shared, image }), signal },
            "图片生成失败",
        );
        return parseImagePayload(payload);
    }

    const form = new FormData();
    Object.entries(shared).forEach(([key, value]) => form.set(key, String(value)));
    for (const file of references) {
        form.append("image", new Blob([await readFileBuffer(file)], { type: file.mimeType }), `reference.${file.mimeType.split("/")[1] || "png"}`);
    }
    const payload = await upstreamJson<ImagePayload>(buildChannelUrl(channel, "/images/edits"), { method: "POST", headers: authHeaders(channel), body: form, signal }, "图片生成失败");
    return parseImagePayload(payload);
}

/** 逐块读上游 SSE：按空行切块，把 data 行拼起来交给解析函数。上游一有内容就回调，不等整段读完。 */
async function readUpstreamSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("");
            if (data && data !== "[DONE]") onData(data);
        }
        if (done) return;
    }
}

async function generateGeminiText(channel: ModelChannel, model: string, systemPrompt: string, prompt: string, references: StoredFile[], onDelta: (delta: string) => void, signal: AbortSignal) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const file of references) parts.push({ inlineData: { mimeType: file.mimeType, data: (await readFileBuffer(file)).toString("base64") } });
    const body = await upstreamStream(
        `${geminiUrl(channel, model, "streamGenerateContent")}?alt=sse`,
        {
            method: "POST",
            headers: { "x-goog-api-key": channel.apiKey, "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({ contents: [{ role: "user", parts }], ...(systemPrompt.trim() ? { systemInstruction: { parts: [{ text: systemPrompt.trim() }] } } : {}) }),
            signal,
        },
        "文本生成失败",
    );
    let text = "";
    await readUpstreamSse(body, (data) => {
        const payload = JSON.parse(data) as GeminiPayload;
        if (payload.promptFeedback?.blockReason) throw fail(`Gemini 拒绝了该请求：${payload.promptFeedback.blockReason}`);
        const delta = (payload.candidates || [])
            .flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => part.text || "")
            .join("");
        if (!delta) return;
        text += delta;
        onDelta(delta);
    });
    return text;
}

/**
 * 文本生成：流式读上游，每收到一段就回调一次，调用方据此边收边落库。
 * 请求体与前端原来直连流式代理时保持一致，只是发起方从浏览器换成了服务端。
 */
export async function generateText(
    channel: ModelChannel,
    model: string,
    systemPrompt: string,
    prompt: string,
    params: GenerationParams,
    references: StoredFile[],
    onDelta: (delta: string) => void,
    signal: AbortSignal,
): Promise<string> {
    if (channel.apiFormat === "gemini") return generateGeminiText(channel, model, systemPrompt, prompt, references, onDelta, signal);

    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
    for (const file of references) content.push({ type: "input_image", image_url: await fileToDataUrl(file) });
    const body = await upstreamStream(
        buildChannelUrl(channel, "/responses"),
        {
            method: "POST",
            headers: { ...authHeaders(channel, "application/json"), Accept: "text/event-stream" },
            body: JSON.stringify({
                model,
                input: [...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []), { role: "user", content }],
                ...(params.reasoningEffort && params.reasoningEffort !== "auto" ? { reasoning: { effort: params.reasoningEffort } } : {}),
                stream: true,
            }),
            signal,
        },
        "文本生成失败",
    );

    let text = "";
    await readUpstreamSse(body, (data) => {
        const event = JSON.parse(data) as TextStreamEvent;
        const error = event.error?.message || event.response?.error?.message;
        if (error) throw fail(error);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            text += event.delta;
            onDelta(event.delta);
        }
        // 有的网关只在结尾给一次完整文本，没有逐字增量，这时补一次整段。
        if (event.type === "response.output_text.done" && !text && typeof event.text === "string") {
            text = event.text;
            onDelta(event.text);
        }
    });
    return text;
}

export function videoProvider(channel: ModelChannel, model: string): VideoProvider {
    return isArkPlanChannel(channel) || isSeedanceModel(model) ? "seedance" : "openai";
}

function seedanceUrl(channel: ModelChannel, taskId?: string) {
    return buildChannelUrl(channel, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

/**
 * 创建上游视频任务并返回任务 ID。任务 ID 会落库，
 * 服务重启或客户端离线后仍能继续轮询同一个上游任务。
 */
export async function createVideoTask(
    channel: ModelChannel,
    model: string,
    prompt: string,
    params: GenerationParams,
    references: { images: StoredFile[]; videos: StoredFile[]; audios: StoredFile[] },
    referenceUrl: (file: StoredFile) => Promise<string>,
    signal: AbortSignal,
): Promise<string> {
    if (channel.apiFormat === "gemini") throw fail("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");

    if (videoProvider(channel, model) === "seedance") {
        const content: Array<Record<string, unknown>> = [];
        if (prompt.trim()) content.push({ type: "text", text: prompt });
        for (const file of references.images) content.push({ type: "image_url", image_url: { url: await referenceUrl(file) }, role: "reference_image" });
        for (const file of references.videos) content.push({ type: "video_url", video_url: { url: await referenceUrl(file) }, role: "reference_video" });
        for (const file of references.audios) content.push({ type: "audio_url", audio_url: { url: await referenceUrl(file) }, role: "reference_audio" });
        if (!content.length) throw fail("请输入视频提示词，或连接参考图片/视频/音频");
        const payload = await upstreamJson<{ id?: string; data?: { id?: string } }>(
            seedanceUrl(channel),
            {
                method: "POST",
                headers: authHeaders(channel, "application/json"),
                body: JSON.stringify({
                    model,
                    content,
                    ...(params.ratio ? { ratio: params.ratio } : {}),
                    ...(params.resolution ? { resolution: params.resolution } : {}),
                    ...(params.seconds ? { duration: Number(params.seconds) } : {}),
                    generate_audio: params.generateAudio !== false,
                    watermark: params.watermark === true,
                }),
                signal,
            },
            "视频任务创建失败",
        );
        const id = payload.id || payload.data?.id;
        if (!id) throw fail("视频接口没有返回任务 ID");
        return id;
    }

    if (references.videos.length || references.audios.length) throw fail("当前视频接口不支持参考视频或参考音频，请切换到 Seedance / 火山 Agent Plan 模型");
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", prompt);
    if (params.seconds) form.set("seconds", params.seconds);
    if (params.size) form.set("size", params.size);
    if (params.resolution) form.set("resolution_name", params.resolution);
    form.set("preset", "normal");
    for (const file of references.images.slice(0, 7)) {
        form.append("input_reference[]", new Blob([await readFileBuffer(file)], { type: file.mimeType }), `reference.${file.mimeType.split("/")[1] || "png"}`);
    }
    const payload = await upstreamJson<{ id?: string; data?: { id?: string } }>(buildChannelUrl(channel, "/videos"), { method: "POST", headers: authHeaders(channel), body: form, signal }, "视频任务创建失败");
    const id = payload.id || payload.data?.id;
    if (!id) throw fail("视频接口没有返回任务 ID");
    return id;
}

function videoResultUrl(payload: VideoPayload) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (/^https?:\/\//i.test(url) || /\.mp4(\?|#|$)/i.test(url)));
}

export async function pollVideoTask(channel: ModelChannel, model: string, taskId: string, signal: AbortSignal): Promise<VideoTaskState> {
    const provider = videoProvider(channel, model);
    const url = provider === "seedance" ? seedanceUrl(channel, taskId) : buildChannelUrl(channel, `/videos/${encodeURIComponent(taskId)}`);
    const envelope = await upstreamJson<VideoPayload | { data?: VideoPayload }>(url, { headers: authHeaders(channel), signal }, "视频任务查询失败");
    const payload = ("data" in envelope && envelope.data ? envelope.data : envelope) as VideoPayload;
    const resultUrl = videoResultUrl(payload);
    if (resultUrl) return { status: "completed", url: resultUrl };
    const status = (payload.status || "").toLowerCase();
    if (status === "succeeded" || status === "completed") {
        if (provider === "seedance") return { status: "failed", error: "视频任务成功但没有返回视频地址" };
        const content = await upstreamBinary(buildChannelUrl(channel, `/videos/${encodeURIComponent(taskId)}/content`), { headers: authHeaders(channel), signal }, "视频下载失败");
        return { status: "completed", body: content.body, mimeType: content.mimeType || "video/mp4" };
    }
    if (status === "failed" || status === "cancelled" || status === "expired") {
        return { status: "failed", error: upstreamMessage(payload.error) || `视频生成${status === "expired" ? "超时" : "失败"}` };
    }
    return { status: "pending" };
}

export async function generateAudio(channel: ModelChannel, model: string, prompt: string, params: GenerationParams, signal: AbortSignal) {
    if (channel.apiFormat === "gemini") throw fail("Gemini 调用格式暂不支持音频生成，请使用 OpenAI 格式渠道");
    const format = params.format || "mp3";
    const result = await upstreamBinary(
        buildChannelUrl(channel, "/audio/speech"),
        {
            method: "POST",
            headers: authHeaders(channel, "application/json"),
            body: JSON.stringify({
                model,
                input: prompt,
                voice: params.voice || "alloy",
                response_format: format,
                speed: params.speed || 1,
                ...(params.instructions?.trim() ? { instructions: params.instructions.trim() } : {}),
            }),
            signal,
        },
        "音频生成失败",
    );
    return { body: result.body, mimeType: result.mimeType?.startsWith("audio/") ? result.mimeType : `audio/${format === "mp3" ? "mpeg" : format}` };
}
