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
};

/** label 是管理员配置的展示名，服务端保证有值（留空时回落成 name），请求仍然用 name。 */
export type ServerModel = { name: string; label: string; apiFormat: ServerApiFormat; capability: ServerCapability };

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
    storage: { remoteEnabled: boolean };
    /** 管理员统一控制的功能入口开关，关掉后所有用户都看不到对应入口。 */
    capabilities: Record<ServerCapability, boolean>;
};

export type ServerStatus = "idle" | "connecting" | "ready" | "error";
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
    setMode: (mode: ServerModeSetting) => void;
    setDetected: (detected: boolean) => void;
    setBaseUrl: (baseUrl: string) => void;
    setSession: (token: string, user: ServerUser) => void;
    setUser: (user: ServerUser | null) => void;
    setSettings: (settings: ServerSettings | null) => void;
    setStatus: (status: ServerStatus, error?: string) => void;
    setSyncedAt: (syncedAt: string) => void;
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
            setMode: (mode) => set(mode === "off" ? { mode, status: "idle", error: "" } : { mode }),
            setDetected: (detected) => set({ detected }),
            setBaseUrl: (baseUrl) => set({ baseUrl: baseUrl.trim().replace(/\/+$/, ""), status: "idle", error: "" }),
            setSession: (token, user) => set({ token, user, status: "ready", error: "" }),
            setUser: (user) => set({ user }),
            setSettings: (settings) => set({ settings }),
            setStatus: (status, error = "") => set({ status, error }),
            setSyncedAt: (syncedAt) => set({ syncedAt }),
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
