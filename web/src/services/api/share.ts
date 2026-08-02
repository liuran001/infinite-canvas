import { serverApiUrl } from "@/services/api/server";
import type { ServerFile, ServerProject, ServerProjectEvent, ServerProjectPresence } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

/**
 * 分享通道：与普通接口共用地址，但走独立的鉴权与错误处理。
 *
 * 两条硬性约束（与设计文档一致）：
 * 1. 分享请求带的是服务端签发的 guest 令牌，绝不复用账号令牌的注入逻辑；
 * 2. 分享请求返回 401/403 只代表这条链接失效，**不能**清掉已登录用户的会话，也不能弹登录框
 *    ——否则一个失效的分享链接就能把用户从自己的账号里踢出去。
 */

export type ShareRole = "viewer" | "editor";

/** 服务端只在创建那一次返回明文 token 与完整链接，之后列表里只有 tokenPrefix。 */
export type ShareRecord = {
    id: string;
    projectId: string;
    role: ShareRole;
    allowAnonymous: boolean;
    allowClone: boolean;
    enabled: boolean;
    tokenPrefix: string;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type ShareCreated = ShareRecord & { token: string; url?: string };

export type ShareAccessLog = {
    id: string;
    shareId: string;
    actorId: string;
    isAnonymous: boolean;
    event: "open" | "edit" | "clone";
    userAgent: string;
    createdAt: string;
};

export type ShareCreateInput = {
    role: ShareRole;
    allowAnonymous: boolean;
    allowClone: boolean;
    /** ISO 时间串，留空表示永不过期。 */
    expiresAt?: string | null;
};

export type ShareUpdateInput = Partial<ShareCreateInput> & { enabled?: boolean };

/**
 * 换取访客会话的返回。actorId 与 displayName 一律由服务端给出：
 * 前端不自报身份，只把上一次拿到的 guest 令牌回传，让服务端决定要不要沿用同一个访客 id。
 */
export type ShareSession = {
    token: string;
    role: ShareRole;
    allowClone: boolean;
    /** 服务端分配的访客标识，匿名时形如 guest:<shareId>:<随机>。 */
    actorId: string;
    /** 服务端给的展示名，匿名访客通常是「访客-XXXX」。 */
    displayName: string;
    expiresAt: string;
    project: { id: string; title: string; revision: number };
};

type ApiEnvelope<T> = { code: string | number; data: T; msg: string };

export class ShareApiError<T = unknown> extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code: string | number,
        readonly data: T | null,
    ) {
        super(message);
    }
}

/** 分享链接失效：token 不存在、已撤销、已过期、匿名未被允许，服务端统一回 404。 */
export function isShareGone(error: unknown) {
    return error instanceof ShareApiError && error.status === 404;
}

/** 只读分享尝试写入。 */
export function isShareReadOnly(error: unknown) {
    return error instanceof ShareApiError && (error.code === "SHARE_READ_ONLY" || error.status === 403);
}

export function isShareConflict(error: unknown) {
    return error instanceof ShareApiError && error.code === "REVISION_CONFLICT";
}

/**
 * 分享请求头。除了 guest 令牌本身，再带一个标记头，方便网关和反向代理按它把分享流量与账号流量分开。
 * 服务端的鉴权、限流与日志都只认 guest 令牌本身，不依赖这个头——它可以被伪造，不能当判据。
 */
export function shareAuthHeaders(guestToken: string, extra?: HeadersInit): HeadersInit {
    return { ...(guestToken ? { Authorization: `Bearer ${guestToken}` } : {}), "X-Share-Guest": "1", ...extra };
}

async function readShareEnvelope<T>(response: Response, fallback: string): Promise<T> {
    const text = await response.text();
    let payload: ApiEnvelope<T> | null = null;
    try {
        payload = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
        throw new ShareApiError(response.ok ? `${fallback}：服务端返回了无法解析的内容` : `${fallback}（HTTP ${response.status}）`, response.status, "PARSE_ERROR", null);
    }
    if (!response.ok || payload.code !== 0) throw new ShareApiError(payload.msg || `${fallback}（HTTP ${response.status}）`, response.status, payload.code, payload.data ?? null);
    return payload.data;
}

/** 分享通道的裸请求：只认传进来的 guest 令牌，永远不碰 useServerStore 的登录态。 */
export async function shareRequest<T>(path: string, init: RequestInit = {}, fallback = "请求失败", guestToken = ""): Promise<T> {
    const isForm = init.body instanceof FormData;
    const response = await fetch(serverApiUrl(path), {
        ...init,
        headers: shareAuthHeaders(guestToken, { ...(isForm || !init.body ? {} : { "Content-Type": "application/json" }), ...init.headers }),
    }).catch(() => {
        throw new ShareApiError(`${fallback}：无法连接服务端，请检查网络`, 0, "NETWORK", null);
    });
    return readShareEnvelope<T>(response, fallback);
}

const jsonBody = (body: unknown) => ({ body: JSON.stringify(body) });

/** 账号令牌。克隆等接口要求真实账号身份，这里读的是登录态，与 guest 令牌互不干扰。 */
function userToken() {
    return useServerStore.getState().token;
}

export const shareApi = {
    /**
     * 用明文 token 换 guest 会话。明文只在这一次请求里出现，之后所有调用都用 guest 令牌。
     * previousToken 是刷新页面后沿用同一访客身份的唯一依据，身份仍由服务端判定。
     */
    createSession: (token: string, previousToken = "") =>
        shareRequest<ShareSession>(`/v1/shares/${encodeURIComponent(token)}/session`, { method: "POST", ...jsonBody({ previousToken }), headers: userToken() ? { "X-User-Authorization": `Bearer ${userToken()}` } : {} }, "打开分享画布失败"),

    /** 克隆到自己的账号，必须带真实账号身份（匿名要先登录）。 */
    clone: (token: string, guestToken: string) =>
        shareRequest<ServerProject>(`/v1/shares/${encodeURIComponent(token)}/clone`, { method: "POST", headers: userToken() ? { "X-User-Authorization": `Bearer ${userToken()}` } : {} }, "保存到我的账号失败", guestToken),

    /**
     * 访客上传素材。projectId 是必须的：服务端靠它走 resolveProjectAccess(ctx, projectId, "write")
     * 判权并把文件记在**所有者**名下（只读分享 403，超频 429），漏传就会退回按账号身份上传。
     */
    uploadFile: (projectId: string, guestToken: string, file: Blob, meta?: { width?: number; height?: number; durationMs?: number; filename?: string }) => {
        const form = new FormData();
        form.append("file", file, meta?.filename || "upload");
        form.append("projectId", projectId);
        if (meta?.width) form.append("width", String(meta.width));
        if (meta?.height) form.append("height", String(meta.height));
        if (meta?.durationMs) form.append("durationMs", String(meta.durationMs));
        return shareRequest<ServerFile>("/v1/files", { method: "POST", body: form }, "上传文件失败", guestToken);
    },

    /** 以下是分享态下的画布读写，走的仍是现有项目接口，只是换成 guest 令牌。 */
    project: (projectId: string, guestToken: string) => shareRequest<ServerProject>(`/v1/projects/${encodeURIComponent(projectId)}`, {}, "读取分享画布失败", guestToken),
    saveProject: (projectId: string, guestToken: string, body: { title: string; data: unknown; revision: number; clientId: string }) =>
        shareRequest<ServerProject>(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "PUT", ...jsonBody(body) }, "保存分享画布失败", guestToken),
    updatePresence: (projectId: string, guestToken: string, body: { clientId: string; nodeIds: string[]; activity: ServerProjectPresence["activity"] }) =>
        shareRequest<{ members: ServerProjectPresence[] }>(`/v1/projects/${encodeURIComponent(projectId)}/presence`, { method: "POST", ...jsonBody(body) }, "更新协作状态失败", guestToken),
    removePresence: (projectId: string, guestToken: string, clientId: string) =>
        shareRequest<{ members: ServerProjectPresence[] }>(`/v1/projects/${encodeURIComponent(projectId)}/presence/${encodeURIComponent(clientId)}`, { method: "DELETE" }, "清理协作状态失败", guestToken),
};

/** 所有者侧的分享管理接口。这些要求真实账号身份，走的是账号令牌，不属于分享通道。 */
export const shareAdminApi = {
    list: (projectId: string) => ownerRequest<ShareRecord[]>(`/v1/projects/${encodeURIComponent(projectId)}/shares`, {}, "读取分享链接失败"),
    create: (projectId: string, input: ShareCreateInput) => ownerRequest<ShareCreated>(`/v1/projects/${encodeURIComponent(projectId)}/shares`, { method: "POST", ...jsonBody(input) }, "创建分享链接失败"),
    update: (projectId: string, shareId: string, input: ShareUpdateInput) => ownerRequest<ShareRecord>(`/v1/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(shareId)}`, { method: "PATCH", ...jsonBody(input) }, "更新分享链接失败"),
    revoke: (projectId: string, shareId: string) => ownerRequest<boolean>(`/v1/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" }, "停用分享链接失败"),
    logs: (projectId: string, shareId: string, limit = 50) => ownerRequest<{ items: ShareAccessLog[] }>(`/v1/projects/${encodeURIComponent(projectId)}/shares/${encodeURIComponent(shareId)}/logs?limit=${limit}`, {}, "读取访问日志失败"),
};

/** 管理接口用账号令牌，但仍复用分享通道的错误处理：分享面板报错不该把用户踢下线。 */
function ownerRequest<T>(path: string, init: RequestInit = {}, fallback = "请求失败") {
    const token = userToken();
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers };
    return fetch(serverApiUrl(path), { ...init, headers })
        .catch(() => {
            throw new ShareApiError(`${fallback}：无法连接服务端，请检查网络`, 0, "NETWORK", null);
        })
        .then((response) => readShareEnvelope<T>(response, fallback));
}

/**
 * 分享态的画布事件流。与账号版的区别只有两处：带 guest 令牌、失败不动登录态。
 * EventSource 不支持自定义头，只能自己 fetch 读流。
 */
export async function shareProjectStream(projectId: string, guestToken: string, clientId: string, sinceRevision: number, onEvent: (event: ServerProjectEvent) => void, signal: AbortSignal) {
    const params = new URLSearchParams({ clientId, sinceRevision: String(sinceRevision) });
    const response = await fetch(serverApiUrl(`/v1/projects/${encodeURIComponent(projectId)}/realtime?${params}`), {
        headers: shareAuthHeaders(guestToken, { Accept: "text/event-stream" }),
        signal,
    }).catch(() => {
        throw new ShareApiError("画布实时连接失败：无法连接服务端，请检查网络", 0, "NETWORK", null);
    });
    if (!response.ok) throw new ShareApiError(`画布实时连接失败（HTTP ${response.status}）`, response.status, "STREAM", null);
    const reader = response.body?.getReader();
    if (!reader) throw new ShareApiError("画布实时连接没有返回内容", response.status, "STREAM", null);
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
            const data = buffer
                .slice(0, index)
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("");
            buffer = buffer.slice(index + 2);
            if (data) onEvent(JSON.parse(data) as ServerProjectEvent);
        }
    }
}
