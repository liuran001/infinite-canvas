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

/**
 * 每条长连接登记成一个「订阅句柄」：总线 listener 与断连回调绑在一起。
 * 早先只登记 onClose，退订 listener 得靠路由自己在断连回调里再调一次返回的函数——
 * 漏掉一次就是一个永久泄漏的 listener，被移除的成员早已看不到页面，进程里却还留着他的回调，
 * 而且他被重新拉回团队时会收到两份事件。现在退订由本模块自己保证，调用方漏不掉。
 */
type Subscription = { listener: (event: TeamMemberEvent) => void; onClose?: () => void };
const subscriptions = new Map<string, Set<Subscription>>();
const closerKey = (teamId: string, userId: string) => `${teamId}:${userId}`;

export function subscribeTeam(teamId: string, userId: string, listener: (event: TeamMemberEvent) => void, onClose?: () => void) {
    const key = channel(teamId);
    const mapKey = closerKey(teamId, userId);
    const subscription: Subscription = { listener, onClose };
    bus.on(key, listener);
    const set = subscriptions.get(mapKey) || new Set<Subscription>();
    set.add(subscription);
    subscriptions.set(mapKey, set);
    // 退订与「被踢下线」走同一条清理路径，两边都只会执行一次。
    return () => dropSubscription(teamId, userId, subscription);
}

function dropSubscription(teamId: string, userId: string, subscription: Subscription) {
    const mapKey = closerKey(teamId, userId);
    const set = subscriptions.get(mapKey);
    if (!set?.delete(subscription)) return false;
    if (!set.size) subscriptions.delete(mapKey);
    bus.off(channel(teamId), subscription.listener);
    return true;
}

export function publishTeamMember(teamId: string, event: Omit<TeamMemberEvent, "teamId">) {
    bus.emit(channel(teamId), { ...event, teamId });
}

/**
 * 主动断开某个成员在该团队下的长连接，并同时退订他的总线 listener。
 * 移除成员只删数据库行是不够的：SSE 建好之后不重连就不会重新鉴权，
 * 被移出的人页面上会一直挂着旧角色的团队视图，直到他自己刷新。
 * 退订必须在这里一并做掉——指望调用方的断连回调里再退一次，就是指望每个路由都记得，记不住的那次就是泄漏。
 */
export function closeTeamConnectionsOf(teamId: string, userId: string) {
    const set = subscriptions.get(closerKey(teamId, userId));
    if (!set) return 0;
    let closed = 0;
    for (const subscription of [...set]) {
        dropSubscription(teamId, userId, subscription);
        closed += 1;
        // 对端可能已经断了，关不掉不该影响剩下的连接。
        try {
            subscription.onClose?.();
        } catch (error) {
            console.warn("关闭被移除成员的团队连接失败：", error);
        }
    }
    return closed;
}

/** 仅供验证脚本使用：确认退订之后总线上真的一个 listener 都不剩。 */
export function teamListenerCount(teamId: string) {
    return bus.listenerCount(channel(teamId));
}
