import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
const read = (relative) => readFileSync(join(root, relative), "utf8");
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
const retryLabel = modal.lastIndexOf("重新登录");
const retryBlock = retryLabel < 0 ? "" : modal.slice(Math.max(0, retryLabel - 500), retryLabel + 40);

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

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
