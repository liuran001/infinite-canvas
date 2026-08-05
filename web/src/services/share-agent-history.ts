import localforage from "localforage";

import type { ServerAgentMessage, ServerAgentSession } from "@/services/api/server";

/**
 * 匿名访客没有账号可跨设备认领历史，因此只在当前浏览器镜像一份。
 * key 同时包含 shareId 与服务端签发的 actorId，绝不把同一分享里的不同访客串在一起。
 */
const store = localforage.createInstance({ name: "infinite-canvas", storeName: "share_agent_history" });
const writes = new Map<string, Promise<void>>();

export type AnonymousShareAgentScope = { shareId: string; actorId: string };
export type AnonymousShareAgentHistory = {
    sessions: ServerAgentSession[];
    activeSessionId: string;
    messagesBySession: Record<string, ServerAgentMessage[]>;
};

const emptyHistory = (): AnonymousShareAgentHistory => ({ sessions: [], activeSessionId: "", messagesBySession: {} });

function keyOf(scope: AnonymousShareAgentScope) {
    return `${scope.shareId}:${scope.actorId}`;
}

function enqueue(scope: AnonymousShareAgentScope, task: (key: string) => Promise<void>) {
    const key = keyOf(scope);
    const next = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(() => task(key));
    writes.set(key, next);
    void next.finally(() => {
        if (writes.get(key) === next) writes.delete(key);
    });
    return next;
}

export async function readAnonymousShareAgentHistory(scope: AnonymousShareAgentScope) {
    await writes.get(keyOf(scope))?.catch(() => undefined);
    return (await store.getItem<AnonymousShareAgentHistory>(keyOf(scope))) || emptyHistory();
}

export function saveAnonymousShareAgentHistory(scope: AnonymousShareAgentScope, input: { sessions: ServerAgentSession[]; activeSessionId: string; messages?: ServerAgentMessage[] }) {
    return enqueue(scope, async (key) => {
        const current = (await store.getItem<AnonymousShareAgentHistory>(key)) || emptyHistory();
        await store.setItem(key, {
            sessions: input.sessions,
            activeSessionId: input.activeSessionId,
            messagesBySession: input.activeSessionId && input.messages ? { ...current.messagesBySession, [input.activeSessionId]: input.messages } : current.messagesBySession,
        } satisfies AnonymousShareAgentHistory);
    });
}

export function removeAnonymousShareAgentSession(scope: AnonymousShareAgentScope, sessionId: string, sessions: ServerAgentSession[], activeSessionId: string) {
    return enqueue(scope, async (key) => {
        const current = (await store.getItem<AnonymousShareAgentHistory>(key)) || emptyHistory();
        const messagesBySession = { ...current.messagesBySession };
        delete messagesBySession[sessionId];
        await store.setItem(key, { sessions, activeSessionId, messagesBySession } satisfies AnonymousShareAgentHistory);
    });
}
