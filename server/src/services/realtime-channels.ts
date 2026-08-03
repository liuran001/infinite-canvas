/**
 * 传输无关的四频道控制器。
 *
 * 这里刻意不 import 任何 `ws` 的东西：频道要做的事情——鉴权、先订阅后读快照、replay、按序 flush、
 * 撤销——和「消息是怎么送出去的」完全无关。把它和 WebSocket 绑在一起，验证一条 replay 顺序就得起一条真实连接，
 * 而时序类的缺陷恰恰是撞不出来的那种。所以频道只依赖一个 `send(frame)`。
 *
 * 四条频道与原来的四条 SSE 一一对应，业务逻辑一律复用既有服务，不在这里复制第二份：
 * - `project:<projectId>`：revision 通知 + presence，访客可订阅自己那张画布。
 * - `team:<teamId>`：绝对余额 / 角色 / 云空间快照，仅账号。
 * - `jobs`：当前用户全部任务，按每个 job 各自的 seq replay，仅账号。
 * - `agent:<sessionId>`：会话消息与状态，仅账号。
 *
 * 统一顺序：鉴权 → 先挂 listener 并缓冲 → 读 replay/快照 → 发 ready → 按到达顺序 flush。
 * 反过来「先读快照再订阅」会漏掉这段 await 窗口里发生的事件，而这些事件不会重发。
 */

import { fail, FORBIDDEN } from "../lib/errors";
import { getAgentSession, listAgentMessages, subscribeAgentSession, type AgentEvent } from "./agent";
import { listJobsSince, subscribeJobs, toJobView, type JobEvent } from "./jobs";
import { resolveProjectAccess, type AccessContext } from "./project-access";
import { listProjectPresence, removeProjectPresence, subscribeProject, updateProjectPresence, type ProjectActivity } from "./project-realtime";
import { storageOfTeam } from "./quota";
import type { RealtimeIdentity } from "./realtime-tickets";
import { serverFrame, type ServerFrame } from "../lib/realtime-protocol";
import { subscribeTeam, type TeamRealtimeEvent } from "./team-realtime";
import { requireTeamRole } from "./team-access";

export type ChannelSend = (frame: ServerFrame) => void;

/** 一条已打开的逻辑频道。`close` 必须幂等：断连、显式 unsubscribe、频道级撤销三条路径都会调它。 */
export type RealtimeChannel = {
    id: string;
    channel: string;
    close: () => void;
    /** 只有 project 频道支持 presence 上行，其它频道为 undefined。 */
    presence?: (payload: unknown) => void;
};

export type OpenChannelOptions = {
    identity: RealtimeIdentity;
    /** 客户端给这次订阅起的 id，所有回发帧都带上它，客户端才分得清哪条频道。 */
    id: string;
    channel: string;
    payload: unknown;
    send: ChannelSend;
};

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ACTIVITIES: ProjectActivity[] = ["idle", "selecting", "editing"];

function forbidden(message: string) {
    return fail(message, 403, FORBIDDEN);
}

function record(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function positiveInt(value: unknown) {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** `project:p1` → `["project", "p1"]`。资源 id 里可能还有冒号，只切第一个。 */
function splitChannel(channel: string) {
    const at = channel.indexOf(":");
    return at < 0 ? ([channel, ""] as const) : ([channel.slice(0, at), channel.slice(at + 1)] as const);
}

function accessContextOf(identity: RealtimeIdentity): AccessContext {
    if (identity.guest) return { user: null, guest: identity.guest };
    if (!identity.userId) throw forbidden("未登录或权限不足");
    return { user: { id: identity.userId, displayName: identity.displayName, avatarUrl: identity.avatarUrl }, guest: null };
}

/** 账号专属频道的守卫。访客令牌只代表「能看某一张被分享的画布」，不是一个可以订阅账号资源的身份。 */
function requireAccount(identity: RealtimeIdentity) {
    if (identity.guest || !identity.userId) throw forbidden("该频道仅账号可订阅");
    return identity.userId;
}

/**
 * 先缓冲、ready 之后再按序放行。与 SSE 侧 `createBufferedWriter` 同一套语义，
 * 但这里额外要保证 close 之后一个字节都不再发：撤销可能正好落在 flush 的循环中间。
 */
function buffered(send: ChannelSend) {
    const queue: ServerFrame[] = [];
    let open = false;
    let closed = false;
    return {
        push(frame: ServerFrame) {
            if (closed) return;
            if (open) return send(frame);
            queue.push(frame);
        },
        flush(ready: ServerFrame) {
            if (closed || open) return;
            send(ready);
            open = true;
            for (const frame of queue.splice(0)) {
                if (closed) return;
                send(frame);
            }
        },
        stop() {
            closed = true;
            queue.length = 0;
        },
    };
}

async function openProject(options: OpenChannelOptions, projectId: string): Promise<RealtimeChannel> {
    const { id, channel, identity, send } = options;
    if (!projectId) throw fail("缺少画布项目 ID", 400, "INVALID_SUBSCRIPTION");
    const input = record(options.payload);
    const clientId = String(input.clientId || "").trim();
    if (!CLIENT_ID.test(clientId)) throw fail("缺少有效的客户端标识", 400, "INVALID_CLIENT_ID");
    const sinceRevision = positiveInt(input.sinceRevision);

    const context = accessContextOf(identity);
    // 访客订阅的是所有者的频道：取访客自己的 id 只会订到一个空频道，而且永远不会报错。
    const ownerId = identity.guest?.ownerId || identity.userId;

    const stream = buffered((frame) => send(frame));
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        stream.stop();
        unsubscribe();
        removeProjectPresence(ownerId, projectId, clientId);
    };
    // 撤销分享时由 project-realtime 回调这里：只关掉这一条逻辑频道，物理连接上的其它订阅不受影响。
    const revoke = () => {
        if (released) return;
        release();
        send(serverFrame("unsubscribed", id, channel, { reason: "REVOKED" }));
    };
    const unsubscribe = subscribeProject(ownerId, projectId, (event) => stream.push(serverFrame("event", id, channel, event)), {
        shareId: identity.guest?.shareId,
        clientId,
        close: revoke,
    });

    let access;
    try {
        access = await resolveProjectAccess(context, projectId, "read");
        // 令牌里的所有者和库里对不上属于异常输入，按不存在处理，绝不改订阅频道。
        if (access.ownerId !== ownerId) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    } catch (error) {
        release();
        throw error;
    }

    if (access.project.revision > sinceRevision) {
        stream.push(serverFrame("event", id, channel, { type: "project.saved", projectId, revision: access.project.revision, writerClientId: "" }));
    }
    stream.flush(serverFrame("ready", id, channel, { revision: access.project.revision, role: access.role, members: listProjectPresence(ownerId, projectId) }));

    return {
        id,
        channel,
        close: release,
        presence(payload: unknown) {
            if (released) return;
            const body = record(payload);
            const activity = String(body.activity || "idle") as ProjectActivity;
            if (!ACTIVITIES.includes(activity)) throw fail("无效的协作状态", 400, "INVALID_ACTIVITY");
            const nodeIds = body.nodeIds;
            if (!Array.isArray(nodeIds) || nodeIds.some((node: unknown) => typeof node !== "string" || !node || node.length > 128)) throw fail("无效的节点列表", 400, "INVALID_NODE_IDS");
            updateProjectPresence(ownerId, projectId, access.actor, { clientId, nodeIds: nodeIds as string[], activity });
        },
    };
}

async function openTeam(options: OpenChannelOptions, teamId: string): Promise<RealtimeChannel> {
    const { id, channel, identity, send } = options;
    if (!teamId) throw fail("缺少团队 ID", 400, "INVALID_SUBSCRIPTION");
    const userId = requireAccount(identity);

    const stream = buffered((frame) => send(frame));
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        stream.stop();
        unsubscribe();
    };
    const revoke = () => {
        if (released) return;
        release();
        send(serverFrame("unsubscribed", id, channel, { reason: "REVOKED" }));
    };
    const unsubscribe = subscribeTeam(teamId, userId, (event: TeamRealtimeEvent) => stream.push(serverFrame("event", id, channel, event)), revoke);

    let team;
    let role;
    let storage;
    try {
        ({ team, role } = await requireTeamRole(userId, teamId, "team.read"));
        storage = await storageOfTeam(teamId);
    } catch (error) {
        release();
        throw error;
    }
    // ready 带绝对余额与云空间：断线重连必然丢事件，只发增量的话界面上的数字会永久偏掉。
    stream.flush(serverFrame("ready", id, channel, { teamId, role, credits: team.credits, storage: { used: storage.used, quota: storage.quota } }));

    return { id, channel, close: release };
}

async function openJobs(options: OpenChannelOptions): Promise<RealtimeChannel> {
    const { id, channel, identity, send } = options;
    const userId = requireAccount(identity);
    const sinceSeq = positiveInt(record(options.payload).sinceSeq);

    let released = false;
    const emit = (event: unknown) => send(serverFrame("event", id, channel, event));
    // 这条频道已经推过的文本字符数，按任务分开记。事件带完整文本，这里只推没推过的尾巴；
    // 任务重跑导致文本变短时把游标归零整段重发。
    const sent = new Map<string, number>();
    const pushText = (jobId: string, text: string) => {
        const previous = sent.get(jobId) ?? 0;
        const offset = previous > text.length ? 0 : previous;
        if (text.length === offset) return;
        emit({ type: "text", id: jobId, offset, text: text.slice(offset) });
        sent.set(jobId, text.length);
    };
    const deliver = (event: JobEvent) => {
        if (released) return;
        if (event.type === "text") return pushText(event.id, event.text);
        // 文本任务的终态快照里带着最终文本，先补文本再推状态，客户端拿到终态时内容一定是完整的。
        if (event.job.kind === "text") pushText(event.job.id, event.job.text);
        emit(event);
    };

    const queue: JobEvent[] = [];
    let replaying = true;
    const unsubscribe = subscribeJobs(userId, (event) => {
        if (released) return;
        if (replaying) queue.push(event);
        else deliver(event);
    });
    const release = () => {
        if (released) return;
        released = true;
        queue.length = 0;
        unsubscribe();
    };

    const replayed = new Map<string, number>();
    let maxSeq = sinceSeq;
    try {
        for (const row of await listJobsSince(userId, sinceSeq)) {
            replayed.set(row.id, row.seq);
            maxSeq = Math.max(maxSeq, row.seq);
            deliver({ type: "job", seq: row.seq, job: await toJobView(row) });
        }
    } catch (error) {
        release();
        throw error;
    }
    send(serverFrame("ready", id, channel, { seq: maxSeq }));
    replaying = false;
    // 攒下的事件按任务逐个去重，只丢掉「快照已经比它新」的那些。
    // 不能用全局 maxSeq 一刀切：补齐读到的是各任务各自的快照，别的任务序号更大不代表这条已被覆盖。
    for (const event of queue.splice(0)) {
        if (event.type === "job" && (replayed.get(event.job.id) ?? 0) >= event.seq) continue;
        deliver(event);
    }

    return { id, channel, close: release };
}

async function openAgent(options: OpenChannelOptions, sessionId: string): Promise<RealtimeChannel> {
    const { id, channel, identity, send } = options;
    if (!sessionId) throw fail("缺少会话 ID", 400, "INVALID_SUBSCRIPTION");
    const userId = requireAccount(identity);
    const sinceSeq = positiveInt(record(options.payload).sinceSeq);

    const stream = buffered((frame) => send(frame));
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        stream.stop();
        unsubscribe();
    };
    const unsubscribe = subscribeAgentSession(userId, sessionId, (event: AgentEvent) => stream.push(serverFrame("event", id, channel, event)));

    let session;
    let history;
    try {
        session = await getAgentSession(userId, sessionId);
        history = await listAgentMessages(userId, sessionId, sinceSeq);
    } catch (error) {
        release();
        throw error;
    }
    for (const message of history) stream.push(serverFrame("event", id, channel, { type: "message", message }));
    // 首帧带上标题与待确认请求：刷新或换设备重连时，靠这一帧就能把「正在等你确认」原样恢复出来。
    stream.push(serverFrame("event", id, channel, { type: "status", status: session.status, error: session.error, title: session.title, pendingAction: session.pendingAction }));
    stream.flush(serverFrame("ready", id, channel, { sessionId, status: session.status }));

    return { id, channel, close: release };
}

/**
 * 打开一条逻辑频道。抛错即订阅失败，调用方负责把它翻成一帧 `error`——
 * 频道自己不发 error，是因为「订阅失败」的错误码格式属于连接层协议，不该在四个分支里各写一遍。
 */
export function openRealtimeChannel(options: OpenChannelOptions): Promise<RealtimeChannel> {
    const [kind, resource] = splitChannel(options.channel);
    if (kind === "project") return openProject(options, resource);
    if (kind === "team") return openTeam(options, resource);
    if (kind === "jobs" && !resource) return openJobs(options);
    if (kind === "agent") return openAgent(options, resource);
    return Promise.reject(fail("未知的频道", 400, "INVALID_SUBSCRIPTION"));
}
