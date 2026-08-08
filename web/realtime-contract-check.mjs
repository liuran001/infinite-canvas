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
const shareSync = read(join(web, "services/share-sync.ts"));
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
check("每次重连都重新取票", /async function connect\(pool[\s\S]{0,900}?await fetchTicket\(pool\.scope\)/.test(connection));
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
check("非终态订阅错误按频道退避重订", /scheduleEntryRetry\(pool, entry\)/.test(connection));
check("realtimeAvailable 为假时仍然排重连", /realtimeAvailable\(pool\.scope\)\)\s*\{[\s\S]{0,400}?scheduleReconnect\(pool\)/.test(connection));
// 同源部署的 base 地址本来就是空串，拿它当门禁会让这整类部署连票都不去取，永远停在 SSE 上。
check("可用性不拿 base 地址当门禁", /export function realtimeAvailable[\s\S]{0,200}?\n\}/.exec(connection)?.[0].includes("serverBaseUrl") === false);
// presence 上行被拒只说明这一次上报没被接受，按订阅失败处理会把整条画布频道打成未就绪。
check("presence 错误与订阅错误分开", /scope === "presence"/.test(connection) && /scope: "presence"/.test(hub));
check("presence 发送结果如实返回", /presence: \(payload: unknown\) => boolean/.test(connection));
// 终态错误若把整条连接拖去重连，同一作用域下其它正常频道会被一条无解的订阅反复打断。
check("终态错误只停单条频道", /TERMINAL_CODES\.has\(failure\.code\)\) return terminate\(pool, entry, failure\)/.test(connection));
check("服务端 unsubscribed 被当成频道终态", /frame\.type === "unsubscribed"/.test(connection));

// 终态码不能靠人肉抄。订阅路径上的服务端错误码是从源码里数出来的：
// 团队守卫发的是 TEAM_* 而不是通用 FORBIDDEN，任何一个漏进前端的重试集，
// 对应的用户（被挂起、被移出、团队被停用、会话已删）就会带着一条永远订不上的频道无限重连。
const terminalCodes = new Set((connection.match(/TERMINAL_CODES = new Set\(\[([\s\S]*?)\]\)/) || [])[1]?.match(/"([^"]+)"/g)?.map((code) => code.slice(1, -1)) || []);
check("前端解析出终态码集合", terminalCodes.size > 0);
const presenceCodes = new Set((connection.match(/PRESENCE_CODES = new Set\(\[([\s\S]*?)\]\)/) || [])[1]?.match(/"([^"]+)"/g)?.map((code) => code.slice(1, -1)) || []);
const teamAccess = read(join(server, "services/team-access.ts"));
const projectAccess = read(join(server, "services/project-access.ts"));
const agentService = read(join(server, "services/agent.ts"));
// 只数 4xx：5xx 与未标记错误是「服务端此刻出问题了」，重连有意义，本来就不该进终态集。
const failCodes = (source) => [...source.matchAll(/fail\([^)]*?,\s*4\d\d,\s*"([A-Z_]+)"/g)].map((match) => match[1]);
const namedFailCodes = (source) => [...source.matchAll(/fail\([^)]*?,\s*4\d\d,\s*(FORBIDDEN|NOT_FOUND)\b/g)].map((match) => match[1]);
// presence 相关的码不进终态集：它们只说明这一次上报被拒，订阅本身还活着，由 PRESENCE_CODES 兜住。
const RETRYABLE = new Set(["RATE_LIMITED"]);
const reachable = [
    ...new Set([
        ...failCodes(channels),
        ...namedFailCodes(channels),
        ...failCodes(teamAccess),
        ...failCodes(projectAccess),
        ...namedFailCodes(projectAccess),
        ...namedFailCodes(agentService),
        ...[...hub.matchAll(/errorFrame\([^)]*?"([A-Z_]+)"/g)].map((match) => match[1]),
    ]),
].filter((code) => !RETRYABLE.has(code));
check("枚举到服务端订阅期错误码", reachable.length >= 8, `实际 ${reachable.join(",")}`);
for (const code of reachable) check(`终态码覆盖 ${code}`, terminalCodes.has(code) || presenceCodes.has(code));
// presence 专属的两个码只能进 presence 集：进终态集会让一次拼错的上报直接判死整条画布订阅。
for (const code of ["INVALID_ACTIVITY", "INVALID_NODE_IDS"]) {
    check(`${code} 归 presence 而不是终态`, presenceCodes.has(code) && terminalCodes.has(code) === false);
}
// 会话不存在必须带稳定错误码：默认的 code=1 在前端只是「操作失败」，会被当成可重试。
check("agent 会话不存在用 404 NOT_FOUND", /fail\("会话不存在", 404, NOT_FOUND\)/.test(agentService));
// 团队页要把这些码翻成「不用再等了」的提示，只认 FORBIDDEN 会让被挂起的人一直看到「正在连接」。
const teamMapped = new Set((teamRealtime.match(/TERMINAL_CODE_STATUS[^=]*= \{([\s\S]*?)\}/) || [])[1]?.match(/([A-Z_]+):/g)?.map((key) => key.slice(0, -1)) || []);
for (const code of ["FORBIDDEN", "REVOKED", "TEAM_FORBIDDEN", "TEAM_MEMBER_SUSPENDED", "TEAM_DISABLED", "TEAM_NOT_FOUND"]) {
    check(`团队终态提示覆盖 ${code}`, teamMapped.has(code));
}
// 会话不存在时换成 SSE 也是同一个 404，只会空转一轮再给出一句指错方向的「连接中断」。
check("云端 Agent 对 NOT_FOUND 不再退回 SSE", /failure\.code === "NOT_FOUND"/.test(cloudAgent));

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

console.log("身份作用域隔离");
// 账号与访客是两个物理身份。共用一条 socket 意味着一张票据同时承载两种权限判定，
// 分享页里已登录的用户会拿账号票去订访客频道（反之亦然），这属于越权，必须按身份分池。
check("连接按身份作用域分池", /scopeKey|pools\.get\(/.test(connection), "connection.ts 仍是单例全局状态");
check("作用域区分 account 与 guest", /kind: "guest"/.test(connection) && /"account"/.test(connection));
check("取票可显式使用 guest 令牌", /scope\.token\(\)/.test(connection) || /guestToken/.test(connection), "fetchTicket 只会读账号 token");
check("guest 取票带分享标记头", /X-Share-Guest/.test(connection), "服务端按 Authorization 判 guest，但网关要能分流");
check("每个作用域各自重连取票", /await fetchTicket\(pool\.scope\)|fetchTicket\(scope\)/.test(connection));
// 池级状态一个都不能省成模块级：省下来的那个字段就是两种身份互相误判的地方。
check("socket 与重连状态挂在池上", /pool\.socket/.test(connection) && /^let socket/m.test(connection) === false);
check("失败计数挂在池上", /pool\.failures/.test(connection) && /^let failures/m.test(connection) === false);
check("订阅表挂在池上", /pool\.entries/.test(connection) && /^const entries = new Map/m.test(connection) === false);
check("分享订阅声明 guest 作用域", /scope: guestScope\(\)/.test(shareSync) && /kind: "guest"/.test(shareSync), "share-sync 没有显式传访客作用域");
check("访客票据用 guest 令牌而不是账号令牌", /token: \(\) => useShareStore\.getState\(\)\.guestToken/.test(shareSync), "guest 作用域取票必须现取 guest 令牌");

console.log("分享画布首选 WebSocket");
check("分享订阅走共享连接", /subscribeRealtime</.test(shareSync));
check("分享频道名为 project:<id>", /channel: `project:\$\{projectId\}`/.test(shareSync));
check("分享订阅传的是 payload 函数", /payload: \(\) =>/.test(shareSync));
check("分享 ready 同步角色", /ready\.role/.test(shareSync) || /role === "viewer" \|\| .*role === "editor"/.test(shareSync));
check("分享 ready 过滤自己的 presence", /clientId !== shareClientId/.test(shareSync));
check("分享按 revision 去重后再拉取", /revision > lastRevision|revision <= lastRevision/.test(shareSync));
check("分享忽略自己写入的事件", /writerClientId === shareClientId/.test(shareSync));
check("分享保留 SSE 降级", /shareProjectStream\(/.test(shareSync) && /watchShareProjectViaSse/.test(shareSync));
const shareOnDegrade = (/onDegrade: \(\) => \{([\s\S]*?)\n\s*\},\n\s*onRecover:/.exec(shareSync) || [])[1] || "";
const shareOnTerminal = (/onTerminal: \(failure\) => \{([\s\S]*?)\n\s*\},\n\s*\}\);/.exec(shareSync) || [])[1] || "";
check("分享连续失败才启用 SSE", /refreshShareSession\(\)\.finally\(startFallback\)/.test(shareOnDegrade));
check("分享 ready 后停止 SSE 降级", /onRecover: stopFallback/.test(shareSync) && /onReady[\s\S]{0,400}?stopFallback\(\)/.test(shareSync));
// 撤销是终态：服务端会主动断开这条频道，但降级成只读也走同一条路径，
// 直接判失效会把「你现在只能看」误报成「链接没了」。重新鉴权一次才分得清。
check("撤销后重新鉴权而不是直接判失效", /refreshShareSession\(\)\.finally\(startFallback\)/.test(shareOnTerminal) && /failure\.code === "REVOKED"/.test(shareOnTerminal) === false, "撤销与降级走同一条断流路径，直接判失效会把「变只读」误报成「链接没了」");
check("确证失效才进 gone 终态", /failure\.code === "PROJECT_NOT_FOUND" \|\| failure\.code === "NOT_FOUND"/.test(shareOnTerminal) && /markGone\(/.test(shareOnTerminal));
check("分享 presence 优先 WebSocket 且保留 HTTP", /subscription\.presence\(|presence\(\{/.test(shareSync) && /shareApi\.updatePresence\(/.test(shareSync));
// 「有订阅对象」不等于「这一帧发出去了」：不看返回值就直接 return，会让访客在降级窗口里彻底隐身。
check("分享 presence 只在发送成功时跳过 HTTP", /sharePresence\.get\(projectId\)\?\.presence\(\{[^)]*\}\)\) return;/.test(shareSync), "share-sync 没有按 presence() 的返回值决定是否回落 HTTP");
// 去抖取成 200（正好等于服务端阈值）会被 RATE_LIMITED 静默丢掉，和账号侧同一个坑。
check("分享 presence 去抖大于服务端限流阈值", /PRESENCE_DEBOUNCE_MS = PRESENCE_MIN_INTERVAL_MS \+ \d+/.test(shareSync) && /setTimeout\(send, PRESENCE_DEBOUNCE_MS\)/.test(shareSync) && /setTimeout\(send, 200\)/.test(shareSync) === false);
// 降级流的 abort 监听只能挂一次，否则每降级一轮就往整页生命周期的 signal 上堆一个闭包。
check("分享降级 abort 监听只注册一次", /signal\.addEventListener\("abort", \(\) => fallback\?\.abort\(\)/.test(shareSync) === false && /signal\.addEventListener\("abort", \(\) => stopFallback\(\), \{ once: true \}\)/.test(shareSync));

console.log("降级路径仍然存在");
check("画布保留 SSE 降级", /serverProjectStream\(/.test(projectRealtime) && /watchProjectViaSse/.test(projectRealtime));
// 新建的画布要等首次保存落库才订阅：在那之前服务端只会回 PROJECT_NOT_FOUND，
// 而这条通道把那个码当成「画布已被删除」，直接订的结果是刚建好的画布把用户踢回列表页。
check("画布等落库之后才订阅", /if \(lastRevision\) subscribe\(\);/.test(projectRealtime) && /syncedRevisionOf/.test(projectRealtime));
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
