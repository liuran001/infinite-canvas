// 实时 WebSocket 的前后端契约检查：跑那些「类型检查过得去、构建也过得去、但线上会错」的约定。
//
// 这里查的三类东西各有理由：
//   1. 协议常量与字段。前后端各有一份 protocol，任何一处改了字段名，表现都是「连上了但订阅永远 ready 不了」，
//      比编译错误难查得多，只有把两份文件对着读一遍才能提前发现。
//   2. 连接层的源码属性。「每次重连都重新取票」「重订阅取的是最新游标」「终态错误只停单条频道」
//      这三条要在浏览器里造出网络中断才测得到，落到源码正则上是唯一划算的做法。
//   3. 降级路径仍然存在。WebSocket 在很多反代后面根本起不来，SSE 与轮询是唯一的兜底，
//      被顺手删掉的话线上表现是「部分用户的余额、任务永远不动」，而 CI 全绿。
//
// 用法：node web/realtime-contract-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "src");
const server = join(here, "..", "server", "src");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
    if (ok) {
        console.log(`  \x1b[32mOK\x1b[0m   ${name}`);
        pass += 1;
    } else {
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ""}`);
        fail += 1;
    }
}
const read = (path) => readFileSync(path, "utf8");

const clientProtocol = read(join(web, "services/realtime/protocol.ts"));
const serverProtocol = read(join(server, "lib/realtime-protocol.ts"));
const connection = read(join(web, "services/realtime/connection.ts"));
const hub = read(join(server, "services/realtime-hub.ts"));
const channels = read(join(server, "services/realtime-channels.ts"));
const ticketsRoute = read(join(server, "routes/realtime.ts"));
const projectRealtime = read(join(web, "services/project-realtime.ts"));
const teamRealtime = read(join(web, "services/team-realtime.ts"));
const jobStream = read(join(web, "services/api/job-stream.ts"));
const cloudAgent = read(join(web, "stores/use-cloud-agent-store.ts"));
const nginx = read(join(here, "..", "nginx.conf"));

console.log("协议常量两侧一致");
for (const constant of ["MAX_FRAME_BYTES", "MAX_SUBSCRIPTIONS", "MAX_SEND_BUFFER_BYTES", "PRESENCE_MIN_INTERVAL_MS"]) {
    const value = (source) => (source.match(new RegExp(`${constant}\\s*=\\s*([^;]+);`)) || [])[1]?.trim();
    check(`${constant} 相同`, value(clientProtocol) === value(serverProtocol), `web=${value(clientProtocol)} server=${value(serverProtocol)}`);
}

console.log("帧类型与错误码两侧一致");
const frameTypes = (source) => (source.match(/CLIENT_FRAME_TYPES = \[([^\]]+)\]/) || [])[1]?.replace(/\s/g, "");
check("客户端帧 type 白名单相同", frameTypes(clientProtocol) === frameTypes(serverProtocol), `web=${frameTypes(clientProtocol)} server=${frameTypes(serverProtocol)}`);
const errorCodes = (source) => (source.match(/ProtocolErrorCode = ([^;]+);/) || [])[1]?.replace(/\s/g, "");
check("协议错误码相同", errorCodes(clientProtocol) === errorCodes(serverProtocol), `web=${errorCodes(clientProtocol)} server=${errorCodes(serverProtocol)}`);
const serverTypes = (source) => (source.match(/ServerFrameType = ([^;]+);/) || [])[1]?.replace(/\s/g, "");
check("服务端帧 type 相同", serverTypes(clientProtocol) === serverTypes(serverProtocol), `web=${serverTypes(clientProtocol)} server=${serverTypes(serverProtocol)}`);

console.log("端点与握手");
// 前端从 serverApiUrl("/v1/realtime") 推导 ws 地址，服务端只在这个 path 上接受 upgrade，两者必须逐字相同。
const serverPath = (hub.match(/REALTIME_PATH = "([^"]+)"/) || [])[1];
check("服务端只在 /api/v1/realtime 接受 upgrade", serverPath === "/api/v1/realtime", `实际 ${serverPath}`);
check("前端由同一路径推导 ws 地址", /serverApiUrl\("\/v1\/realtime"\)/.test(connection));
check("前端按 http/https 推导 ws/wss", /protocol === "https:" \? "wss:" : "ws:"/.test(connection));
check("票据只走 query，不进请求头", /ticket=\$\{encodeURIComponent\(ticket\)\}/.test(connection) && /searchParams\.get\("ticket"\)/.test(hub));
check("取票端点与服务端路由一致", /serverApiUrl\("\/v1\/realtime\/tickets"\)/.test(connection) && /"\/v1\/realtime\/tickets"/.test(ticketsRoute));

console.log("重连与订阅");
// 票据一次性且 30 秒过期：复用旧票在重连时必然 401，而且是「网好了却连不上」这种最难查的形态。
check("每次重连都重新取票", /connect\(\)[\s\S]{0,600}?await fetchTicket\(\)/.test(connection));
// 重订阅必须取调用方此刻的游标，取首次订阅时的快照会把断线期间处理过的事件再放一遍。
check("订阅参数是每次求值的函数", /payload\?: \(\) => unknown/.test(clientProtocol) === false && /payload\?\.\(\)/.test(connection));
for (const [name, source] of [
    ["画布", projectRealtime],
    ["生成任务", jobStream],
    ["云端 Agent", cloudAgent],
]) {
    check(`${name}订阅传的是 payload 函数`, /payload: \(\) =>/.test(source));
}
const backoff = (connection.match(/RETRIES = \[([^\]]+)\]/) || [])[1]?.replace(/\s/g, "");
check("退避序列为 1500..30000", backoff === "1500,3000,6000,12000,24000,30000", `实际 ${backoff}`);
check("退避带 0.8~1.2 抖动", /0\.8 \+ Math\.random\(\) \* 0\.4/.test(connection));
check("连续 3 次失败通知降级", /FAILURES_BEFORE_DEGRADE = 3/.test(connection));
check("ready 之后通知恢复", /recoverEntry\(entry\)/.test(connection));
// 降级与恢复必须按逻辑频道算：全局标志会让一条频道 ready 就把另一条还没接回来的频道的降级路径关掉。
check("降级按频道各算各的", /entry\.degraded/.test(connection) && /^let degraded/m.test(connection) === false);
check("非终态订阅错误按频道退避重订", /scheduleEntryRetry\(entry\)/.test(connection));
check("realtimeAvailable 为假时仍然排重连", /realtimeAvailable\(\)\)\s*\{[\s\S]{0,400}?scheduleReconnect\(\)/.test(connection));
// presence 上行被拒只说明这一次上报没被接受，按订阅失败处理会把整条画布频道打成未就绪。
check("presence 错误与订阅错误分开", /scope === "presence"/.test(connection) && /scope: "presence"/.test(hub));
check("presence 发送结果如实返回", /presence: \(payload: unknown\) => boolean/.test(connection));
// 终态错误若把整条连接拖去重连，另外三条正常频道会被一条无解的订阅反复打断。
check("终态错误只停单条频道", /TERMINAL_CODES\.has\(failure\.code\)\) return terminate\(entry, failure\)/.test(connection));
check("服务端 unsubscribed 被当成频道终态", /frame\.type === "unsubscribed"/.test(connection));

console.log("频道名与服务端分派一致");
for (const [name, pattern, source] of [
    ["project", /channel: `project:\$\{projectId\}`/, projectRealtime],
    ["team", /channel: `team:\$\{teamId\}`/, teamRealtime],
    ["jobs", /channel: "jobs"/, jobStream],
    ["agent", /channel: `agent:\$\{sessionId\}`/, cloudAgent],
]) {
    check(`${name} 频道名前端正确`, pattern.test(source));
    check(`${name} 频道服务端可分派`, new RegExp(`kind === "${name}"`).test(channels));
}

console.log("降级路径仍然存在");
check("画布保留 SSE 降级", /serverProjectStream\(/.test(projectRealtime) && /watchProjectViaSse/.test(projectRealtime));
check("团队保留 SSE 与轮询降级", /decodeSseFrames\(/.test(teamRealtime) && /POLL_INTERVAL = 30_000/.test(teamRealtime));
// 服务端总线是进程内 EventEmitter，多实例下推送本来就不完整，健康时也要低频纠偏。
check("团队在 WebSocket 健康时仍纠偏", /CORRECTION_INTERVAL/.test(teamRealtime));
check("生成任务保留 SSE 与 5 秒轮询", /serverJobStream\(/.test(jobStream) && /FALLBACK_POLL_MS = 5000/.test(jobStream));
check("云端 Agent 保留 SSE 降级", /serverAgentStream\(/.test(cloudAgent) && /attachViaSse/.test(cloudAgent));
// presence 走 WebSocket 上行，但没发出去时必须补一次 HTTP，否则别人根本看不到这个人。
check("presence 优先 WebSocket 且保留 HTTP", /realtimePresence\.get\(projectId\)\?\.presence\(/.test(projectRealtime) && /updateProjectPresence\(/.test(projectRealtime));
// 去抖间隔必须严格大于服务端的最小上报间隔，取等会被限流悄悄丢掉。
check("presence 去抖大于服务端限流阈值", /PRESENCE_DEBOUNCE_MS = PRESENCE_MIN_INTERVAL_MS \+ \d+/.test(projectRealtime));
// 降级流的 abort 监听只能挂一次：挂在 start 里的话每降级一轮就往整页生命周期的 signal 上堆一个闭包。
check("画布降级 abort 监听只注册一次", /startFallback = \(\) => \{[^}]*\}/.test(projectRealtime) && /signal\.addEventListener\("abort", \(\) => fallback\?\.abort\(\)/.test(projectRealtime) === false);
check("团队降级 abort 监听只注册一次", /signal\.addEventListener\("abort", \(\) => sse\?\.abort\(\)/.test(teamRealtime) === false);
// ready 排在补齐之前，没有名单就只能把每个等待中的任务都补查一次 HTTP。
check("jobs ready 带上本轮补齐的任务名单", /jobIds: \[\.\.\.replayed\.keys\(\)\]/.test(channels) && /event\.jobIds/.test(jobStream));
check("Agent 恢复后停掉 SSE", /onRecover: \(\) => \{[\s\S]{0,300}?streamAbort\?\.abort\(\)/.test(cloudAgent));
// 传输切换时同一个 clientId 会短暂由两条通道上报，无差别删除会让人在别人画布上凭空消失。
check("presence 删除按来源判定", /source\?: string/.test(read(join(server, "services/project-realtime.ts"))) && /PRESENCE_SOURCE_HTTP/.test(read(join(server, "routes/sync.ts"))));

console.log("反代放行 WebSocket");
check("nginx 有 connection_upgrade map", /map \$http_upgrade \$connection_upgrade/.test(nginx));
check("nginx 转发 Upgrade 头", /proxy_set_header Upgrade \$http_upgrade;/.test(nginx));
check("nginx 转发 Connection 头", /proxy_set_header Connection \$connection_upgrade;/.test(nginx));
// 空 Upgrade 时必须是 close：写死 upgrade 会让每个普通接口请求都带上升级意图。
check("空 Upgrade 映射为 close", /""\s+close;/.test(nginx));

console.log(`\n通过 ${pass} 条，失败 ${fail} 条`);
process.exit(fail ? 1 : 0);
