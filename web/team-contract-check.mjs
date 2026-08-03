// 团队前台的契约检查：跑那些「类型检查过得去、构建也过得去、但线上会错」的逻辑。
//
// 这里的三类断言各有各的理由：
//   1. store 直接跑真代码（node 自带 TS 类型擦除，store 只依赖 zustand）。
//      余额是钱，「REST 慢一拍就把实时推来的余额丢掉」这种缺陷只在时序上出现，
//      浏览器 E2E 里几乎撞不到，只能把时序显式摆出来跑一遍。
//   2. SSE 分帧同样是纯逻辑，直接跑。真实服务端只发 \n\n，但反代改写换行、
//      把一帧切成两个分片都是线上才会发生的事，等 E2E 撞上就晚了。
//   3. 剩下几条只能落在源码层面（重连的终止条件要起浏览器 + 造 403 才测得到，
//      而 ui-check 自己的白名单本来就是一条源码属性），用最紧的正则钉住。
//
// 用法：node web/team-contract-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSseFrames, parseSseJson } from "./src/services/sse-frames.ts";
import { useTeamStore } from "./src/stores/use-team-store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
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

const read = (relative) => readFileSync(join(root, relative), "utf8");
const store = () => useTeamStore.getState();
const team = (id, credits, myRole = "owner") => ({ id, name: id, description: "", avatarUrl: "", ownerId: "u1", credits, memberLimit: 0, status: "active", myRole, createdAt: "", updatedAt: "" });

console.log("团队 store 的时序契约");

// REST 比 SSE 慢是常态（SSE 那条连接建好就立刻发 ready，REST 还要排队等事务）。
// 没有先占位的话，setCredits 认不出这个 teamId，第一份余额被直接丢掉，
// 界面停在 0 一直到下一次有人花钱——而那可能是几个小时以后。
store().clear();
store().bindTeam("team-1");
store().setCredits("team-1", 777);
store().setRealtimeStatus("ready");
check("占位之后 ready 推来的余额能落库", store().credits === 777, `当前 ${store().credits}`);

// 改个团队名会触发 refetch，那份快照是 SSE 之前的旧余额。盖回去等于余额自己往回跳。
store().applyTeamSnapshot(team("team-1", 0));
check("实时已就绪时 REST 快照不覆盖余额", store().credits === 777, `当前 ${store().credits}`);
check("实时已就绪时 REST 快照不重置连接状态", store().realtimeStatus === "ready", `当前 ${store().realtimeStatus}`);

// 还没连上的时候快照是唯一的数据来源，必须能写进去。
store().clear();
store().bindTeam("team-1");
store().applyTeamSnapshot(team("team-1", 42, "admin"));
check("未就绪时 REST 快照负责填充余额", store().credits === 42, `当前 ${store().credits}`);
check("未就绪时 REST 快照负责填充角色", store().myRole === "admin", `当前 ${store().myRole}`);

// 同一个团队重复 bind（React 严格模式、重渲染都会发生）不能把已经收到的实时值清掉。
store().setCredits("team-1", 900);
store().setRealtimeStatus("ready");
store().bindTeam("team-1");
check("重复绑定同一个团队不清空实时值", store().credits === 900 && store().realtimeStatus === "ready", `余额 ${store().credits}，状态 ${store().realtimeStatus}`);

// 换团队必须清干净，否则新团队页会先闪一下上一支队伍的余额。
store().bindTeam("team-2");
check("切换团队清掉上一支队伍的余额", store().credits === 0, `当前 ${store().credits}`);
check("切换团队清掉上一支队伍的角色", store().myRole === "", `当前 ${store().myRole}`);
store().setCredits("team-1", 555);
check("迟到的旧团队事件不会写进新团队", store().credits === 0, `当前 ${store().credits}`);

// 永久失败要留下原因：只把数字停住而不说为什么，用户会以为余额真的是那个数。
store().setRealtimeStatus("failed", "你已不在这个团队里");
check("终止状态记下失败原因", store().realtimeStatus === "failed" && store().realtimeError === "你已不在这个团队里", `${store().realtimeStatus} / ${store().realtimeError}`);
store().clear();
check("clear 一并清掉失败原因", store().realtimeStatus === "idle" && store().realtimeError === "", `${store().realtimeStatus} / ${store().realtimeError}`);

console.log("SSE 分帧");

const frames = (input) => decodeSseFrames(input).data;
check("按空行切出数据帧", JSON.stringify(frames('data: {"a":1}\n\ndata: {"a":2}\n\n')) === JSON.stringify(['{"a":1}', '{"a":2}']));
// 反代（nginx、部分企业网关）会把 \n 改写成 \r\n；只认 \n\n 的话整条流会一帧都切不出来，
// 界面表现为「连上了但余额永远不动」，比断开还难查。
check("兼容 \\r\\n 分隔", JSON.stringify(frames('data: {"a":1}\r\n\r\n')) === JSON.stringify(['{"a":1}']));
const first = decodeSseFrames('data: {"a":1}\r\n\r');
const second = decodeSseFrames(`${first.rest}\ndata: next\r\n\r\n`);
check("\\r\\n 被切在两个分片之间也能切帧", first.data.length === 0 && JSON.stringify(second.data) === JSON.stringify(['{"a":1}', "next"]), `第一片 ${JSON.stringify(first.data)}，第二片 ${JSON.stringify(second.data)}`);
check("保活注释帧不产出数据", frames(": keep-alive\n\n").length === 0);
// 规范：多行 data 用换行连接，冒号后只去掉紧跟的那一个空格。
check("多行 data 按规范用换行连接", JSON.stringify(frames("data: ab\ndata: cd\n\n")) === JSON.stringify(["ab\ncd"]));
check("没有空格的 data 行照样解析", JSON.stringify(frames("data:ab\n\n")) === JSON.stringify(["ab"]));
check("只吃掉冒号后的一个空格", JSON.stringify(frames("data:  ab \n\n")) === JSON.stringify([" ab "]));
check("未收完的半帧留在余量里", decodeSseFrames('data: {"a":1}').rest === 'data: {"a":1}');
// 一直收不到帧分隔的话，缓冲会一直涨；不设上限就是把这个标签页的内存交给对端处置。
let overflowed = false;
try {
    decodeSseFrames("x".repeat((1 << 20) + 1));
} catch {
    overflowed = true;
}
check("缓冲超过上限时断开而不是一直攒", overflowed);
// 一个坏帧不能掀翻整条连接：抛出去会让重连计数把一次「解析失败」当成「服务端挂了」。
check("脏帧解析成 null 而不是抛错", parseSseJson("{ not json") === null);
check("正常帧照常解析", parseSseJson('{"type":"ready"}')?.type === "ready");

console.log("实时连接的终止条件");

const realtime = read("services/team-realtime.ts");
// 401/403/404 重连一万次也是同一个结果：401 已经清了会话，403 是被挂起或降级，404 是团队没了或人已被移出。
// 不停手就是每 6 秒打一次必然失败的请求，外加一个 30 秒轮询永远转下去。
check("识别永久失败的状态码", /TERMINAL_STATUS[^=]*=\s*\[401,\s*403,\s*404\]/.test(realtime), "没有把 401/403/404 单独列为永久失败");
check("永久失败时停止重连", /if \(terminal[\s\S]{0,200}?break;/.test(realtime), "永久失败没有跳出重连循环");
check("永久失败时停掉轮询", /if \(terminal[\s\S]{0,200}?clearPolling\(\)/.test(realtime), "永久失败后轮询还在跑");
check("永久失败写进 store", /if \(terminal[\s\S]{0,200}?setRealtimeStatus\("failed"/.test(realtime), "永久失败没有写进 store，界面看不出来");
const pollBlock = /const pollOnce[\s\S]*?const startPolling/.exec(realtime)?.[0] || "";
check("轮询自己撞上永久失败也收手", /terminalStatusOf\(/.test(pollBlock) && /clearPolling\(\)/.test(pollBlock) && /setRealtimeStatus\("failed"/.test(pollBlock), "轮询是降级路径，撞上 403/404 却比主连接还执着");
check("流失败携带 HTTP 状态码", /class TeamStreamError[\s\S]{0,200}?status/.test(realtime), "错误里没有状态码，调用方只能去匹配文案");
// 降级到轮询之后，重连循环每转一圈都会重设状态。不看 poller 就会把 polling 改回 reconnecting，
// 界面于是说「正在连接实时同步」，而用户实际在看一个每 30 秒才动一次的数字。
const statusLine = /setRealtimeStatus\((?![\s\S]{0,10}"failed")[^\n]*(?:connecting|reconnecting)[^\n]*\)/.exec(realtime)?.[0] || "";
check("已降级到轮询时状态保持 polling", /poller \? "polling"/.test(statusLine), `重连循环设置的状态没有考虑轮询是否在跑：${statusLine || "没找到那行"}`);
check("分帧走共用实现", /decodeSseFrames\(/.test(realtime) && /parseSseJson[<(]/.test(realtime), "team-realtime 没有用共用的分帧实现");
// 服务端正常 EOF（多实例部署里另一个实例根本不会推事件、反代到点掐流）不计失败的话，
// 一条秒断秒连的流会让 failure 永远停在 0，轮询兜底永远不启动，余额可以一整天不动。
const loop = /let failure = 0;[\s\S]*?clearPolling\(\);\n    \}\)\(\);/.exec(realtime)?.[0] || "";
check("找得到重连循环", Boolean(loop), "重连循环的形状变了，下面几条断言会落空");
const afterStream = /await openStream\([\s\S]*?\n            \} catch/.exec(loop)?.[0] || "";
check("正常 EOF 也计一次失败", /failure \+= 1;/.test(afterStream), "openStream 正常返回没有 failure++，流一直秒断秒连也不会降级到轮询");
// 只有 ready 才是「这条连接确实在工作」的证据；在别的地方清零等于把一条什么都没推的流当成健康。
const zeroing = (loop.match(/(?<!let )failure = 0/g) || []).length;
check("只有 ready 才清零失败计数", zeroing === 1 && /"ready"[\s\S]{0,200}?failure = 0/.test(loop), `failure = 0 出现了 ${zeroing} 次`);
// signal 活到整个团队页的生命周期。退避一次挂一个不摘的 abort 监听，闭包连同 timer 一直留在内存里。
const sleepFn = /const sleep = [\s\S]*?\n    \}\);/.exec(realtime)?.[0] || "";
check("退避正常结束时摘掉 abort 监听", /removeEventListener\("abort"/.test(sleepFn), "sleep 正常超时没有 removeEventListener，每次重连都往 signal 上堆一个死监听");

const layoutSrc = read("pages/teams/layout.tsx");
// 403 正是被降级或挂起，404 是团队没了或人已被移出，401 连会话都没了：这之后「我是什么角色」已经没有可信答案。
// 还按最后一次已知角色渲染管理入口，用户就对着一排点了必然报错的按钮反复试。
check("终止状态下按只读收起管理入口", /realtimeStatus === "failed" \? "viewer"/.test(layoutSrc), "永久失败后仍按旧角色渲染管理按钮，全是点了必然被拒的死按钮");
check("传给子页面的角色用收敛后的值", /myRole: contextRole/.test(layoutSrc), "Outlet 还在传未收敛的角色");

console.log("表单提交的契约");

// validateFields 会 reject。放在 try 外面就是一条没人接的 promise rejection：
// 必填项留空时按钮不动、控制台报错，用户只当页面卡住了。
for (const [file, form] of [
    ["pages/teams/index.tsx", "createForm"],
    ["pages/teams/detail.tsx", "editForm"],
    ["pages/teams/members.tsx", "form"],
]) {
    const source = read(file);
    const guarded = new RegExp(`try \\{[\\s\\S]{0,400}?await ${form}\\.validateFields\\(\\)`).test(source);
    check(`${file} 的 validateFields 在 try 内`, guarded, "校验失败会变成 unhandled rejection");
    check(`${file} 不把校验失败当服务端错误报`, /"errorFields" in \w+\) return;/.test(source), "字段已经标红了还再弹一句失败，会被当成服务端出错");
}

const members = read("pages/teams/members.tsx");
// InputNumber 清空给的是 null，直接发出去被服务端当成缺字段或坏类型；0 正是表单上写的「不限」。
check("清空额度按 0（不限）提交", /Number\(values\.creditLimit\) \|\| 0/.test(members), "InputNumber 清空后的 null 会被原样发给服务端");
check("owner 与非 owner 两条路都用归一后的额度", (members.match(/creditLimit,?\s*(\}|limitWindow)/g) || []).length >= 2 && !/creditLimit: values\.creditLimit/.test(members), "还有分支直接用了未归一的 values.creditLimit");

const detail = read("pages/teams/detail.tsx");
// 转让不可逆：请求飞行期间确定按钮还能再点，第二次请求发出时自己已经不是 owner，用户看到一句莫名其妙的「无权限」。
check("转让按钮防重复提交", /confirmLoading=\{transferSubmitting\}/.test(detail) && /if \(transferSubmitting\) return;/.test(detail), "转让弹窗没有 confirmLoading / 重入保护");

console.log("团队页面的其余契约");

const layout = read("pages/teams/layout.tsx");
// 占位必须发生在开流之前，否则第一份 ready 会被 store 当成别的团队的事件丢掉。
check("先占位再开流", /bindTeam\(id\);[\s\S]{0,200}?watchTeam\(id,/.test(layout), "watchTeam 在 bindTeam 之前启动，ready 的余额会被丢掉");
check("REST 快照走不覆盖实时值的入口", /applyTeamSnapshot\(data\)/.test(layout) && !/setCurrentTeam\(/.test(layout), "布局还在用会重置实时状态的旧入口");
check("失败状态在界面上有说法", /realtimeStatus === "failed"/.test(layout), "永久失败在界面上不可见，用户会把停住的余额当成真值");
check("导航标出当前页", /aria-current=/.test(layout), "页签没有 aria-current，读屏用户听不出当前在哪一页");

const logs = read("pages/teams/logs.tsx");
// 被降级成 member 的人如果 scope 还停在 all，流水页会一直打一个必然 403 的接口。
check("流水范围随角色实时收敛", /const \w*[Ss]cope = all \?/.test(logs), "scope 只在初始化时判了一次角色，降级后会一直请求全员流水");

console.log("ui-check 自身的契约");

const uiCheck = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui-check.mjs"), "utf8");
// 全局放行 400 等于把「某个页面把请求打坏了」和「这条断言故意造的错」混为一谈，
// 前者从此再也不会让脚本变红。
check("不全局忽略 400", !/realErrors = \(\)[^\n]*400/.test(uiCheck), "realErrors 的噪音正则里全局放行了 400");
check("预期错误按段申报", /const visit = async \([^)]*expected/.test(uiCheck), "visit 不接受按段申报的预期错误");
check("每段的预期错误会被重置", /expectedErrors = /.test(uiCheck), "预期错误没有在每次导航时重置，会一直放行到脚本结束");
// 裸 goto 漏掉重置的话，上一段申报的白名单会一直延续下去，替后面所有段落挡枪。
const outsideReset = uiCheck.replace(/const resetErrors = [\s\S]*?\n    \};/, "");
check("裸 goto 也重置预期错误", !/errors\.length = 0;/.test(outsideReset) && (uiCheck.match(/resetErrors\(/g) || []).length >= 3, "还有直接清 errors 而不重置白名单的地方");
check("申报了却没出现要报出来", /申报/.test(uiCheck) || /预期内的错误没有出现/.test(uiCheck), "白名单没有反向校验，接口改好了也不会有人来删它");
// 吞掉超时会让后面所有断言在一个错误的页面上继续跑，最后报一堆无关的失败。
check("创建团队的跳转不吞超时", !/waitForURL\([^)]*\)\s*\.catch\(\(\) => \{\}\)/.test(uiCheck), "waitForURL 的超时被吞了");
check("没进详情页就直接判失败", /const entered = await page[\s\S]{0,40}?\.waitForURL/.test(uiCheck), "没有把跳转结果变成一条显式断言");
check("没进详情页时跳过后续断言并记为失败", /if \(entered\)[\s\S]{0,4000}?\} else \{[\s\S]{0,600}?skip\(/.test(uiCheck), "跳转失败后仍然在错误的页面上继续断言");

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
