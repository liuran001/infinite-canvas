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

/** 元素可能压根不存在，isVisible() 会抛；统一收敛成布尔，断言才不会因为一次异常整体崩掉。 */
function isVisible(locator) {
    return locator.isVisible().catch(() => false);
}

/**
 * 前置步骤没成功时，后面的断言不能在一个错误的页面上继续跑——那样只会报出一堆无关的失败，
 * 真正的原因反而被埋住。但也不能让它们悄悄消失，所以按失败记账并写明原因。
 */
function skip(names, reason) {
    names.forEach((name) => check(name, false, reason));
}

async function main() {
    const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    // 前端默认连同源 /api，dev server 没有代理，这里把服务端地址注入本地存储。
    // 只在首次写入：addInitScript 每次导航都会重跑，无条件覆盖会把登录拿到的令牌清掉，
    // 后续访问二级页面就会被登录守卫踢回首页。
    await context.addInitScript((api) => {
        const key = "infinite-canvas:server_store";
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: { mode: "on", baseUrl: api, token: "", syncedAt: "" }, version: 0 }));
    }, API);

    let page = await context.newPage();
    const errors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console: ${msg.text().slice(0, 200)}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${String(error).slice(0, 200)}`));

    // 每一段自己申报预期内的控制台错误，绝不在这里全局放行某个状态码：
    // 一旦全局忽略 400，「某个页面把请求打坏了」和「这条断言故意造出来的失败」就共用一个出口，
    // 前者从此再也不会让脚本变红。申报的范围只到下一次导航为止。
    let expectedErrors = [];
    /**
     * 清空上一段的错误并申报这一段预期内的。裸 goto 也必须走它：
     * 漏一次的话，上一段申报的白名单会一直延续到脚本结束，替后面所有段落挡枪。
     */
    const resetErrors = (expected = []) => {
        errors.length = 0;
        expectedErrors = expected;
    };
    const visit = async (path, waitFor, expected = []) => {
        resetErrors(expected);
        await page.goto(`${WEB}${path}`, { waitUntil: "networkidle", timeout: 45000 });
        if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);
    };
    // 忽略与本次改动无关的噪音（favicon、devtools、第三方图片 CDN）
    const realErrors = () => errors.filter((e) => !/favicon|DevTools|net::ERR_(NAME_NOT_RESOLVED|CONNECTION)|jsdelivr|githubusercontent/i.test(e) && !expectedErrors.some((pattern) => pattern.test(e)));
    /** 申报了却没出现，说明这条白名单已经过期：留着它只会在以后替真故障挡枪，必须报出来让人删掉。 */
    const missingExpected = () => expectedErrors.filter((pattern) => !errors.some((item) => pattern.test(item)));

    console.log("公开页面");
    await visit("/", "h1");
    check("首页可渲染", await page.locator("h1").first().isVisible());
    check("首页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    // 未登录访问二级页面应当被守卫挡回首页并弹出登录框，顺带验证守卫本身。
    await visit("/canvas");
    await page.waitForTimeout(800);
    check("未登录访问画布被挡回首页", new URL(page.url()).pathname === "/", `当前地址 ${page.url()}`);
    check("被挡回后弹出登录框", (await page.getByRole("button", { name: /^登录$/ }).count()) > 0);
    check("登录守卫无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    console.log("注册与登录");
    await page.getByText("还没有账号？立即注册").first().click();
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

    // 系统模型模式由后台开关控制，关掉时面板只剩本地 Agent，下面的断言都要跟着实际配置走。
    const agentSettings = await page.evaluate(async (api) => {
        const response = await fetch(`${api}/api/settings`);
        const data = (await response.json()).data;
        return { enabled: Boolean(data?.agent?.enabled), image: data?.capabilities?.image !== false };
    }, API);
    const cloudAgentEnabled = agentSettings.enabled;
    if (cloudAgentEnabled) {
        // 「Agent 默认模型」是独立的偏好项：面板里的即时切换只管当前会话，新建会话起手用的是这里，且跟随账号云端同步。
        await visit("/config");
        check("偏好设置里有 Agent 默认模型", (await page.getByText("Agent 默认模型").count()) > 0);
        // Agent 自己调生成工具时用的默认参数：模型不传就按这里补齐，和工作台的默认分开配。
        check("偏好设置里有 Agent 生成默认设置", (await page.getByText("Agent 生成默认设置").count()) > 0);
        check("偏好设置里有 Agent 默认生文模型", (await page.getByRole("combobox", { name: "选择 Agent 默认生文模型" }).count()) > 0);
        if (agentSettings.image) {
            check("偏好设置里有 Agent 默认生图模型", (await page.getByRole("combobox", { name: "选择 Agent 默认生图模型" }).count()) > 0);
            const imageFields = await Promise.all(["Agent 默认生图尺寸", "Agent 默认生图画质", "Agent 默认生图张数", "Agent 默认生图背景"].map((label) => page.getByText(label, { exact: true }).count()));
            check(
                "偏好设置里有 Agent 默认生图参数",
                imageFields.every((count) => count > 0),
                `各项匹配数 ${JSON.stringify(imageFields)}`,
            );
        }
        check("偏好设置无运行时报错", realErrors().length === 0, realErrors().join("\n       "));
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

    console.log("画布 Agent 面板");
    await page.getByRole("button", { name: "Agent", exact: true }).last().click();
    await page.waitForTimeout(1200);
    const panelOpened = (await page.getByRole("tablist", { name: "Agent 面板" }).count()) > 0;
    check("Agent 面板可打开", panelOpened);
    const modeSwitch = page.getByRole("button", { name: "切换 Agent 模式" });
    if (cloudAgentEnabled) {
        check("默认进入系统模型模式", (await modeSwitch.count()) > 0 && (await modeSwitch.first().innerText()).includes("系统模型"));
        check("系统模型面板说明按消息计费", (await page.getByText(/每条消息 \d+ 点/).count()) > 0);
        // 计费口径是「每发一条消息扣一次」，面板上不能再出现按轮计费的说法，否则和实际扣费自相矛盾。
        check("面板不再出现按轮计费的说法", (await page.getByText(/按轮计费|每轮/).count()) === 0);
        check("系统模型面板能上传图片", (await page.getByRole("button", { name: "上传图片" }).count()) > 0);
        // 模型现在由用户自己选：选择器要在输入框里，并且显示当前这个会话实际在用的模型（不是「选择模型」占位）。
        const modelPicker = page.getByRole("combobox", { name: "选择系统模型" });
        check("系统模型面板能选模型", (await modelPicker.count()) > 0);
        const pickedModel = (await modelPicker.count()) ? (await modelPicker.first().innerText()).trim() : "";
        check("模型选择器显示当前在用的模型", Boolean(pickedModel) && !pickedModel.includes("选择模型"), `当前显示「${pickedModel}」`);
        // 切到本地再切回来，确认两种模式都能挂载，本地 Agent 没有被云端模式挤坏。
        await modeSwitch.first().click();
        await page.getByRole("menuitem", { name: /本地 Agent/ }).click();
        await page.waitForTimeout(800);
        check("可切换到本地 Agent 模式", (await page.getByRole("tab", { name: /连接/ }).count()) > 0);
        await modeSwitch.first().click();
        await page.getByRole("menuitem", { name: /系统模型/ }).click();
        await page.waitForTimeout(800);
        check("可切回系统模型模式", (await page.getByText(/每条消息 \d+ 点/).count()) > 0);
        check("切回来后模型选择器还在", (await page.getByRole("combobox", { name: "选择系统模型" }).count()) > 0);
    } else {
        check("未开放系统模型时只保留本地 Agent", (await modeSwitch.count()) === 0);
    }
    check("Agent 面板无运行时报错", realErrors().length === 0, realErrors().join("\n       "));
    await page.screenshot({ path: "ui-check-agent.png" }).catch(() => {});

    console.log("画布分享");
    const projectUrl = page.url();
    await page.goto(projectUrl, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(1200);
    resetErrors();
    const shareButton = page.getByRole("button", { name: "分享", exact: true });
    check("画布页有分享入口", (await shareButton.count()) > 0);
    if (await shareButton.count()) {
        await shareButton.first().click();
        await page.waitForTimeout(900);
        check("分享面板可打开", (await page.getByText("新建链接").count()) > 0);
        check("分享面板有角色切换", (await page.getByText("可编辑", { exact: true }).count()) > 0);
        check("分享面板有匿名开关", (await page.getByText("允许匿名访问").count()) > 0);
        check("分享面板有克隆开关", (await page.getByText("允许保存到自己账号").count()) > 0);
        check("分享面板有过期设置", (await page.getByText("过期时间").count()) > 0);
        check("分享面板无运行时报错", realErrors().length === 0, realErrors().join("\n       "));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
    }

    // 分享页在登录守卫之外：无效 token 也应当渲染失效提示，而不是被踢回首页。
    await visit("/s/invalid-token-for-ui-check");
    check("无效分享链接渲染失效提示", (await page.getByText("链接不存在或已失效").count()) > 0, `当前地址 ${page.url()}`);
    check("分享页不会被登录守卫踢回首页", new URL(page.url()).pathname.startsWith("/s/"), `当前地址 ${page.url()}`);
    const robotsMeta = await page
        .locator('head meta[name="robots"]')
        .getAttribute("content")
        .catch(() => null);
    check("分享页注入 robots meta", (robotsMeta || "").includes("noindex"), `当前值 ${robotsMeta}`);
    const robotsTxt = await page.evaluate(async (web) => (await fetch(`${web}/robots.txt`)).text(), WEB);
    check("robots.txt 屏蔽 /s/", robotsTxt.includes("Disallow: /s/"));
    check("分享页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    // 离开分享页后运行时注入的 meta 必须被清理，否则整站都会带上 noindex。
    await visit("/");
    const leftover = await page.locator('head meta[name="robots"]').count();
    check("离开分享页后清理 robots meta", leftover === 0);

    console.log("团队前台");
    // check(名称, 是否通过, 失败详情)：这里统一把断言写成布尔比较，
    // 传一个非空字符串或数字进去会被当成「通过」，等于这条断言从此再也失败不了。
    await visit("/teams");
    check("团队列表页可打开", await isVisible(page.getByText("我的团队").first()));
    check("无团队时显示创建引导", await isVisible(page.getByRole("button", { name: /创建团队/ }).first()));
    check("提供手输邀请码入口", await isVisible(page.getByPlaceholder(/邀请码/).first()));

    await page
        .getByRole("button", { name: /创建团队/ })
        .first()
        .click();
    await page.getByLabel("团队名称").fill("UI 验证团队");
    // antd 会在两个汉字的按钮里插一个空格，可访问名因此是「确 定」，写死两字会永远等不到。
    await page.getByRole("button", { name: /确\s*定/ }).click();
    // 超时不能吞：吞掉的话下面全部断言会在一个错误的页面上继续跑，最后报一堆和真正原因无关的失败。
    const entered = await page
        .waitForURL(/\/teams\/team-/, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
    check("创建团队后跳进详情页", entered, `当前地址 ${page.url()}`);
    const uiTeamId = entered ? new URL(page.url()).pathname.split("/")[2] || "" : "";

    if (entered) {
        check("创建后进入团队详情", await isVisible(page.getByText("UI 验证团队").first()));
        check("详情页展示团队积分", await isVisible(page.getByText(/团队积分/).first()));

        await page.getByRole("link", { name: "成员" }).click();
        await page.waitForTimeout(800);
        check("成员页展示自己为 owner", await isVisible(page.getByText("owner").first()));

        await page.getByRole("link", { name: "邀请" }).click();
        await page.waitForTimeout(800);
        await page
            .getByRole("button", { name: /生成邀请链接/ })
            .first()
            .click();
        await page.waitForTimeout(1000);
        check("生成后展示可复制的完整链接", await isVisible(page.getByRole("button", { name: /复制链接/ }).first()));
        await page.keyboard.press("Escape");
        await page
            .getByRole("button", { name: /生成邀请码/ })
            .first()
            .click();
        await page.waitForTimeout(1000);
        const inviteCode = await page
            .getByTestId("team-invite-code")
            .first()
            .innerText()
            .catch(() => "");
        check("邀请码常驻可见", inviteCode.trim().length === 10, `当前值「${inviteCode.trim()}」`);
    } else {
        skip(["创建后进入团队详情", "详情页展示团队积分", "成员页展示自己为 owner", "生成后展示可复制的完整链接", "邀请码常驻可见"], "没有进入团队详情页，依赖它的断言无法执行");
    }

    // 这一段故意用一个不存在的 token，预期服务端回 400；只在这一次导航里放行它。
    await visit("/join/not-a-real-token", null, [/status of 400/]);
    check("无效邀请链接给出明确提示", await isVisible(page.getByText(/邀请链接无效或已失效/).first()));
    check("无效邀请确实被服务端拒绝", missingExpected().length === 0, "预期内的 400 没有出现，这条白名单已经过期");
    check("团队页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));

    console.log("余额实时同步与回落开关");
    await visit("/config");
    const fallback = page.getByRole("switch", { name: /团队积分用尽时/ });
    check("设置页存在回落开关", await isVisible(fallback.first()));
    check("回落开关默认关闭", (await fallback.first().getAttribute("aria-checked")) === "false");
    await fallback.first().click();
    // 偏好推送带 2 秒防抖，等不够就会在还没写到服务端时刷新，看到的自然还是旧值。
    await page.waitForTimeout(4000);
    await visit("/config");
    const persisted = await page
        .getByRole("switch", { name: /团队积分用尽时/ })
        .first()
        .getAttribute("aria-checked");
    check("回落开关状态被持久化", persisted === "true", `当前值 ${persisted}`);
    await page
        .getByRole("switch", { name: /团队积分用尽时/ })
        .first()
        .click();
    await page.waitForTimeout(800);

    if (uiTeamId) {
        // 充值只有平台管理员能做，这里单独换一次管理员令牌；下面的团队页仍然停留在普通用户的登录态。
        const teamAdminToken = await page.evaluate(
            async ([api, username, password]) => {
                const response = await fetch(`${api}/api/admin/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username, password }),
                });
                return (await response.json()).data?.token || "";
            },
            [API, process.env.UI_ADMIN || "admin", process.env.UI_ADMIN_PASSWORD || "infinite-canvas"],
        );
        // 团队详情页挂着一条常驻 SSE，networkidle 永远不会到，这里只等 DOM。
        resetErrors();
        await page.goto(`${WEB}/teams/${uiTeamId}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(2500);
        const before = await page
            .getByTestId("team-credits")
            .first()
            .innerText()
            .catch(() => "");
        // 直接从后端充值，页面不刷新，验证 SSE 真的把新余额推了下来。
        const topped = await page.evaluate(
            async ([api, id, token]) => {
                const response = await fetch(`${api}/api/admin/teams/${id}/credits`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ credits: 777, remark: "UI 实时验证" }),
                });
                return response.ok;
            },
            [API, uiTeamId, teamAdminToken],
        );
        const pushed = topped
            ? await page
                  .waitForFunction((prev) => document.querySelector('[data-testid="team-credits"]')?.textContent !== prev, before, { timeout: 8000 })
                  .then(() => true)
                  .catch(() => false)
            : false;
        const after = await page
            .getByTestId("team-credits")
            .first()
            .innerText()
            .catch(() => "");
        check("余额未刷新页面即更新", pushed && after.includes("777"), `充值 ${topped}，充值前「${before.trim()}」，充值后「${after.trim()}」`);
        check("团队详情页无运行时报错", realErrors().length === 0, realErrors().join("\n       "));
    } else {
        check("余额未刷新页面即更新", false, "没有拿到 UI 验证团队 id");
    }

    console.log("管理后台");
    // 凭据要当参数传进去：evaluate 的回调跑在浏览器里，那边没有 process。
    const adminToken = await page.evaluate(
        async ([api, username, password]) => {
            const response = await fetch(`${api}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
            });
            return (await response.json()).data?.token || "";
        },
        [API, process.env.UI_ADMIN || "admin", process.env.UI_ADMIN_PASSWORD || "infinite-canvas"],
    );
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
        ["/admin/invites", "邀请码"],
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
