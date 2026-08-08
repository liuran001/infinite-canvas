import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
const read = (relative) => readFileSync(join(root, relative), "utf8");
const executableSource = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const hasHardcodedChinese = (source) => /(?:["'`][^"'`\n]*[\u3400-\u9fff]|>[^<>{}\n]*[\u3400-\u9fff][^<>{}\n]*<)/.test(executableSource(source));
let pass = 0;
let fail = 0;

function check(name, ok) {
    console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
    ok ? (pass += 1) : (fail += 1);
}

const api = read("services/api/server.ts");
const localData = read("services/account-local-data.ts");
const teamRealtime = read("services/team-realtime.ts");
const modal = read("components/layout/login-modal.tsx");
const userStatusActions = read("components/layout/user-status-actions.tsx");
const retryLabel = modal.lastIndexOf('auth.oauth.signInAgain');
const retryBlock = retryLabel < 0 ? "" : modal.slice(Math.max(0, retryLabel - 700), retryLabel + 80);

console.log("登录页 Turnstile 契约");
check("Passkey options 透传登录验证码", /passkeyLoginOptions:[\s\S]{0,260}?captchaToken[\s\S]{0,180}?jsonBody\(\{\s*username,\s*captchaToken\s*\}\)/.test(api));
check("Linux.do 授权地址透传登录验证码", /linuxDoAuthorizeUrl:[\s\S]{0,260}?captchaToken[\s\S]{0,260}?params\.set\("captchaToken",\s*captchaToken\)/.test(api));
check("Passkey 登录使用当前验证码", /passkeyLoginOptions\([^,]*,\s*captchaToken\)/.test(modal));
check("Linux.do 登录使用当前验证码", /linuxDoAuthorizeUrl\([^,]*,\s*captchaToken\)/.test(modal));
check("验证码未完成时第三方登录不可点击", /disabled:\s*captchaEnabled\s*&&\s*!captchaToken/.test(modal) && /disabled=\{item\.disabled\}/.test(modal));
check("注册模式不展示登录型第三方入口", /!isRegister\s*&&\s*thirdParty\.length/.test(modal));
check("补邀请码页重新登录会回到验证码登录框", /setLoginOpen\(true\)/.test(retryBlock) && /navigate\(redirect/.test(retryBlock) && !/linuxDoAuthorizeUrl/.test(retryBlock));
check("会话失效前保留账号 ID 用于清理本地数据", /const ownerId = useServerStore\.getState\(\)\.user\?\.id \|\| "";[\s\S]{0,180}?clearSession\(\);[\s\S]{0,260}?clearCurrentAccountLocalData\(ownerId\)/.test(api));
check("账号本地资产同时清理 IndexedDB 与降级 localStorage", /ACCOUNT_STORE_KEYS\.forEach\(\(key\) => localStorage\.removeItem\(key\)\)/.test(localData) && /ACCOUNT_STORE_KEYS\.map\(\(key\) => localforage\.removeItem\(key\)\)/.test(localData));
check("团队实时鉴权失效复用账号清理流程", /if \(response\.status === 401\) \{\s*expireAccountSession\(\);/.test(teamRealtime));
check("登录与 OAuth 界面不残留硬编码中文", /useTranslation\(\)/.test(modal) && !hasHardcodedChinese(modal));

console.log("用户顶栏入口契约");
check("顶栏不重新引入文档按钮", !/<a[^>]*href=\{DOCS_URL\}/.test(userStatusActions) && !/<BookOpen\b/.test(userStatusActions));
check("画布顶栏隐藏语言切换且保留主题按钮", /\{variant === "canvas" \? null : \(\s*<Tooltip[^>]*title=\{languageLabel\}[\s\S]{0,420}?changeAppLocale\(nextLocale\)[\s\S]{0,160}?<\/Tooltip>\s*\)\}\s*<AnimatedThemeToggler/.test(userStatusActions));

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
