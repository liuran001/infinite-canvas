import "reflect-metadata";

import http from "node:http";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 实时协作专项验证：WebSocket upgrade 骨架的路径匹配、鉴权拒绝、拒绝响应格式与帧大小限制。
 * 用法：cd server && npx tsx verify-realtime.ts
 */
const env = prepareEnv("verify-realtime");

type Handshake = "open" | { status: number; length: string | null };

function connectWs(url: string) {
    return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.on("open", () => resolve(socket));
        socket.on("unexpected-response", (_req, res) => {
            res.resume();
            reject(Object.assign(new Error(`ws ${res.statusCode}`), { status: res.statusCode, length: res.headers["content-length"] ?? null }));
        });
        socket.on("error", (error) => reject(error));
    });
}

/** 每个连接单独返回自己的握手结果，避免多个连接共用一份状态导致断言互相污染。 */
async function handshake(url: string): Promise<Handshake> {
    try {
        const socket = await connectWs(url);
        socket.close();
        return "open";
    } catch (error) {
        const failure = error as { status?: number; length?: string | null };
        return { status: failure.status ?? 0, length: failure.length ?? null };
    }
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
    check("错误 WS 路径返回 404", await handshake(`${base}/api/v1/realtime-nope`), { status: 404, length: "0" });
    check("无票据返回 401", await handshake(`${base}/api/v1/realtime`), { status: 401, length: "0" });
    check("带票据握手成功", await handshake(`${base}/api/v1/realtime?ticket=x`), "open");

    console.log("拒绝路径的健壮性");
    const dead = new Duplex({ read() {}, write: (_chunk, _encoding, callback) => callback() });
    server.emit("upgrade", { url: "/api/v1/realtime" } as unknown as http.IncomingMessage, dead, Buffer.alloc(0));
    check("拒绝裸 socket 前挂上 error 监听", dead.listenerCount("error"), 1);
    dead.emit("error", new Error("ECONNRESET")); // 没有 error 监听器时 Node 会直接抛出，进程崩掉
    check("拒绝后 socket 报错不崩进程", dead.destroyed, true);

    console.log("帧大小限制");
    const live = await connectWs(`${base}/api/v1/realtime?ticket=x`);
    live.send(Buffer.alloc(64 * 1024));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    check("64KiB 整帧不触发关闭", live.readyState, WebSocket.OPEN);
    const closed = new Promise<number>((resolve) => {
        live.on("close", (code) => resolve(code));
        setTimeout(() => resolve(0), 3000).unref();
    });
    live.send(Buffer.alloc(64 * 1024 + 1));
    check("超过 64KiB 的帧被 1009 关闭", await closed, 1009);

    live.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
