import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { useMemo } from "react";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { localForageStorage } from "@/lib/localforage-storage";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { isServerMode } from "@/stores/use-server-store";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    /** 服务端版本号，本地模式下始终为 undefined。 */
    revision?: number;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";
type PersistedCanvasState = Pick<CanvasStore, "projects">;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPersistState: PersistedCanvasState | null = null;
const applyingRemoteProjects = new Set<string>();
const remoteProjectListeners = new Set<(project: CanvasProject) => void>();

const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        queuedPersistState = parsed.state as PersistedCanvasState;
        return parsed;
    },
    setItem: (name, value) => {
        const nextState = value.state as PersistedCanvasState;
        if (queuedPersistState && queuedPersistState.projects === nextState.projects) return;
        queuedPersistState = nextState;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            void localForageStorage.setItem(name, JSON.stringify(value));
        }, 400);
    },
    removeItem: (name) => localForageStorage.removeItem(name),
};

/** 服务器模式下把改动推到云端，动态导入避免与同步模块循环依赖。 */
function pushRemote(project?: CanvasProject) {
    if (!project || !isServerMode()) return;
    void import("@/services/remote-sync").then((module) => module.pushProject(project));
}

function removeRemote(ids: string[]) {
    if (!isServerMode()) return;
    void import("@/services/remote-sync").then((module) => ids.forEach((id) => module.removeRemoteProject(id)));
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            projects: [],
            createProject: (title = i18n.t("canvas.project.untitled")) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const project: CanvasProject = {
                    id,
                    title,
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: source.title || i18n.t("canvas.project.imported"),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                pushRemote(project);
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => {
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
                }));
                if (!applyingRemoteProjects.has(id)) pushRemote(get().projects.find((project) => project.id === id));
            },
            deleteProjects: (ids) => {
                set((state) => {
                    const projects = state.projects.filter((project) => !ids.includes(project.id));
                    return { projects };
                });
                removeRemote(ids);
            },
            replaceProjects: (projects) => set({ projects }),
            updateProject: (id, patch) => {
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
                }));
                // 平移缩放画布只改 viewport，不值得为此上传整份项目 JSON，等有内容改动再推。
                if (!applyingRemoteProjects.has(id) && Object.keys(patch).some((key) => key !== "viewport")) pushRemote(get().projects.find((project) => project.id === id));
            },
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasStore.setState({ hydrated: true });
            },
        },
    ),
);

export function applyRemoteProject(project: CanvasProject) {
    applyingRemoteProjects.add(project.id);
    useCanvasStore.setState((state) => ({
        projects: state.projects.some((item) => item.id === project.id) ? state.projects.map((item) => (item.id === project.id ? project : item)) : [project, ...state.projects],
    }));
    remoteProjectListeners.forEach((listener) => listener(project));
}

/** 画布页处理完 React state 后显式释放，不能靠 microtask 猜 React 什么时候提交。 */
export function finishApplyingRemoteProject(id: string) {
    applyingRemoteProjects.delete(id);
}

export function onRemoteProjectApplied(listener: (project: CanvasProject) => void) {
    remoteProjectListeners.add(listener);
    return () => { remoteProjectListeners.delete(listener); };
}

export function isApplyingRemoteProject(id: string) {
    return applyingRemoteProjects.has(id);
}

/**
 * 挑出这些节点里已经不在画布上的（用户引用了某个节点之后又把它删了）。
 * 画布页会把节点实时写回本 store，所以这里查到的就是当前画布。
 * 选择器只返回字符串：拖动节点时 store 每帧都在变，返回数组/Set 会让调用方跟着白白重渲染。
 */
export function useMissingCanvasNodeIds(projectId: string, nodeIds: string[]) {
    const missing = useCanvasStore((state) => {
        const project = state.projects.find((item) => item.id === projectId);
        // 画布还没加载出来时一律当成「还在」，别在数据没到位时就把引用标成已删除。
        if (!project) return "";
        return nodeIds.filter((id) => !project.nodes.some((node) => node.id === id)).join(",");
    });
    return useMemo(() => new Set(missing ? missing.split(",") : []), [missing]);
}
