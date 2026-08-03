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
    const wss = attachRealtime(server);
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

    console.log("真实连接上的频道多路复用");
    const { publishProjectSaved, listProjectPresence } = await import("./src/services/project-realtime");
    const { publishTeamCredits, teamListenerCount } = await import("./src/services/team-realtime");
    const { Team, TeamMember } = await import("./src/db/entities");
    const { MAX_SUBSCRIPTIONS: maxSubs } = protocol;

    const teamId = "team-rt-1";
    await repo(Team).insert({ id: teamId, name: "实时团队", description: "", avatarUrl: "", ownerId: "owner-1", credits: 100, storageQuota: 1 << 20, memberLimit: 0, status: "active", createdAt: now(), updatedAt: now() });
    await repo(TeamMember).insert({ teamId, userId: "owner-1", role: "owner", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });

    const ownerIdentity = { userId: "owner-1", displayName: "画布主", avatarUrl: "", guest: null };
    /** 一条真实连接，帧按到达顺序全存下来：断言顺序（先 ready 后 event）正是这里要看的东西。 */
    async function openClient(identity: { userId: string; displayName: string; avatarUrl: string; guest: unknown }) {
        const socket = await connectWs(`${base}/api/v1/realtime?ticket=${issueTicket(identity as never, Date.now())}`, origin);
        const frames: Array<{ type: string; id?: string; channel?: string; payload?: Record<string, unknown> }> = [];
        socket.on("message", (data) => frames.push(JSON.parse(String(data))));
        const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify({ v: 1, ...frame }));
        /** 等一帧。轮询而不是一次性 await 某个事件：一次交互可能先来 event 再来 ready，等错帧就会永久挂住。 */
        const wait = async (id: string, type: string, timeoutMs = 3000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const hit = frames.find((frame) => frame.id === id && frame.type === type);
                if (hit) return hit;
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            return null;
        };
        /** 等一个任意条件成立。撤销后重订这类用例要数「第几帧」，按 id+type 取第一帧是不够的。 */
        const until = async (predicate: () => boolean, timeoutMs = 3000) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline && !predicate()) await new Promise<void>((resolve) => setTimeout(resolve, 10));
            return predicate();
        };
        return { socket, frames, send, wait, until };
    }

    const client = await openClient(ownerIdentity);
    // sinceRevision 给到当前值：不然 ready 之前还会补一帧「你落后了」的 project.saved，
    // 那一帧是对的，但会把下面这条断言指到错误的帧上。补齐本身由 sinceRevision=0 的分支覆盖。
    client.send({ type: "subscribe", id: "p", channel: "project:p1", payload: { clientId: "ws-client-1", sinceRevision: 1 } });
    client.send({ type: "subscribe", id: "t", channel: `team:${teamId}`, payload: {} });
    client.send({ type: "subscribe", id: "j", channel: "jobs", payload: { sinceSeq: 0 } });
    const projectReady = await client.wait("p", "ready");
    const teamReady = await client.wait("t", "ready");
    const jobsReady = await client.wait("j", "ready");
    check("project 频道 ready 带 revision", projectReady?.payload?.revision, 1);
    check("project 频道 ready 带角色", projectReady?.payload?.role, "owner");
    check("team 频道 ready 带绝对余额", teamReady?.payload?.credits, 100);
    check("team 频道 ready 带云空间用量", (teamReady?.payload?.storage as { used: number } | undefined)?.used, 0);
    check("jobs 频道 ready 带 seq", jobsReady?.payload?.seq, 0);
    check("三条频道复用同一条 socket", client.socket.readyState, WebSocket.OPEN);

    publishProjectSaved("owner-1", "p1", 2, "remote-client");
    const saved = await client.wait("p", "event");
    check("project 事件按订阅 id 回发", [saved?.channel, (saved?.payload as { type: string; revision: number } | undefined)?.revision], ["project:p1", 2]);
    publishTeamCredits(teamId, 42);
    const creditsEvent = await client.wait("t", "event");
    check("team 余额事件带绝对值", (creditsEvent?.payload as { credits: number } | undefined)?.credits, 42);

    client.send({ type: "presence.update", id: "p", payload: { clientId: "ws-client-1", nodeIds: ["n1"], activity: "editing" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    check("presence 上行写进项目 presence", listProjectPresence("owner-1", "p1").map((member) => member.activity), ["editing"]);
    client.send({ type: "presence.update", id: "p", payload: { clientId: "ws-client-1", nodeIds: [], activity: "idle" } });
    const limited = await client.wait("p", "error");
    check("200ms 内重复 presence 被限流", (limited?.payload as { code: string } | undefined)?.code, "RATE_LIMITED");

    console.log("订阅错误与上限不影响物理连接");
    client.send({ type: "subscribe", id: "bad", channel: "team:team-not-mine", payload: {} });
    const denied = await client.wait("bad", "error");
    check("订不到别人的团队", (denied?.payload as { code: string } | undefined)?.code, "TEAM_NOT_FOUND");
    check("订阅失败不关物理连接", client.socket.readyState, WebSocket.OPEN);

    for (let index = 0; index < maxSubs; index += 1) client.send({ type: "subscribe", id: `extra-${index}`, channel: "jobs", payload: {} });
    const overflow = await client.wait(`extra-${maxSubs - 1}`, "error");
    check("超过订阅上限被拒", (overflow?.payload as { code: string } | undefined)?.code, "TOO_MANY_SUBSCRIPTIONS");
    check("超上限后连接仍然开着", client.socket.readyState, WebSocket.OPEN);

    console.log("退订与断连清理");
    client.send({ type: "unsubscribe", id: "t" });
    await client.wait("t", "unsubscribed");
    check("退订后团队总线上不留 listener", teamListenerCount(teamId), 0);
    const closedClient = new Promise<void>((resolve) => client.socket.on("close", () => resolve()));
    client.socket.close();
    await closedClient;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    check("断连清空该连接的 presence", listProjectPresence("owner-1", "p1"), []);

    console.log("访客频道隔离");
    const guestTicketIdentity = { userId: "", displayName: "访客", avatarUrl: "", guest: guestSessionOf(await repo(ProjectShare).findOneByOrFail({ id: share.id }), { accountId: "", actorId: "guest-1", displayName: "访客", avatarUrl: "" }) };
    const guestClient = await openClient(guestTicketIdentity as never);
    guestClient.send({ type: "subscribe", id: "gp", channel: "project:p1", payload: { clientId: "guest-client-1" } });
    guestClient.send({ type: "subscribe", id: "gt", channel: `team:${teamId}`, payload: {} });
    guestClient.send({ type: "subscribe", id: "gj", channel: "jobs", payload: {} });
    guestClient.send({ type: "subscribe", id: "ga", channel: "agent:s1", payload: {} });
    check("访客可以订阅被分享的画布", (await guestClient.wait("gp", "ready"))?.payload?.role, "editor");
    // 游标落后时 ready 之前补一帧当前 revision：不补的话刚连上的客户端要一直等到下一次别人保存才知道自己是旧的。
    check("落后游标会补一帧当前 revision", (await guestClient.wait("gp", "event"))?.payload, { type: "project.saved", projectId: "p1", revision: 1, writerClientId: "" });
    const guestCodes = await Promise.all(["gt", "gj", "ga"].map(async (id) => ((await guestClient.wait(id, "error"))?.payload as { code: string } | undefined)?.code));
    check("访客订不到 team/jobs/agent", guestCodes, ["FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]);
    guestClient.socket.terminate();

    console.log("jobs 补齐与 ready 的顺序");
    const { Job } = await import("./src/db/entities");
    const runningJobId = "job-rt-1";
    await repo(Job).insert({
        id: runningJobId,
        userId: "owner-1",
        clientJobId: "rt-1",
        kind: "image",
        status: "running",
        model: "mock-image",
        prompt: "",
        params: "{}",
        inputFileIds: [],
        outputFileIds: [],
        text: "",
        context: {},
        error: "",
        credits: 0,
        progress: 0,
        seq: 3,
        upstreamTaskId: "",
        payerKind: "user",
        payerTeamId: "",
        payerLogId: "",
        storageTeamId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: "",
    });
    const jobsClient = await openClient(ownerIdentity);
    jobsClient.send({ type: "subscribe", id: "jr", channel: "jobs", payload: { sinceSeq: 0 } });
    await jobsClient.until(() => jobsClient.frames.some((frame) => frame.id === "jr" && frame.type === "event"));
    const readyAt = jobsClient.frames.findIndex((frame) => frame.id === "jr" && frame.type === "ready");
    const replayAt = jobsClient.frames.findIndex((frame) => frame.id === "jr" && frame.type === "event");
    check("jobs 补齐带回运行中的任务", (jobsClient.frames[replayAt]?.payload as { job?: { id: string } } | undefined)?.job?.id, runningJobId);
    check("jobs ready 带上补齐后的最大 seq", jobsClient.frames[readyAt]?.payload?.seq, 3);
    // ready 必须排在补齐事件之前：反过来的话客户端会先收到一批比自己游标新的任务，
    // 再收到「你的游标是多少」，中途断开就会把一个还没生效的游标当成已经追平。
    check("jobs ready 排在补齐事件之前", [readyAt >= 0, replayAt > readyAt], [true, true]);
    jobsClient.socket.terminate();

    console.log("频道级撤销后同一订阅 id 可以重订");
    const { disconnectShare } = await import("./src/services/project-realtime");
    const revokedClient = await openClient(guestTicketIdentity as never);
    revokedClient.send({ type: "subscribe", id: "rp", channel: "project:p1", payload: { clientId: "revoked-client-1" } });
    await revokedClient.wait("rp", "ready");
    check("撤销关掉了这条逻辑频道", disconnectShare("owner-1", "p1", share.id) >= 1, true);
    const revokedFrame = await revokedClient.wait("rp", "unsubscribed");
    check("撤销回发 REVOKED", (revokedFrame?.payload as { reason: string } | undefined)?.reason, "REVOKED");
    // 撤销不关物理连接，但连接层的订阅表必须同步清掉：留着的话这个 id 会被一条死记录永久占住。
    check("撤销后物理连接仍然开着", revokedClient.socket.readyState, WebSocket.OPEN);
    revokedClient.send({ type: "subscribe", id: "rp", channel: "project:p1", payload: { clientId: "revoked-client-2" } });
    const reSubscribed = await revokedClient.until(() => revokedClient.frames.filter((frame) => frame.id === "rp" && frame.type === "ready").length === 2);
    check("撤销后同一个订阅 id 能重新订上", reSubscribed, true);
    check("重订没有被判成重复订阅", revokedClient.frames.filter((frame) => frame.id === "rp" && frame.type === "error").length, 0);
    revokedClient.socket.terminate();

    server.closeAllConnections();
    // 心跳定时器挂在 wss 上，server.close() 不会带上它；不显式关掉，脚本跑完会一直挂着不退出。
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
