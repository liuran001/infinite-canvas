import { ServerApiError, serverApi, type ServerProject, type ServerUserAsset } from "@/services/api/server";
import { mergeProjectSnapshots } from "@/services/project-merge";
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { applyRemoteProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import type { Asset } from "@/stores/use-asset-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCloudAgentStore } from "@/stores/use-cloud-agent-store";
import type { AiConfig } from "@/stores/use-config-store";
import { useConfigStore } from "@/stores/use-config-store";
import { isServerMode, useServerStore } from "@/stores/use-server-store";

/** 画布 JSON 体积可能很大，连续编辑只推最后一次。 */
const PUSH_DELAY = 2000;
/** 同步请求的并发上限。 */
const MAX_RUNNING = 3;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const queue: Array<() => Promise<unknown>> = [];
let running = 0;
let projectSync: Promise<unknown> | null = null;
let assetSync: Promise<unknown> | null = null;
let pluginSync: Promise<unknown> | null = null;
const projectSaves = new Map<string, { inflight: boolean; dirty: boolean; retries: number; base: CanvasProject | null }>();
const confirmedProjects = new Map<string, CanvasProject>();

/** 每个标签页都有独立身份；模块单例保证同一标签页内列表页和画布页共用。 */
const projectClientId = `tab_${crypto.randomUUID().replaceAll("-", "")}`;
export function getProjectClientId() {
    return projectClientId;
}

export function cancelProjectPush(id: string) {
    cancel(`project:${id}`);
}

function cancel(key: string) {
    clearTimeout(timers.get(key));
    timers.delete(key);
}

function schedule(key: string, task: () => Promise<unknown>) {
    cancel(key);
    timers.set(
        key,
        setTimeout(() => {
            timers.delete(key);
            pump(task);
        }, PUSH_DELAY),
    );
}

function pump(task?: () => Promise<unknown>) {
    if (task) queue.push(task);
    while (running < MAX_RUNNING && queue.length) {
        const next = queue.shift()!;
        running += 1;
        void next().finally(() => {
            running -= 1;
            pump();
        });
    }
}

/** 乐观锁失败说明服务端已有更新的版本，重新拉一次以远程为准。 */
function isConflict(error: unknown) {
    return error instanceof Error && error.message.includes("已更新");
}

function time(value: string) {
    return Date.parse(value) || 0;
}

function byUpdatedAtDesc(a: { updatedAt: string }, b: { updatedAt: string }) {
    return time(b.updatedAt) - time(a.updatedAt);
}

function latestUpdatedAt(items: Array<{ updatedAt: string }>, since: string) {
    return items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), since);
}

function toProject(item: ServerProject): CanvasProject {
    return { ...(item.data as CanvasProject), id: item.id, title: item.title, updatedAt: item.updatedAt, revision: item.revision };
}

function toAsset(item: ServerUserAsset): Asset {
    return { ...(item.data as Asset), id: item.id, title: item.title, updatedAt: item.updatedAt, revision: item.revision } as Asset;
}

/** 素材里的图片/视频按 storageKey 重新解析，跨设备拉回来的地址才指向当前服务端。 */
async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } };
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } };
    }
    return asset;
}

export function pushProject(project: CanvasProject) {
    if (!isServerMode()) return;
    schedule(`project:${project.id}`, () => flushProject(project.id));
}

export function pushUserAsset(asset: Asset) {
    if (!isServerMode()) return;
    schedule(`asset:${asset.id}`, () => flushUserAsset(asset.id));
}

export function removeRemoteProject(id: string) {
    if (!isServerMode()) return;
    cancel(`project:${id}`);
    pump(() => serverApi.deleteProject(id, projectClientId).catch((error) => console.warn("删除云端画布失败", error)));
}

export function removeRemoteUserAsset(id: string) {
    if (!isServerMode()) return;
    cancel(`asset:${id}`);
    pump(() => serverApi.deleteUserAsset(id).catch((error) => console.warn("删除云端素材失败", error)));
}

export function pushUserPlugin(id: string) {
    if (!isServerMode()) return;
    schedule(`plugin:${id}`, () => flushUserPlugin(id));
}

export function removeRemoteUserPlugin(id: string) {
    if (!isServerMode()) return;
    cancel(`plugin:${id}`);
    pump(() => serverApi.deleteUserPlugin(id).catch((error) => console.warn("删除云端插件失败", error)));
}

/** 偏好是纯个人配置，没有版本号，改动防抖后整份覆盖到服务端。 */
export function pushPreferences() {
    if (!isServerMode()) return;
    schedule("preferences", flushPreferences);
}

/** 同一项目只允许一个 PUT 在途；在途期间的修改置 dirty，成功后立即补发最新快照。 */
async function flushProject(id: string) {
    const state = projectSaves.get(id) || { inflight: false, dirty: false, retries: 0, base: null };
    projectSaves.set(id, state);
    if (state.inflight) {
        state.dirty = true;
        return;
    }
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!project || !isServerMode()) return;
    const cloudAgent = useCloudAgentStore.getState();
    if (cloudAgent.status === "running" && cloudAgent.projectId === id) return;
    state.inflight = true;
    state.dirty = false;
    state.base ||= confirmedProjects.get(id) || project;
    useServerStore.getState().setSyncState("saving");
    try {
        const saved = await serverApi.saveProject(id, { title: project.title, data: project, revision: project.revision || 0, clientId: projectClientId });
        const current = useCanvasStore.getState().projects.find((item) => item.id === id);
        if (current) {
            useCanvasStore.setState((store) => ({ projects: store.projects.map((item) => (item.id === id ? { ...item, revision: saved.revision, updatedAt: saved.updatedAt } : item)) }));
            state.base = { ...project, revision: saved.revision, updatedAt: saved.updatedAt };
            confirmedProjects.set(id, state.base);
        }
        state.retries = 0;
        useServerStore.getState().setSyncState("saved");
    } catch (error) {
        if (error instanceof ServerApiError && error.code === "REVISION_CONFLICT" && error.data && state.base && state.retries < 3) {
            const conflictProject = error.data as ServerProject;
            state.retries += 1;
            const local = useCanvasStore.getState().projects.find((item) => item.id === id);
            if (local) {
                const remote = toProject(conflictProject);
                const merged = mergeProjectSnapshots(state.base, local, remote);
                applyRemoteProject(merged);
                state.base = remote;
                state.dirty = true;
            }
        } else {
            console.warn("推送云端画布失败", error);
            useServerStore.getState().setSyncState("failed", error instanceof Error ? error.message : "同步失败");
        }
    } finally {
        state.inflight = false;
        if (state.dirty) {
            state.dirty = false;
            void flushProject(id);
        }
    }
}

async function flushUserAsset(id: string) {
    const asset = useAssetStore.getState().assets.find((item) => item.id === id);
    if (!asset || !isServerMode()) return;
    try {
        const saved = await serverApi.saveUserAsset(id, { kind: asset.kind, title: asset.title, data: asset, revision: asset.revision });
        useAssetStore.setState((state) => ({ assets: state.assets.map((item) => (item.id === id ? ({ ...item, revision: saved.revision, updatedAt: saved.updatedAt } as Asset) : item)) }));
    } catch (error) {
        console.warn("推送云端素材失败", error);
        if (isConflict(error)) void syncUserAssets();
    }
}

async function flushUserPlugin(id: string) {
    const plugin = usePluginStore.getState().plugins.find((item) => item.id === id);
    if (!plugin || !isServerMode()) return;
    try {
        const saved = await serverApi.saveUserPlugin(id, { data: plugin, revision: plugin.revision });
        usePluginStore.setState((state) => ({ plugins: state.plugins.map((item) => (item.id === id ? { ...item, revision: saved.revision } : item)) }));
    } catch (error) {
        console.warn("推送云端插件失败", error);
        if (isConflict(error)) void syncUserPlugins();
    }
}

/** 推送时重新读一遍最新偏好，防抖期间的连续改动都会包含进来。 */
async function flushPreferences() {
    if (!isServerMode()) return;
    await serverApi.savePreferences({ ...useConfigStore.getState().config }).catch((error) => console.warn("推送云端偏好失败", error));
}

/**
 * 登录后以云端偏好为准覆盖本地：本地 localStorage 只是防刷新闪烁的离线缓存。
 * 云端还没有记录（新账号）时反过来把本地偏好推上去当初始值。
 */
async function pullPreferences() {
    if (!isServerMode()) return;
    const remote = await serverApi.preferences();
    if (!Object.keys(remote).length) return flushPreferences();
    useConfigStore.setState((state) => ({ config: { ...state.config, ...(remote as Partial<AiConfig>) } }));
}

/**
 * 拉取增量并按 updatedAt 后写胜出合并：远程更新则覆盖本地，
 * 本地更新或从未推送过则排队推送，远程软删除则移除本地。
 * 本地胜出时先记下远程版本号，推送才不会被乐观锁挡回来。
 */
async function pullProjects(since: string) {
    if (!isServerMode()) return since;
    const { items } = await serverApi.projects(since);
    const store = useCanvasStore.getState();
    const merged = new Map(store.projects.map((project) => [project.id, project]));
    const pending = new Set<string>();
    items.forEach((item) => {
        const local = merged.get(item.id);
        if (item.deleted) merged.delete(item.id);
        else if (local && time(local.updatedAt) > time(item.updatedAt)) {
            merged.set(item.id, { ...local, revision: item.revision });
            pending.add(item.id);
        } else merged.set(item.id, toProject(item));
    });
    store.projects.forEach((project) => {
        if (!project.revision && merged.has(project.id)) pending.add(project.id);
    });
    if (items.length) store.replaceProjects([...merged.values()].sort(byUpdatedAtDesc));
    pending.forEach((id) => pump(() => flushProject(id)));
    return latestUpdatedAt(items, since);
}

async function pullUserAssets(since: string) {
    if (!isServerMode()) return since;
    const { items } = await serverApi.userAssets(since);
    const store = useAssetStore.getState();
    const merged = new Map(store.assets.map((asset) => [asset.id, asset]));
    const pending = new Set<string>();
    items.forEach((item) => {
        const local = merged.get(item.id);
        if (item.deleted) merged.delete(item.id);
        else if (local && time(local.updatedAt) > time(item.updatedAt)) {
            merged.set(item.id, { ...local, revision: item.revision } as Asset);
            pending.add(item.id);
        } else merged.set(item.id, toAsset(item));
    });
    store.assets.forEach((asset) => {
        if (!asset.revision && merged.has(asset.id)) pending.add(asset.id);
    });
    if (items.length) store.replaceAssets(await Promise.all([...merged.values()].sort(byUpdatedAtDesc).map(hydrateAsset)));
    pending.forEach((id) => pump(() => flushUserAsset(id)));
    return latestUpdatedAt(items, since);
}

/** 插件整条记录都存在 data 里，本地没有独立的更新时间，拉到什么就以云端为准。 */
async function pullUserPlugins(since: string) {
    if (!isServerMode()) return since;
    const { items } = await serverApi.userPlugins(since);
    // 插件 store 没有 hydrated 标记，合并前先确保本地记录已经读出来，否则会被回填的持久化数据盖掉。
    await usePluginStore.persist.rehydrate();
    const store = usePluginStore.getState();
    const merged = new Map(store.plugins.map((plugin) => [plugin.id, plugin]));
    items.forEach((item) => {
        if (item.deleted) merged.delete(item.id);
        else merged.set(item.id, { ...(item.data as InstalledPlugin), id: item.id, revision: item.revision });
    });
    const pending = store.plugins.filter((plugin) => !plugin.revision && merged.has(plugin.id)).map((plugin) => plugin.id);
    if (items.length) usePluginStore.setState({ plugins: [...merged.values()] });
    pending.forEach((id) => pump(() => flushUserPlugin(id)));
    return latestUpdatedAt(items, since);
}

/**
 * 按 ID 强制以远程为准覆盖本地画布，云端 Agent 改完画布后由画布页调用。
 * 不能复用 pullProjects 的「按 updatedAt 后写胜出」：本地这份刚被用户操作过，
 * updatedAt 往往比服务端新，后写胜出会把 agent 的改动当成过期数据丢掉。
 */
export async function pullProject(id: string) {
    if (!isServerMode()) return null;
    const item = await serverApi.project(id);
    if (item.deleted) return null;
    // 先取消本地待推送的防抖任务，否则刚覆盖完又会被旧状态推回服务端。
    cancel(`project:${id}`);
    const project = toProject(item);
    confirmedProjects.set(id, project);
    // 本地可能压根没有这张画布（换设备、或直接打开画布链接），这时要补进列表而不是只替换。
    applyRemoteProject(project);
    return project;
}

export function syncProjects() {
    projectSync ||= pullProjects(useServerStore.getState().syncedAt)
        .catch((error) => console.warn("同步云端画布失败", error))
        .finally(() => {
            projectSync = null;
        });
    return projectSync;
}

export function syncUserAssets() {
    assetSync ||= pullUserAssets(useServerStore.getState().syncedAt)
        .catch((error) => console.warn("同步云端素材失败", error))
        .finally(() => {
            assetSync = null;
        });
    return assetSync;
}

export function syncUserPlugins() {
    pluginSync ||= pullUserPlugins(useServerStore.getState().syncedAt)
        .catch((error) => console.warn("同步云端插件失败", error))
        .finally(() => {
            pluginSync = null;
        });
    return pluginSync;
}

/** 登录后的一次性全量同步，各侧都成功才推进水位线，避免任一侧失败后漏拉增量。 */
export async function syncAll() {
    if (!isServerMode()) return;
    const since = useServerStore.getState().syncedAt;
    // 偏好没有增量水位线，独立跑一遍，不影响画布/素材/插件的同步进度。
    void pullPreferences().catch((error) => console.warn("同步云端偏好失败", error));
    try {
        const marks = await Promise.all([pullProjects(since), pullUserAssets(since), pullUserPlugins(since)]);
        useServerStore.getState().setSyncedAt(marks.reduce((latest, mark) => (mark > latest ? mark : latest), since));
    } catch (error) {
        console.warn("同步云端数据失败", error);
    }
}
