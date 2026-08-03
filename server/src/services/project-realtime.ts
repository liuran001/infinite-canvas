import { EventEmitter } from "node:events";

import { now } from "../lib/errors";
import type { ProjectActor } from "./project-access";

export type ProjectActivity = "idle" | "selecting" | "editing";
export type ProjectPresence = {
    clientId: string;
    principalId: string;
    displayName: string;
    avatarUrl: string;
    color: string;
    nodeIds: string[];
    activity: ProjectActivity;
    updatedAt: string;
};
export type ProjectRealtimeEvent =
    | { type: "project.saved"; projectId: string; revision: number; writerClientId: string }
    | { type: "project.deleted"; projectId: string; revision: number; writerClientId: string }
    | { type: "presence.sync"; projectId: string; members: ProjectPresence[] };

const PRESENCE_TTL_MS = 45_000;
const MAX_PRESENCE_NODES = 50;
const COLORS = ["#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#059669", "#0891b2", "#4f46e5"];
const bus = new EventEmitter();
bus.setMaxListeners(0);
/**
 * 每条 presence 记录额外记住是哪条传输写进来的。
 *
 * 同一个 clientId 在传输切换的窗口里会同时存在两条通道：WebSocket 掉线后画布退到 SSE + HTTP 上报，
 * 而那条 WebSocket 频道要过一会儿才真正关闭。关闭时若无条件删掉这个 clientId，
 * 就会把 SSE 那边刚写进去的 presence 一起抹掉——表现是「切到降级之后自己在别人画布上消失了」，
 * 而且要等下一次心跳（15 秒）才回来。反向切换同理。
 * 所以按来源删：只有当前记录仍然属于那条正在关闭的传输时才删。
 */
type PresenceEntry = ProjectPresence & { source: string };
/** HTTP 上报（含 SSE 降级路径）统一算作这一个来源：它们本来就写同一张表，互相覆盖是预期行为。 */
export const PRESENCE_SOURCE_HTTP = "http";
const presence = new Map<string, Map<string, PresenceEntry>>();
/** 每条长连接登记自己是从哪条分享进来的，撤销时才找得到该关谁。owner 直连的 shareId 为空。 */
type ProjectConnection = { key: string; shareId: string; clientId: string; close: () => void };
const connections = new Set<ProjectConnection>();
const channel = (ownerId: string, projectId: string) => `${ownerId}:${projectId}`;

function colorFor(value: string) {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return COLORS[hash % COLORS.length];
}

function members(ownerId: string, projectId: string): ProjectPresence[] {
    // source 只是服务端内部的归属标记，绝不能出现在推给客户端的成员列表里：
    // 它会让前端多出一个能依赖、又随时可能改的字段。
    return [...(presence.get(channel(ownerId, projectId))?.values() || [])].sort((a, b) => a.clientId.localeCompare(b.clientId)).map(({ source: _source, ...member }) => member);
}

function publish(ownerId: string, projectId: string, event: ProjectRealtimeEvent) {
    bus.emit(channel(ownerId, projectId), event);
}

function publishPresence(ownerId: string, projectId: string) {
    publish(ownerId, projectId, { type: "presence.sync", projectId, members: members(ownerId, projectId) });
}

export function subscribeProject(ownerId: string, projectId: string, listener: (event: ProjectRealtimeEvent) => void, options: { shareId?: string; clientId?: string; close?: () => void } = {}) {
    const key = channel(ownerId, projectId);
    bus.on(key, listener);
    const connection: ProjectConnection | null = options.close ? { key, shareId: options.shareId || "", clientId: options.clientId || "", close: options.close } : null;
    if (connection) connections.add(connection);
    return () => {
        bus.off(key, listener);
        if (connection) connections.delete(connection);
    };
}

/**
 * 撤销或降级分享后主动断开该链接下的长连接。
 * 只靠 guest 令牌的短 TTL 不够：SSE 建好之后不重连就不会重新鉴权，撤销要等到下次重连才生效。
 */
export function disconnectShare(ownerId: string, projectId: string, shareId: string) {
    if (!shareId) return 0;
    const key = channel(ownerId, projectId);
    let closed = 0;
    for (const connection of [...connections]) {
        if (connection.key !== key || connection.shareId !== shareId) continue;
        connections.delete(connection);
        closed += 1;
        if (connection.clientId) removeProjectPresence(ownerId, projectId, connection.clientId);
        // 对端可能已经断了，关不掉不该影响剩下的连接。
        try {
            connection.close();
        } catch (error) {
            console.warn("关闭已撤销分享的连接失败：", error);
        }
    }
    return closed;
}

export function publishProjectSaved(ownerId: string, projectId: string, revision: number, writerClientId: string) {
    publish(ownerId, projectId, { type: "project.saved", projectId, revision, writerClientId });
}

export function publishProjectDeleted(ownerId: string, projectId: string, revision: number, writerClientId: string) {
    publish(ownerId, projectId, { type: "project.deleted", projectId, revision, writerClientId });
}

export function listProjectPresence(ownerId: string, projectId: string) {
    return members(ownerId, projectId);
}

export function updateProjectPresence(ownerId: string, projectId: string, actor: ProjectActor, input: { clientId: string; nodeIds: string[]; activity: ProjectActivity; source?: string }) {
    const key = channel(ownerId, projectId);
    const entries = presence.get(key) || new Map<string, PresenceEntry>();
    entries.set(input.clientId, {
        clientId: input.clientId,
        principalId: actor.id,
        displayName: actor.displayName || "协作者",
        avatarUrl: actor.avatarUrl || "",
        color: colorFor(`${actor.id}:${input.clientId}`),
        nodeIds: [...new Set(input.nodeIds)].slice(0, MAX_PRESENCE_NODES),
        activity: input.activity,
        updatedAt: now(),
        source: input.source || PRESENCE_SOURCE_HTTP,
    });
    presence.set(key, entries);
    publishPresence(ownerId, projectId);
    return members(ownerId, projectId);
}

/**
 * 删掉一条 presence。传了 source 就只删「仍然属于该来源」的那条：
 * 一条 WebSocket 频道关闭时，同一个 clientId 可能已经改由 HTTP/SSE 上报，
 * 无条件删会把还活着的那条抹掉，用户在别人画布上凭空消失十几秒。
 * 用户显式退出（dispose、DELETE 接口）不传 source，那是真的要走人。
 */
export function removeProjectPresence(ownerId: string, projectId: string, clientId: string, source?: string) {
    const key = channel(ownerId, projectId);
    const entries = presence.get(key);
    const current = entries?.get(clientId);
    if (!entries || !current) return members(ownerId, projectId);
    if (source && current.source !== source) return members(ownerId, projectId);
    entries.delete(clientId);
    if (!entries.size) presence.delete(key);
    publishPresence(ownerId, projectId);
    return members(ownerId, projectId);
}

/** Presence 是易失提示，每 15 秒清一次；内容状态始终以数据库 revision 为准。 */
const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [key, entries] of presence) {
        let changed = false;
        for (const [clientId, item] of entries) {
            if (Date.parse(item.updatedAt) >= cutoff) continue;
            entries.delete(clientId);
            changed = true;
        }
        if (!changed) continue;
        if (!entries.size) presence.delete(key);
        const split = key.indexOf(":");
        publishPresence(key.slice(0, split), key.slice(split + 1));
    }
}, 15_000);
cleanupTimer.unref();
