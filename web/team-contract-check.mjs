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
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSseFrames, parseSseJson } from "./src/services/sse-frames.ts";
import { validateInviteCode, normalizeInviteCode, INVITE_CODE_MAX_LENGTH, INVITE_CODE_MIN_LENGTH } from "./src/lib/invite-code.ts";
import { ownedTeamCount, teamCreateBlockedReason } from "./src/lib/team-limits.ts";
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
/** 递归列出 src 下所有 ts/tsx，给「全仓扫描某个反模式」这类断言用。 */
function sourceFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}
const store = () => useTeamStore.getState();
const team = (id, credits, myRole = "owner", storageUsed = 0, storageQuota = 0) => ({
    id,
    name: id,
    description: "",
    avatarUrl: "",
    ownerId: "u1",
    credits,
    storageUsed,
    storageQuota,
    memberLimit: 0,
    status: "active",
    myRole,
    createdAt: "",
    updatedAt: "",
});

console.log("团队 store 的时序契约");

// REST 比 SSE 慢是常态（SSE 那条连接建好就立刻发 ready，REST 还要排队等事务）。
// 没有先占位的话，setCredits 认不出这个 teamId，第一份余额被直接丢掉，
// 界面停在 0 一直到下一次有人花钱——而那可能是几个小时以后。
store().clear();
store().bindTeam("team-1");
store().setCredits("team-1", 777);
store().setRealtimeStatus("team-1", "ready");
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
store().setRealtimeStatus("team-1", "ready");
store().bindTeam("team-1");
check("重复绑定同一个团队不清空实时值", store().credits === 900 && store().realtimeStatus === "ready", `余额 ${store().credits}，状态 ${store().realtimeStatus}`);

// 换团队必须清干净，否则新团队页会先闪一下上一支队伍的余额。
store().bindTeam("team-2");
check("切换团队清掉上一支队伍的余额", store().credits === 0, `当前 ${store().credits}`);
check("切换团队清掉上一支队伍的角色", store().myRole === "", `当前 ${store().myRole}`);
store().setCredits("team-1", 555);
check("迟到的旧团队事件不会写进新团队", store().credits === 0, `当前 ${store().credits}`);

// 迟到的状态同样要按团队挡住。A 队那个还没停下来的轮询撞上 403/404 时，用户可能已经切到 B 队：
// 不挡的话 B 队页面会挂出「你已不在这个团队里」，而他明明好好地待在 B 队，余额也还在实时更新。
store().setRealtimeStatus("team-1", "failed", "你已不在这个团队里");
check("迟到的旧团队状态不会污染新团队", store().realtimeStatus !== "failed" && store().realtimeError === "", `${store().realtimeStatus} / ${store().realtimeError}`);

// 永久失败要留下原因：只把数字停住而不说为什么，用户会以为余额真的是那个数。
store().setRealtimeStatus("team-2", "failed", "你已不在这个团队里");
check("终止状态记下失败原因", store().realtimeStatus === "failed" && store().realtimeError === "你已不在这个团队里", `${store().realtimeStatus} / ${store().realtimeError}`);
store().clear();
check("clear 一并清掉失败原因", store().realtimeStatus === "idle" && store().realtimeError === "", `${store().realtimeStatus} / ${store().realtimeError}`);

console.log("团队云空间的时序契约");

// 云空间和余额是同一条管道推下来的，所以它必须遵守同一套隔离规则。
// 少挡一处，B 队页面上就会显示 A 队的用量——而且那个数字看着完全正常，没有任何迹象说明它是错的。
store().clear();
store().bindTeam("team-1");
store().setStorage("team-1", 1024, 4096);
check("占位之后推来的云空间用量能落库", store().storageUsed === 1024 && store().storageQuota === 4096, `${store().storageUsed} / ${store().storageQuota}`);

store().setRealtimeStatus("team-1", "ready");
store().applyTeamSnapshot(team("team-1", 0, "owner", 0, 4096));
check("实时已就绪时 REST 快照不覆盖云空间用量", store().storageUsed === 1024, `当前 ${store().storageUsed}`);

// 还没连上时快照是唯一来源，必须能写进去，否则首屏进度条永远是 0。
store().clear();
store().bindTeam("team-1");
store().applyTeamSnapshot(team("team-1", 0, "admin", 2048, 8192));
check("未就绪时 REST 快照负责填充云空间", store().storageUsed === 2048 && store().storageQuota === 8192, `${store().storageUsed} / ${store().storageQuota}`);

store().bindTeam("team-2");
check("切换团队清掉上一支队伍的云空间", store().storageUsed === 0 && store().storageQuota === 0, `${store().storageUsed} / ${store().storageQuota}`);
store().setStorage("team-1", 9999, 9999);
check("迟到的旧团队云空间事件不会写进新团队", store().storageUsed === 0 && store().storageQuota === 0, `${store().storageUsed} / ${store().storageQuota}`);
store().clear();

const realtimeSource = read("services/team-realtime.ts");
// ready 是第一条事件，也是唯一一条能在首屏之前到达的。不在这里写云空间，进度条要等到下一次有人上传才会动。
check("ready 事件同时落库云空间", /"ready"[\s\S]{0,400}?setStorage\(teamId, event\.storageUsed, event\.storageQuota\)/.test(realtimeSource), "ready 只写了余额，首屏的云空间要等下一次变化才出现");
check("team.storage 事件写进 store", /"team\.storage"[\s\S]{0,200}?setStorage\(teamId,/.test(realtimeSource), "云空间的实时事件没有落库，用量不会实时更新");
// 降级之后余额每 30 秒动一次而用量永远停在进页面时的值，用户会照着一个偏小的数字继续传。
const pollSource = /const pollOnce[\s\S]*?const startPolling/.exec(realtimeSource)?.[0] || "";
check("降级轮询也刷新云空间", /setStorage\(teamId, team\.storageUsed, team\.storageQuota\)/.test(pollSource), "轮询只刷了余额，降级后云空间用量会一直停在旧值");
const storageCalls = realtimeSource.match(/setStorage\([^)]*/g) || [];
check("每次写云空间都带上 teamId", storageCalls.length >= 3 && storageCalls.every((call) => call.startsWith("setStorage(teamId,")), `没带 teamId 的调用：${storageCalls.filter((call) => !call.startsWith("setStorage(teamId,")).join(" | ") || "无"}`);
const teamStoreSource = read("stores/use-team-store.ts");
check("store 按当前团队挡住迟到的云空间", /setStorage: \(teamId, [^\n]*state\.currentTeamId === teamId/.test(teamStoreSource), "setStorage 没有 currentTeamId 守卫，切队之后旧连接还能改新页面的用量");

// 团队空间满和个人空间满是两本账。说成「你的云空间不足」，用户会跑去删自己的个人画布，删完一点用都没有。
check("团队配额错误码与个人分开", /TEAM_QUOTA_EXCEEDED = "TEAM_QUOTA_EXCEEDED"/.test(realtimeSource), "团队云空间不足没有独立错误码，会和个人配额混为一谈");
check("团队配额失败也能按文案识别", /团队云空间不足/.test(realtimeSource), "异步任务的失败原因只有文案，不按文案认就漏掉整条生成路径");
// 两种失败可能在同一批任务里同时发生，共用一个去重开关会让后弹的那条被永久吞掉。
check("配额弹窗与积分弹窗各自去重", /let quotaModalOpen = false/.test(realtimeSource) && /let exhaustedModalOpen = false/.test(realtimeSource), "两种弹窗共用一个开关，其中一条提示会被吞掉");
for (const file of ["services/api/job-stream.ts", "services/api/image.ts", "stores/use-cloud-agent-store.ts"]) {
    const source = read(file);
    check(`${file} 接上团队配额提示`, /notifyTeamQuotaExceeded\(/.test(source), "这条路径上团队空间满只会显示一句干巴巴的失败，用户不知道该清理谁的空间");
}

const detailSource = read("pages/teams/detail.tsx");
// 读 outlet 里那份 REST 快照的话，只有手动刷新数字才会变，实时推送等于白接。
check("详情页的云空间读实时 store", /useTeamStore\(\(state\) => state\.storageUsed\)/.test(detailSource), "用量读的是 REST 快照，SSE 推下来的新值显示不出来");
// Zustand 5 走 useSyncExternalStore：selector 返回新对象引用会无限重渲染并抛 React error #185。
check("云空间 selector 不返回新对象", !/useTeamStore\(\(state\) => \(\{/.test(detailSource), "selector 返回了新对象引用，会无限重渲染（React error #185）");
check("云空间用量有 data-testid", /data-testid="team-storage"/.test(detailSource), "UI 自动化脚本定位不到团队云空间");

console.log("创建团队的数量上限");

const owned = (count) => Array.from({ length: count }, (_, index) => team(`t${index}`, 0)).map((item) => ({ ...item, ownerId: "me" }));
check("只统计自己创建的团队", ownedTeamCount([...owned(2), { ...team("other", 0), ownerId: "someone-else" }], "me") === 2, `当前 ${ownedTeamCount([...owned(2), { ...team("other", 0), ownerId: "someone-else" }], "me")}`);
// 解散掉的团队不占名额，否则用户解散了也建不了新的，界面上还说「解散不再需要的团队后可以再建」。
check("已解散的团队不占名额", ownedTeamCount([...owned(1), { ...team("gone", 0), ownerId: "me", status: "disbanded" }], "me") === 1);
check("没登录时不算任何名额", ownedTeamCount(owned(3), "") === 0);
check("没到上限时不拦", teamCreateBlockedReason(owned(2), "me", 5) === "");
check("到达上限时给出原因", teamCreateBlockedReason(owned(5), "me", 5).includes("最多创建 5 个"), `当前「${teamCreateBlockedReason(owned(5), "me", 5)}」`);
check("超过上限同样拦住", teamCreateBlockedReason(owned(7), "me", 5) !== "");
// 0 表示不限，语义跟着服务端走（teams.ts 里写的是 `limit > 0 && ...`，0 根本不参与判定）。
// 理解反了的后果很隐蔽：管理员填 0 想放开限制，前端却把所有人的创建入口锁死，
// 而服务端那边其实是放行的——用户连报错都看不到，只看到按钮是灰的。
check("上限为 0 时按不限放行", teamCreateBlockedReason(owned(99), "me", 0) === "", `当前「${teamCreateBlockedReason(owned(99), "me", 0)}」`);
// 坏配置不能把所有人的创建入口锁死。
check("配置异常时按不限处理", teamCreateBlockedReason(owned(99), "me", -1) === "" && teamCreateBlockedReason(owned(99), "me", Number.NaN) === "");

const teamsPage = read("pages/teams/index.tsx");
check("创建按钮按上限禁用", /disabled=\{Boolean\(blockedReason\)\}/.test(teamsPage), "达到上限后按钮还亮着，点下去只会拿到一句原始的接口错误");
// 禁用的按钮点不动也悬停不出提示（触屏尤其如此），原因必须在页面上直接写一遍。
check("上限原因在页面上直接可见", /data-testid="team-create-blocked"/.test(teamsPage), "原因只挂在 Tooltip 上，触屏用户永远看不到");
// settings 还没拉回来就把入口锁死的话，慢一拍的网络会让所有人都建不了团队。
check("配置未就绪时不拦创建", /maxTeamsPerUser === undefined \? "" :/.test(teamsPage), "配置还没拉回来就按上限拦，网络慢一拍所有人都建不了团队");
// 界面上的说明和实际判定必须是同一套。说成「填 0 表示不允许创建」而代码按不限放行，
// 管理员会照着提示把创建功能「关掉」，结果谁都没被关住。
check("设置页把 0 说成不限", /填 0 表示不限/.test(read("pages/admin/settings/index.tsx")), "系统设置里 0 的说明和 teamCreateBlockedReason 的判定对不上");
// 旧版本服务端、以及新旧滚动升级期间，公开配置里根本没有 teams 这一节。
// 少一个 ?. 就是当场抛 TypeError，整个团队列表页变成一张错误页——一个加提示的改动不该有这个能力。
check("旧配置缺 team 时不炸页", /settings\?\.team\?\./.test(teamsPage), "settings?.team.x 会在旧服务端上抛 TypeError，整页白屏");
const settingsPage = read("pages/admin/settings/index.tsx");
check("系统设置页对缺失的 team 兜底", /draft\.public\.team \|\|/.test(settingsPage), "直接解构 team 会让系统设置页白屏，管理员连回去改配置的入口都没了");
// 字段缺失时算出的百分比是 NaN，进度条变成一段空白，界面上看不出任何异常——比显示成 0 难查得多。
check("云空间缺字段时兜底成 0", /const bytes = \(value/.test(teamStoreSource) && /storageUsed: bytes\(/.test(teamStoreSource), "storageUsed 可能是 undefined，百分比会算成 NaN");

console.log("指定邀请码的校验");

check("留空表示随机生成，不算错", validateInviteCode("") === "" && validateInviteCode("   ") === "");
check("小写会被归一成大写", normalizeInviteCode(" abc9 ") === "ABC9");
check("合法码通过校验", validateInviteCode("autumn26") === "", `当前「${validateInviteCode("autumn26")}」`);
// 0/O/1/I/L 正是因为肉眼难分才被排除；报错必须点名是哪几个字符，只说「含非法字符」用户盯着码也看不出来。
const illegal = validateInviteCode("WELC0ME");
check("形近字被拒绝", illegal !== "", "0 应当不在字母表里");
check("报错点名违规字符", illegal.includes("0"), `当前「${illegal}」`);
check("太短的码被拒绝", validateInviteCode("AB").includes(String(INVITE_CODE_MIN_LENGTH)), `当前「${validateInviteCode("AB")}」`);
check("超长的码被拒绝", validateInviteCode("A".repeat(INVITE_CODE_MAX_LENGTH + 1)) !== "", "超过长度上限没有被拦住");
check("刚好在边界上的码通过", validateInviteCode("A".repeat(INVITE_CODE_MIN_LENGTH)) === "" && validateInviteCode("A".repeat(INVITE_CODE_MAX_LENGTH)) === "");

const invitesPage = read("pages/admin/invites/index.tsx");
// 只禁用数量输入框是不够的：禁用不会改已经填进去的值，提交上去仍然是 count=10，服务端只能整批拒掉。
check("指定码值时数量强制为 1", /batchForm\.setFieldsValue\(\{ count: 1 \}\)/.test(invitesPage), "只禁用了数量框，已填的值仍会原样提交并被服务端拒绝");
check("指定码值时禁用数量输入", /disabled=\{singleCode\}/.test(invitesPage), "指定码值时数量还能改");
check("提交前把码值归一成大写", /normalizeInviteCode\(values\.code/.test(invitesPage), "小写码原样发出去，管理员发出的码和实际存的对不上");
check("批量生成的校验在 try 内", /try \{[\s\S]{0,400}?await batchForm\.validateFields\(\)/.test(invitesPage), "校验失败会变成 unhandled rejection，界面看着像卡住");
check("不把校验失败当服务端错误报", /"errorFields" in \w+\) return;/.test(invitesPage), "字段已经标红了还再弹一句失败，会被当成服务端出错");

console.log("昵称修改");

const accountModal = read("components/layout/account-settings-modal.tsx");
// 只提示「已保存」而不更新 store 的话，顶栏、成员列表、协作 presence 会一直是旧昵称，用户以为没改成功又改一遍。
check("改完昵称写回登录态", /setUser\(await serverApi\.updateProfile\(/.test(accountModal), "没有把新用户对象写回 store，全站还显示旧昵称");
// 用户名是登录凭据也是历史记录里定位到人的锚点，不能自助改。
check("弹窗里没有用户名输入框", !/name="username"/.test(accountModal), "账号设置里出现了可改用户名的输入框");
check("昵称有长度上限", /maxLength=\{DISPLAY_NAME_MAX\}/.test(accountModal), "昵称没有长度限制，填超了会被服务端悄悄截断");
// 弹窗不销毁表单，上次改了一半又关掉的草稿会留着，下次打开看到的就不是账号真正的昵称。
check("每次打开用当前昵称重置表单", /if \(open\) profileForm\.setFieldsValue/.test(accountModal), "上次没保存的草稿会留在输入框里，看着像是账号的真实昵称");
check("昵称允许留空并回落到用户名", /displayName \|\| user\?\.username/.test(accountModal), "空昵称没有回落，界面上会出现无名氏");

console.log("画布按钮的 hover 契约");

// 这几条是「以后不会再犯」的机械保证，不是对某几个按钮的抽查。
//
// 背景：画布上的按钮底色要跟着画布主题走，只能内联写；而内联样式压得过 antd 自己的 hover 规则，
// 于是 antd 的 hover 背景永远不生效——鼠标放上去毫无反馈，用户看不出这里能点。
// 以前每个按钮各写一份 style={{ background }}，也就各自漏掉了一次 hover，全站漏了七处。
const surfaceButton = read("components/canvas/canvas-surface-button.tsx");
const globalCss = read("styles/globals.css");
const themeSource = read("lib/canvas-theme.ts");

// 只要还有人用「type="text" + 内联背景色」这个写法，这条就红：那正是漏掉 hover 的那一步。
const inlineBackgroundTextButtons = [];
for (const relative of sourceFiles(join(root))) {
    const source = readFileSync(relative, "utf8");
    for (const match of source.matchAll(/type="text"/g)) {
        const start = source.lastIndexOf("<", match.index);
        let index = match.index + match[0].length;
        let depth = 0;
        let end = source.length;
        while (index < source.length) {
            const char = source[index];
            if (char === "{") depth += 1;
            else if (char === "}") depth -= 1;
            else if (char === ">" && depth === 0) {
                end = index + 1;
                break;
            }
            index += 1;
        }
        const fragment = source.slice(start, end);
        if (/(background|backgroundColor)\s*:/.test(fragment)) inlineBackgroundTextButtons.push(`${relative.slice(root.length + 1)}:${source.slice(0, start).split("\n").length}`);
    }
}
check("没有按钮再自己内联写背景色", inlineBackgroundTextButtons.length === 0, `这些地方绕开了 CanvasSurfaceButton，它们的 hover 一定是死的：${inlineBackgroundTextButtons.join(", ")}`);

// 着色必须落在样式表里：只有走样式表才能带 !important 压过 antd，也只有走 :hover 选择器才有 hover 态。
check("hover 规则落在样式表里", /\.canvas-surface-button:hover[^{]*\{[^}]*background:[^;]*!important/.test(globalCss), "globals.css 里没有 .canvas-surface-button 的 hover 规则，hover 依旧不会生效");
check("静态色也带 !important", /\.canvas-surface-button\s*\{[^}]*background:[^;]*!important/.test(globalCss), "静态背景没有 !important，会被 antd 的默认底色盖掉");
// 颜色从主题取，不在组件里写死：写死就等于又开了一处「深浅两套主题各调一遍」的口子。
check("hover 色由主题提供", /panelHover/.test(themeSource) && /fillHover/.test(themeSource) && /activeBgHover/.test(themeSource), "canvas-theme 里缺 hover 色，组件只能自己编一个");
check("组件只从主题取色", /theme\.toolbar\.panelHover/.test(surfaceButton) && /theme\.node\.fillHover/.test(surfaceButton), "CanvasSurfaceButton 没有用主题里的 hover 色");
// 选中态（比如 Agent 面板已打开）再 hover 也要有反馈，否则会被当成点不动了。
check("选中态也有 hover 反馈", /activeBgHover/.test(surfaceButton), "选中的按钮 hover 没有任何变化，看着像坏了");
// 调用方不能再自己写 type：写成别的 type 就又回到 antd 默认那套亮色 hover 上去了。
check("组件锁死 type=text", /\.\.\.rest\}\s*\n\s*type="text"/.test(surfaceButton) || /type="text"[\s\S]{0,80}\.\.\.rest/.test(surfaceButton), "type 没有被组件锁死，调用方可以覆盖掉");

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
check("永久失败写进 store", /if \(terminal[\s\S]{0,200}?setRealtimeStatus\(teamId, "failed"/.test(realtime), "永久失败没有写进 store，界面看不出来");
const pollBlock = /const pollOnce[\s\S]*?const startPolling/.exec(realtime)?.[0] || "";
check("轮询自己撞上永久失败也收手", /terminalStatusOf\(/.test(pollBlock) && /clearPolling\(\)/.test(pollBlock) && /setRealtimeStatus\(teamId, "failed"/.test(pollBlock), "轮询是降级路径，撞上 403/404 却比主连接还执着");
check("流失败携带 HTTP 状态码", /class TeamStreamError[\s\S]{0,200}?status/.test(realtime), "错误里没有状态码，调用方只能去匹配文案");
// 降级到轮询之后，重连循环每转一圈都会重设状态。不看 poller 就会把 polling 改回 reconnecting，
// 界面于是说「正在连接实时同步」，而用户实际在看一个每 30 秒才动一次的数字。
const statusLine = /setRealtimeStatus\((?![\s\S]{0,10}"failed")[^\n]*(?:connecting|reconnecting)[^\n]*\)/.exec(realtime)?.[0] || "";
check("已降级到轮询时状态保持 polling", /poller \? "polling"/.test(statusLine), `重连循环设置的状态没有考虑轮询是否在跑：${statusLine || "没找到那行"}`);
check("分帧走共用实现", /decodeSseFrames\(/.test(realtime) && /parseSseJson[<(]/.test(realtime), "team-realtime 没有用共用的分帧实现");
// 每一处状态写入都得报上自己是哪支队伍。漏一处，那处就成了跨团队污染的入口——
// watchTeam 的闭包会在 abort 之后继续活一小会儿（飞行中的请求、已排队的定时器回调）。
const statusCalls = realtime.match(/setRealtimeStatus\([^)]*/g) || [];
check(
    "每次写状态都带上 teamId",
    statusCalls.length >= 5 && statusCalls.every((call) => call.startsWith("setRealtimeStatus(teamId,")),
    `没带 teamId 的调用：${statusCalls.filter((call) => !call.startsWith("setRealtimeStatus(teamId,")).join(" | ") || "无"}`,
);
const storeSource = read("stores/use-team-store.ts");
check("store 按当前团队挡住迟到的状态", /setRealtimeStatus: \(teamId, [^\n]*state\.currentTeamId === teamId/.test(storeSource), "setRealtimeStatus 没有 currentTeamId 守卫，切队之后旧连接还能改新页面的状态");
// 轮询的请求是切走之前发出去的，它的失败只属于上一支队伍；卸载之后就不该再往 store 里写任何东西。
check("卸载后轮询不再写 store", /if \(signal\.aborted\) return;/.test(pollBlock), "pollOnce 的 catch 没有检查 signal.aborted");
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
