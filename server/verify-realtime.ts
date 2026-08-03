import "reflect-metadata";

import http from "node:http";
import { WebSocket } from "ws";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 实时协作专项验证：WebSocket upgrade 骨架的路径匹配与鉴权拒绝。
 * 用法：cd server && npx tsx verify-realtime.ts
 */
const env = prepareEnv("verify-realtime");

function connectWs(url: string) {
    return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on("open", () => resolve(socket));
        socket.on("unexpected-response", (_req, res) => {
            res.resume();
            reject(Object.assign(new Error(`ws ${res.statusCode}`), { status: res.statusCode }));
        });
        socket.on("error", (error) => reject(Object.assign(error, { status: (error as { status?: number }).status ?? 0 })));
    });
}

async function main() {
    const { check, finish } = createChecker();
    const { attachRealtime } = await import("./src/services/realtime-hub");

    const server = http.createServer((_req, res) => res.end());
    attachRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `ws://127.0.0.1:${port}`;

    console.log("WebSocket upgrade 骨架");
    const rejected: number[] = [];
    await connectWs(`${base}/api/v1/realtime-nope`).catch((error) => rejected.push(error.status));
    check("错误 WS 路径返回 404", rejected.at(-1), 404);
    await connectWs(`${base}/api/v1/realtime`).catch((error) => rejected.push(error.status));
    check("无票据返回 401", rejected.at(-1), 401);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
