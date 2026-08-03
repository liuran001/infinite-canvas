import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { config } from "../config";
import { SafeError } from "../lib/errors";
import { MAX_FRAME_BYTES, MAX_SEND_BUFFER_BYTES, MAX_SUBSCRIPTIONS, PRESENCE_MIN_INTERVAL_MS, parseClientFrame, serverFrame, type ServerFrame } from "../lib/realtime-protocol";
import { openRealtimeChannel, type RealtimeChannel } from "./realtime-channels";
import { consumeTicket, type RealtimeIdentity } from "./realtime-tickets";

const REALTIME_PATH = "/api/v1/realtime";
/** 心跳周期。反向代理常见的空闲超时是 60 秒，25 秒一轮保证两次机会。 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

function reject(socket: Duplex, status: number, text: string) {
    socket.on("error", () => {}); // 客户端可能已经断开，写拒绝响应触发的 EPIPE/ECONNRESET 不能崩掉进程
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

/**
 * Origin 白名单。没有 Origin 的一律放行：非浏览器客户端（探针、服务端转发）本来就不发这个头，
 * 而 CSRF 面向的恰恰是浏览器。浏览器发来的 Origin 必须是本服务自身地址，
 * 或者 CORS_ORIGIN 明确配置的前端域名；配成 `*` 时不把它当成允许任意来源连 WebSocket。
 */
function originAllowed(req: IncomingMessage) {
    const origin = String(req.headers.origin || "").trim();
    if (!origin) return true;
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
    const proto = String(req.headers["x-forwarded-proto"] || "").trim() || "http";
    if (host && (origin === `${proto}://${host}` || origin === `http://${host}` || origin === `https://${host}`)) return true;
    return config.corsOrigin !== "*" && origin === config.corsOrigin;
}

/**
 * 背压判定。单独导出成纯函数，验证脚本才能确定性地断言这条阈值——
 * 要在真实连接上把 4MiB 的发送缓冲攒起来，得先让对端停止读取再灌几十 MB 数据，
 * 那种用例跑不稳，而跑不稳的用例最后一定会被人注释掉。
 */
export function overBackpressureLimit(bufferedAmount: number) {
    return bufferedAmount > MAX_SEND_BUFFER_BYTES;
}

function errorFrame(id: string | undefined, channel: string | undefined, code: string, message: string) {
    return serverFrame("error", id, channel, { code, message });
}

/**
 * presence 上行失败的错误帧。带上 `scope: "presence"` 是刻意的：
 * 客户端必须能把「这一次上报没被接受」和「这条订阅失败了」分开——
 * 两者共用一种帧的话，一次超频上报就会被前端当成订阅挂了，进而把整条画布频道退到未就绪、
 * 反复重订，而它其实一直好好的。错误码本身不足以区分（INTERNAL 两边都可能出现）。
 */
function presenceErrorFrame(id: string | undefined, channel: string | undefined, code: string, message: string) {
    return serverFrame("error", id, channel, { code, message, scope: "presence" });
}

/** 未标记的错误不能把内部细节抖给客户端，但错误码要保留，前端得靠它区分「重试」和「别再连了」。 */
function failureOf(error: unknown) {
    if (error instanceof SafeError) return { code: String(error.code), message: error.message };
    console.error("realtime subscribe failed:", error);
    return { code: "INTERNAL", message: "订阅失败" };
}

/**
 * 一条物理连接的全部状态。逻辑订阅、presence 节流游标和心跳都挂在这里，
 * close 时统一清空——分散在各处的清理只要漏一条，就是一个永远不会被回收的 listener。
 */
class Connection {
    private readonly channels = new Map<string, RealtimeChannel>();
    /** 正在打开中的订阅 id。打开是异步的，不占位的话同一个 id 连发两次 subscribe 会开出两条频道。 */
    private readonly opening = new Set<string>();
    private lastPresenceAt = 0;
    private closed = false;

    constructor(private readonly socket: WebSocket, private readonly identity: RealtimeIdentity) {}

    /**
     * 发送一帧。对端不读时 `bufferedAmount` 会一路涨上去，继续攒只会把服务端内存吃光——
     * 超过上限就直接断开这条连接：慢客户端重连一次就能靠 replay 补回来，而内存吃光是全局故障。
     */
    send = (frame: ServerFrame) => {
        if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
        if (overBackpressureLimit(this.socket.bufferedAmount)) {
            console.warn("realtime: 客户端积压超限，断开连接");
            this.close();
            this.socket.terminate();
            return;
        }
        this.socket.send(JSON.stringify(frame));
    };

    private async subscribe(id: string, channel: string, payload: unknown) {
        if (this.channels.has(id) || this.opening.has(id)) return this.send(errorFrame(id, channel, "DUPLICATE_SUBSCRIPTION", "该订阅 id 已在使用"));
        if (this.channels.size + this.opening.size >= MAX_SUBSCRIPTIONS) return this.send(errorFrame(id, channel, "TOO_MANY_SUBSCRIPTIONS", `每条连接最多 ${MAX_SUBSCRIPTIONS} 个订阅`));
        this.opening.add(id);
        try {
            // 频道可能在 open 的 await 窗口里就被服务端收回（撤销分享、移出团队）。
            // 那种情况下它已经自己清理干净了，登记进订阅表只会留下一条死记录，还会把这个 id 占住。
            let selfClosed = false;
            const opened = await openRealtimeChannel({
                identity: this.identity,
                id,
                channel,
                payload,
                send: this.send,
                onClosed: (closedId) => {
                    if (closedId === id) selfClosed = true;
                    // 只删表、不回调 close：hub 主动关闭那条路径已经先删过再关，这里删不到也就不会再绕回去。
                    this.channels.delete(closedId);
                },
            });
            // 先取消占位再判：`||` 会短路，把 delete 写在条件里的话，
            // 连接已关或频道自关这两条路径上占位永远删不掉——那个订阅 id 会被一条不存在的频道永久占住，
            // 客户端拿同一个 id 重订只会一直收到「重复订阅」，而且每漏一个都在啃 32 个订阅的额度。
            const wasOpening = this.opening.delete(id);
            if (this.closed || selfClosed || !wasOpening) return opened.close();
            this.channels.set(id, opened);
        } catch (error) {
            this.opening.delete(id);
            const failure = failureOf(error);
            // 订阅失败只回一帧 error，绝不关物理连接：一条频道没权限不该把另外三条正常的频道一起打掉。
            this.send(errorFrame(id, channel, failure.code, failure.message));
        }
    }

    private unsubscribe(id: string) {
        // 打开中的订阅也要能取消：登记进 opening 之后 close 才认得它。
        this.opening.delete(id);
        const channel = this.channels.get(id);
        this.channels.delete(id);
        channel?.close();
        this.send(serverFrame("unsubscribed", id, channel?.channel, { reason: "CLIENT" }));
    }

    private presence(id: string, payload: unknown) {
        const channel = this.channels.get(id);
        if (!channel?.presence) return this.send(presenceErrorFrame(id, channel?.channel, "INVALID_SUBSCRIPTION", "该订阅不支持 presence"));
        const nowMs = Date.now();
        // 节流按连接而不是按频道：presence 是易失提示，攒着的那几十毫秒没有任何信息量，
        // 但一个循环里狂发的客户端能把所有订阅方的连接一起写爆。
        if (nowMs - this.lastPresenceAt < PRESENCE_MIN_INTERVAL_MS) return this.send(presenceErrorFrame(id, channel.channel, "RATE_LIMITED", "presence 上报过于频繁"));
        this.lastPresenceAt = nowMs;
        try {
            channel.presence(payload);
        } catch (error) {
            const failure = failureOf(error);
            this.send(presenceErrorFrame(id, channel.channel, failure.code, failure.message));
        }
    }

    handle(raw: string | Buffer | ArrayBuffer | Buffer[]) {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : raw;
        const parsed = parseClientFrame(data);
        if (!parsed.ok) return this.send(errorFrame(undefined, undefined, parsed.code, parsed.message));
        const { type, id, channel, payload } = parsed.frame;
        if (type === "subscribe") return void this.subscribe(id, channel as string, payload);
        if (type === "unsubscribe") return this.unsubscribe(id);
        return this.presence(id, payload);
    }

    /** 幂等：断连、terminate 与背压断开可能连着调好几次，每条频道只能关一次。 */
    close() {
        if (this.closed) return;
        this.closed = true;
        this.opening.clear();
        for (const channel of [...this.channels.values()]) {
            this.channels.delete(channel.id);
            try {
                channel.close();
            } catch (error) {
                console.warn("关闭实时频道失败：", error);
            }
        }
    }
}

/** 把实时协作的 WebSocket 端点挂到 HTTP server 上，走 noServer 模式自行处理 upgrade。 */
export function attachRealtime(server: Server, options: { heartbeatMs?: number } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    wss.on("connection", (socket: WebSocket, _req: IncomingMessage, identity: RealtimeIdentity) => {
        const connection = new Connection(socket, identity);
        socket.on("message", (data) => connection.handle(data as Buffer));
        socket.on("close", () => connection.close());
        // 协议层错误（超大帧、非法 opcode）由 ws 自己关闭连接，但清理仍要走同一条路径。
        socket.on("error", () => connection.close());
    });

    // 心跳周期可注入，验证脚本才能在秒级内跑完「不回 pong 就被 terminate」这条用例。
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            const client = socket as WebSocket & { __alive?: boolean };
            if (client.readyState !== WebSocket.OPEN) continue;
            // 上一轮 ping 到现在还没回 pong：对端要么死了要么卡死，继续留着它只是占内存。
            if (client.__alive === false) {
                client.terminate();
                continue;
            }
            client.__alive = false;
            client.once("pong", () => void (client.__alive = true));
            client.ping();
        }
    }, options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    wss.on("close", () => clearInterval(heartbeat));

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== REALTIME_PATH) return reject(socket, 404, "Not Found");
        // Origin 先于票据校验：跨站页面若能把别人的一次性票据消费掉，就等于零成本地把对方踢下线。
        if (!originAllowed(req)) return reject(socket, 403, "Forbidden");
        const identity = consumeTicket(url.searchParams.get("ticket") || "", Date.now());
        if (!identity) return reject(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("error", () => {}); // 超大帧、非法帧这类协议错误由 ws 自己关闭连接，不能崩掉进程
            wss.emit("connection", ws, req, identity);
        });
    });

    return wss;
}
