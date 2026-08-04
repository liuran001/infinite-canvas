import { create } from "zustand";

import type { ShareRole, ShareSession } from "@/services/api/share";
import type { ServerProjectPresence } from "@/services/api/server";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

/** 分享页的生命周期。gone 是终态：链接不存在、已撤销或已过期，不再重试。 */
export type ShareStatus = "idle" | "loading" | "ready" | "gone" | "error";
export type ShareSyncState = "idle" | "saving" | "saved" | "failed";
export type ShareStreamStatus = "idle" | "connecting" | "ready" | "reconnecting" | "failed";

type ShareStore = {
    /** URL 上的明文 token。只留在内存里，不落任何持久化存储。 */
    token: string;
    /** 服务端签发的短期访客令牌，所有分享请求都用它。 */
    guestToken: string;
    role: ShareRole;
    allowClone: boolean;
    shareId: string;
    anonymous: boolean;
    fullCanvas: boolean;
    ownerPays: boolean;
    selfPayRequired: boolean;
    allowAnonymousEdit: boolean;
    /** 服务端分配的访客身份，前端只做展示。 */
    actorId: string;
    displayName: string;
    status: ShareStatus;
    error: string;
    /** 分享画布本体。刻意不进 canvas store：它不属于当前账号，不该出现在项目列表，也不该被持久化。 */
    project: CanvasProject | null;
    /** 服务端确认过的版本号，保存与冲突合并都以它为准。 */
    revision: number;
    streamStatus: ShareStreamStatus;
    members: ServerProjectPresence[];
    syncState: ShareSyncState;
    syncError: string;
    /** 克隆进行中，用来禁用按钮避免重复建副本。 */
    cloning: boolean;
    begin: (token: string) => void;
    applySession: (session: ShareSession) => void;
    setStatus: (status: ShareStatus, error?: string) => void;
    setProject: (project: CanvasProject, revision: number) => void;
    setRevision: (revision: number) => void;
    setStreamStatus: (streamStatus: ShareStreamStatus) => void;
    /** 服务端把链接降级成只读时同步过来，交互层据此立刻收权。 */
    setRole: (role: ShareRole) => void;
    setMembers: (members: ServerProjectPresence[]) => void;
    setSyncState: (syncState: ShareSyncState, syncError?: string) => void;
    setCloning: (cloning: boolean) => void;
    /** 链接失效：清掉访客令牌并进入终态。注意这里只动分享状态，不碰账号会话。 */
    markGone: (message?: string) => void;
    reset: () => void;
};

const initial = {
    token: "",
    guestToken: "",
    role: "viewer" as ShareRole,
    allowClone: false,
    shareId: "",
    anonymous: true,
    fullCanvas: false,
    ownerPays: false,
    selfPayRequired: true,
    allowAnonymousEdit: false,
    actorId: "",
    displayName: "",
    status: "idle" as ShareStatus,
    error: "",
    project: null,
    revision: 0,
    streamStatus: "idle" as ShareStreamStatus,
    members: [] as ServerProjectPresence[],
    syncState: "idle" as ShareSyncState,
    syncError: "",
    cloning: false,
};

export const useShareStore = create<ShareStore>()((set) => ({
    ...initial,
    begin: (token) => set({ ...initial, token, status: "loading" }),
    applySession: (session) =>
        set({
            guestToken: session.token,
            role: session.role,
            allowClone: session.allowClone,
            shareId: session.shareId,
            anonymous: session.anonymous,
            fullCanvas: session.fullCanvas,
            ownerPays: session.ownerPays,
            selfPayRequired: session.selfPayRequired,
            allowAnonymousEdit: session.allowAnonymousEdit,
            actorId: session.actorId,
            displayName: session.displayName,
            revision: session.project.revision,
            status: "loading",
            error: "",
        }),
    setStatus: (status, error = "") => set({ status, error }),
    setProject: (project, revision) => set({ project, revision, status: "ready", error: "" }),
    setRevision: (revision) => set({ revision }),
    setStreamStatus: (streamStatus) => set({ streamStatus }),
    setRole: (role) => set({ role }),
    setMembers: (members) => set({ members }),
    setSyncState: (syncState, syncError = "") => set({ syncState, syncError }),
    setCloning: (cloning) => set({ cloning }),
    markGone: (message = "链接已失效") => set({ guestToken: "", status: "gone", error: message, streamStatus: "failed", members: [] }),
    reset: () => set({ ...initial }),
}));

/** 只读判定集中在一处：所有编辑入口都读它，避免每个组件各写一遍条件。 */
export function useShareReadOnly() {
    return useShareStore((state) => state.role !== "editor" || state.status !== "ready");
}

export function isShareEditable() {
    const state = useShareStore.getState();
    return state.role === "editor" && state.status === "ready";
}
