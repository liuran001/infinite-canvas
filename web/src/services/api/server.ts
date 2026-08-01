import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

import { useServerStore, type ServerSettings, type ServerUser } from "@/stores/use-server-store";

export type ServerJobKind = "image" | "video" | "audio" | "text";
export type ServerJobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";

export type ServerFile = { id: string; kind: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number };

/** 云空间用量：used 由服务端按文件对象实时聚合，quota 是该账号的上限。 */
export type ServerStorage = { used: number; quota: number };

export type ServerJob = {
    id: string;
    clientJobId: string;
    kind: ServerJobKind;
    status: ServerJobStatus;
    model: string;
    progress: number;
    error: string;
    outputs: ServerFile[];
    /** 文本任务已经生成出来的内容，中途断开也能凭它拿回已生成的那一半。 */
    text: string;
    /** 客户端下发的任务归属信息，换设备后靠它把任务定位回界面。 */
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    finishedAt: string;
};

export type ServerJobInput = {
    clientJobId: string;
    kind: ServerJobKind;
    model: string;
    prompt: string;
    params: Record<string, unknown>;
    inputFileIds: string[];
    context?: Record<string, unknown>;
};

/** awaiting 表示服务端跑到一半停下来等用户点头，此时循环没结束，也不能再发新消息。 */
export type ServerAgentSessionStatus = "idle" | "running" | "awaiting" | "failed";
export type ServerAgentMessageRole = "user" | "assistant" | "tool";
/**
 * 待用户确认的请求。做成一个带 type 的联合而不是给每种情况各加字段：
 * 两种请求的交互完全一样（暂停 → 确认卡片 → 批准或拒绝走同一个接口），前端只按 type 换文案。
 */
export type ServerAgentPendingAction = { type: "continue"; roundsUsed: number; credits: number } | { type: "rename_canvas"; title: string; reason: string };
/** pendingAction 跟着会话行走，刷新页面或换设备重新拉一次会话仍然看得到那条待确认请求。 */
export type ServerAgentSession = { id: string; projectId: string; title: string; status: ServerAgentSessionStatus; model: string; error: string; lastSeq: number; pendingAction?: ServerAgentPendingAction | null; createdAt: string; updatedAt: string };
/** 用户从画布拖进面板的节点引用。只有 ID、类型、标题；storageKey 仅供前端画缩略图，不会进模型上下文。 */
export type ServerAgentReference = { nodeId: string; type: string; title: string; storageKey?: string };
/** seq 是会话内自增游标，断线重连按它拉增量；工具消息会先后推「已调用」和「有结果」两次，seq 相同。 */
export type ServerAgentMessage = { seq: number; role: ServerAgentMessageRole; content: string; toolName: string; toolArgs: string; toolResult: string; attachments: string[]; references: ServerAgentReference[]; createdAt: string };
/** status 事件顺带把标题与待确认请求一起推出来：这两样执行过程中都会变，前端不必为它们再拉一次会话。 */
export type ServerAgentEvent = { type: "message"; message: ServerAgentMessage } | { type: "status"; status: ServerAgentSessionStatus; error: string; title?: string; pendingAction?: ServerAgentPendingAction | null };
/**
 * 生成任务事件流的事件形状。
 * `job` 是任务快照，seq 是该用户内单调递增的变更序号，断线重连带上最后收到的 seq 就能补齐；
 * `text` 是文本增量，offset 是这段内容在完整文本里的起点，按它覆盖写入，重连或重跑都不会错位；
 * `ready` 表示补齐结束，后面都是实时事件。
 */
export type ServerJobEvent = { type: "job"; seq: number; job: ServerJob } | { type: "text"; id: string; offset: number; text: string } | { type: "ready"; seq: number };

export type ServerProject = { id: string; title: string; data: unknown; revision: number; deleted: boolean; createdAt: string; updatedAt: string };
export type ServerUserAsset = { id: string; kind: string; title: string; data: unknown; revision: number; deleted: boolean; createdAt: string; updatedAt: string };
export type ServerUserPlugin = { id: string; data: unknown; revision: number; deleted: boolean; createdAt: string; updatedAt: string };
export type ServerPasskey = { id: string; name: string; createdAt: string };

type ApiEnvelope<T> = { code: number; data: T; msg: string };

export function serverBaseUrl() {
    return useServerStore.getState().baseUrl;
}

export function serverApiUrl(path: string) {
    const base = serverBaseUrl();
    return `${base}/api${path.startsWith("/") ? path : `/${path}`}`;
}

/** 文件直链，可直接放进 img/video 的 src。 */
export function serverFileUrl(fileId: string) {
    return serverApiUrl(`/files/${fileId}/content`);
}

function authHeaders(extra?: HeadersInit): HeadersInit {
    const token = useServerStore.getState().token;
    return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

async function readEnvelope<T>(response: Response, fallback: string): Promise<T> {
    // 401 只可能是登录态失效，直接清理本地会话让界面回到登录入口。
    if (response.status === 401) {
        useServerStore.getState().clearSession();
        useServerStore.getState().setLoginOpen(true);
        throw new Error("登录状态已失效，请重新登录");
    }
    const text = await response.text();
    let payload: ApiEnvelope<T> | null = null;
    try {
        payload = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
        throw new Error(response.ok ? `${fallback}：服务端返回了无法解析的内容` : `${fallback}（HTTP ${response.status}）`);
    }
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || `${fallback}（HTTP ${response.status}）`);
    return payload.data;
}

export async function serverRequest<T>(path: string, init: RequestInit = {}, fallback = "请求失败"): Promise<T> {
    const isForm = init.body instanceof FormData;
    const response = await fetch(serverApiUrl(path), {
        ...init,
        headers: authHeaders({ ...(isForm || !init.body ? {} : { "Content-Type": "application/json" }), ...init.headers }),
    }).catch(() => {
        throw new Error(`${fallback}：无法连接服务端，请检查服务器地址与网络`);
    });
    return readEnvelope<T>(response, fallback);
}

function jsonBody(body: unknown) {
    return { body: JSON.stringify(body) };
}

export const serverApi = {
    health: () => serverRequest<string>("/health", {}, "连接服务端失败"),
    settings: () => serverRequest<ServerSettings>("/settings", {}, "读取服务端配置失败"),
    me: () => serverRequest<ServerUser>("/auth/me", {}, "读取用户信息失败"),
    login: (username: string, password: string) => serverRequest<{ token: string; user: ServerUser }>("/auth/login", { method: "POST", ...jsonBody({ username, password }) }, "登录失败"),
    register: (username: string, password: string) => serverRequest<{ token: string; user: ServerUser }>("/auth/register", { method: "POST", ...jsonBody({ username, password }) }, "注册失败"),
    linuxDoAuthorizeUrl: (redirect: string) => `${serverApiUrl("/auth/linux-do/authorize")}?redirect=${encodeURIComponent(redirect)}`,
    changePassword: (oldPassword: string, newPassword: string) => serverRequest<boolean>("/auth/password", { method: "POST", ...jsonBody({ oldPassword, newPassword }) }, "修改密码失败"),
    linuxDoBindUrl: (redirect: string) => serverRequest<{ url: string }>(`/auth/linux-do/bind?redirect=${encodeURIComponent(redirect)}`, {}, "获取授权地址失败"),
    unbindLinuxDo: () => serverRequest<ServerUser>("/auth/linux-do/unbind", { method: "POST" }, "解绑 Linux.do 失败"),

    preferences: () => serverRequest<Record<string, unknown>>("/v1/preferences", {}, "读取云端偏好失败"),
    savePreferences: (preferences: Record<string, unknown>) => serverRequest<Record<string, unknown>>("/v1/preferences", { method: "PUT", ...jsonBody(preferences) }, "保存云端偏好失败"),

    passkeys: () => serverRequest<ServerPasskey[]>("/auth/passkeys", {}, "读取 Passkey 失败"),
    passkeyRegisterOptions: () => serverRequest<PublicKeyCredentialCreationOptionsJSON>("/auth/passkey/register/options", { method: "POST" }, "添加 Passkey 失败"),
    passkeyRegisterVerify: (response: RegistrationResponseJSON, name: string) =>
        serverRequest<ServerPasskey>("/auth/passkey/register/verify", { method: "POST", ...jsonBody({ response, name }) }, "添加 Passkey 失败"),
    passkeyLoginOptions: (username = "") =>
        serverRequest<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>("/auth/passkey/login/options", { method: "POST", ...jsonBody({ username }) }, "Passkey 登录失败"),
    passkeyLoginVerify: (flowId: string, response: AuthenticationResponseJSON) =>
        serverRequest<{ token: string; user: ServerUser }>("/auth/passkey/login/verify", { method: "POST", ...jsonBody({ flowId, response }) }, "Passkey 登录失败"),
    renamePasskey: (id: string, name: string) => serverRequest<ServerPasskey>(`/auth/passkeys/${id}`, { method: "PUT", ...jsonBody({ name }) }, "重命名 Passkey 失败"),
    deletePasskey: (id: string) => serverRequest<boolean>(`/auth/passkeys/${id}`, { method: "DELETE" }, "删除 Passkey 失败"),

    uploadFile: async (file: Blob, meta?: { width?: number; height?: number; durationMs?: number; filename?: string }) => {
        const form = new FormData();
        form.append("file", file, meta?.filename || "upload");
        if (meta?.width) form.append("width", String(meta.width));
        if (meta?.height) form.append("height", String(meta.height));
        if (meta?.durationMs) form.append("durationMs", String(meta.durationMs));
        return serverRequest<ServerFile>("/v1/files", { method: "POST", body: form }, "上传文件失败");
    },
    file: (id: string) => serverRequest<ServerFile>(`/v1/files/${id}`, {}, "读取文件失败"),
    deleteFile: (id: string) => serverRequest<boolean>(`/v1/files/${id}`, { method: "DELETE" }, "删除文件失败"),
    storage: () => serverRequest<ServerStorage>("/v1/storage", {}, "读取云空间用量失败"),

    createJob: (input: ServerJobInput) => serverRequest<ServerJob>("/v1/jobs", { method: "POST", ...jsonBody(input) }, "提交生成任务失败"),
    job: (id: string) => serverRequest<ServerJob>(`/v1/jobs/${id}`, {}, "查询生成任务失败"),
    jobs: (statuses: ServerJobStatus[] = [], since = "") => {
        const params = new URLSearchParams();
        if (statuses.length) params.set("status", statuses.join(","));
        if (since) params.set("since", since);
        return serverRequest<{ items: ServerJob[] }>(`/v1/jobs${params.toString() ? `?${params}` : ""}`, {}, "查询生成任务失败");
    },
    cancelJob: (id: string) => serverRequest<ServerJob>(`/v1/jobs/${id}/cancel`, { method: "POST" }, "取消生成任务失败"),

    projects: (since = "") => serverRequest<{ items: ServerProject[] }>(`/v1/projects${since ? `?since=${encodeURIComponent(since)}` : ""}`, {}, "读取云端画布失败"),
    project: (id: string) => serverRequest<ServerProject>(`/v1/projects/${id}`, {}, "读取云端画布失败"),
    saveProject: (id: string, body: { title: string; data: unknown; revision?: number }) => serverRequest<ServerProject>(`/v1/projects/${id}`, { method: "PUT", ...jsonBody(body) }, "保存云端画布失败"),
    deleteProject: (id: string) => serverRequest<boolean>(`/v1/projects/${id}`, { method: "DELETE" }, "删除云端画布失败"),

    userAssets: (since = "") => serverRequest<{ items: ServerUserAsset[] }>(`/v1/user-assets${since ? `?since=${encodeURIComponent(since)}` : ""}`, {}, "读取云端素材失败"),
    saveUserAsset: (id: string, body: { kind: string; title: string; data: unknown; revision?: number }) => serverRequest<ServerUserAsset>(`/v1/user-assets/${id}`, { method: "PUT", ...jsonBody(body) }, "保存云端素材失败"),
    deleteUserAsset: (id: string) => serverRequest<boolean>(`/v1/user-assets/${id}`, { method: "DELETE" }, "删除云端素材失败"),

    userPlugins: (since = "") => serverRequest<{ items: ServerUserPlugin[] }>(`/v1/user-plugins${since ? `?since=${encodeURIComponent(since)}` : ""}`, {}, "读取云端插件失败"),
    saveUserPlugin: (id: string, body: { data: unknown; revision?: number }) => serverRequest<ServerUserPlugin>(`/v1/user-plugins/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody(body) }, "保存云端插件失败"),
    deleteUserPlugin: (id: string) => serverRequest<boolean>(`/v1/user-plugins/${encodeURIComponent(id)}`, { method: "DELETE" }, "删除云端插件失败"),

    aiModels: (model: string) => serverRequest<string[]>(`/v1/ai/models?model=${encodeURIComponent(model)}`, {}, "读取模型失败"),

    agentSessions: (projectId: string) => serverRequest<{ items: ServerAgentSession[] }>(`/v1/agent/sessions?projectId=${encodeURIComponent(projectId)}`, {}, "读取 Agent 会话失败"),
    createAgentSession: (body: { sessionId: string; projectId: string; title: string; model: string }) => serverRequest<ServerAgentSession>("/v1/agent/sessions", { method: "POST", ...jsonBody(body) }, "新建 Agent 会话失败"),
    agentSession: (id: string) => serverRequest<ServerAgentSession>(`/v1/agent/sessions/${id}`, {}, "读取 Agent 会话失败"),
    deleteAgentSession: (id: string) => serverRequest<boolean>(`/v1/agent/sessions/${id}`, { method: "DELETE" }, "删除 Agent 会话失败"),
    agentMessages: (id: string, sinceSeq: number) => serverRequest<{ items: ServerAgentMessage[] }>(`/v1/agent/sessions/${id}/messages?sinceSeq=${sinceSeq}`, {}, "读取 Agent 消息失败"),
    /** clientMessageId 是幂等键：断网重发同一个键只会拿回已存在的那条消息，不会重复执行也不会重复扣点。model 是用户在面板上选的模型，留空表示按服务端默认。 */
    sendAgentMessage: (id: string, body: { clientMessageId: string; content: string; model: string; attachmentIds: string[]; references: Array<{ nodeId: string }> }) => serverRequest<ServerAgentMessage>(`/v1/agent/sessions/${id}/messages`, { method: "POST", ...jsonBody(body) }, "发送消息失败"),
    abortAgentSession: (id: string) => serverRequest<ServerAgentSession>(`/v1/agent/sessions/${id}/abort`, { method: "POST" }, "中止 Agent 执行失败"),
    /** 回应 status 为 awaiting 时挂起的那条请求。批准就接着跑，拒绝就收尾，两种请求共用这一个接口。 */
    resolveAgentSession: (id: string, approved: boolean) => serverRequest<ServerAgentSession>(`/v1/agent/sessions/${id}/resolve`, { method: "POST", ...jsonBody({ approved }) }, "回应 Agent 请求失败"),
};

/**
 * Agent 事件流。鉴权靠请求头带令牌，EventSource 不支持自定义头，只能自己 fetch + 读流解析 SSE。
 * 断开只是取消订阅，服务端的推理循环照常跑完并落库，重连时带上 sinceSeq 就能把断线期间的消息补齐。
 */
export async function serverAgentStream(sessionId: string, sinceSeq: number, onEvent: (event: ServerAgentEvent) => void, signal: AbortSignal) {
    const response = await fetch(serverApiUrl(`/v1/agent/sessions/${sessionId}/stream?sinceSeq=${sinceSeq}`), { headers: authHeaders({ Accept: "text/event-stream" }), signal }).catch(() => {
        throw new Error("Agent 事件流连接失败：无法连接服务端，请检查网络");
    });
    if (response.status === 401) {
        useServerStore.getState().clearSession();
        useServerStore.getState().setLoginOpen(true);
        throw new Error("登录状态已失效，请重新登录");
    }
    if (!response.ok) throw new Error(`Agent 事件流连接失败（HTTP ${response.status}）`);
    await readServerSse(response, (data) => onEvent(JSON.parse(data) as ServerAgentEvent), "Agent 事件流没有返回内容");
}

/** SSE 按空行分块；保活帧是 ": keep-alive" 注释，没有 data 行，这里自然跳过。 */
async function readServerSse(response: Response, onData: (data: string) => void, empty: string) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(empty);
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
            if (data) onData(data);
        }
    }
}

/**
 * 生成任务事件流：一条连接订阅当前用户所有任务的状态、进度与文本增量。
 * 鉴权靠请求头带令牌，EventSource 不支持自定义头，只能自己 fetch + 读流解析 SSE。
 * 不做成每个任务一条：浏览器对同源只允许 6 个并发连接，同时跑几个生成就会把连接池占满。
 * 断开只是取消订阅，服务端任务照常跑完并落库，重连时带上 sinceSeq 就能补齐断线期间的变化。
 */
export async function serverJobStream(sinceSeq: number, onEvent: (event: ServerJobEvent) => void, signal: AbortSignal) {
    const response = await fetch(serverApiUrl(`/v1/jobs/stream?sinceSeq=${sinceSeq}`), { headers: authHeaders({ Accept: "text/event-stream" }), signal }).catch(() => {
        throw new Error("生成任务事件流连接失败：无法连接服务端，请检查网络");
    });
    if (response.status === 401) {
        useServerStore.getState().clearSession();
        useServerStore.getState().setLoginOpen(true);
        throw new Error("登录状态已失效，请重新登录");
    }
    if (!response.ok) throw new Error(`生成任务事件流连接失败（HTTP ${response.status}）`);
    await readServerSse(response, (data) => onEvent(JSON.parse(data) as ServerJobEvent), "生成任务事件流没有返回内容");
}

/** 文本类调用需要流式读取，单独走 fetch 拿原始 Response。 */
export async function serverAiStream(path: string, body: unknown, signal?: AbortSignal) {
    const response = await fetch(serverApiUrl(path), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal,
    }).catch(() => {
        throw new Error("请求失败：无法连接服务端，请检查服务器地址与网络");
    });
    if (response.status === 401) {
        useServerStore.getState().clearSession();
        useServerStore.getState().setLoginOpen(true);
        throw new Error("登录状态已失效，请重新登录");
    }
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        try {
            throw new Error((JSON.parse(text) as ApiEnvelope<unknown>).msg || `请求失败（HTTP ${response.status}）`);
        } catch (error) {
            throw error instanceof Error && error.message ? error : new Error(`请求失败（HTTP ${response.status}）`);
        }
    }
    return response;
}

/**
 * 连接服务端：拉公开配置，有令牌就顺带校验登录态。
 * auto 模式下这同时是一次探测，探测不到就静默退回本地模式（纯前端部署就是这种情况）；
 * 用户手动设成 on 时才把连接失败当成错误提示出来。
 */
export async function connectServer() {
    const store = useServerStore.getState();
    if (store.mode === "off") return false;
    store.setStatus("connecting");
    try {
        store.setSettings(await serverApi.settings());
        store.setDetected(true);
        if (store.token) {
            const user = await serverApi.me();
            if (user.role === "guest") throw new Error("登录状态已失效，请重新登录");
            store.setSession(store.token, user);
        } else {
            store.setStatus("idle");
        }
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : "连接服务端失败";
        const current = useServerStore.getState();
        // 令牌失效不代表后端不可用，探测结果要保留，否则会连带退回本地模式。
        if (!current.settings) current.setDetected(false);
        current.setStatus(current.mode === "auto" && !current.settings ? "idle" : "error", message);
        return false;
    }
}
