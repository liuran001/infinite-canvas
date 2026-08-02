import { serverApi, serverProjectStream, type ServerProjectEvent, type ServerProjectPresence } from "@/services/api/server";
import { getProjectClientId, pullProject } from "@/services/remote-sync";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useProjectPresenceStore } from "@/stores/use-project-presence-store";

const RETRIES = [1500, 3000, 6000, 12000, 24000, 30000];
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export function watchProject(projectId: string, handlers: { onProject?: (revision: number) => void; onDeleted?: () => void }, signal: AbortSignal) {
    const clientId = getProjectClientId();
    useProjectPresenceStore.getState().bind(projectId, clientId);
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
    return clientId;
}

export function createPresenceReporter(projectId: string) {
    const clientId = getProjectClientId();
    let current: { nodeIds: string[]; activity: ServerProjectPresence["activity"] } = { nodeIds: [], activity: "idle" };
    let timer = 0;
    const send = () => void serverApi.updateProjectPresence(projectId, { clientId, ...current }).catch(() => undefined);
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
            void serverApi.removeProjectPresence(projectId, clientId).catch(() => undefined);
        },
    };
}
