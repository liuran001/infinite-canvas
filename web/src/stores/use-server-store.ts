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

export type ServerModel = { name: string; apiFormat: ServerApiFormat; capability: ServerCapability };

export type ServerSettings = {
    modelChannel: {
        models: ServerModel[];
        modelCosts: Array<{ model: string; credits: number }>;
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
};

export type ServerStatus = "idle" | "connecting" | "ready" | "error";

type ServerStore = {
    /** 服务器模式总开关，关闭时整个应用退回纯本地模式。 */
    enabled: boolean;
    /** 服务端地址，留空表示与前端同源，走 nginx 反代的 /api。 */
    baseUrl: string;
    token: string;
    user: ServerUser | null;
    settings: ServerSettings | null;
    status: ServerStatus;
    error: string;
    /** 本地已同步到的服务端时间戳，用于增量拉取项目与素材。 */
    syncedAt: string;
    setEnabled: (enabled: boolean) => void;
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
            enabled: false,
            baseUrl: "",
            token: "",
            user: null,
            settings: null,
            status: "idle",
            error: "",
            syncedAt: "",
            setEnabled: (enabled) => set(enabled ? { enabled } : { enabled, status: "idle", error: "" }),
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
            partialize: (state) => ({ enabled: state.enabled, baseUrl: state.baseUrl, token: state.token, syncedAt: state.syncedAt }),
        },
    ),
);

/** 是否处于「已登录的服务器模式」，数据读写与生成都应走服务端。 */
export function isServerMode() {
    const state = useServerStore.getState();
    return state.enabled && Boolean(state.token) && Boolean(state.user);
}

export function useIsServerMode() {
    return useServerStore((state) => state.enabled && Boolean(state.token) && Boolean(state.user));
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
