import { randomUUID } from "node:crypto";

import { fail } from "../lib/errors";
import { getSettings } from "./settings";

export type TurnstileFlow = "login" | "register" | "oauthComplete";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const actionOf: Record<TurnstileFlow, string> = { login: "login", register: "register", oauthComplete: "oauth_complete" };

/**
 * Turnstile 只能作为服务端门禁：浏览器拿到 token 不代表它有效，必须把 token 和私有 Secret
 * 送回 Cloudflare 复核。三个入口分别读取自己的开关，关闭时完全跳过，不要求前端伪造空 token。
 */
export async function verifyTurnstile(flow: TurnstileFlow, token: string, remoteIp = "") {
    const settings = await getSettings();
    const config = settings.public.auth.turnstile;
    const enabled = flow === "login" ? config.loginEnabled : flow === "register" ? config.registerEnabled : config.oauthCompleteEnabled;
    if (!enabled) return;
    if (!config.siteKey || !settings.private.auth.turnstile.secretKey) throw fail("验证码未配置，请联系管理员");
    const responseToken = token.trim();
    if (!responseToken) throw fail("请先完成人机验证", 400, "CAPTCHA_REQUIRED");
    if (responseToken.length > 4096) throw fail("验证码无效，请重新验证", 400, "CAPTCHA_INVALID");

    const body = new URLSearchParams({
        secret: settings.private.auth.turnstile.secretKey,
        response: responseToken,
        idempotency_key: randomUUID(),
    });
    if (remoteIp) body.set("remoteip", remoteIp);
    const result = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
    }).catch(() => {
        throw fail("验证码校验失败，请重试", 502, "CAPTCHA_UNAVAILABLE");
    });
    if (!result.ok) throw fail("验证码校验失败，请重试", 502, "CAPTCHA_UNAVAILABLE");
    const payload = (await result.json().catch(() => null)) as { success?: boolean; action?: string } | null;
    // action 是前端 render 时固定的用途标签。缺失也不能放行，否则其它页面签出的 token
    // 或未配置 action 的旧组件可以跨入口复用。
    if (!payload?.success || payload.action !== actionOf[flow]) throw fail("验证码无效或已过期，请重新验证", 400, "CAPTCHA_INVALID");
}
