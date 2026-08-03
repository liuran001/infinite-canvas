/**
 * 浏览器侧的实时 WebSocket。
 *
 * 为什么一个身份只留一条：浏览器对同源的并发连接本来就紧张，而画布、团队、生成任务、云端 Agent
 * 四条频道的事件量都很小，各开一条连接除了多占额度、多握手四次之外没有任何好处。
 * 所以这里做成「一条 socket + 多条逻辑订阅」，订阅的生命周期与连接的生命周期彻底分开：
 * 断线时订阅不会消失，只是暂时没有底层通道；重连成功后按各自最新的游标重新订阅。
 *
 * 但「一条」只在同一个物理身份内成立。账号与分享访客是两个身份：票据是按取票时的
 * Authorization 签发的，一条 socket 只承载一种身份判定。分享页里常常同时存在两者
 * （已登录用户打开别人的链接），把两种身份的订阅塞进同一条连接，等于让访客频道跑在账号票上、
 * 或者反过来——前者是越权，后者是「订阅永远 FORBIDDEN」。所以连接按作用域分池，
 * 每个作用域各有自己的 socket、退避与降级状态，互不影响。
 *
 * 三条容易被写错、因此在这里集中处理的规则：
 *   1. 每次重连都要重新取票。票据是一次性的、30 秒过期，复用上一次的票只会在重连时稳定拿到 401，
 *      表现为「网络恢复了但页面永远连不上」。
 *   2. 重订阅用的是订阅方此刻的游标，而不是首次订阅时的那个。拿旧游标重订会把断线期间已经
 *      处理过的事件再放一遍，任务文本会重复、画布会白拉几次。
 *   3. 服务端明确判定为终态的订阅错误（没权限、频道不存在）只停这一条频道。整条连接跟着重连的话，
 *      同一作用域下其它正常的频道会被一条无解的订阅拖着一起反复断开。
 */

import { serverApiUrl, serverBaseUrl } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

import { clientFrame, isServerFrame, REALTIME_IDENTIFIER, type ServerFrame } from "./protocol";

/** 与既有 SSE 路径同一套退避节奏，再叠 0.8~1.2 的抖动，避免服务端重启后所有标签页同一毫秒回来。 */
const RETRIES = [1500, 3000, 6000, 12000, 24000, 30000];
/** 连续这么多次都没连上就通知各订阅方启用自己的降级路径（SSE 或轮询），但重连不停。 */
const FAILURES_BEFORE_DEGRADE = 3;

/**
 * 订阅失败后不该重试的错误码。这些码代表「换多少次连接结果都一样」：
 * 没权限、频道名非法、资源不存在，以及连接层自己判定的订阅冲突与超限。
 * 继续重订只是每隔几秒打一次必然失败的请求。
 *
 * 团队那四个码要单独列：服务端的团队守卫不发通用的 FORBIDDEN，而是发
 * TEAM_FORBIDDEN / TEAM_MEMBER_SUSPENDED / TEAM_DISABLED / TEAM_NOT_FOUND，
 * 漏掉任何一个，被移出团队或被挂起的人都会带着一条永远订不上的频道无限重连。
 * DUPLICATE_SUBSCRIPTION 与 TOO_MANY_SUBSCRIPTIONS 同理：这两条是本次连接的确定结论，
 * 原样再发一遍只会拿到同一帧 error。
 */
const TERMINAL_CODES = new Set([
    "FORBIDDEN",
    "INVALID_SUBSCRIPTION",
    "INVALID_CLIENT_ID",
    "INVALID_ACTIVITY",
    "INVALID_NODE_IDS",
    "PROJECT_NOT_FOUND",
    "TEAM_NOT_FOUND",
    "TEAM_FORBIDDEN",
    "TEAM_MEMBER_SUSPENDED",
    "TEAM_DISABLED",
    "NOT_FOUND",
    "UNSUPPORTED_VERSION",
    "UNKNOWN_TYPE",
    "DUPLICATE_SUBSCRIPTION",
    "TOO_MANY_SUBSCRIPTIONS",
]);

/**
 * 订阅所属的物理身份。
 * - `account`：账号登录态，取票用 useServerStore 里的 JWT。
 * - `guest`：分享访客，取票用调用方每次现取的 guest 令牌（它会续期，缓存下来必然过期）。
 *   `key` 用来区分不同的访客会话，换了一条分享链接就该换一条连接，而不是复用上一条的 socket。
 */
export type RealtimeScope = { kind: "account" } | { kind: "guest"; key: string; token: () => string };

const ACCOUNT: RealtimeScope = { kind: "account" };

export type RealtimeFailure = { code: string; message: string };

export type RealtimeSubscribeOptions<Event> = {
    /** 频道名，例如 `project:xxx`、`team:xxx`、`jobs`、`agent:xxx`。 */
    channel: string;
    /** 这条订阅用哪个身份连。省略即账号身份。 */
    scope?: RealtimeScope;
    /**
     * 订阅参数。每次（重）订阅都会调一次，返回的必须是调用方此刻的最新游标，
     * 而不是订阅建立时的那份快照——否则重连会重放已经处理过的事件。
     */
    payload?: () => unknown;
    /** 服务端确认订阅生效，payload 是该频道的首帧快照。 */
    onReady?: (payload: unknown) => void;
    onEvent?: (event: Event) => void;
    /** 连接连续失败到阈值：调用方该打开自己的降级路径了。 */
    onDegrade?: () => void;
    /** 订阅重新 ready：降级路径可以关掉了。 */
    onRecover?: () => void;
    /** 这条频道被判定为不可恢复（服务端撤销或终态错误），调用方不会再收到任何事件。 */
    onTerminal?: (failure: RealtimeFailure) => void;
};

export type RealtimeSubscription = {
    /** 主动退订。幂等。 */
    close: () => void;
    /** 上行 presence，只有 project 频道会被服务端接受，其余频道调用等于空操作。 */
    presence: (payload: unknown) => void;
};

type Entry = {
    id: string;
    options: RealtimeSubscribeOptions<unknown>;
    /** 服务端是否已经确认这条订阅。断线时置回 false，重连后重新发 subscribe。 */
    ready: boolean;
    /** 已经把 subscribe 发出去、还在等 ready。 */
    pending: boolean;
    closed: boolean;
};

/** 一个身份作用域的全部连接状态。作用域之间不共享任何字段——共享哪怕一个失败计数都会互相误判。 */
type Pool = {
    scope: RealtimeScope;
    socket: WebSocket | null;
    connecting: boolean;
    failures: number;
    degraded: boolean;
    retryTimer: number;
    entries: Map<string, Entry>;
};

const pools = new Map<string, Pool>();
let nextId = 0;

function scopeKey(scope: RealtimeScope) {
    return scope.kind === "guest" ? `guest:${scope.key}` : "account";
}

function poolOf(scope: RealtimeScope) {
    const key = scopeKey(scope);
    const existing = pools.get(key);
    if (existing) {
        // guest 令牌会续期：只保留最新的取票函数，旧闭包里的令牌过期后取票会一直 401。
        existing.scope = scope;
        return existing;
    }
    const pool: Pool = { scope, socket: null, connecting: false, failures: 0, degraded: false, retryTimer: 0, entries: new Map() };
    pools.set(key, pool);
    return pool;
}

/** WebSocket 地址由 HTTP base 推导：两者永远指向同一个后端，分开配只会多一个能配错的地方。 */
export function realtimeUrl(ticket: string) {
    const base = new URL(serverApiUrl("/v1/realtime"), window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.search = `?ticket=${encodeURIComponent(ticket)}`;
    return base.toString();
}

function scopeToken(scope: RealtimeScope) {
    return scope.kind === "guest" ? scope.token() : useServerStore.getState().token;
}

/** 只有配了服务端地址、且这个身份此刻拿得到凭据的情况下才值得尝试 WebSocket。 */
export function realtimeAvailable(scope: RealtimeScope = ACCOUNT) {
    return typeof WebSocket !== "undefined" && Boolean(serverBaseUrl()) && Boolean(scopeToken(scope));
}

async function fetchTicket(scope: RealtimeScope): Promise<string> {
    const token = scopeToken(scope);
    // 访客票据必须用 guest 令牌换：拿账号 token 取到的票在服务端就是账号身份，
    // 订 project 频道会去查这个账号自己的画布，结果不是越权就是永远 404。
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    // 与其它分享请求同一个标记头，方便网关按它把分享流量和账号流量分开；服务端仍只认令牌本身。
    if (scope.kind === "guest") headers["X-Share-Guest"] = "1";
    const response = await fetch(serverApiUrl("/v1/realtime/tickets"), { method: "POST", headers });
    if (!response.ok) throw new Error(`实时票据获取失败（HTTP ${response.status}）`);
    const body = (await response.json()) as { data?: { ticket?: string } };
    const ticket = body?.data?.ticket;
    if (!ticket) throw new Error("实时票据获取失败：服务端没有返回票据");
    return ticket;
}

function send(pool: Pool, frame: unknown) {
    if (!pool.socket || pool.socket.readyState !== WebSocket.OPEN) return false;
    pool.socket.send(JSON.stringify(frame));
    return true;
}

function subscribeEntry(pool: Pool, entry: Entry) {
    if (entry.closed || entry.ready || entry.pending) return;
    // 游标在发送的这一刻才取：这正是「重连不重放」依赖的那一步。
    const payload = entry.options.payload?.();
    if (!send(pool, clientFrame("subscribe", entry.id, entry.options.channel, payload))) return;
    entry.pending = true;
}

function markDegraded(pool: Pool) {
    if (pool.degraded) return;
    pool.degraded = true;
    for (const entry of pool.entries.values()) entry.options.onDegrade?.();
}

function markRecovered(pool: Pool) {
    if (!pool.degraded) return;
    pool.degraded = false;
    for (const entry of pool.entries.values()) entry.options.onRecover?.();
}

function dropPool(pool: Pool) {
    if (pool.entries.size) return;
    closeSocket(pool);
    // 空池留着只会在下次取票时用一份可能已经过期的 guest 令牌，直接丢掉更干净。
    if (pools.get(scopeKey(pool.scope)) === pool) pools.delete(scopeKey(pool.scope));
}

function terminate(pool: Pool, entry: Entry, failure: RealtimeFailure) {
    if (entry.closed) return;
    entry.closed = true;
    pool.entries.delete(entry.id);
    entry.options.onTerminal?.(failure);
    dropPool(pool);
}

function handleFrame(pool: Pool, frame: ServerFrame) {
    const entry = frame.id ? pool.entries.get(frame.id) : undefined;
    if (!entry || entry.closed) return;
    if (frame.type === "ready") {
        entry.ready = true;
        entry.pending = false;
        pool.failures = 0;
        entry.options.onReady?.(frame.payload);
        markRecovered(pool);
        return;
    }
    if (frame.type === "event") return entry.options.onEvent?.(frame.payload);
    if (frame.type === "unsubscribed") {
        // 服务端主动收回（撤销分享、移出团队）：这条频道在本次会话里不会再回来。
        return terminate(pool, entry, { code: "REVOKED", message: "该频道已被服务端关闭" });
    }
    const payload = (frame.payload || {}) as { code?: string; message?: string };
    const failure = { code: String(payload.code || "INTERNAL"), message: String(payload.message || "订阅失败") };
    entry.pending = false;
    if (TERMINAL_CODES.has(failure.code)) return terminate(pool, entry, failure);
    // 非终态错误留给下一次重连再试，不在同一条连接上立刻重订：服务端刚拒过一次，
    // 紧接着原样再发一遍多半还是同一个结果，只会把日志刷满。
    entry.ready = false;
}

function closeSocket(pool: Pool) {
    window.clearTimeout(pool.retryTimer);
    pool.retryTimer = 0;
    const current = pool.socket;
    pool.socket = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) current.close();
}

function scheduleReconnect(pool: Pool) {
    if (pool.retryTimer || !pool.entries.size) return;
    const base = RETRIES[Math.min(pool.failures, RETRIES.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    pool.retryTimer = window.setTimeout(() => {
        pool.retryTimer = 0;
        void connect(pool);
    }, delay);
}

function onClosed(pool: Pool) {
    pool.socket = null;
    pool.connecting = false;
    for (const entry of pool.entries.values()) {
        entry.ready = false;
        entry.pending = false;
    }
    pool.failures += 1;
    if (pool.failures >= FAILURES_BEFORE_DEGRADE) markDegraded(pool);
    scheduleReconnect(pool);
}

async function connect(pool: Pool) {
    if (pool.socket || pool.connecting || !pool.entries.size) return;
    if (!realtimeAvailable(pool.scope)) {
        pool.failures += 1;
        markDegraded(pool);
        return;
    }
    pool.connecting = true;
    let ticket: string;
    try {
        // 每次重连都重新取票：票据一次性且 30 秒过期，复用旧票在重连时必然 401。
        ticket = await fetchTicket(pool.scope);
    } catch {
        pool.connecting = false;
        pool.failures += 1;
        if (pool.failures >= FAILURES_BEFORE_DEGRADE) markDegraded(pool);
        scheduleReconnect(pool);
        return;
    }
    if (!pool.entries.size) {
        pool.connecting = false;
        return;
    }
    const ws = new WebSocket(realtimeUrl(ticket));
    pool.socket = ws;
    ws.onopen = () => {
        pool.connecting = false;
        for (const entry of pool.entries.values()) subscribeEntry(pool, entry);
    };
    ws.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(message.data);
        } catch {
            return;
        }
        // 坏帧只丢它自己：抛出去会被 onclose 当成断线，白白触发一次重连与退避。
        if (isServerFrame(parsed)) handleFrame(pool, parsed);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
        if (pool.socket !== ws) return;
        onClosed(pool);
    };
}

/**
 * 订阅一条频道。返回的句柄只管这一条订阅，底层连接在同一身份作用域内共享与复用。
 * 频道名非法时不建连接，直接按终态错误回调——把明显拼错的频道发给服务端只是多一次往返。
 */
export function subscribeRealtime<Event = unknown>(options: RealtimeSubscribeOptions<Event>): RealtimeSubscription {
    const id = `sub-${++nextId}`;
    const entry: Entry = { id, options: options as RealtimeSubscribeOptions<unknown>, ready: false, pending: false, closed: false };
    if (!REALTIME_IDENTIFIER.test(options.channel)) {
        options.onTerminal?.({ code: "INVALID_SUBSCRIPTION", message: "频道名不合法" });
        return { close: () => {}, presence: () => {} };
    }
    const pool = poolOf(options.scope || ACCOUNT);
    pool.entries.set(id, entry);
    if (pool.socket && pool.socket.readyState === WebSocket.OPEN) subscribeEntry(pool, entry);
    else void connect(pool);

    return {
        close() {
            if (entry.closed) return;
            entry.closed = true;
            pool.entries.delete(id);
            if (entry.ready || entry.pending) send(pool, clientFrame("unsubscribe", id));
            // 最后一条订阅退出就把连接收掉：空连接白占一个并发额度，还会一直被心跳唤醒。
            dropPool(pool);
        },
        presence(payload: unknown) {
            if (entry.closed || !entry.ready) return;
            send(pool, clientFrame("presence.update", id, undefined, payload));
        },
    };
}

/** 只给契约脚本用：把模块内的连接状态清干净，避免用例之间互相影响。 */
export function resetRealtimeConnection() {
    for (const pool of pools.values()) {
        for (const entry of pool.entries.values()) entry.closed = true;
        pool.entries.clear();
        closeSocket(pool);
        pool.connecting = false;
        pool.failures = 0;
        pool.degraded = false;
    }
    pools.clear();
}
