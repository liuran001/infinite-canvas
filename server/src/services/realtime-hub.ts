import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

const REALTIME_PATH = "/api/v1/realtime";

function reject(socket: Duplex, status: number, text: string) {
    socket.on("error", () => {}); // 客户端可能已经断开，写拒绝响应触发的 EPIPE/ECONNRESET 不能崩掉进程
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

/** 把实时协作的 WebSocket 端点挂到 HTTP server 上，走 noServer 模式自行处理 upgrade。 */
export function attachRealtime(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== REALTIME_PATH) return reject(socket, 404, "Not Found");
        const ticket = url.searchParams.get("ticket");
        if (!ticket) return reject(socket, 401, "Unauthorized");
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.on("error", () => {}); // 超大帧、非法帧这类协议错误由 ws 自己关闭连接，不能崩掉进程
            wss.emit("connection", ws, req);
        });
    });

    return wss;
}
