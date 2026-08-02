import { isShareConflict, isShareGone, shareApi, shareProjectStream, type ShareApiError } from "@/services/api/share";
import type { ServerProject, ServerProjectEvent, ServerProjectPresence } from "@/services/api/server";
import { mergeProjectSnapshots } from "@/services/project-merge";
import { useShareStore } from "@/stores/use-share-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

/**
 * 分享画布的同步层。串行保存、409 三方合并、SSE 与 Presence 的语义与 remote-sync 完全一致，
 * 区别只有两点：
 * 1. 走 guest 令牌的分享通道；
 * 2. 画布只活在 share store 里——不进用户的项目列表，也不进 localforage 持久化。
 *    分享画布不属于当前账号，混进本地库会在退出分享后变成幽灵项目。
 */

const PUSH_DELAY = 2000;
const RETRIES = [1500, 3000, 6000, 12000, 24000, 30000];

/** 每个标签页一个身份，与账号侧同构（Presence 按 clientId 去重）。 */
const shareClientId = `share_${crypto.randomUUID().replaceAll("-", "")}`;
export function getShareClientId() {
    return shareClientId;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** 串行保存的三态：在途、期间又有改动、连续冲突重试次数。 */
const saveState = { inflight: false, dirty: false, retries: 0, base: null as CanvasProject | null };

function toProject(item: ServerProject): CanvasProject {
    return { ...(item.data as CanvasProject), id: item.id, title: item.title, updatedAt: item.updatedAt, revision: item.revision };
}

export function cancelSharePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
}

/** 只读分享连排队都不该发生：编辑入口全禁用之后这里是最后一道闸。 */
export function pushShareProject(project: CanvasProject) {
    const state = useShareStore.getState();
    if (state.role !== "editor" || state.status !== "ready" || !state.guestToken) return;
    useShareStore.setState({ project });
    cancelSharePush();
    pushTimer = setTimeout(() => {
        pushTimer = null;
        void flushShareProject();
    }, PUSH_DELAY);
}

/** 同一画布只允许一个 PUT 在途；在途期间的改动置 dirty，成功后立即补发最新快照。 */
export async function flushShareProject(): Promise<void> {
    const store = useShareStore.getState();
    if (store.role !== "editor" || store.status !== "ready" || !store.guestToken) return;
    if (saveState.inflight) {
        saveState.dirty = true;
        return;
    }
    const project = store.project;
    if (!project) return;
    saveState.inflight = true;
    saveState.dirty = false;
    saveState.base ||= project;
    useShareStore.getState().setSyncState("saving");
    try {
        const saved = await shareApi.saveProject(project.id, store.guestToken, { title: project.title, data: project, revision: store.revision || 0, clientId: shareClientId });
        const confirmed = { ...project, revision: saved.revision, updatedAt: saved.updatedAt };
        saveState.base = confirmed;
        saveState.retries = 0;
        useShareStore.setState({ project: { ...useShareStore.getState().project!, revision: saved.revision, updatedAt: saved.updatedAt }, revision: saved.revision });
        useShareStore.getState().setSyncState("saved");
    } catch (error) {
        if (isShareGone(error)) {
            useShareStore.getState().markGone("链接已失效");
        } else if (isShareConflict(error) && (error as ShareApiError).data && saveState.base && saveState.retries < 3) {
            // 与账号侧同一套三方合并：base 是上次确认过的快照，local 是当前内存快照，remote 是服务端最新版本。
            const remote = toProject((error as ShareApiError).data as ServerProject);
            saveState.retries += 1;
            const local = useShareStore.getState().project;
            if (local) {
                const merged = mergeProjectSnapshots(saveState.base, local, remote);
                useShareStore.setState({ project: merged, revision: remote.revision || 0 });
                saveState.base = remote;
                saveState.dirty = true;
            }
        } else {
            useShareStore.getState().setSyncState("failed", error instanceof Error ? error.message : "保存失败");
        }
    } finally {
        saveState.inflight = false;
        if (saveState.dirty) {
            saveState.dirty = false;
            void flushShareProject();
        }
    }
}

/** 按 ID 强制以远程为准拉取。分享画布不落本地库，只回写 share store。 */
export async function pullShareProject() {
    const { project, guestToken, token } = useShareStore.getState();
    if (!project || !guestToken || !token) return null;
    const item = await shareApi.project(project.id, guestToken);
    const next = toProject(item);
    cancelSharePush();
    saveState.base = next;
    useShareStore.setState({ project: next, revision: next.revision || 0 });
    return next;
}

/** 首次载入：拿到 guest 令牌后读一次画布本体。 */
export async function loadShareProject(projectId: string) {
    const { guestToken } = useShareStore.getState();
    if (!guestToken) return null;
    try {
        const project = toProject(await shareApi.project(projectId, guestToken));
        saveState.base = project;
        useShareStore.getState().setProject(project, project.revision || 0);
        return project;
    } catch (error) {
        if (isShareGone(error)) useShareStore.getState().markGone("链接不存在或已失效");
        else useShareStore.getState().setStatus("error", error instanceof Error ? error.message : "读取分享画布失败");
        return null;
    }
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });

/**
 * 订阅分享画布的实时事件。撤销后服务端会主动断开连接，重连拿到 404 即判定链接失效并停止重试
 * ——这正是设计文档要求的「撤销立即断流」在客户端的落点。
 */
export function watchShareProject(projectId: string, handlers: { onProject?: (project: CanvasProject) => void; onDeleted?: () => void }, signal: AbortSignal) {
    void (async () => {
        let failure = 0;
        while (!signal.aborted) {
            const store = useShareStore.getState();
            if (!store.guestToken) break;
            let lastRevision = store.revision || 0;
            store.setStreamStatus(failure ? "reconnecting" : "connecting");
            try {
                await shareProjectStream(
                    projectId,
                    store.guestToken,
                    shareClientId,
                    lastRevision,
                    (event: ServerProjectEvent) => {
                        if (event.type === "ready") {
                            lastRevision = Math.max(lastRevision, event.revision);
                            useShareStore.getState().setMembers(event.members.filter((item) => item.clientId !== shareClientId));
                            useShareStore.getState().setStreamStatus("ready");
                            failure = 0;
                        } else if (event.type === "presence.sync") {
                            useShareStore.getState().setMembers(event.members.filter((item) => item.clientId !== shareClientId));
                        } else if (event.type === "project.deleted") {
                            handlers.onDeleted?.();
                        } else if (event.revision > lastRevision) {
                            lastRevision = event.revision;
                            if (event.writerClientId === shareClientId) return;
                            void pullShareProject()
                                .then((project) => project && handlers.onProject?.(project))
                                .catch(() => undefined);
                        }
                    },
                    signal,
                );
            } catch (error) {
                if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) break;
                if (isShareGone(error)) {
                    useShareStore.getState().markGone("链接已失效");
                    break;
                }
                useShareStore.getState().setStreamStatus("reconnecting");
            }
            if (!signal.aborted) await sleep(RETRIES[Math.min(failure++, RETRIES.length - 1)], signal).catch(() => undefined);
        }
    })();
    return shareClientId;
}

/** Presence 上报。只读访客同样上报，让所有者看到「有人在看」。 */
export function createSharePresenceReporter(projectId: string) {
    let current: { nodeIds: string[]; activity: ServerProjectPresence["activity"] } = { nodeIds: [], activity: "idle" };
    let timer = 0;
    const send = () => {
        const { guestToken } = useShareStore.getState();
        if (!guestToken) return;
        void shareApi.updatePresence(projectId, guestToken, { clientId: shareClientId, ...current }).catch(() => undefined);
    };
    const heartbeat = window.setInterval(send, 15_000);
    return {
        update(nodeIds: string[], activity: ServerProjectPresence["activity"]) {
            current = { nodeIds: [...new Set(nodeIds)], activity };
            window.clearTimeout(timer);
            timer = window.setTimeout(send, 200);
        },
        dispose() {
            window.clearTimeout(timer);
            window.clearInterval(heartbeat);
            const { guestToken } = useShareStore.getState();
            if (guestToken) void shareApi.removePresence(projectId, guestToken, shareClientId).catch(() => undefined);
        },
    };
}

/** 页面卸载时把状态清干净，免得下一次打开别的分享链接读到上一次的残留。 */
export function resetShareSync() {
    cancelSharePush();
    saveState.inflight = false;
    saveState.dirty = false;
    saveState.retries = 0;
    saveState.base = null;
}
