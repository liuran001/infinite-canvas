// 实时连接层的行为测试：用一个假的 WebSocket 与一套可手动推进的定时器，把
// `web/src/services/realtime/connection.ts` 真正跑起来。
//
// 为什么不靠正则：这个模块里最容易错的东西全是时序——「订阅被拒之后过多久重订」「哪条频道该降级」
// 「presence 被限流算不算订阅挂了」。这些性质在源码里看起来都对，只有把帧真的喂进去才知道结果。
// 而在浏览器里造这些场景要断网、要卡服务端，跑不稳；跑不稳的用例最后一定会被注释掉。
//
// 依赖只有 esbuild（web 已经装了）：连接层引用的 `@/services/api/server` 与 store 在这里换成桩，
// 被测代码本身一个字都没改。
//
// 用法：node web/realtime-behavior-check.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  \x1b[32mOK\x1b[0m   ${name}`);
        pass += 1;
    } else {
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       实际 ${JSON.stringify(actual)}\n       期望 ${JSON.stringify(expected)}`);
        fail += 1;
    }
}

/** 手动推进的定时器。退避最短 1500ms，用真实定时器跑一遍要几十秒，而且结果依赖机器负载。 */
const clock = {
    now: 0,
    seq: 0,
    timers: new Map(),
    setTimeout(fn, delay) {
        const id = ++clock.seq;
        clock.timers.set(id, { at: clock.now + (delay || 0), fn });
        return id;
    },
    clearTimeout(id) {
        clock.timers.delete(id);
    },
    setInterval(fn, delay) {
        return clock.setTimeout(fn, delay);
    },
    clearInterval(id) {
        clock.timers.delete(id);
    },
    /** 推进到某个时刻，按到期顺序执行。回调里新排的定时器如果也到期了，同一轮里一起跑掉。 */
    advance(ms) {
        const until = clock.now + ms;
        for (;;) {
            const due = [...clock.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            clock.timers.delete(due[0]);
            clock.now = Math.max(clock.now, due[1].at);
            due[1].fn();
        }
        clock.now = until;
    },
    reset() {
        clock.now = 0;
        clock.timers.clear();
    },
};

/** 假 WebSocket。只实现被测代码用到的那一面，并把每一帧原样记下来供断言。 */
class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        FakeWebSocket.instances.push(this);
    }
    send(raw) {
        this.sent.push(JSON.parse(raw));
    }
    close() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
    /* 下面几个只给用例调用，模拟服务端那一侧 */
    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }
    deliver(frame) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
    drop() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
    /** 客户端发出的 subscribe 帧，按顺序。 */
    subscribes() {
        return this.sent.filter((frame) => frame.type === "subscribe");
    }
    presences() {
        return this.sent.filter((frame) => frame.type === "presence.update");
    }
}

const stub = {
    "@/services/api/server": `
        export function serverApiUrl(path) { return "http://server.test/api" + path; }
        export function serverBaseUrl() { return globalThis.__stub.baseUrl; }
    `,
    "@/stores/use-server-store": `
        export const useServerStore = { getState: () => ({ token: globalThis.__stub.token }) };
    `,
};

const alias = {
    name: "stub-web-alias",
    setup(build) {
        build.onResolve({ filter: /^@\// }, (args) => {
            if (stub[args.path]) return { path: args.path, namespace: "stub" };
            return { path: join(here, "src", args.path.slice(2)) + ".ts" };
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stub[args.path], loader: "js" }));
    },
};

const bundle = await esbuild.build({
    entryPoints: [join(here, "src/services/realtime/connection.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    plugins: [alias],
});

globalThis.__stub = { baseUrl: "http://server.test", token: "t1" };
globalThis.WebSocket = FakeWebSocket;
globalThis.window = {
    location: { href: "http://app.test/" },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
};
// 取票是唯一的网络调用，直接给成功；票据本身的用例在 server/verify-realtime.ts 里。
// 每次取票的凭据与标记头都记下来：账号票与访客票混用是这一层最贵的错误（越权或永远 FORBIDDEN）。
const tickets = [];
globalThis.fetch = async (url, init) => {
    tickets.push({ url, headers: (init && init.headers) || {} });
    return { ok: true, json: async () => ({ data: { ticket: `ticket-${Math.random()}` } }) };
};

const source = bundle.outputFiles[0].text;
const { subscribeRealtime, resetRealtimeConnection } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

/** 起一条订阅并把连接推到 OPEN，返回这条假 socket 与记录下来的回调调用。 */
async function connectOnce(options) {
    const calls = { ready: 0, degrade: 0, recover: 0, terminal: [], events: [] };
    const subscription = subscribeRealtime({
        ...options,
        onReady: () => (calls.ready += 1),
        onDegrade: () => (calls.degrade += 1),
        onRecover: () => (calls.recover += 1),
        onTerminal: (failure) => calls.terminal.push(failure.code),
        onEvent: (event) => calls.events.push(event),
    });
    await Promise.resolve();
    await Promise.resolve();
    return { subscription, calls };
}

function currentSocket() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function reset() {
    resetRealtimeConnection();
    clock.reset();
    FakeWebSocket.instances.length = 0;
    tickets.length = 0;
    globalThis.__stub = { baseUrl: "http://server.test", token: "t1" };
}

const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

console.log("presence 上行要如实回报有没有发出去");
{
    reset();
    const { subscription } = await connectOnce({ channel: "project:p1", payload: () => ({ clientId: "c1" }) });
    const socket = currentSocket();
    socket.open();
    check("订阅还没 ready 时 presence 返回 false", subscription.presence({ clientId: "c1" }), false);
    check("没发出去的 presence 不占用帧", socket.presences().length, 0);
    socket.deliver({ v: 1, type: "ready", id: socket.subscribes()[0].id, payload: { revision: 1 } });
    check("ready 之后 presence 返回 true", subscription.presence({ clientId: "c1" }), true);
    check("ready 之后 presence 真的发了一帧", socket.presences().length, 1);
    socket.drop();
    check("连接断开后 presence 返回 false", subscription.presence({ clientId: "c1" }), false);
    subscription.close();
    check("退订之后 presence 返回 false", subscription.presence({ clientId: "c1" }), false);
}

console.log("非终态订阅错误按频道单独退避重订，不重建物理连接");
{
    reset();
    const { calls } = await connectOnce({ channel: "team:t1" });
    const socket = currentSocket();
    socket.open();
    const id = socket.subscribes()[0].id;
    socket.deliver({ v: 1, type: "error", id, payload: { code: "INTERNAL", message: "数据库超时" } });
    check("非终态错误不终止频道", calls.terminal, []);
    check("被拒之后没有立刻原样重订", socket.subscribes().length, 1);
    clock.advance(5000);
    await settle();
    check("退避之后在同一条 socket 上重订", socket.subscribes().length, 2);
    check("重订没有重建物理连接", FakeWebSocket.instances.length, 1);
    check("重订用的是同一个订阅 id", socket.subscribes()[1].id, id);
}

console.log("降级与恢复按频道各算各的");
{
    reset();
    const a = await connectOnce({ channel: "team:t1" });
    const b = await connectOnce({ channel: "jobs" });
    const socket = currentSocket();
    socket.open();
    await settle();
    const idA = socket.subscribes().find((frame) => frame.channel === "team:t1").id;
    const idB = socket.subscribes().find((frame) => frame.channel === "jobs").id;
    socket.deliver({ v: 1, type: "ready", id: idB, payload: {} });
    for (let attempt = 0; attempt < 3; attempt += 1) {
        socket.deliver({ v: 1, type: "error", id: idA, payload: { code: "INTERNAL", message: "数据库超时" } });
        clock.advance(40_000);
        await settle();
    }
    check("失败的那条频道降级了", a.calls.degrade, 1);
    check("正常的那条频道没有被拖着降级", b.calls.degrade, 0);
    check("另一条频道 ready 不会让降级的那条误以为恢复", a.calls.recover, 0);
    socket.deliver({ v: 1, type: "ready", id: idA, payload: {} });
    check("自身 ready 才算恢复", a.calls.recover, 1);
    check("没降级过的频道不会收到恢复回调", b.calls.recover, 0);
}

console.log("presence 错误与订阅错误分开");
{
    reset();
    const { subscription, calls } = await connectOnce({ channel: "project:p1", payload: () => ({ clientId: "c1" }) });
    const socket = currentSocket();
    socket.open();
    const id = socket.subscribes()[0].id;
    socket.deliver({ v: 1, type: "ready", id, payload: { revision: 1 } });
    socket.deliver({ v: 1, type: "error", id, payload: { code: "RATE_LIMITED", message: "上报过于频繁", scope: "presence" } });
    check("限流不把订阅打回未就绪", subscription.presence({ clientId: "c1" }), true);
    check("限流不触发重订", socket.subscribes().length, 1);
    check("限流不终止频道", calls.terminal, []);
    // 老服务端不带 scope，只能按错误码兜底；非法 presence 同样只是这一次上报被拒。
    socket.deliver({ v: 1, type: "error", id, payload: { code: "INVALID_NODE_IDS", message: "无效的节点列表" } });
    check("非法 presence 不终止 project 订阅", calls.terminal, []);
    check("非法 presence 之后订阅仍然就绪", subscription.presence({ clientId: "c1" }), true);
    socket.deliver({ v: 1, type: "error", id, payload: { code: "FORBIDDEN", message: "没有权限" } });
    check("真正的终态错误仍然终止频道", calls.terminal, ["FORBIDDEN"]);
}

console.log("拿不到登录态时仍然继续重连");
{
    reset();
    globalThis.__stub = { baseUrl: "", token: "" };
    const { calls } = await connectOnce({ channel: "jobs" });
    check("没有服务端地址时不会立刻降级", calls.degrade, 0);
    check("也没有建立任何连接", FakeWebSocket.instances.length, 0);
    // 退避是 1500/3000/6000...，每次只推进到刚好触发下一次尝试，才能数清是第几次失败才降级。
    clock.advance(4000);
    await settle();
    check("第二次尝试仍然不降级", calls.degrade, 0);
    clock.advance(8000);
    await settle();
    check("连续三次失败才降级", calls.degrade, 1);
    // 登录态就绪之后必须能自己接上，否则用户会一直停在降级路径直到手动刷新。
    globalThis.__stub = { baseUrl: "http://server.test", token: "t1" };
    clock.advance(40_000);
    await settle();
    check("登录态就绪后重连把连接建起来", FakeWebSocket.instances.length, 1);
    currentSocket().open();
    currentSocket().deliver({ v: 1, type: "ready", id: currentSocket().subscribes()[0].id, payload: {} });
    check("接回来之后通知恢复", calls.recover, 1);
}

console.log("断线重连用的是当下的游标");
{
    reset();
    let cursor = 0;
    const { calls } = await connectOnce({ channel: "jobs", payload: () => ({ sinceSeq: cursor }) });
    const first = currentSocket();
    first.open();
    first.deliver({ v: 1, type: "ready", id: first.subscribes()[0].id, payload: {} });
    check("首订用的是当时的游标", first.subscribes()[0].payload, { sinceSeq: 0 });
    cursor = 42;
    first.drop();
    clock.advance(40_000);
    await settle();
    const second = currentSocket();
    second.open();
    check("重连建了新连接", FakeWebSocket.instances.length, 2);
    check("重订用的是最新游标", second.subscribes()[0].payload, { sinceSeq: 42 });
    check("断线本身不算终态", calls.terminal, []);
}

console.log("服务端收回频道即终态");
{
    reset();
    const { calls } = await connectOnce({ channel: "project:p1", payload: () => ({ clientId: "c1" }) });
    const socket = currentSocket();
    socket.open();
    const id = socket.subscribes()[0].id;
    socket.deliver({ v: 1, type: "ready", id, payload: {} });
    socket.deliver({ v: 1, type: "unsubscribed", id, payload: { reason: "REVOKED" } });
    check("撤销回调带 REVOKED", calls.terminal, ["REVOKED"]);
    clock.advance(60_000);
    await settle();
    check("终态之后不再重订", socket.subscribes().length, 1);
}

console.log("账号与访客各走各的连接");
{
    reset();
    let guestToken = "g1";
    const guestScope = { kind: "guest", key: "share-abc", token: () => guestToken };
    const account = await connectOnce({ channel: "jobs" });
    const guest = await connectOnce({ channel: "project:p1", scope: guestScope, payload: () => ({ clientId: "c1" }) });
    check("两个身份各建一条 socket", FakeWebSocket.instances.length, 2);
    const accountSocket = FakeWebSocket.instances[0];
    const guestSocket = FakeWebSocket.instances[1];
    accountSocket.open();
    guestSocket.open();
    await settle();
    check(
        "账号 socket 上只有账号那条订阅",
        accountSocket.subscribes().map((frame) => frame.channel),
        ["jobs"],
    );
    check(
        "访客 socket 上只有访客那条订阅",
        guestSocket.subscribes().map((frame) => frame.channel),
        ["project:p1"],
    );
    check("账号票用账号令牌", tickets[0].headers.Authorization, "Bearer t1");
    check("账号票不带分享标记头", tickets[0].headers["X-Share-Guest"], undefined);
    check("访客票用 guest 令牌", tickets[1].headers.Authorization, "Bearer g1");
    check("访客票带分享标记头", tickets[1].headers["X-Share-Guest"], "1");

    // 一个身份的连接塌了不该动另一个身份：两条池的失败计数、重连退避都必须各归各。
    guestSocket.drop();
    await settle();
    check("访客断线不影响账号 socket", accountSocket.readyState, FakeWebSocket.OPEN);
    accountSocket.deliver({ v: 1, type: "ready", id: accountSocket.subscribes()[0].id, payload: {} });
    check("账号那条订阅照常 ready", account.calls.ready, 1);
    // guest 令牌会续期：重连必须现取，缓存住旧的那份到点后取票只会一直 401。
    guestToken = "g2";
    clock.advance(40_000);
    await settle();
    check("访客重连只重建访客那条连接", FakeWebSocket.instances.length, 3);
    check("访客重连取的是最新 guest 令牌", tickets[tickets.length - 1].headers.Authorization, "Bearer g2");

    // 访客频道被判死，不该把账号那条也带走。
    const reconnected = currentSocket();
    reconnected.open();
    reconnected.deliver({ v: 1, type: "error", id: reconnected.subscribes()[0].id, payload: { code: "FORBIDDEN", message: "没有权限" } });
    check("访客频道终态", guest.calls.terminal, ["FORBIDDEN"]);
    check("账号频道没有被牵连", account.calls.terminal, []);
    check("账号 socket 仍然开着", accountSocket.readyState, FakeWebSocket.OPEN);
}

console.log("同一条分享链接复用连接，换链接换连接");
{
    reset();
    const scopeOf = (key) => ({ kind: "guest", key, token: () => "g1" });
    await connectOnce({ channel: "project:p1", scope: scopeOf("share-abc") });
    await connectOnce({ channel: "project:p2", scope: scopeOf("share-abc") });
    check("同一条链接共用一条 socket", FakeWebSocket.instances.length, 1);
    await connectOnce({ channel: "project:p3", scope: scopeOf("share-xyz") });
    check("换一条链接另起一条 socket", FakeWebSocket.instances.length, 2);
}

reset();
console.log(`\n通过 ${pass} 条，失败 ${fail} 条`);
process.exit(fail ? 1 : 0);
