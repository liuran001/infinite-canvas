import { serverApi, serverProjectStream, type ServerProjectEvent, type ServerProjectPresence } from "@/services/api/server";
import { subscribeRealtime, type RealtimeSubscription } from "@/services/realtime/connection";
import { getProjectClientId, pullProject } from "@/services/remote-sync";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useProjectPresenceStore } from "@/stores/use-project-presence-store";

const RETRIES = [1500, 3000, 6000, 12000, 24000, 30000];
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
 * 画布实时订阅。优先走共享 WebSocket，连不上（旧服务端、反代不支持 Upgrade）才退回原来的 SSE 循环。
 * SSE 那条路径一个字都没动：它是这条功能唯一被验证过的降级出口，WebSocket 在任何环境下失效时都得靠它兜底。
 */
export function watchProject(projectId: string, handlers: { onProject?: (revision: number) => void; onDeleted?: () => void }, signal: AbortSignal) {
    const clientId = getProjectClientId();
    useProjectPresenceStore.getState().bind(projectId, clientId);

    const presence = useProjectPresenceStore.getState();
    let lastRevision = useCanvasStore.getState().projects.find((item) => item.id === projectId)?.revision || 0;
    let fallback: AbortController | null = null;
    const stopFallback = () => {
        fallback?.abort();
        fallback = null;
    };
    const startFallback = () => {
        if (fallback || signal.aborted) return;
        fallback = new AbortController();
        // 外层 signal 一停，降级流也要跟着停，否则换画布之后它还在往旧画布上写状态。
        signal.addEventListener("abort", () => fallback?.abort(), { once: true });
        watchProjectViaSse(projectId, handlers, fallback.signal);
    };

    const apply = (event: ServerProjectEvent) => {
        if (event.type === "presence.sync") return presence.setMembers(event.members.filter((item) => item.clientId !== clientId));
        if (event.type === "project.deleted") return handlers.onDeleted?.();
        if (event.type === "ready") return;
        if (event.revision <= lastRevision) return;
        lastRevision = event.revision;
        if (event.writerClientId === clientId) return;
        void pullProject(projectId).then(() => handlers.onProject?.(event.revision));
    };

    const subscription = subscribeRealtime<ServerProjectEvent>({
        channel: `project:${projectId}`,
        payload: () => ({ clientId, sinceRevision: lastRevision }),
        onReady: (payload) => {
            const ready = (payload || {}) as { revision?: number; members?: ServerProjectPresence[] };
            lastRevision = Math.max(lastRevision, Number(ready.revision) || 0);
            presence.setMembers((ready.members || []).filter((item) => item.clientId !== clientId));
            presence.setStatus("ready");
            stopFallback();
        },
        onEvent: apply,
        onDegrade: () => {
            presence.setStatus("reconnecting");
            startFallback();
        },
        onRecover: stopFallback,
        onTerminal: (failure) => {
            if (failure.code === "PROJECT_NOT_FOUND") {
                presence.setStatus("failed");
                handlers.onDeleted?.();
                return;
            }
            // 其它终态错误说明这条 WebSocket 频道没戏了，但画布同步不能就此停掉：交给 SSE。
            startFallback();
        },
    });
    presence.setStatus("connecting");
    signal.addEventListener(
        "abort",
        () => {
            subscription.close();
            stopFallback();
            // 订阅表里留下一条已经关掉的记录，presence 就会一直往一条死连接上发，
            // 而 HTTP 回落永远不会被走到——别人从此看不到这个人在画布上的位置。
            if (realtimePresence.get(projectId) === subscription) realtimePresence.delete(projectId);
        },
        { once: true },
    );
    realtimePresence.set(projectId, subscription);

    return clientId;
}

/** 已上线的 SSE 实现，保留为降级路径。 */
function watchProjectViaSse(projectId: string, handlers: { onProject?: (revision: number) => void; onDeleted?: () => void }, signal: AbortSignal) {
    const clientId = getProjectClientId();
    void (async () => {
        let failure = 0;
        while (!signal.aborted) {
            const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
            let lastRevision = project?.revision || 0;
            useProjectPresenceStore.getState().setStatus(failure ? "reconnecting" : "connecting");
            try {
                await serverProjectStream(
                    projectId,
                    clientId,
                    lastRevision,
                    (event: ServerProjectEvent) => {
                        if (event.type === "ready") {
                            lastRevision = Math.max(lastRevision, event.revision);
                            useProjectPresenceStore.getState().setMembers(event.members.filter((item) => item.clientId !== clientId));
                            useProjectPresenceStore.getState().setStatus("ready");
                            failure = 0;
                        } else if (event.type === "presence.sync") {
                            useProjectPresenceStore.getState().setMembers(event.members.filter((item) => item.clientId !== clientId));
                        } else if (event.type === "project.deleted") {
                            handlers.onDeleted?.();
                        } else if (event.revision > lastRevision) {
                            lastRevision = event.revision;
                            if (event.writerClientId === clientId) return;
                            void pullProject(projectId).then(() => handlers.onProject?.(event.revision));
                        }
                    },
                    signal,
                );
            } catch (error) {
                if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) break;
                if (error instanceof Error && /HTTP 404/.test(error.message)) {
                    useProjectPresenceStore.getState().setStatus("failed");
                    handlers.onDeleted?.();
                    break;
                }
                useProjectPresenceStore.getState().setStatus("reconnecting");
            }
            if (!signal.aborted) await sleep(RETRIES[Math.min(failure++, RETRIES.length - 1)], signal).catch(() => undefined);
        }
    })();
}

/** 画布 id → 当前那条 WebSocket 订阅，presence 上行要用它；没有连接时回落到 HTTP 接口。 */
const realtimePresence = new Map<string, RealtimeSubscription>();

export function createPresenceReporter(projectId: string) {
    const clientId = getProjectClientId();
    let current: { nodeIds: string[]; activity: ServerProjectPresence["activity"] } = { nodeIds: [], activity: "idle" };
    let timer = 0;
    // presence 优先走 WebSocket 上行：它和事件走同一条连接，不会因为 HTTP 请求排队而比画布变更晚到。
    // 没有可用订阅时仍打 HTTP 接口，这条路径在 WebSocket 不可用的环境下是唯一能让别人看到你的方式。
    const send = () => {
        const subscription = realtimePresence.get(projectId);
        if (subscription) return subscription.presence({ clientId, ...current });
        void serverApi.updateProjectPresence(projectId, { clientId, ...current }).catch(() => undefined);
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
            realtimePresence.delete(projectId);
            void serverApi.removeProjectPresence(projectId, clientId).catch(() => undefined);
        },
    };
}
