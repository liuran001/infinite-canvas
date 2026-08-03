import "reflect-metadata";

import http from "node:http";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 实时协作专项验证：WebSocket upgrade 骨架的路径匹配、一次性 ticket、Origin 校验、
 * 拒绝响应格式与帧大小限制。
 * 用法：cd server && npx tsx verify-realtime.ts
 */
const env = prepareEnv("verify-realtime");

type Handshake = "open" | { status: number; length: string | null };

function connectWs(url: string, origin?: string) {
    return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, origin ? { origin } : {});
        socket.on("open", () => resolve(socket));
        socket.on("unexpected-response", (_req, res) => {
            res.resume();
            reject(Object.assign(new Error(`ws ${res.statusCode}`), { status: res.statusCode, length: res.headers["content-length"] ?? null }));
        });
        socket.on("error", (error) => reject(error));
    });
}

/** 每个连接单独返回自己的握手结果，避免多个连接共用一份状态导致断言互相污染。 */
async function handshake(url: string, origin?: string): Promise<Handshake> {
    try {
        const socket = await connectWs(url, origin);
        socket.close();
        return "open";
    } catch (error) {
        const failure = error as { status?: number; length?: string | null };
        return { status: failure.status ?? 0, length: failure.length ?? null };
    }
}

async function main() {
    const { check, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { Project, ProjectShare, User } = await import("./src/db/entities");
    const { attachRealtime } = await import("./src/services/realtime-hub");
    const protocol = await import("./src/lib/realtime-protocol");
    const { consumeTicket, issueTicket, resetRealtimeTickets } = await import("./src/services/realtime-tickets");
    const { createApp } = await import("./src/app");
    const { createShare, guestSessionOf, signGuestToken } = await import("./src/services/project-share");
    const { newSession } = await import("./src/services/auth");
    const { now } = await import("./src/lib/errors");

    await initDatabase();

    console.log("一次性 ticket");
    const identity = { userId: "u1", displayName: "用户", avatarUrl: "", guest: null };
    const nowMs = Date.now();
    const ticket = issueTicket(identity, nowMs);
    check("ticket 首次消费成功", consumeTicket(ticket, nowMs)?.userId, "u1");
    check("ticket 不可重放", consumeTicket(ticket, nowMs), null);
    check("伪造 ticket 被拒", consumeTicket("forged", nowMs), null);
    check("过期 ticket 被拒", consumeTicket(issueTicket(identity, nowMs - 30_001), nowMs), null);
    check("刚好没到期的 ticket 仍可用", consumeTicket(issueTicket(identity, nowMs - 29_000), nowMs)?.userId, "u1");
    check("空 ticket 被拒", consumeTicket("", nowMs), null);
    resetRealtimeTickets();

    const server = http.createServer(createApp());
    attachRealtime(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `ws://127.0.0.1:${port}`;
    const origin = `http://127.0.0.1:${port}`;
    const freshTicket = () => issueTicket(identity, Date.now());

    console.log("WebSocket upgrade 骨架");
    check("错误 WS 路径返回 404", await handshake(`${base}/api/v1/realtime-nope?ticket=${freshTicket()}`), { status: 404, length: "0" });
    check("无票据返回 401", await handshake(`${base}/api/v1/realtime`), { status: 401, length: "0" });
    check("伪造票据返回 401", await handshake(`${base}/api/v1/realtime?ticket=forged`), { status: 401, length: "0" });
    check("正确 Origin + 票据握手成功", await handshake(`${base}/api/v1/realtime?ticket=${freshTicket()}`, origin), "open");
    const replayed = freshTicket();
    check("票据首次 upgrade 成功", await handshake(`${base}/api/v1/realtime?ticket=${replayed}`, origin), "open");
    check("同一票据第二次 upgrade 返回 401", await handshake(`${base}/api/v1/realtime?ticket=${replayed}`, origin), { status: 401, length: "0" });

    console.log("Origin 校验");
    const rejected = freshTicket();
    check("不允许的 Origin 返回 403", await handshake(`${base}/api/v1/realtime?ticket=${rejected}`, "http://evil.example.com"), { status: 403, length: "0" });
    // Origin 先于票据校验：跨站页面不能拿着别人的票据把它消费掉，否则等于给了一个零成本的拒绝服务手段。
    check("被 Origin 拒掉时票据没有被消费掉", await handshake(`${base}/api/v1/realtime?ticket=${rejected}`, origin), "open");
    check("没有 Origin 的非浏览器客户端放行", await handshake(`${base}/api/v1/realtime?ticket=${freshTicket()}`), "open");

    console.log("取票接口");
    const users = repo(User);
    await users.insert({ id: "owner-1", username: "owner-1", password: "", email: "", displayName: "画布主", avatarUrl: "", role: "user", credits: 0, storageQuota: 1 << 20, affCode: "owner-1", affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const { token: accountToken } = await newSession(await users.findOneByOrFail({ id: "owner-1" }));
    await repo(Project).insert({ userId: "owner-1", projectId: "p1", title: "画布", data: "{}", revision: 1, deleted: false, createdAt: now(), updatedAt: now() });
    const { share } = await createShare("owner-1", "p1", { role: "editor", allowAnonymous: true, allowClone: false, expiresAt: "" });
    const guestToken = signGuestToken(guestSessionOf(await repo(ProjectShare).findOneByOrFail({ id: share.id }), { accountId: "", actorId: "", displayName: "", avatarUrl: "" }));
    const postTicket = async (headers: Record<string, string>) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/realtime/tickets`, { method: "POST", headers });
        return { status: res.status, body: (await res.json()) as { code: number; data: { ticket?: string; expiresInMs?: number } | null } };
    };
    const account = await postTicket({ Authorization: `Bearer ${accountToken}` });
    check("账号取票成功", [account.status, account.body.code, account.body.data?.expiresInMs], [200, 0, 30_000]);
    check("账号票据能完成 upgrade", await handshake(`${base}/api/v1/realtime?ticket=${account.body.data?.ticket}`, origin), "open");
    const guest = await postTicket({ Authorization: `Bearer ${guestToken}` });
    check("访客取票成功", [guest.status, guest.body.code, guest.body.data?.expiresInMs], [200, 0, 30_000]);
    check("访客票据能完成 upgrade", await handshake(`${base}/api/v1/realtime?ticket=${guest.body.data?.ticket}`, origin), "open");
    check("两次取票不会拿到同一串", account.body.data?.ticket === guest.body.data?.ticket, false);
    const anonymous = await postTicket({});
    // 只断言 HTTP 401 与空 data：错误码是稳定标识，不该在这里把 envelope 的 code 值写死。
    check("未登录取票被 401 拒绝", [anonymous.status, anonymous.body.data], [401, null]);

    console.log("拒绝路径的健壮性");
    const dead = new Duplex({ read() {}, write: (_chunk, _encoding, callback) => callback() });
    server.emit("upgrade", { url: "/api/v1/realtime", headers: {} } as unknown as http.IncomingMessage, dead, Buffer.alloc(0));
    check("拒绝裸 socket 前挂上 error 监听", dead.listenerCount("error"), 1);
    dead.emit("error", new Error("ECONNRESET")); // 没有 error 监听器时 Node 会直接抛出，进程崩掉
    check("拒绝后 socket 报错不崩进程", dead.destroyed, true);

    console.log("帧大小限制");
    const live = await connectWs(`${base}/api/v1/realtime?ticket=${freshTicket()}`, origin);
    live.send(Buffer.alloc(64 * 1024));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    check("64KiB 整帧不触发关闭", live.readyState, WebSocket.OPEN);
    const closed = new Promise<number>((resolve) => {
        live.on("close", (code) => resolve(code));
        setTimeout(() => resolve(0), 3000).unref();
    });
    live.send(Buffer.alloc(64 * 1024 + 1));
    check("超过 64KiB 的帧被 1009 关闭", await closed, 1009);

    console.log("协议帧解析");
    const { MAX_FRAME_BYTES, MAX_SEND_BUFFER_BYTES, MAX_SUBSCRIPTIONS, PRESENCE_MIN_INTERVAL_MS, parseClientFrame } = protocol;
    const parse = (raw: string | Buffer) => parseClientFrame(raw);
    const failureOf = (raw: string | Buffer) => {
        const result = parse(raw);
        return result.ok ? "解析成功" : result.code;
    };
    const frame = (extra: Record<string, unknown>) => JSON.stringify({ v: 1, ...extra });

    check("硬限制取自协议模块", [MAX_FRAME_BYTES, MAX_SUBSCRIPTIONS, MAX_SEND_BUFFER_BYTES, PRESENCE_MIN_INTERVAL_MS], [65_536, 32, 4_194_304, 200]);

    check("非法 JSON 被拒", failureOf("{not json"), "INVALID_FRAME");
    check("空帧被拒", failureOf(""), "INVALID_FRAME");
    check("顶层数组被拒", failureOf("[]"), "INVALID_FRAME");
    check("顶层 null 被拒", failureOf("null"), "INVALID_FRAME");
    check("顶层字符串被拒", failureOf('"subscribe"'), "INVALID_FRAME");
    // 版本先于 type 判定：老客户端发来的未知 type 应报「版本不支持」，否则升级提示会指错方向。
    check("v 缺失被拒", failureOf(JSON.stringify({ type: "subscribe", id: "s1", channel: "project:p1" })), "UNSUPPORTED_VERSION");
    check("v=2 被拒", failureOf(JSON.stringify({ v: 2, type: "subscribe", id: "s1", channel: "project:p1" })), "UNSUPPORTED_VERSION");
    check('v="1" 字符串被拒', failureOf(JSON.stringify({ v: "1", type: "subscribe", id: "s1", channel: "project:p1" })), "UNSUPPORTED_VERSION");
    check("未知 type 被拒", failureOf(frame({ type: "shutdown", id: "s1" })), "UNKNOWN_TYPE");
    check("服务端 type 不能由客户端发来", failureOf(frame({ type: "event", id: "s1", channel: "project:p1" })), "UNKNOWN_TYPE");
    check("type 非字符串被拒", failureOf(frame({ type: 1, id: "s1" })), "UNKNOWN_TYPE");
    check("缺 id 被拒", failureOf(frame({ type: "subscribe", channel: "project:p1" })), "INVALID_SUBSCRIPTION");
    check("id 非字符串被拒", failureOf(frame({ type: "subscribe", id: 1, channel: "project:p1" })), "INVALID_SUBSCRIPTION");
    check("id 含非法字符被拒", failureOf(frame({ type: "subscribe", id: "s 1", channel: "project:p1" })), "INVALID_SUBSCRIPTION");
    check("超长 id 被拒", failureOf(frame({ type: "subscribe", id: "s".repeat(129), channel: "project:p1" })), "INVALID_SUBSCRIPTION");
    check("subscribe 缺 channel 被拒", failureOf(frame({ type: "subscribe", id: "s1" })), "INVALID_SUBSCRIPTION");
    check("channel 含非法字符被拒", failureOf(frame({ type: "subscribe", id: "s1", channel: "project/p1" })), "INVALID_SUBSCRIPTION");
    check("超长 channel 被拒", failureOf(frame({ type: "subscribe", id: "s1", channel: "c".repeat(129) })), "INVALID_SUBSCRIPTION");
    check("presence.update 缺 id 被拒", failureOf(frame({ type: "presence.update", payload: {} })), "INVALID_SUBSCRIPTION");
    check("unsubscribe 缺 id 被拒", failureOf(frame({ type: "unsubscribe" })), "INVALID_SUBSCRIPTION");

    // 大小按 UTF-8 字节数而不是字符串长度：一个中文字符 3 字节，按 length 判会放进三倍大的帧。
    const padding = (bytes: number) => "x".repeat(bytes);
    const overhead = frame({ type: "presence.update", id: "s1", payload: { note: "" } }).length;
    check("恰好 64KiB 的帧被接受", parse(frame({ type: "presence.update", id: "s1", payload: { note: padding(MAX_FRAME_BYTES - overhead) } })).ok, true);
    check("超过 64KiB 的帧被拒", failureOf(frame({ type: "presence.update", id: "s1", payload: { note: padding(MAX_FRAME_BYTES - overhead + 1) } })), "FRAME_TOO_LARGE");
    const wide = JSON.stringify({ v: 1, type: "presence.update", id: "s1", payload: { note: "中".repeat(30_000) } });
    check("多字节帧按字节数而不是字符数判定", [wide.length <= MAX_FRAME_BYTES, failureOf(wide)], [true, "FRAME_TOO_LARGE"]);
    check("Buffer 入参同样受大小限制", failureOf(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x20)), "FRAME_TOO_LARGE");
    // 超大帧不能先 JSON.parse 再判长度：那样一个 100MB 的帧已经把内存吃掉了才被拒。
    check("超大帧先于 JSON 解析被拒", failureOf("{not json".padEnd(MAX_FRAME_BYTES + 1, " ")), "FRAME_TOO_LARGE");

    check("嵌套过深的 payload 被拒", failureOf(frame({ type: "presence.update", id: "s1", payload: JSON.parse("[".repeat(40) + "1" + "]".repeat(40)) })), "INVALID_FRAME");
    check("__proto__ 键被拒", failureOf('{"v":1,"type":"presence.update","id":"s1","payload":{"__proto__":{"admin":true}}}'), "INVALID_FRAME");
    check("constructor 键被拒", failureOf('{"v":1,"type":"presence.update","id":"s1","payload":{"constructor":{"x":1}}}'), "INVALID_FRAME");
    check("原型没有被污染", ({} as Record<string, unknown>).admin, undefined);

    const subscribed = parse(frame({ type: "subscribe", id: "sub-1", channel: "project:p1", payload: { sinceRevision: 7 } }));
    check("合法 subscribe 解析出字段", subscribed.ok && [subscribed.frame.type, subscribed.frame.id, subscribed.frame.channel, subscribed.frame.payload], ["subscribe", "sub-1", "project:p1", { sinceRevision: 7 }]);
    const unsubscribed2 = parse(frame({ type: "unsubscribe", id: "sub-1" }));
    check("合法 unsubscribe 解析出字段", unsubscribed2.ok && [unsubscribed2.frame.type, unsubscribed2.frame.id], ["unsubscribe", "sub-1"]);
    const presence = parse(frame({ type: "presence.update", id: "sub-1", payload: { clientId: "c1", nodes: ["n1"], active: true } }));
    check("合法 presence.update 解析出字段", presence.ok && [presence.frame.type, presence.frame.id, presence.frame.payload], ["presence.update", "sub-1", { clientId: "c1", nodes: ["n1"], active: true }]);
    check("unsubscribe 不要求 channel", unsubscribed2.ok, true);
    check("缺省 payload 解析为 undefined", unsubscribed2.ok && "payload" in unsubscribed2.frame && unsubscribed2.frame.payload === undefined, true);

    live.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
