import { fail } from "./errors";

/** 从上游各式各样的错误体里挖出可读文案，挖不到就返回空串。 */
export function upstreamMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value) as unknown;
            const inner = upstreamMessage(parsed);
            if (inner) return inner;
            return typeof parsed === "object" && parsed && !Object.keys(parsed).length ? "" : value;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return `上游返回了 HTML 错误页面（${value.slice(0, 80)}...）`;
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    const errorMessage = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown } | undefined)?.message;
    return upstreamMessage(payload.msg) || upstreamMessage(payload.message) || upstreamMessage(errorMessage) || upstreamMessage(payload.detail) || "";
}

export function statusMessage(status: number, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 404) return "接口地址不存在（404），请检查 Base URL 和模型选择";
    if (status === 502) return "网关错误（502），接口服务暂时不可用，请稍后重试";
    if (status === 503) return "服务繁忙（503），请稍后重试";
    return `${fallback}（HTTP ${status}）`;
}

/** 统一的上游请求：非 2xx 或 code!=0 都转成带上游文案的 SafeError。 */
export async function upstreamJson<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
    const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(600000) }).catch((error: Error) => {
        throw fail(error.name === "TimeoutError" ? `${fallback}：上游接口超时` : `${fallback}：上游接口无响应或网络不可达`);
    });
    const text = await response.text();
    if (!response.ok) throw fail(upstreamMessage(text) || statusMessage(response.status, fallback));
    let payload: unknown;
    try {
        payload = JSON.parse(text);
    } catch {
        throw fail(upstreamMessage(text) || `${fallback}：上游返回了无法解析的内容`);
    }
    const envelope = payload as { code?: number | string; data?: unknown };
    if (envelope && typeof envelope === "object" && envelope.code !== undefined && envelope.code !== 0 && envelope.code !== "0") {
        throw fail(upstreamMessage(payload) || fallback);
    }
    return payload as T;
}

/** 流式请求：只校验响应头，body 交给调用方边收边处理，不能先 text() 整段读完，否则就不是流了。 */
export async function upstreamStream(url: string, init: RequestInit, fallback: string) {
    const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(600000) }).catch((error: Error) => {
        throw fail(error.name === "TimeoutError" ? `${fallback}：上游接口超时` : `${fallback}：上游接口无响应或网络不可达`);
    });
    if (!response.ok) throw fail(upstreamMessage(await response.text().catch(() => "")) || statusMessage(response.status, fallback));
    if (!response.body) throw fail(`${fallback}：上游没有返回内容`);
    return response.body;
}

/**
 * 逐块读 SSE，把每个事件的 data 交给回调。生成任务与 Agent 共用一份：
 * 两边都要按 \n\n 切事件、拼多行 data、并跳过 [DONE]，各写一份迟早有一边漏掉某个细节。
 */
export async function readUpstreamSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
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

export async function upstreamBinary(url: string, init: RequestInit, fallback: string) {
    const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(600000) }).catch((error: Error) => {
        throw fail(error.name === "TimeoutError" ? `${fallback}：上游接口超时` : `${fallback}：上游接口无响应或网络不可达`);
    });
    const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim();
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw fail(upstreamMessage(body.toString("utf8")) || statusMessage(response.status, fallback));
    // 部分网关即使出错也返回 200，靠 JSON body 区分。
    if (mimeType.includes("json")) throw fail(upstreamMessage(body.toString("utf8")) || fallback);
    return { body, mimeType };
}
