// 分享通道的静态契约检查：确保分享态永远不会走到只认账号令牌的公共请求通道。
//
// 这类缺陷类型检查和构建都发现不了——两条通道的函数签名完全兼容，只是令牌来源不同。
// 而后端的 verify-share.ts 也测不到，因为断裂发生在纯前端的调用链里。
// 代价是真实的：分享页一旦走进公共通道拿到 401，readEnvelope 会清掉访客自己的账号会话，
// 于是"打开别人的分享链接"变成了"把自己从账号里踢出去"。
//
// 用法：node web/share-contract-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

console.log("分享通道契约");

const helpers = read("lib/canvas/canvas-generation-helpers.ts");
const sharePage = read("pages/share/share-canvas.tsx");

// hydrateCanvasImages 遇到 dataURL 图片会上传，而上传只认账号令牌。
// 分享页必须显式关掉这一步，否则匿名访客打开一张含 dataURL 节点的画布就会被登出。
check("hydrateCanvasImages 支持关闭上传", /allowUpload\s*=\s*true/.test(helpers), "缺少 allowUpload 开关，分享态无法阻止上传");
check("关闭上传时 dataURL 原样保留", /!content\.startsWith\("data:image\/"\)\s*\|\|\s*!allowUpload/.test(helpers), "allowUpload 没有真正拦住上传分支");

const hydrateCalls = [...sharePage.matchAll(/hydrateCanvasImages\(([^;]*?)\)\s*(?:\.then|\))/gs)];
check("分享页确实调用了图片水合", hydrateCalls.length > 0, "没找到调用，断言失效需要更新脚本");
check(
    "分享页每次水合都关掉上传",
    hydrateCalls.every((matched) => /allowUpload:\s*false/.test(matched[1])),
    `${hydrateCalls.filter((m) => !/allowUpload:\s*false/.test(m[1])).length} 处调用没传 allowUpload: false`,
);

// 分享页只能用分享通道；一旦直接引入公共 API 通道，就等于绕开了 guest 令牌与 401 保护。
check("分享页不直接引入公共 API 通道", !/from\s+"@\/services\/api\/server"/.test(sharePage.replace(/import type[^;]+;/g, "")), "分享页不应直接调用 serverApi");
check("分享页不直接引入上传工具", !/from\s+"@\/services\/image-storage"/.test(sharePage), "上传只认账号令牌，分享页不能直接用");

const shareApi = read("services/api/share.ts");
// 分享通道自己绝不能碰账号会话，这是它存在的理由。
check("分享通道不清除账号会话", !/clearSession\(\)/.test(shareApi), "分享请求失败不得清掉用户的登录态");
check("分享通道不弹登录框", !/setLoginOpen\(/.test(shareApi), "分享链接失效不该表现为账号掉线");

const shareSync = read("services/share-sync.ts");
// 链接被降级成只读后，前端要立刻收权，否则访客会一直编辑而改动全部存不上。
check("保存被拒时识别只读", /isShareReadOnly\(error\)/.test(shareSync), "403 只读没有单独处理，访客会持续编辑并丢改动");
check("识别只读后切换角色", /setRole\("viewer"\)/.test(shareSync), "识别到只读却没收权");
check("重连时同步服务端角色", /event\.role/.test(shareSync), "ready 事件带了角色但前端不读，降级要等到下次续期才生效");

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
