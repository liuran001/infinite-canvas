// 真实浏览器 UI 验证：跑通登录、主要页面与管理后台，重点抓运行时报错。
// 类型检查和构建都发现不了「组件渲染时抛异常」「用了已废弃的组件属性」这类问题，只有真跑一遍才知道。
//
// 用法：先分别起后端与前端，再执行
//   npm i --no-save playwright && npx playwright install chromium
//   node ui-check.mjs
// 端口非默认时用 UI_WEB / UI_API 覆盖，管理员账号用 UI_ADMIN / UI_ADMIN_PASSWORD 覆盖。
import { chromium } from "playwright";

// 端口与浏览器路径都可用环境变量覆盖，默认对应 README 里的本地开发端口。
const WEB = process.env.UI_WEB || "http://127.0.0.1:3000";
const API = process.env.UI_API || "http://127.0.0.1:8080";
const EXECUTABLE = process.env.UI_CHROMIUM || undefined;
let pass = 0;
let fail = 0;
const issues = [];

function check(name, ok, detail = "") {
    if (ok) {
        console.log(`  \x1b[32mOK\x1b[0m   ${name}`);
        pass += 1;
    } else {
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ""}`);
        fail += 1;
    }
}

async function main() {
    const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // 前端默认连同源 /api，dev server 没有代理，这里把服务端地址注入本地存储。
    await context.addInitScript((api) => {
        localStorage.setItem("infinite-canvas:server_store", JSON.stringify({ state: { mode: "on", baseUrl: api, token: "", syncedAt: "" }, version: 0 }));
    }, API);

    let page = await context.newPage();
    const errors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 200)}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${String(error).slice(0, 200)}`));

    const visit = async (path, waitFor) => {
        errors.length = 0;
        await page.goto(`${WEB}${path}`, { waitUntil: "networkidle", timeout: 45000 });
        if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);
    };
    // 忽略与本次改动无关的噪音（favicon、devtools、第三方图片 CDN）
    const realErrors = () => errors.filter((e) => !/favicon|DevTools|net::ERR_(NAME_NOT_RESOLVED|CONNECTION)|jsdelivr|githubusercontent/i.test(e));

    console.log("公开页面");
    await visit("/", "h1");
    check("首页可渲染", await page.locator("h1").first().isVisible());
    check("首页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    await visit("/login");
    check("登录页可渲染", (await page.getByRole("button", { name: /登录|注册并登录/ }).count()) > 0);
    check("登录页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    console.log("注册与登录");
    await page
        .getByRole("tab", { name: "注册" })
        .click()
        .catch(async () => {
            await page.getByText("注册", { exact: true }).first().click();
        });
    await page.waitForTimeout(400);
    // 随机用户名，脚本可以重复跑而不撞上「用户名已存在」。
    const username = `uitester-${Date.now().toString(36)}`;
    await page.getByPlaceholder("用户名").fill(username);
    await page.getByPlaceholder("密码").fill("uitester-pass");
    await page.getByRole("button", { name: "注册并登录" }).click();
    await page.waitForTimeout(2500);
    const loggedIn = await page.evaluate(() => {
        const raw = localStorage.getItem("infinite-canvas:server_store");
        return Boolean(raw && JSON.parse(raw).state?.token);
    });
    check("注册后拿到登录态", loggedIn);
    check("注册过程无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    console.log("主要页面");
    for (const [path, label] of [
        ["/", "首页"],
        ["/canvas", "画布列表"],
        ["/image", "生图工作台"],
        ["/prompts", "提示词库"],
        ["/assets", "我的资产"],
        ["/config", "偏好设置"],
    ]) {
        await visit(path);
        check(`${label}可打开且无运行时报错`, realErrors().length === 0, realErrors().join("\n       "));
    }

    console.log("画布详情");
    await visit("/canvas");
    const created = await page
        .getByRole("button", { name: /新建画布|新建/ })
        .first()
        .click()
        .then(() => true)
        .catch(() => false);
    await page.waitForTimeout(2500);
    check("能新建画布并进入", created && page.url().includes("/canvas/"), `当前地址 ${page.url()}`);
    check("画布页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));
    await page.screenshot({ path: "ui-check-canvas.png" }).catch(() => {});

    console.log("管理后台");
    const adminToken = await page.evaluate(async (api) => {
        const response = await fetch(`${api}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: process.env.UI_ADMIN || "admin", password: process.env.UI_ADMIN_PASSWORD || "infinite-canvas" }),
        });
        return (await response.json()).data?.token || "";
    }, API);
    check("管理员登录接口可用", Boolean(adminToken));

    // 用带管理员令牌的新 context：addInitScript 每次导航都会重跑，
    // 在旧 context 上补设 localStorage 会被它覆盖回空令牌。
    await page.close();
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await adminContext.addInitScript(
        ([api, token]) => {
            localStorage.setItem("infinite-canvas:server_store", JSON.stringify({ state: { mode: "on", baseUrl: api, token, syncedAt: "" }, version: 0 }));
        },
        [API, adminToken],
    );
    page = await adminContext.newPage();
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 200)}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${String(error).slice(0, 200)}`));

    for (const [path, label] of [
        ["/admin/users", "用户管理"],
        ["/admin/credit-logs", "算力点流水"],
        ["/admin/settings", "系统设置"],
        ["/admin/prompts", "提示词"],
        ["/admin/assets", "素材"],
        ["/admin/generations", "生成记录"],
        ["/admin/contents", "用户内容"],
    ]) {
        await visit(path);
        const notForbidden = (await page.getByText("无权访问管理后台").count()) === 0;
        check(`${label}页可打开`, notForbidden, notForbidden ? "" : "被权限拦截");
        check(`${label}页无运行时报错`, realErrors().length === 0, realErrors().join("\n       "));
    }
    await page.screenshot({ path: "ui-check-admin.png", fullPage: false }).catch(() => {});

    await browser.close();
    console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
    if (issues.length) console.log(issues.join("\n"));
    process.exit(fail ? 1 : 0);
}

main().catch((error) => {
    console.error("UI 验证脚本异常:", error);
    process.exit(1);
});
