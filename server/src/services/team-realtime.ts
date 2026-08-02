import { EventEmitter } from "node:events";

/**
 * 团队实时总线。与 project-realtime 一样是进程内 EventEmitter，因此存在明确的单实例限制：
 * 水平扩容成多进程后，事件只在产生它的那个进程内广播，连到别的实例的成员收不到成员变更，
 * 界面上的成员列表会一直停在旧值，直到用户自己刷新或发起一次会被服务端拒绝的调用。
 *
 * 这不影响正确性：所有权限与名额判定都靠数据库上的条件更新，广播只负责让界面早点知道，
 * 任何判定都不读它，所以跨实例最坏结果是数字滞后，不会放行本该被拒的操作。
 *
 * 结论：实时推送仅在单实例部署下完整可用。要多实例必须先把总线换成 Redis Pub/Sub 或数据库轮询；
 * 在那之前，前端必须保留「SSE 不可用时按 30 秒轮询」的降级路径。
 */
export type TeamMemberEvent = { type: "member.joined" | "member.left" | "member.removed" | "member.roleChanged"; teamId: string; userId: string; role: string };

const bus = new EventEmitter();
bus.setMaxListeners(0);
const channel = (teamId: string) => `team:${teamId}`;
/** 每条长连接登记自己属于哪个用户，成员被移除时才找得到该关谁。 */
const closers = new Map<string, Set<() => void>>();
const closerKey = (teamId: string, userId: string) => `${teamId}:${userId}`;

export function subscribeTeam(teamId: string, userId: string, listener: (event: TeamMemberEvent) => void, onClose?: () => void) {
    const key = channel(teamId);
    bus.on(key, listener);
    const closeKey = closerKey(teamId, userId);
    if (onClose) {
        const set = closers.get(closeKey) || new Set<() => void>();
        set.add(onClose);
        closers.set(closeKey, set);
    }
    return () => {
        bus.off(key, listener);
        if (!onClose) return;
        const set = closers.get(closeKey);
        if (!set?.delete(onClose)) return;
        if (!set.size) closers.delete(closeKey);
    };
}

export function publishTeamMember(teamId: string, event: Omit<TeamMemberEvent, "teamId">) {
    bus.emit(channel(teamId), { ...event, teamId });
}

/**
 * 主动断开某个成员在该团队下的长连接。
 * 移除成员只删数据库行是不够的：SSE 建好之后不重连就不会重新鉴权，
 * 被移出的人页面上会一直挂着旧角色的团队视图，直到他自己刷新。
 */
export function closeTeamConnectionsOf(teamId: string, userId: string) {
    const key = closerKey(teamId, userId);
    const set = closers.get(key);
    if (!set) return 0;
    closers.delete(key);
    let closed = 0;
    for (const close of set) {
        closed += 1;
        // 对端可能已经断了，关不掉不该影响剩下的连接。
        try {
            close();
        } catch (error) {
            console.warn("关闭被移除成员的团队连接失败：", error);
        }
    }
    return closed;
}
