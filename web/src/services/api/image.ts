import { notifyTeamCreditsExhausted, notifyTeamQuotaExceeded } from "@/services/team-realtime";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { serverModelFormat, useServerStore } from "@/stores/use-server-store";
import { serverAiStream } from "./server";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type MessageContent = AiTextMessage["content"];
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem = { role: AiTextMessage["role"]; content: string | ResponseInputContent[] };
type ResponseApiPayload = {
    output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type GeminiPart = { text?: string; inlineData?: { mimeType?: string; data?: string }; fileData?: { mimeType?: string; fileUri?: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }>; error?: { message?: string }; promptFeedback?: { blockReason?: string } };
type GeminiStreamState = { buffer: string; text: string; error?: string };

type TextRequest = { model: string; systemPrompt: string; format: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

export function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
export function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

export function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

/** 文本模型、调用格式与全局系统提示词都由服务端下发，这里只挑出本次请求要用的部分。 */
function resolveTextRequest(config: AiConfig): TextRequest {
    const channel = useServerStore.getState().settings?.modelChannel;
    if (!channel) throw new Error("服务端配置尚未就绪，请稍后重试");
    const name = modelOptionName(config.model || config.textModel);
    const model = channel.models.some((item) => item.name === name && item.capability === "text") ? name : channel.defaultTextModel;
    if (!model) throw new Error("服务端没有配置可用的文本模型");
    // 服务端的系统提示词是管理员设的全局约束，用户在偏好设置里填的是个人偏好，两者都保留。
    const systemPrompt = [channel.systemPrompt.trim(), config.systemPrompt.trim()].filter(Boolean).join("\n\n");
    return { model, systemPrompt, format: serverModelFormat(model) };
}

/** 文本问答走服务端流式代理，请求体与上游协议保持一致，只换地址与鉴权。 */
export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const request = resolveTextRequest(config);
    try {
        const answer = (request.format === "gemini" ? await requestGeminiText(request, messages, onDelta, options) : await requestResponsesText(config, request, messages, onDelta, options)) || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return answer;
    } catch (error) {
        // 同步的文本调用在服务端就地扣费，团队池不足会当场 403 回来；这条路径不经任务流，得自己弹一次。
        notifyTeamCreditsExhausted(error);
        notifyTeamQuotaExceeded(error);
        throw new Error(readError(error, "请求失败"));
    }
}

async function requestResponsesText(config: AiConfig, request: TextRequest, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const body = {
        model: request.model,
        input: toResponseInput(withSystemMessage(request.systemPrompt, messages)),
        ...(config.reasoningEffort === "auto" ? {} : { reasoning: { effort: config.reasoningEffort } }),
        stream: true,
    };
    const state: ResponseStreamState = { buffer: "", text: "" };
    await readStream(await serverAiStream("/v1/ai/responses", body, options?.signal), (chunk, flush) => {
        consumeResponseStreamText(state, chunk, onDelta, flush);
        if (state.error) throw new Error(state.error);
    });
    if (!state.payload) return state.text;
    validateResponsePayload(state.payload);
    return state.text || responseText(state.payload);
}

async function requestGeminiText(request: TextRequest, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    // Gemini 的模型名在直连时写在 URL 上，转发时用查询参数带给服务端，请求体保持不变。
    const path = `/v1/ai/gemini/streamGenerateContent?model=${encodeURIComponent(request.model.replace(/^models\//, ""))}`;
    const state: GeminiStreamState = { buffer: "", text: "" };
    await readStream(await serverAiStream(path, toGeminiBody(request.systemPrompt, messages), options?.signal), (chunk, flush) => {
        consumeGeminiStreamText(state, chunk, onDelta, flush);
        if (state.error) throw new Error(state.error);
    });
    return state.text;
}

async function readStream(response: Response, consume: (chunk: string, flush?: boolean) => void) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("服务端没有返回内容");
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode(), true);
}

/** SSE 按空行切块，把完整的块交给对应协议的解析函数。 */
function consumeSseText(buffer: string, text: string, flush: boolean, consumeBlock: (block: string) => void) {
    let rest = buffer + text;
    for (;;) {
        const match = rest.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeBlock(rest.slice(0, index));
        rest = rest.slice(index + match[0].length);
    }
    if (flush && rest.trim()) {
        consumeBlock(rest);
        return "";
    }
    return rest;
}

function sseData(block: string) {
    return block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta: (text: string) => void, flush = false) {
    state.buffer = consumeSseText(state.buffer, text, flush, (block) => consumeResponseStreamBlock(block, state, onDelta));
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta: (text: string) => void) {
    const data = sseData(block);
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta: (text: string) => void, flush = false) {
    state.buffer = consumeSseText(state.buffer, text, flush, (block) => {
        const data = sseData(block);
        if (!data || data === "[DONE]") return;
        const content = geminiText(JSON.parse(data) as GeminiPayload);
        if (!content) return;
        state.text += content;
        onDelta(state.text);
    });
}

function withSystemMessage(systemPrompt: string, messages: AiTextMessage[]): AiTextMessage[] {
    return systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: AiTextMessage[]): ResponseInputItem[] {
    return messages.map((message) => ({ role: message.role, content: toResponseContent(message.content) }));
}

function toResponseContent(content: MessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function responseText(payload: ResponseApiPayload) {
    return (
        payload.output_text ||
        (payload.output || [])
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("")
    );
}

function toGeminiBody(systemPrompt: string, messages: AiTextMessage[]) {
    const systemText = [systemPrompt, ...messages.filter((message) => message.role === "system").map((message) => geminiTextContent(message.content))].filter(Boolean).join("\n\n");
    const contents = messages.filter((message) => message.role !== "system").map((message): GeminiContent => ({ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }));
    return { contents, ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}) };
}

function toGeminiParts(content: MessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: MessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function geminiText(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
    return (payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || []).map((part) => part.text || "").join("");
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function readError(error: unknown, fallback: string) {
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return (error instanceof Error && error.message) || fallback;
}
