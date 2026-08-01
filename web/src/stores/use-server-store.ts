import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ServerRole = "guest" | "user" | "admin";
export type ServerApiFormat = "openai" | "gemini" | "ark";
export type ServerCapability = "image" | "video" | "text" | "audio";

export type ServerUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: ServerRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
    /** 是否已绑定 Linux.do，账号设置据此决定给「绑定」还是「解绑」。 */
    linuxDoBound: boolean;
};

/** label 是管理员配置的展示名，服务端保证有值（留空时回落成 name），请求仍然用 name。vision 表示该模型能不能读图。 */
export type ServerModel = { name: string; label: string; apiFormat: ServerApiFormat; capability: ServerCapability; vision: boolean };

export type ServerSettings = {
    modelChannel: {
        models: ServerModel[];
        /** qualityCredits 按画质档位在基础价上叠加。 */
        modelCosts: Array<{ model: string; credits: number; qualityCredits?: Record<string, number> }>;
        defaultModel: string;
        defaultImageModel: string;
        defaultVideoModel: string;
        defaultTextModel: string;
        defaultAudioModel: string;
        systemPrompt: string;
        allowCustomChannel: boolean;
    };
    auth: { allowRegister: boolean; linuxDo: { enabled: boolean } };
    /** searchEnabled 由后台「搜索开关 + 是否配了 key」推导，没配 key 时后端不会把联网搜索给 agent。 */
    agent: { enabled: boolean; model: string; maxRounds: number; searchEnabled: boolean };
    /** defaultQuota 是新账号的云空间上限（字节）。 */
    storage: { remoteEnabled: boolean; defaultQuota: number };
    /** 管理员统一控制的功能入口开关，关掉后所有用户都看不到对应入口。 */
    capabilities: Record<ServerCapability, boolean>;
};

export type ServerStatus = "idle" | "connecting" | "ready" | "error";
/** 画布等数据推送到服务端的状态，失败时界面要明确告诉用户可能没同步上。 */
export type SyncState = "idle" | "saving" | "saved" | "failed";
/** auto 表示自动探测同源后端，探测到就用；on / off 为用户手动固定。 */
export type ServerModeSetting = "auto" | "on" | "off";

type ServerStore = {
    /** 服务器模式开关，默认 auto：部署了后端就直接可用，纯前端部署自动退回本地模式。 */
    mode: ServerModeSetting;
    /** auto 模式下是否探测到了可用后端，每次启动重新探测，不持久化。 */
    detected: boolean;
    /** 服务端地址，留空表示与前端同源，走 nginx 反代的 /api。 */
    baseUrl: string;
    token: string;
    user: ServerUser | null;
    settings: ServerSettings | null;
    status: ServerStatus;
    error: string;
    /** 本地已同步到的服务端时间戳，用于增量拉取项目与素材。 */
    syncedAt: string;
    /** 登录弹窗开关。全站数据都在服务端，未登录时由它引导登录。 */
    loginOpen: boolean;
    /** 登录失败原因，显示在登录弹窗里。第三方登录被拒时用它把原因留给用户看。 */
    loginError: string;
    syncState: SyncState;
    syncError: string;
    setMode: (mode: ServerModeSetting) => void;
    setDetected: (detected: boolean) => void;
    setBaseUrl: (baseUrl: string) => void;
    setSession: (token: string, user: ServerUser) => void;
    setUser: (user: ServerUser | null) => void;
    setSettings: (settings: ServerSettings | null) => void;
    setStatus: (status: ServerStatus, error?: string) => void;
    setSyncedAt: (syncedAt: string) => void;
    setLoginOpen: (loginOpen: boolean) => void;
    setLoginError: (loginError: string) => void;
    setSyncState: (syncState: SyncState, syncError?: string) => void;
    clearSession: () => void;
};

export const SERVER_STORE_KEY = "infinite-canvas:server_store";

export const useServerStore = create<ServerStore>()(
    persist(
        (set) => ({
            mode: "auto",
            detected: false,
            baseUrl: "",
            token: "",
            user: null,
            settings: null,
            status: "idle",
            error: "",
            syncedAt: "",
            loginOpen: false,
            loginError: "",
            syncState: "idle",
            syncError: "",
            setMode: (mode) => set(mode === "off" ? { mode, status: "idle", error: "" } : { mode }),
            setDetected: (detected) => set({ detected }),
            setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.trim().replace(/\/+$/, ""), status: "idle", error: "" }),
            setSession: (token, user) => set({ token, user, status: "ready", error: "", loginOpen: false, loginError: "" }),
            setUser: (user) => set({ user }),
            setSettings: (settings) => set({ settings }),
            setStatus: (status, error = "") => set({ status, error }),
            setSyncedAt: (syncedAt) => set({ syncedAt }),
            setLoginOpen: (loginOpen) => set(loginOpen ? { loginOpen } : { loginOpen, loginError: "" }),
            setLoginError: (loginError) => set({ loginError }),
            setSyncState: (syncState, syncError = "") => set({ syncState, syncError }),
            clearSession: () => set({ token: "", user: null, status: "idle", error: "", syncedAt: "" }),
        }),
        {
            name: SERVER_STORE_KEY,
            partialize: (state) => ({ mode: state.mode, baseUrl: state.baseUrl, token: state.token, syncedAt: state.syncedAt }),
        },
    ),
);

/** 服务器模式是否启用（未必已登录）：on 直接启用，auto 看有没有探测到后端。 */
function serverEnabled(state: Pick<ServerStore, "mode" | "detected">) {
    return state.mode === "on" || (state.mode === "auto" && state.detected);
}

export function isServerEnabled() {
    return serverEnabled(useServerStore.getState());
}

export function useIsServerEnabled() {
    return useServerStore(serverEnabled);
}

/** 是否处于「已登录的服务器模式」，数据读写与生成都应走服务端。 */
export function isServerMode() {
    const state = useServerStore.getState();
    return serverEnabled(state) && Boolean(state.token) && Boolean(state.user);
}

export function useIsServerMode() {
    return useServerStore((state) => serverEnabled(state) && Boolean(state.token) && Boolean(state.user));
}

export function isServerAdmin() {
    return useServerStore.getState().user?.role === "admin";
}

export function serverModelsByCapability(capability: ServerCapability) {
    return (useServerStore.getState().settings?.modelChannel.models || []).filter((model) => model.capability === capability);
}

export function serverModelFormat(name: string): ServerApiFormat {
    return useServerStore.getState().settings?.modelChannel.models.find((model) => model.name === name)?.apiFormat || "openai";
}
