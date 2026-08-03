import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import { config } from "../config";
import { consumeTicket } from "./realtime-tickets";

const REALTIME_PATH = "/api/v1/realtime";

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

/** 把实时协作的 WebSocket 端点挂到 HTTP server 上，走 noServer 模式自行处理 upgrade。 */
export function attachRealtime(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
