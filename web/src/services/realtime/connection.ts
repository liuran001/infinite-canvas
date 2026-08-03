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
 * 每个作用域各有自己的 socket、退避与重连状态，互不影响。
 *
 * 五条容易被写错、因此在这里集中处理的规则：
 *   1. 每次重连都要重新取票。票据是一次性的、30 秒过期，复用上一次的票只会在重连时稳定拿到 401，
 *      表现为「网络恢复了但页面永远连不上」。
 *   2. 重订阅用的是订阅方此刻的游标，而不是首次订阅时的那个。拿旧游标重订会把断线期间已经
 *      处理过的事件再放一遍，任务文本会重复、画布会白拉几次。
 *   3. 服务端明确判定为终态的订阅错误（没权限、频道不存在）只停这一条频道。整条连接跟着重连的话，
 *      同一作用域下其它正常的频道会被一条无解的订阅拖着一起反复断开。
 *   4. 降级与恢复一律按逻辑频道算，不按物理连接算。四条频道的失败原因彼此独立（一条被限流、
 *      一条数据库超时），拿「另一条频道 ready 了」当作自己恢复的信号，会把还没接回来的那条频道的
 *      降级路径提前关掉，于是它既收不到推送、也不再轮询，界面从此停在旧值上。
 *   5. presence 上行的错误和订阅错误必须分开。服务端在 presence 相关的 error 帧上带 `scope: "presence"`：
 *      限流、非法节点列表都只说明这一次上报没被接受，订阅本身还活着——把它当订阅失败处理的话，
 *      一次手抖的高频上报就能把整条画布频道打成未就绪，甚至按终态码直接终止掉。
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
 *
 * 这里刻意不含 INVALID_ACTIVITY / INVALID_NODE_IDS：那两个只可能由 presence 上行触发，
 * 一次拼错的上报不该把整条画布订阅判成不可恢复，它们归 PRESENCE_CODES 管。
 */
const TERMINAL_CODES = new Set([
    "FORBIDDEN",
    "INVALID_SUBSCRIPTION",
    "INVALID_CLIENT_ID",
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
 * 只可能由 presence 上行产生的错误码。新服务端会在错误帧里带 `scope: "presence"`，
 * 但握手成功的老服务端不会，所以按错误码再兜一层：把限流当成订阅失败的代价是
 * 一次高频上报就能让整条画布频道退到未就绪，然后被当作「连不上」拖去重订。
 */
const PRESENCE_CODES = new Set(["RATE_LIMITED", "INVALID_ACTIVITY", "INVALID_NODE_IDS"]);

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
    /**
     * 上行 presence，只有 project 频道会被服务端接受，其余频道调用等于空操作。
     * 返回这一帧是不是真的写进了 socket：返回 false 时调用方必须走自己的 HTTP 回落，
     * 否则「WebSocket 还在、但这条频道没 ready」的那段时间里，别人完全看不到这个人。
     */
    presence: (payload: unknown) => boolean;
};

type Entry = {
    id: string;
    options: RealtimeSubscribeOptions<unknown>;
    /** 服务端是否已经确认这条订阅。断线时置回 false，重连后重新发 subscribe。 */
    ready: boolean;
    /** 已经把 subscribe 发出去、还在等 ready。 */
    pending: boolean;
    closed: boolean;
    /**
     * 这条频道自己有没有通知过调用方降级。刻意不做成池级：同一条 socket 上的几条频道失败原因
     * 彼此独立，用池级标志的话，一条频道 ready 就会把另一条还没接回来的频道的降级路径一起关掉。
     */
    degraded: boolean;
    /** 这条频道自己的连续失败次数，决定它自己的重订退避与降级时机。 */
    failures: number;
    /** 这条频道自己的重订定时器。物理连接是好的，只有这条订阅要退避重试。 */
    retryTimer: number;
};

/** 一个身份作用域的全部连接状态。作用域之间不共享任何字段——共享哪怕一个失败计数都会互相误判。 */
type Pool = {
    scope: RealtimeScope;
    socket: WebSocket | null;
    connecting: boolean;
    /** 这个作用域的物理连接连续失败次数，只决定重连退避。降级是按 entry 算的。 */
    failures: number;
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
    const pool: Pool = { scope, socket: null, connecting: false, failures: 0, retryTimer: 0, entries: new Map() };
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

/** 清掉这条频道自己的重订定时器。频道关闭、连接断开、重订成功三条路径都要走它。 */
function clearEntryRetry(entry: Entry) {
    if (!entry.retryTimer) return;
    window.clearTimeout(entry.retryTimer);
    entry.retryTimer = 0;
}

/**
 * 单条频道的重订退避。物理连接是好的、只有这一条订阅被拒时用它：
 * 拖着整条连接重连会把同一作用域下其它正常频道一起打断，而干脆不重订则意味着这条频道要等到
 * 下一次网络抖动才有机会回来——服务端一次数据库超时就能让画布永久停更。
 */
function scheduleEntryRetry(pool: Pool, entry: Entry) {
    if (entry.closed || entry.retryTimer) return;
    const base = RETRIES[Math.min(entry.failures, RETRIES.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    entry.retryTimer = window.setTimeout(() => {
        entry.retryTimer = 0;
        if (entry.closed) return;
        if (pool.socket && pool.socket.readyState === WebSocket.OPEN) subscribeEntry(pool, entry);
        else void connect(pool);
    }, delay);
}

/** 只让这一条频道降级。别的频道可能好好的，通知它们一起降级等于白多几份轮询。 */
function degradeEntry(entry: Entry) {
    if (entry.closed || entry.degraded) return;
    entry.degraded = true;
    entry.options.onDegrade?.();
}

/** 只让这一条频道恢复。自身 ready 才算恢复——别的频道 ready 说明不了这条已经接回来。 */
function recoverEntry(entry: Entry) {
    if (!entry.degraded) return;
    entry.degraded = false;
    entry.options.onRecover?.();
}

/** 连接层面的失败（握手失败、取票失败、断线）会连累这个作用域的所有频道，逐条按各自的计数决定降级。 */
function degradeAll(pool: Pool) {
    for (const entry of pool.entries.values()) if (entry.failures >= FAILURES_BEFORE_DEGRADE) degradeEntry(entry);
}

/** 连接层失败：这个作用域里每条频道都记一次，池自己也记一次（用于重连退避）。 */
function countConnectionFailure(pool: Pool) {
    pool.failures += 1;
    for (const entry of pool.entries.values()) entry.failures += 1;
    degradeAll(pool);
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
    clearEntryRetry(entry);
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
        entry.failures = 0;
        clearEntryRetry(entry);
        pool.failures = 0;
        entry.options.onReady?.(frame.payload);
        recoverEntry(entry);
        return;
    }
    if (frame.type === "event") return entry.options.onEvent?.(frame.payload);
    if (frame.type === "unsubscribed") {
        // 服务端主动收回（撤销分享、移出团队）：这条频道在本次会话里不会再回来。
        return terminate(pool, entry, { code: "REVOKED", message: "该频道已被服务端关闭" });
    }
    const payload = (frame.payload || {}) as { code?: string; message?: string; scope?: string };
    const failure = { code: String(payload.code || "INTERNAL"), message: String(payload.message || "订阅失败") };
    // presence 上行被拒只说明这一次上报没被接受：订阅还在、事件照收。
    // 按订阅失败处理的话，一次超频上报就会把 ready 抹掉，紧接着被当成「没连上」反复重订。
    if (payload.scope === "presence" || PRESENCE_CODES.has(failure.code)) return;
    entry.pending = false;
    if (TERMINAL_CODES.has(failure.code)) return terminate(pool, entry, failure);
    // 非终态错误按这条频道自己的节奏重订：物理连接还好着，没有理由把它拖去重连，
    // 也没有理由等到下一次断线才试——那可能是几小时之后。
    entry.ready = false;
    entry.failures += 1;
    if (entry.failures >= FAILURES_BEFORE_DEGRADE) degradeEntry(entry);
    scheduleEntryRetry(pool, entry);
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
        entry.failures += 1;
        // 连接没了，单条频道的重订定时器没有意义：醒来也发不出去，反而会先于统一重连白跑一趟。
        clearEntryRetry(entry);
    }
    pool.failures += 1;
    degradeAll(pool);
    scheduleReconnect(pool);
}

async function connect(pool: Pool) {
    if (pool.socket || pool.connecting || !pool.entries.size) return;
    // 没有服务端地址或这个身份还没拿到凭据时同样按一次失败计数并继续排重连：
    // 登录态与 guest 令牌都是异步就绪的，这里直接放弃的话，凭据到手后没有任何东西会把连接重新拉起来，
    // 用户会一直停在降级路径上直到手动刷新。
    if (!realtimeAvailable(pool.scope)) {
        countConnectionFailure(pool);
        scheduleReconnect(pool);
        return;
    }
    pool.connecting = true;
    let ticket: string;
    try {
        // 每次重连都重新取票：票据一次性且 30 秒过期，复用旧票在重连时必然 401。
        ticket = await fetchTicket(pool.scope);
    } catch {
        pool.connecting = false;
        countConnectionFailure(pool);
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
        for (const entry of pool.entries.values()) {
            clearEntryRetry(entry);
            subscribeEntry(pool, entry);
        }
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
    const entry: Entry = { id, options: options as RealtimeSubscribeOptions<unknown>, ready: false, pending: false, closed: false, degraded: false, failures: 0, retryTimer: 0 };
    if (!REALTIME_IDENTIFIER.test(options.channel)) {
        options.onTerminal?.({ code: "INVALID_SUBSCRIPTION", message: "频道名不合法" });
        return { close: () => {}, presence: () => false };
    }
    const pool = poolOf(options.scope || ACCOUNT);
    pool.entries.set(id, entry);
    if (pool.socket && pool.socket.readyState === WebSocket.OPEN) subscribeEntry(pool, entry);
    else void connect(pool);

    return {
        close() {
            if (entry.closed) return;
            entry.closed = true;
            clearEntryRetry(entry);
            pool.entries.delete(id);
            if (entry.ready || entry.pending) send(pool, clientFrame("unsubscribe", id));
            // 最后一条订阅退出就把连接收掉：空连接白占一个并发额度，还会一直被心跳唤醒。
            dropPool(pool);
        },
        presence(payload: unknown) {
            // 只有真的写进 socket 才算发出去。返回 false 时调用方要自己打 HTTP，
            // 否则订阅还没 ready 的这段时间里，这个人在别人的画布上是隐身的。
            if (entry.closed || !entry.ready) return false;
            return send(pool, clientFrame("presence.update", id, undefined, payload));
        },
    };
}

/** 只给契约脚本用：把模块内的连接状态清干净，避免用例之间互相影响。 */
export function resetRealtimeConnection() {
    for (const pool of pools.values()) {
        for (const entry of pool.entries.values()) {
            entry.closed = true;
            clearEntryRetry(entry);
        }
        pool.entries.clear();
        closeSocket(pool);
        pool.connecting = false;
        pool.failures = 0;
    }
    pools.clear();
}
