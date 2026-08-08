import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import enUS from "./src/i18n/locales/en-US.ts";
import zhCN from "./src/i18n/locales/zh-CN.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
const read = (relative) => readFileSync(join(root, relative), "utf8");
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
    console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
    ok ? (pass += 1) : (fail += 1);
}

function leafPaths(value, prefix = "") {
    if (Array.isArray(value)) return value.flatMap((item, index) => leafPaths(item, `${prefix}[${index}]`));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => leafPaths(item, prefix ? `${prefix}.${key}` : key));
    return [prefix];
}

function sourceWithoutComments(value) {
    return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const project = read("pages/canvas/project.tsx");
const topBar = read("components/canvas/canvas-top-bar.tsx");
const mention = read("components/canvas/canvas-resource-mention-textarea.tsx");
const pluginHost = read("pages/canvas/hooks/use-plugin-host.tsx");
const cloudPanel = read("components/agent/cloud-agent-panel.tsx");
const cloudComposer = read("components/agent/cloud-agent-composer.tsx");
const agentModeSwitch = read("components/agent/agent-mode-switch.tsx");
const agentSearchCard = read("components/agent/agent-search-card.tsx");
const cloudFormat = read("components/agent/cloud-agent-format.ts");
const cloudReferences = read("components/agent/cloud-agent-references.ts");
const userStatusActions = read("components/layout/user-status-actions.tsx");
const accountSettingsModal = read("components/layout/account-settings-modal.tsx");
const passkeyManager = read("components/layout/passkey-manager.tsx");
const loginModal = read("components/layout/login-modal.tsx");
const appConfigModal = read("components/layout/app-config-modal.tsx");
const localPanel = read("components/agent/local-agent-panel.tsx");
const eventFormatters = read("components/agent/agent-event-formatters.ts");
const chatMessage = read("components/agent/agent-chat-message.tsx");

console.log("画布英文完整性契约");

const zhCanvasPaths = leafPaths(zhCN.canvas).sort();
const enCanvasPaths = leafPaths(enUS.canvas).sort();
check("中英文画布词条结构一致", JSON.stringify(zhCanvasPaths) === JSON.stringify(enCanvasPaths));
check("英文画布词条不残留中文", !/[\p{Script=Han}]/u.test(JSON.stringify(enUS.canvas)));
check("内置音频节点标签中英文完整", Boolean(zhCN.assets.kinds.audio) && Boolean(enUS.assets.kinds.audio));

check("普通画布顶栏协作、分享与同步状态走 i18n", /t\("canvas\.collaborating"/.test(topBar) && /t\("canvas\.share\.openCanvas"/.test(topBar) && /t\("canvas\.sync\./.test(topBar));
check("本地 Agent 紧凑状态走 i18n", /t\("canvas\.agentConnected"/.test(topBar) && /t\("canvas\.agentConnecting"/.test(topBar));
check("共享画布顶栏动作与状态走 i18n", /function SharedCanvasTopBar[\s\S]{0,1800}?useTranslation\(\)/.test(project) && /t\("canvas\.share\./.test(project));
check("画布分享、素材与导出提示走 i18n", ["未找到当前画布", "正在导出当前画布…", "请先登录，登录后会继续保存到你的账号", "已保存到你的画布", "保存到我的账号失败", "请先登录后再加入我的资产", "没有可保存的视频", "保存视频失败", "没有可保存的图片", "保存图片失败", "拖入的图片信息无法识别", "图片资产无法读取，请重新上传", "插入资产失败", "服务端生成暂不支持蒙版编辑"].every((text) => !project.includes(`\"${text}\"`)));
check("画布生成失败兜底走 i18n", !project.includes('"页面刷新后生成已中断，请重新生成。"') && !project.includes('"生成失败"'));
check("引用删除提示走 i18n", /useTranslation\(\)/.test(mention) && /t\("canvas\.composer\.referenceDeleted"\)/.test(mention));
check("插件模型未配置提示走 i18n", /t\("canvas\.plugins\.aiConfigRequired"\)/.test(pluginHost));

console.log("画布云端 Agent 英文完整性契约");
check("中英文云端 Agent 词条结构一致", Boolean(zhCN.agent.cloud) && JSON.stringify(leafPaths(zhCN.agent.cloud).sort()) === JSON.stringify(leafPaths(enUS.agent.cloud).sort()));
check("英文云端 Agent 词条不残留中文", Boolean(enUS.agent.cloud) && !/[\p{Script=Han}]/u.test(JSON.stringify(enUS.agent.cloud)));
check("云端 Agent 面板可见文案走 i18n", /useTranslation\(\)/.test(cloudPanel) && !["删除会话？", "新会话", "收起对话", "当前画布还没有会话", "匿名访客的 Agent 历史保存在当前浏览器"].some((text) => cloudPanel.includes(text)));
check("云端 Agent 输入区可见文案走 i18n", /useTranslation\(\)/.test(cloudComposer) && !["松手把这个节点作为引用插进光标位置", "上传图片，可拖到画布上", "移除图片"].some((text) => cloudComposer.includes(text)));
check("Agent 模式切换走 i18n", /useTranslation\(\)/.test(agentModeSwitch) && !/label: "系统模型"|label: "本地 Agent"|aria-label="切换 Agent 模式"/.test(agentModeSwitch));
check("云端 Agent 模式词条完整", ["cloud", "cloudDescription", "local", "localDescription", "switch"].every((key) => zhCN.agent.cloud.mode?.[key] && enUS.agent.cloud.mode?.[key]));
check("云端 Agent 输入区引用词条完整", ["drop", "draggable", "uploadHint"].every((key) => zhCN.agent.cloud.references?.[key] && enUS.agent.cloud.references?.[key]));
check("搜索结果卡走 i18n", /useTranslation\(\)/.test(agentSearchCard) && !/条结果|原始结果/.test(agentSearchCard));
check("云端 Agent 格式化输出走 i18n", /from "@\/i18n"/.test(cloudFormat) && /agent\.cloud\.tools\./.test(cloudFormat));
check("云端 Agent 引用类型走 i18n", /from "@\/i18n"/.test(cloudReferences) && /agent\.cloud\.references\./.test(cloudReferences));

console.log("账号区域英文完整性契约");
check("中英文顶栏用户词条结构一致", Boolean(zhCN.topNav.user) && JSON.stringify(leafPaths(zhCN.topNav.user).sort()) === JSON.stringify(leafPaths(enUS.topNav.user).sort()));
check("中英文账号词条结构一致", Boolean(zhCN.account) && JSON.stringify(leafPaths(zhCN.account).sort()) === JSON.stringify(leafPaths(enUS.account).sort()));
check("英文账号区域词条不残留中文", Boolean(enUS.topNav.user) && Boolean(enUS.account) && !/[\p{Script=Han}]/u.test(JSON.stringify({ user: enUS.topNav.user, account: enUS.account })));
check(
    "账号区域可见文案走 i18n",
    [userStatusActions.replace(/"中"/g, ""), accountSettingsModal, passkeyManager].every((source) => !/[\p{Script=Han}]/u.test(sourceWithoutComments(source))),
);
check("中英文登录词条结构一致", Boolean(zhCN.auth) && JSON.stringify(leafPaths(zhCN.auth).sort()) === JSON.stringify(leafPaths(enUS.auth).sort()));
check("英文登录词条不残留中文", Boolean(enUS.auth) && !/[\p{Script=Han}]/u.test(JSON.stringify(enUS.auth)));
check("登录与 OAuth 可见文案走 i18n", /useTranslation\(\)/.test(loginModal) && !/[\p{Script=Han}]/u.test(sourceWithoutComments(loginModal)));
check(
    "登录动态词条完整",
    ["registered", "signedIn"].every((key) => zhCN.auth?.success?.[key] && enUS.auth?.success?.[key]) &&
        ["createAccount", "signInTitle", "registerAndSignIn", "signIn", "hasAccount", "noAccount"].every((key) => zhCN.auth?.form?.[key] && enUS.auth?.form?.[key]),
);
check("中英文偏好设置词条结构一致", Boolean(zhCN.config.preferences) && JSON.stringify(leafPaths(zhCN.config.preferences).sort()) === JSON.stringify(leafPaths(enUS.config.preferences).sort()));
check("英文偏好设置词条不残留中文", Boolean(enUS.config.preferences) && !/[\p{Script=Han}]/u.test(JSON.stringify(enUS.config.preferences)));
check("偏好设置可见文案走 i18n", /useTranslation\(\)/.test(appConfigModal) && !/[\p{Script=Han}]/u.test(sourceWithoutComments(appConfigModal)));
check(
    "偏好设置动态词条完整",
    ["image", "video", "text", "audio"].every((key) => zhCN.config.preferences?.models?.[key] && enUS.config.preferences?.models?.[key]) &&
        ["default", "transparent"].every((key) => zhCN.config.preferences?.background?.[key] && enUS.config.preferences?.background?.[key]),
);
check("本地 Agent 分享限制提示走 i18n", /rt\("shareCanvasScopeOnly"\)/.test(localPanel) && /rt\("toolRejected"/.test(localPanel) && !localPanel.includes('"分享画布仅允许 Agent 操作当前画布，不能使用账号级工具或跳转页面"'));
check("本地 Agent 画布引用提示随语言切换", /tr\("canvasReferencesTask"\)/.test(eventFormatters) && /tr\("canvasReferencesInstruction"\)/.test(eventFormatters) && !eventFormatters.includes('"请处理引用的画布素材。"'));
check("工具卡去重不依赖硬编码中文", /i18n\.t\("agent\.eventExtra\.tools\.readCanvas"\)/.test(chatMessage) && /i18n\.t\("agent\.eventMore\.canvasRead"\)/.test(chatMessage));
check("画布页不保留已迁移的中文反推提示常量", !project.includes("IMAGE_PROMPT_REVERSE_PRESET"));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
