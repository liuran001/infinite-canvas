import { createHash, randomBytes } from "node:crypto";

import type { GuestSession } from "./project-share";

/** WebSocket 连接身份。账号与分享访客二选一，和 HTTP 侧的 AccessContext 保持同一套语义。 */
export type RealtimeIdentity = {
    userId: string;
    displayName: string;
    avatarUrl: string;
    guest: GuestSession | null;
};

export const TICKET_TTL_MS = 30_000;

/**
 * 只保存哈希、身份快照与过期时间。明文票据只在响应体里出现一次，
 * 内存里留下明文的话，一次堆快照就等于把所有在途连接凭据交出去。
 */
const tickets = new Map<string, { identity: RealtimeIdentity; expiresAt: number }>();

function hash(ticket: string) {
    return createHash("sha256").update(ticket).digest("hex");
}

/** 签发一次性票据。issuedAt 显式传入，验证脚本才能构造已过期的票据。 */
export function issueTicket(identity: RealtimeIdentity, issuedAt: number) {
    for (const [key, row] of tickets) if (row.expiresAt <= issuedAt) tickets.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(hash(ticket), { identity, expiresAt: issuedAt + TICKET_TTL_MS });
    return ticket;
}

/**
 * 消费票据。先删再判过期：并发两次 upgrade 只能有一次拿到身份，
 * 「先判后删」的写法会让两条连接同时通过。
 */
export function consumeTicket(ticket: string, nowMs: number): RealtimeIdentity | null {
    if (!ticket) return null;
    const key = hash(ticket);
    const row = tickets.get(key);
    tickets.delete(key);
    if (!row || row.expiresAt <= nowMs) return null;
    return row.identity;
}

/** 只给验证脚本用：清掉进程内残留的票据，避免用例之间互相影响。 */
export function resetRealtimeTickets() {
    tickets.clear();
}
