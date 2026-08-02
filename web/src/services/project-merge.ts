import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

function stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
    return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => stable(a) === stable(b);

function mergeValue<T>(base: T, local: T, remote: T): T {
    if (equal(local, base)) return remote;
    if (equal(remote, base)) return local;
    return local;
}

/** 按 ID 三方合并。删除优先：base 里存在而任一侧删除的条目不会被另一侧修改复活。 */
function mergeItems<T extends { id: string }>(base: T[], local: T[], remote: T[]) {
    const baseMap = new Map(base.map((item) => [item.id, item]));
    const localMap = new Map(local.map((item) => [item.id, item]));
    const remoteMap = new Map(remote.map((item) => [item.id, item]));
    const result: T[] = [];
    for (const id of new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])) {
        const before = baseMap.get(id);
        const ours = localMap.get(id);
        const theirs = remoteMap.get(id);
        if (before && (!ours || !theirs)) continue;
        if (!before) {
            if (ours) result.push(ours);
            else if (theirs) result.push(theirs);
            continue;
        }
        result.push(mergeValue(before, ours!, theirs!));
    }
    return result;
}

export function mergeProjectSnapshots(base: CanvasProject, local: CanvasProject, remote: CanvasProject): CanvasProject {
    const nodes = mergeItems<CanvasNodeData>(base.nodes, local.nodes, remote.nodes);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const connections = mergeItems<CanvasConnection>(base.connections, local.connections, remote.connections).filter((connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId));
    return {
        ...remote,
        title: mergeValue(base.title, local.title, remote.title),
        nodes,
        connections,
        chatSessions: mergeValue(base.chatSessions, local.chatSessions, remote.chatSessions),
        activeChatId: mergeValue(base.activeChatId, local.activeChatId, remote.activeChatId),
        backgroundMode: mergeValue(base.backgroundMode, local.backgroundMode, remote.backgroundMode),
        showImageInfo: mergeValue(base.showImageInfo, local.showImageInfo, remote.showImageInfo),
        // 视口只属于当前设备，不参与协作。
        viewport: local.viewport,
        updatedAt: new Date().toISOString(),
        revision: remote.revision,
    };
}
