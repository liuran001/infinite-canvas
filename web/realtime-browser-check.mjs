// 同源部署下的实时链路端到端验证：真浏览器 + 反向代理 + 真后端。
//
// 为什么单独有这个脚本：生产是 nginx 伺服 dist、把 /api 连同 Upgrade 一起反代到后端，前端与 API 同源；
// 本地开发却是 3000/8080 两个源。同源这一路上前端的服务端地址是空字符串，而恰恰是这个取值上
// 出过两次线上事故——一次是「空地址被当成没连服务端，于是永远不取票、永远只走 SSE」，
// 一次是「刚新建、还没落库的画布订阅被回 PROJECT_NOT_FOUND，前端当成画布已删除把人踢回列表」。
// 两者类型检查、构建、单元桩都拦不住：桩里的地址永远非空，而画布在桩里永远已经存在。
//
// 用法：
//   1. 起后端（示例）：
//      cd server && PORT=18080 ADMIN_USERNAME=admin ADMIN_PASSWORD=verify-pass JWT_SECRET=verify-secret \
//        STORAGE_DRIVER=sqlite DATABASE_DSN=/tmp/ws-verify/test.db DATA_DIR=/tmp/ws-verify/data npx tsx src/index.ts
//   2. 构建前端：cd web && npm run build
//   3. 跑本脚本：cd web && node realtime-browser-check.mjs
// 端口用 WS_API / WS_PORT 覆盖，WS_HEADED=1 开有头浏览器。
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "dist");
const PORT = Number(process.env.WS_PORT || 13000);
const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.WS_API || 18080) };
const WEB = `http://127.0.0.1:${PORT}`;
const HEADED = process.env.WS_HEADED === "1";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
    console.log(ok ? `  \x1b[32mOK\x1b[0m   ${name}` : `  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ""}`);
    ok ? (pass += 1) : (fail += 1);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

/** 等价于 nginx.conf 里那段 /api 反代：转发请求，并在客户端真的发起 Upgrade 时把握手原样透传。 */
function startGateway() {
    const server = createServer((req, res) => {
        if (!req.url.startsWith("/api")) return serveStatic(req, res);
        const upstream = httpRequest({ ...UPSTREAM, path: req.url, method: req.method, headers: req.headers }, (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            upstreamRes.pipe(res);
        });
        upstream.on("error", () => res.writeHead(502).end("bad gateway"));
        req.pipe(upstream);
    });
    server.on("upgrade", (req, socket, head) => {
        const upstream = connect(UPSTREAM.port, UPSTREAM.host, () => {
            const headers = Object.entries(req.headers)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`)
                .join("");
            upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n`);
            if (head?.length) upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
    });
    return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

async function serveStatic(req, res) {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    for (const candidate of [join(DIST, safe), join(DIST, "index.html")]) {
        try {
            const body = await readFile(candidate);
            return res.writeHead(200, { "Content-Type": TYPES[extname(candidate)] || "application/octet-stream" }).end(body);
        } catch {
            /* 落到下一个候选：SPA 路由一律回 index.html */
        }
    }
    res.writeHead(404).end("not found");
}

const gateway = await startGateway();
const browser = await chromium.launch({ headless: !HEADED });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

// 三类证据分开记：取票是「前端有没有决定走 WebSocket」，握手是「反代有没有放行」，帧是「协议有没有跑通」。
const tickets = [];
const sockets = [];
const sse = [];
const errors = [];
page.on("response", (response) => {
    if (response.url().includes("/v1/realtime/tickets")) tickets.push(response.status());
    if (/\/projects\/[^/]+\/realtime/.test(response.url())) sse.push(response.url());
});
page.on("websocket", (ws) => {
    const record = { url: ws.url(), frames: [], closed: false };
    sockets.push(record);
    ws.on("framereceived", (frame) => record.frames.push(String(frame.payload).slice(0, 300)));
    ws.on("close", () => (record.closed = true));
});
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));

console.log("同源部署下的实时连接");
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.getByText("还没有账号？立即注册").first().click();
await page.getByPlaceholder("用户名").fill(`wsverify${Date.now().toString(36)}`);
await page.getByPlaceholder("密码").fill("wsverify-pass");
await page.getByRole("button", { name: "注册并登录" }).click();
await page.waitForTimeout(3000);

check("注册后拿到登录态", await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem("infinite-canvas:server_store") || "{}")?.state?.token)));
const storedBase = await page.evaluate(() => JSON.parse(localStorage.getItem("infinite-canvas:server_store") || "{}")?.state?.baseUrl);
check("同源部署的服务端地址确实是空串", storedBase === "", `实际 ${JSON.stringify(storedBase)}`);

// 新建画布：它在首次保存落库之前服务端还不认识，历史上正是这一段把用户踢回过列表页。
await page.goto(`${WEB}/canvas`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByRole("button", { name: "新建画布" }).first().click();
await page.waitForTimeout(9000);

check("新建的画布没有被当成已删除踢回列表", /\/canvas\/.+/.test(page.url()), `当前地址 ${page.url()}`);
check("前端发起了取票请求", tickets.length > 0, `取票请求 ${tickets.length} 条`);
check("取票成功", tickets.length > 0 && tickets.every((status) => status === 200), JSON.stringify(tickets));
check("建立了 WebSocket", sockets.length > 0);
check("WebSocket 走同源地址", sockets.length > 0 && sockets.every((socket) => socket.url.startsWith(`ws://127.0.0.1:${PORT}/api/v1/realtime?ticket=`)), sockets.map((socket) => socket.url).join("\n       "));
const ready = sockets.flatMap((socket) => socket.frames).filter((frame) => frame.includes('"ready"'));
check("画布频道收到 ready", ready.length > 0, ready.slice(0, 2).join("\n       "));
check("订阅没有被服务端拒绝", sockets.flatMap((socket) => socket.frames).some((frame) => frame.includes('"ready"')) && !sockets.flatMap((socket) => socket.frames).some((frame) => frame.includes("PROJECT_NOT_FOUND")), sockets.flatMap((socket) => socket.frames).filter((frame) => frame.includes("error")).join("\n       "));
check("没有回落到 SSE", sse.length === 0, sse.join("\n       "));
check("没有页面运行时报错", errors.length === 0, errors.join("\n       "));

if (HEADED) {
    console.log("\n有头模式：浏览器保持打开 300 秒，可自行操作。");
    await page.waitForTimeout(300000);
}

await browser.close();
gateway.close();
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
