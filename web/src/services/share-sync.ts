import { isShareConflict, isShareGone, isShareReadOnly, shareApi, shareProjectStream, type ShareApiError } from "@/services/api/share";
import type { ServerProject, ServerProjectEvent, ServerProjectPresence } from "@/services/api/server";
import { mergeProjectSnapshots } from "@/services/project-merge";
import { subscribeRealtime, type RealtimeScope, type RealtimeSubscription } from "@/services/realtime/connection";
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
        } else if (isShareReadOnly(error)) {
            // 链接在编辑途中被降级成只读。继续留在可编辑状态只会让访客一直改、一直存不上，
            // 当场收权并说明原因，比默默失败诚实。
            useShareStore.getState().setRole("viewer");
            useShareStore.getState().setSyncState("failed", "这条分享链接已被改为只读，你的最新改动没有保存");
            saveState.dirty = false;
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
 * 访客的实时身份作用域。key 用 URL 上的明文分享 token：一条链接一条连接，换链接就换连接。
 * 令牌每次现取——guest 令牌会周期性续期，缓存住的那份到点之后取票只会一直 401。
 */
function guestScope(): RealtimeScope {
    return { kind: "guest", key: useShareStore.getState().token || "share", token: () => useShareStore.getState().guestToken };
}

/** ready 与 presence.sync 的成员列表都要滤掉自己，否则页面上会多出一个「自己在看自己」。 */
function applyMembers(members: ServerProjectPresence[] | undefined) {
    useShareStore.getState().setMembers((members || []).filter((item) => item.clientId !== shareClientId));
}

/** 服务端在 ready 里带的是这条链接此刻的角色；owner 直连时是 owner，不属于分享角色，跳过。 */
function applyRole(role: unknown) {
    if ((role === "viewer" || role === "editor") && role !== useShareStore.getState().role) useShareStore.getState().setRole(role);
}

/**
 * 订阅分享画布的实时事件。首选与账号画布同一条共享 WebSocket（走访客票据），
 * 连不上（旧服务端、反代不放 Upgrade）才退回原来的 SSE 循环——SSE 是这条链路唯一被验证过的兜底。
 *
 * 撤销的处理是这里最容易写错的一处：服务端撤销、降级成只读、关掉匿名，走的都是同一个
 * 「断开这条频道」的动作，客户端收到的都是 unsubscribed。直接判成「链接已失效」会把
 * 「你现在只能看」误报成「链接没了」，画布当场白掉。所以撤销后一律交给 SSE 重新鉴权一次：
 * 真失效会拿到 404 并进 gone 终态，只是降级则会在新的 ready 里带回 viewer 角色。
 */
export function watchShareProject(projectId: string, handlers: { onProject?: (project: CanvasProject) => void; onDeleted?: () => void }, signal: AbortSignal) {
    let lastRevision = useShareStore.getState().revision || 0;
    let fallback: AbortController | null = null;
    const stopFallback = () => {
        fallback?.abort();
        fallback = null;
    };
    const startFallback = () => {
        if (fallback || signal.aborted) return;
        fallback = new AbortController();
        // 外层 signal 一停，降级流也要跟着停，否则离开分享页之后它还在往 store 里写状态。
        signal.addEventListener("abort", () => fallback?.abort(), { once: true });
        watchShareProjectViaSse(projectId, handlers, fallback.signal);
    };

    const subscription = subscribeRealtime<ServerProjectEvent>({
        channel: `project:${projectId}`,
        scope: guestScope(),
        payload: () => ({ clientId: shareClientId, sinceRevision: lastRevision }),
        onReady: (payload) => {
            const ready = (payload || {}) as { revision?: number; role?: unknown; members?: ServerProjectPresence[] };
            lastRevision = Math.max(lastRevision, Number(ready.revision) || 0);
            applyRole(ready.role);
            applyMembers(ready.members);
            useShareStore.getState().setStreamStatus("ready");
            stopFallback();
        },
        onEvent: (event) => {
            if (event.type === "presence.sync") return applyMembers(event.members);
            if (event.type === "project.deleted") return handlers.onDeleted?.();
            if (event.type === "ready") return;
            if (event.revision <= lastRevision) return;
            lastRevision = event.revision;
            if (event.writerClientId === shareClientId) return;
            void pullShareProject()
                .then((project) => project && handlers.onProject?.(project))
                .catch(() => undefined);
        },
        onDegrade: () => {
            useShareStore.getState().setStreamStatus("reconnecting");
            startFallback();
        },
        onRecover: stopFallback,
        onTerminal: (failure) => {
            // 服务端确证这条链接不存在了：没有任何重试能改变结果，直接进终态，别再拉一条注定 404 的流。
            if (failure.code === "PROJECT_NOT_FOUND" || failure.code === "NOT_FOUND") {
                useShareStore.getState().markGone("链接已失效");
                return;
            }
            // 其余终态（撤销、降级、权限被收）都分不清是「没了」还是「变只读了」：让 SSE 重新鉴权一次去分。
            useShareStore.getState().setStreamStatus("reconnecting");
            startFallback();
        },
    });
    useShareStore.getState().setStreamStatus("connecting");
    signal.addEventListener(
        "abort",
        () => {
            subscription.close();
            stopFallback();
            // 留下一条已关闭的订阅，presence 就会一直往死连接上发，HTTP 回落永远走不到，
            // 别人从此看不到这个访客在画布上的位置。
            if (sharePresence.get(projectId) === subscription) sharePresence.delete(projectId);
        },
        { once: true },
    );
    sharePresence.set(projectId, subscription);

    return shareClientId;
}

/** 已上线的 SSE 实现，保留为降级路径。撤销后重连拿到 404 即判定失效并停止重试。 */
function watchShareProjectViaSse(projectId: string, handlers: { onProject?: (project: CanvasProject) => void; onDeleted?: () => void }, signal: AbortSignal) {
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
                            // 降级为只读会先断流，重连后的 ready 是最早能拿到新角色的地方。
                            // 不在这里同步，访客最长要到下次续期（10 分钟）才知道自己已经不能编辑了。
                            // owner 不是分享角色（所有者自己开这条流时会带上），跳过不动。
                            if ((event.role === "viewer" || event.role === "editor") && event.role !== useShareStore.getState().role) useShareStore.getState().setRole(event.role);
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

/** 画布 id → 当前那条访客 WebSocket 订阅，presence 上行要用它；没有连接时回落到 HTTP 接口。 */
const sharePresence = new Map<string, RealtimeSubscription>();

/** Presence 上报。只读访客同样上报，让所有者看到「有人在看」。 */
export function createSharePresenceReporter(projectId: string) {
    let current: { nodeIds: string[]; activity: ServerProjectPresence["activity"] } = { nodeIds: [], activity: "idle" };
    let timer = 0;
    // 与账号侧同构：presence 优先走 WebSocket 上行，和事件同一条连接，不会因为 HTTP 排队而比画布变更晚到。
    // 没有可用订阅时仍打 HTTP 接口——在 WebSocket 起不来的环境里这是唯一能让别人看到你的方式。
    const send = () => {
        const subscription = sharePresence.get(projectId);
        if (subscription) return subscription.presence({ clientId: shareClientId, ...current });
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
            sharePresence.delete(projectId);
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
