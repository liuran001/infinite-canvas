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
const presence = new Map<string, Map<string, ProjectPresence>>();
const channel = (ownerId: string, projectId: string) => `${ownerId}:${projectId}`;

function colorFor(value: string) {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return COLORS[hash % COLORS.length];
}

function members(ownerId: string, projectId: string) {
    return [...(presence.get(channel(ownerId, projectId))?.values() || [])].sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function publish(ownerId: string, projectId: string, event: ProjectRealtimeEvent) {
    bus.emit(channel(ownerId, projectId), event);
}

function publishPresence(ownerId: string, projectId: string) {
    publish(ownerId, projectId, { type: "presence.sync", projectId, members: members(ownerId, projectId) });
}

export function subscribeProject(ownerId: string, projectId: string, listener: (event: ProjectRealtimeEvent) => void) {
    const key = channel(ownerId, projectId);
    bus.on(key, listener);
    return () => void bus.off(key, listener);
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

export function updateProjectPresence(ownerId: string, projectId: string, actor: ProjectActor, input: { clientId: string; nodeIds: string[]; activity: ProjectActivity }) {
    const key = channel(ownerId, projectId);
    const entries = presence.get(key) || new Map<string, ProjectPresence>();
    entries.set(input.clientId, {
        clientId: input.clientId,
        principalId: actor.id,
        displayName: actor.displayName || "协作者",
        avatarUrl: actor.avatarUrl || "",
        color: colorFor(`${actor.id}:${input.clientId}`),
        nodeIds: [...new Set(input.nodeIds)].slice(0, MAX_PRESENCE_NODES),
        activity: input.activity,
        updatedAt: now(),
    });
    presence.set(key, entries);
    publishPresence(ownerId, projectId);
    return members(ownerId, projectId);
}

export function removeProjectPresence(ownerId: string, projectId: string, clientId: string) {
    const key = channel(ownerId, projectId);
    const entries = presence.get(key);
    if (!entries?.delete(clientId)) return members(ownerId, projectId);
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
