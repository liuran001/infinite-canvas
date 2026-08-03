/**
 * 浏览器侧唯一一条实时 WebSocket。
 *
 * 为什么整个应用只留一条：浏览器对同源的并发连接本来就紧张，而画布、团队、生成任务、云端 Agent
 * 四条频道的事件量都很小，各开一条连接除了多占额度、多握手四次之外没有任何好处。
 * 所以这里做成「一条 socket + 多条逻辑订阅」，订阅的生命周期与连接的生命周期彻底分开：
 * 断线时订阅不会消失，只是暂时没有底层通道；重连成功后按各自最新的游标重新订阅。
 *
 * 三条容易被写错、因此在这里集中处理的规则：
 *   1. 每次重连都要重新取票。票据是一次性的、30 秒过期，复用上一次的票只会在重连时稳定拿到 401，
 *      表现为「网络恢复了但页面永远连不上」。
 *   2. 重订阅用的是订阅方此刻的游标，而不是首次订阅时的那个。拿旧游标重订会把断线期间已经
 *      处理过的事件再放一遍，任务文本会重复、画布会白拉几次。
 *   3. 服务端明确判定为终态的订阅错误（没权限、频道不存在）只停这一条频道。整条连接跟着重连的话，
 *      另外三条正常的频道会被一条无解的订阅拖着一起反复断开。
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
 * 没权限、频道名非法、资源不存在。继续重订只是每隔几秒打一次必然失败的请求。
 *
 * 这里刻意不含 INVALID_ACTIVITY / INVALID_NODE_IDS：那两个只可能由 presence 上行触发，
 * 一次拼错的上报不该把整条画布订阅判成不可恢复。
 */
const TERMINAL_CODES = new Set(["FORBIDDEN", "INVALID_SUBSCRIPTION", "INVALID_CLIENT_ID", "PROJECT_NOT_FOUND", "TEAM_NOT_FOUND", "NOT_FOUND", "UNSUPPORTED_VERSION", "UNKNOWN_TYPE"]);

/**
 * 只可能由 presence 上行产生的错误码。新服务端会在错误帧里带 `scope: "presence"`，
 * 但握手成功的老服务端不会，所以按错误码再兜一层：把限流当成订阅失败的代价是
 * 一次高频上报就能让整条画布频道退到未就绪，然后被当作「连不上」拖去重订。
 */
const PRESENCE_CODES = new Set(["RATE_LIMITED", "INVALID_ACTIVITY", "INVALID_NODE_IDS"]);

export type RealtimeFailure = { code: string; message: string };

export type RealtimeSubscribeOptions<Event> = {
    /** 频道名，例如 `project:xxx`、`team:xxx`、`jobs`、`agent:xxx`。 */
    channel: string;
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
     * 这条频道自己有没有通知过调用方降级。刻意不做成全局：四条频道的失败原因彼此独立，
     * 用全局标志的话，一条频道 ready 就会把另一条还没接回来的频道的降级路径一起关掉。
     */
    degraded: boolean;
    /** 这条频道自己的连续订阅失败次数，决定它自己的重订退避与降级时机。 */
    failures: number;
    /** 这条频道自己的重订定时器。物理连接是好的，只有这条订阅要退避重试。 */
    retryTimer: number;
};

let socket: WebSocket | null = null;
let connecting = false;
let failures = 0;
let retryTimer = 0;
let nextId = 0;
const entries = new Map<string, Entry>();

/** WebSocket 地址由 HTTP base 推导：两者永远指向同一个后端，分开配只会多一个能配错的地方。 */
export function realtimeUrl(ticket: string) {
    const base = new URL(serverApiUrl("/v1/realtime"), window.location.href);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.search = `?ticket=${encodeURIComponent(ticket)}`;
    return base.toString();
}

/** 只有配了服务端地址、且拿得到票据的模式下才值得尝试 WebSocket。 */
export function realtimeAvailable() {
    return typeof WebSocket !== "undefined" && Boolean(serverBaseUrl()) && Boolean(useServerStore.getState().token);
}

async function fetchTicket(): Promise<string> {
    const token = useServerStore.getState().token;
    const response = await fetch(serverApiUrl("/v1/realtime/tickets"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`实时票据获取失败（HTTP ${response.status}）`);
    const body = (await response.json()) as { data?: { ticket?: string } };
    const ticket = body?.data?.ticket;
    if (!ticket) throw new Error("实时票据获取失败：服务端没有返回票据");
    return ticket;
}

function send(frame: unknown) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
}

function subscribeEntry(entry: Entry) {
    if (entry.closed || entry.ready || entry.pending) return;
    // 游标在发送的这一刻才取：这正是「重连不重放」依赖的那一步。
    const payload = entry.options.payload?.();
    if (!send(clientFrame("subscribe", entry.id, entry.options.channel, payload))) return;
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
 * 拖着整条连接重连会把另外三条正常频道一起打断，而干脆不重订则意味着这条频道要等到
 * 下一次网络抖动才有机会回来——服务端一次数据库超时就能让画布永久停更。
 */
function scheduleEntryRetry(entry: Entry) {
    if (entry.closed || entry.retryTimer) return;
    const base = RETRIES[Math.min(entry.failures, RETRIES.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    entry.retryTimer = window.setTimeout(() => {
        entry.retryTimer = 0;
        if (entry.closed) return;
        if (socket && socket.readyState === WebSocket.OPEN) subscribeEntry(entry);
        else void connect();
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

/** 连接层面的失败（握手失败、取票失败、断线）会连累所有频道，逐条按各自的计数决定要不要降级。 */
function degradeAll() {
    for (const entry of entries.values()) if (entry.failures >= FAILURES_BEFORE_DEGRADE) degradeEntry(entry);
}

function terminate(entry: Entry, failure: RealtimeFailure) {
    if (entry.closed) return;
    entry.closed = true;
    clearEntryRetry(entry);
    entries.delete(entry.id);
    entry.options.onTerminal?.(failure);
    if (!entries.size) closeSocket();
}

function handleFrame(frame: ServerFrame) {
    const entry = frame.id ? entries.get(frame.id) : undefined;
    if (!entry || entry.closed) return;
    if (frame.type === "ready") {
        entry.ready = true;
        entry.pending = false;
        entry.failures = 0;
        clearEntryRetry(entry);
        failures = 0;
        entry.options.onReady?.(frame.payload);
        recoverEntry(entry);
        return;
    }
    if (frame.type === "event") return entry.options.onEvent?.(frame.payload);
    if (frame.type === "unsubscribed") {
        // 服务端主动收回（撤销分享、移出团队）：这条频道在本次会话里不会再回来。
        return terminate(entry, { code: "REVOKED", message: "该频道已被服务端关闭" });
    }
    const payload = (frame.payload || {}) as { code?: string; message?: string; scope?: string };
    const failure = { code: String(payload.code || "INTERNAL"), message: String(payload.message || "订阅失败") };
    // presence 上行被拒只说明这一次上报没被接受：订阅还在、事件照收。
    // 按订阅失败处理的话，一次超频上报就会把 ready 抹掉，紧接着被当成「没连上」反复重订。
    if (payload.scope === "presence" || PRESENCE_CODES.has(failure.code)) return;
    entry.pending = false;
    if (TERMINAL_CODES.has(failure.code)) return terminate(entry, failure);
    // 非终态错误按这条频道自己的节奏重订：物理连接还好着，没有理由把它拖去重连，
    // 也没有理由等到下一次断线才试——那可能是几小时之后。
    entry.ready = false;
    entry.failures += 1;
    if (entry.failures >= FAILURES_BEFORE_DEGRADE) degradeEntry(entry);
    scheduleEntryRetry(entry);
}

function closeSocket() {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    const current = socket;
    socket = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    if (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING) current.close();
}

function scheduleReconnect() {
    if (retryTimer || !entries.size) return;
    const base = RETRIES[Math.min(failures, RETRIES.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        void connect();
    }, delay);
}

function onClosed() {
    socket = null;
    connecting = false;
    for (const entry of entries.values()) {
        entry.ready = false;
        entry.pending = false;
        entry.failures += 1;
        // 连接没了，单条频道的重订定时器没有意义：醒来也发不出去，反而会先于统一重连白跑一趟。
        clearEntryRetry(entry);
    }
    failures += 1;
    degradeAll();
    scheduleReconnect();
}

async function connect() {
    if (socket || connecting || !entries.size) return;
    // 没有服务端地址或没有登录态时同样按一次失败计数并继续排重连：
    // 登录态是异步就绪的，这里直接放弃的话，登录完成后没有任何东西会把连接重新拉起来，
    // 用户会一直停在降级路径上直到手动刷新。
    if (!realtimeAvailable()) {
        failures += 1;
        for (const entry of entries.values()) entry.failures += 1;
        degradeAll();
        scheduleReconnect();
        return;
    }
    connecting = true;
    let ticket: string;
    try {
        // 每次重连都重新取票：票据一次性且 30 秒过期，复用旧票在重连时必然 401。
        ticket = await fetchTicket();
    } catch {
        connecting = false;
        failures += 1;
        for (const entry of entries.values()) entry.failures += 1;
        degradeAll();
        scheduleReconnect();
        return;
    }
    if (!entries.size) {
        connecting = false;
        return;
    }
    const ws = new WebSocket(realtimeUrl(ticket));
    socket = ws;
    ws.onopen = () => {
        connecting = false;
        for (const entry of entries.values()) {
            clearEntryRetry(entry);
            subscribeEntry(entry);
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
        if (isServerFrame(parsed)) handleFrame(parsed);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
        if (socket !== ws) return;
        onClosed();
    };
}

/**
 * 订阅一条频道。返回的句柄只管这一条订阅，底层连接由本模块共享与复用。
 * 频道名非法时不建连接，直接按终态错误回调——把明显拼错的频道发给服务端只是多一次往返。
 */
export function subscribeRealtime<Event = unknown>(options: RealtimeSubscribeOptions<Event>): RealtimeSubscription {
    const id = `sub-${++nextId}`;
    const entry: Entry = { id, options: options as RealtimeSubscribeOptions<unknown>, ready: false, pending: false, closed: false, degraded: false, failures: 0, retryTimer: 0 };
    if (!REALTIME_IDENTIFIER.test(options.channel)) {
        options.onTerminal?.({ code: "INVALID_SUBSCRIPTION", message: "频道名不合法" });
        return { close: () => {}, presence: () => false };
    }
    entries.set(id, entry);
    if (socket && socket.readyState === WebSocket.OPEN) subscribeEntry(entry);
    else void connect();

    return {
        close() {
            if (entry.closed) return;
            entry.closed = true;
            clearEntryRetry(entry);
            entries.delete(id);
            if (entry.ready || entry.pending) send(clientFrame("unsubscribe", id));
            // 最后一条订阅退出就把连接收掉：空连接白占一个并发额度，还会一直被心跳唤醒。
            if (!entries.size) closeSocket();
        },
        presence(payload: unknown) {
            // 只有真的写进 socket 才算发出去。返回 false 时调用方要自己打 HTTP，
            // 否则订阅还没 ready 的这段时间里，这个人在别人的画布上是隐身的。
            if (entry.closed || !entry.ready) return false;
            return send(clientFrame("presence.update", id, undefined, payload));
        },
    };
}

/** 只给契约脚本用：把模块内的连接状态清干净，避免用例之间互相影响。 */
export function resetRealtimeConnection() {
    for (const entry of entries.values()) {
        entry.closed = true;
        clearEntryRetry(entry);
    }
    entries.clear();
    closeSocket();
    connecting = false;
    failures = 0;
}
