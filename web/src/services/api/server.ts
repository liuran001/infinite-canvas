import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

import { useServerStore, type ServerSettings, type ServerUser } from "@/stores/use-server-store";

export type ServerJobKind = "image" | "video" | "audio";
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
    saveProject: (id: string, body: { title: string; data: unknown; revision?: number }) => serverRequest<ServerProject>(`/v1/projects/${id}`, { method: "PUT", ...jsonBody(body) }, "保存云端画布失败"),
    deleteProject: (id: string) => serverRequest<boolean>(`/v1/projects/${id}`, { method: "DELETE" }, "删除云端画布失败"),

    userAssets: (since = "") => serverRequest<{ items: ServerUserAsset[] }>(`/v1/user-assets${since ? `?since=${encodeURIComponent(since)}` : ""}`, {}, "读取云端素材失败"),
    saveUserAsset: (id: string, body: { kind: string; title: string; data: unknown; revision?: number }) => serverRequest<ServerUserAsset>(`/v1/user-assets/${id}`, { method: "PUT", ...jsonBody(body) }, "保存云端素材失败"),
    deleteUserAsset: (id: string) => serverRequest<boolean>(`/v1/user-assets/${id}`, { method: "DELETE" }, "删除云端素材失败"),

    userPlugins: (since = "") => serverRequest<{ items: ServerUserPlugin[] }>(`/v1/user-plugins${since ? `?since=${encodeURIComponent(since)}` : ""}`, {}, "读取云端插件失败"),
    saveUserPlugin: (id: string, body: { data: unknown; revision?: number }) => serverRequest<ServerUserPlugin>(`/v1/user-plugins/${encodeURIComponent(id)}`, { method: "PUT", ...jsonBody(body) }, "保存云端插件失败"),
    deleteUserPlugin: (id: string) => serverRequest<boolean>(`/v1/user-plugins/${encodeURIComponent(id)}`, { method: "DELETE" }, "删除云端插件失败"),

    aiModels: (model: string) => serverRequest<string[]>(`/v1/ai/models?model=${encodeURIComponent(model)}`, {}, "读取模型失败"),
};

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
