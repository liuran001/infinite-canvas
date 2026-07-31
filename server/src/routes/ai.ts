import { Router } from "express";
import { Readable } from "node:stream";

import { fail } from "../lib/errors";
import { handle, ok } from "../lib/response";
import { statusMessage, upstreamMessage } from "../lib/upstream";
import { requireUser, userAuth } from "../middleware/auth";
import { consumeUserCredits, refundUserCredits } from "../services/auth";
import { buildChannelUrl, modelCost, selectModelChannel, type ModelChannel } from "../services/settings";

export const aiRouter = Router();
aiRouter.use(userAuth);

function geminiUrl(channel: ModelChannel, model: string, action: string) {
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const lower = baseUrl.toLowerCase();
    const versioned = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
    return `${versioned}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${action}`;
}

/**
 * 文本类调用保持同步转发（流式），不进任务队列：
 * 对话结果无需持久化，中断后重新提问即可，任务化反而增加延迟。
 */
async function proxy(req: Parameters<Parameters<typeof handle>[0]>[0], res: Parameters<Parameters<typeof handle>[0]>[1], resolveUrl: (channel: ModelChannel, model: string) => string, query?: string) {
    const user = requireUser(req);
    const model = String(req.body?.model || req.query.model || "").trim();
    if (!model) throw fail("缺少模型名称");
    const channel = await selectModelChannel(model);
    const credits = await modelCost(model);
    const url = resolveUrl(channel, model) + (query ? `?${query}` : "");
    const headers: Record<string, string> = channel.apiFormat === "gemini" ? { "x-goog-api-key": channel.apiKey } : { Authorization: `Bearer ${channel.apiKey}` };
    headers["Content-Type"] = "application/json";
    if (req.headers.accept) headers.Accept = String(req.headers.accept);

    await consumeUserCredits(user.id, model, credits, url);
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(req.body || {}), signal: controller.signal }).catch(async (error: Error) => {
        await refundUserCredits(user.id, model, credits, url).catch(() => undefined);
        throw fail(error.name === "AbortError" ? "请求已取消" : "AI 接口请求失败：上游无响应或网络不可达");
    });

    if (!response.ok) {
        await refundUserCredits(user.id, model, credits, url).catch(() => undefined);
        const body = await response.text().catch(() => "");
        throw fail(upstreamMessage(body) || statusMessage(response.status, "AI 接口请求失败"));
    }

    res.status(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentType?.includes("event-stream")) res.setHeader("Cache-Control", "no-cache");
    if (!response.body) return res.end();
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}

aiRouter.post("/v1/ai/responses", handle((req, res) => proxy(req, res, (channel) => buildChannelUrl(channel, "/responses"))));

aiRouter.post("/v1/ai/chat/completions", handle((req, res) => proxy(req, res, (channel) => buildChannelUrl(channel, "/chat/completions"))));

aiRouter.post(
    "/v1/ai/gemini/:action",
    handle((req, res) => {
        const action = req.params.action === "streamGenerateContent" ? "streamGenerateContent" : "generateContent";
        return proxy(req, res, (channel, model) => geminiUrl(channel, model, action), action === "streamGenerateContent" ? "alt=sse" : undefined);
    }),
);

/** 服务器模式下渠道密钥不下发给前端，模型列表由服务端代查。 */
aiRouter.get(
    "/v1/ai/models",
    handle(async (req, res) => {
        const model = String(req.query.model || "").trim();
        if (!model) throw fail("缺少模型名称");
        const channel = await selectModelChannel(model);
        const response = await fetch(buildChannelUrl(channel, "/models"), { headers: { Authorization: `Bearer ${channel.apiKey}` }, signal: AbortSignal.timeout(30000) }).catch(() => {
            throw fail("读取模型失败：上游接口无响应或网络不可达");
        });
        if (!response.ok) throw fail(statusMessage(response.status, "读取模型失败"));
        const payload = (await response.json()) as { data?: Array<{ id?: string }> };
        ok(
            res,
            (payload.data || [])
                .map((item) => (item.id || "").trim())
                .filter(Boolean)
                .sort(),
        );
    }),
);
