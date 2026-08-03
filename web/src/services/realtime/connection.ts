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
 */
const TERMINAL_CODES = new Set(["FORBIDDEN", "INVALID_SUBSCRIPTION", "INVALID_CLIENT_ID", "INVALID_ACTIVITY", "INVALID_NODE_IDS", "PROJECT_NOT_FOUND", "TEAM_NOT_FOUND", "NOT_FOUND", "UNSUPPORTED_VERSION", "UNKNOWN_TYPE"]);

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

let socket: WebSocket | null = null;
let connecting = false;
let failures = 0;
let degraded = false;
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

function markDegraded() {
    if (degraded) return;
    degraded = true;
    for (const entry of entries.values()) entry.options.onDegrade?.();
}

function markRecovered() {
    if (!degraded) return;
    degraded = false;
    for (const entry of entries.values()) entry.options.onRecover?.();
}

function terminate(entry: Entry, failure: RealtimeFailure) {
    if (entry.closed) return;
    entry.closed = true;
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
        failures = 0;
        entry.options.onReady?.(frame.payload);
        markRecovered();
        return;
    }
    if (frame.type === "event") return entry.options.onEvent?.(frame.payload);
    if (frame.type === "unsubscribed") {
        // 服务端主动收回（撤销分享、移出团队）：这条频道在本次会话里不会再回来。
        return terminate(entry, { code: "REVOKED", message: "该频道已被服务端关闭" });
    }
    const payload = (frame.payload || {}) as { code?: string; message?: string };
    const failure = { code: String(payload.code || "INTERNAL"), message: String(payload.message || "订阅失败") };
    entry.pending = false;
    if (TERMINAL_CODES.has(failure.code)) return terminate(entry, failure);
    // 非终态错误留给下一次重连再试，不在同一条连接上立刻重订：服务端刚拒过一次，
    // 紧接着原样再发一遍多半还是同一个结果，只会把日志刷满。
    entry.ready = false;
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
    }
    failures += 1;
    if (failures >= FAILURES_BEFORE_DEGRADE) markDegraded();
    scheduleReconnect();
}

async function connect() {
    if (socket || connecting || !entries.size) return;
    if (!realtimeAvailable()) {
        failures += 1;
        markDegraded();
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
        if (failures >= FAILURES_BEFORE_DEGRADE) markDegraded();
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
        for (const entry of entries.values()) subscribeEntry(entry);
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
    const entry: Entry = { id, options: options as RealtimeSubscribeOptions<unknown>, ready: false, pending: false, closed: false };
    if (!REALTIME_IDENTIFIER.test(options.channel)) {
        options.onTerminal?.({ code: "INVALID_SUBSCRIPTION", message: "频道名不合法" });
        return { close: () => {}, presence: () => {} };
    }
    entries.set(id, entry);
    if (socket && socket.readyState === WebSocket.OPEN) subscribeEntry(entry);
    else void connect();

    return {
        close() {
            if (entry.closed) return;
            entry.closed = true;
            entries.delete(id);
            if (entry.ready || entry.pending) send(clientFrame("unsubscribe", id));
            // 最后一条订阅退出就把连接收掉：空连接白占一个并发额度，还会一直被心跳唤醒。
            if (!entries.size) closeSocket();
        },
        presence(payload: unknown) {
            if (entry.closed || !entry.ready) return;
            send(clientFrame("presence.update", id, undefined, payload));
        },
    };
}

/** 只给契约脚本用：把模块内的连接状态清干净，避免用例之间互相影响。 */
export function resetRealtimeConnection() {
    for (const entry of entries.values()) entry.closed = true;
    entries.clear();
    closeSocket();
    connecting = false;
    failures = 0;
    degraded = false;
}
