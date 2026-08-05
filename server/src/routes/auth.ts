import { Router } from "express";

import { fail, SafeError } from "../lib/errors";
import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth, optionalAuth, requireUser, userAuth } from "../middleware/auth";
import { cancelAccountDeletion, reactivateDeletedAccount, requestAccountDeletion } from "../services/account-deletion";
import {
    adjustUserCredits,
    adjustUserQuota,
    changePassword,
    completeLinuxDoRegister,
    deleteCreditLog,
    deleteUser,
    guestUser,
    linuxDoAuthorizeUrl,
    listCreditLogs,
    listUsers,
    login,
    loginWithLinuxDo,
    newSession,
    register,
    requestOrigin,
    saveCreditLog,
    saveUser,
    unbindLinuxDo,
    updateDisplayName,
} from "../services/auth";
import { verifyTurnstile } from "../services/turnstile";

export const authRouter = Router();

authRouter.post(
    "/auth/register",
    handle(async (req, res) => {
        await verifyTurnstile("register", String(req.body?.captchaToken || ""), req.ip || "");
        ok(res, await register(String(req.body?.username || ""), String(req.body?.password || ""), String(req.body?.inviteCode || "")));
    }),
);

authRouter.post(
    "/auth/login",
    handle(async (req, res) => {
        await verifyTurnstile("login", String(req.body?.captchaToken || ""), req.ip || "");
        ok(res, await login(String(req.body?.username || ""), String(req.body?.password || "")));
    }),
);

authRouter.post(
    "/admin/login",
    handle(async (req, res) => {
        await verifyTurnstile("login", String(req.body?.captchaToken || ""), req.ip || "");
        const session = await login(String(req.body?.username || ""), String(req.body?.password || ""));
        if (session.user.role !== "admin") throw fail("需要管理员权限");
        ok(res, session);
    }),
);

authRouter.get("/auth/me", optionalAuth, handle((req, res) => ok(res, req.user || guestUser())));

authRouter.get(
    "/auth/linux-do/authorize",
    handle(async (req, res) => {
        await verifyTurnstile("login", String(req.query.captchaToken || ""), req.ip || "");
        res.redirect(await linuxDoAuthorizeUrl(req, String(req.query.redirect || "/")));
    }),
);

/** 给已登录账号绑定 Linux.do。返回授权地址由前端跳转，回调走同一个 callback。 */
authRouter.get(
    "/auth/linux-do/bind",
    userAuth,
    handle(async (req, res) => {
        ok(res, { url: await linuxDoAuthorizeUrl(req, String(req.query.redirect || "/"), requireUser(req).id) });
    }),
);

authRouter.post(
    "/auth/linux-do/unbind",
    userAuth,
    handle(async (req, res) => ok(res, await unbindLinuxDo(requireUser(req).id))),
);

authRouter.post(
    "/auth/password",
    userAuth,
    handle(async (req, res) => {
        await changePassword(requireUser(req).id, String(req.body?.oldPassword || ""), String(req.body?.newPassword || ""));
        ok(res, true);
    }),
);

/** 用户自助改昵称。只收 displayName 一个字段，username 不在这条路径上，多传也不会被读。 */
authRouter.post(
    "/auth/profile",
    userAuth,
    handle(async (req, res) => ok(res, await updateDisplayName(requireUser(req).id, req.body?.displayName))),
);

/** 申请后 sessionVersion 立即递增，当前响应发完后所有设备的旧 JWT 都会失效。 */
authRouter.post("/auth/account-deletion/request", userAuth, handle(async (req, res) => ok(res, await requestAccountDeletion(requireUser(req).id))));

/** 登录凭据已经校验成功时，用短期恢复 token 明确取消注销并换发一套全新的登录态。 */
authRouter.post(
    "/auth/account-deletion/cancel",
    handle(async (req, res) => ok(res, await newSession(await cancelAccountDeletion(String(req.body?.resumeToken || ""))))),
);

/** OAuth 回调统一重定向回前端，令牌与错误都通过查询参数传递。 */
authRouter.get("/auth/linux-do/callback", async (req, res) => {
    const params = new URLSearchParams();
    let target = "/login";
    try {
        const { session, redirect, bound, pendingToken } = await loginWithLinuxDo(req, String(req.query.code || ""), String(req.query.state || ""));
        // 绑定场景用户本来就登录着，直接回原页面提示成功，不换发令牌。
        if (bound) {
            target = redirect || "/";
            params.set("bound", "linux-do");
        } else if (pendingToken) {
            // 新用户且要求邀请码：这里只发待注册凭据，绝不发令牌，用户在前端补完邀请码前始终是未登录状态。
            params.set("pendingToken", pendingToken);
            if (redirect) params.set("redirect", redirect);
        } else {
            params.set("token", session?.token || "");
            if (redirect) params.set("redirect", redirect);
        }
    } catch (error) {
        if (error instanceof SafeError && error.code === "ACCOUNT_DELETION_PENDING") {
            const data = (error.data || {}) as { resumeToken?: string; deletesAt?: string };
            params.set("deletionPending", "1");
            params.set("resumeToken", data.resumeToken || "");
            params.set("deletesAt", data.deletesAt || "");
        } else {
            params.set("error", error instanceof Error ? error.message : "Linux.do 授权失败");
        }
        const redirect = (error as { redirect?: string }).redirect;
        if (redirect) params.set("redirect", redirect);
    }
    res.redirect(`${requestOrigin(req)}${target}?${params}`);
});

/** 补交邀请码完成第三方注册。身份只认 pendingToken 里的签名内容，请求体不接受任何第三方身份字段。 */
authRouter.post(
    "/auth/linux-do/complete",
    handle(async (req, res) => {
        await verifyTurnstile("oauthComplete", String(req.body?.captchaToken || ""), req.ip || "");
        ok(res, await completeLinuxDoRegister(String(req.body?.pendingToken || ""), String(req.body?.inviteCode || "")));
    }),
);

export const adminUserRouter = Router();
adminUserRouter.use(adminAuth);
adminUserRouter.get("/users", handle(async (req, res) => ok(res, await listUsers(parseQuery(req)))));
adminUserRouter.post("/users", handle(async (req, res) => ok(res, await saveUser(req.body || {}, String(req.body?.password || "")))));
adminUserRouter.post("/users/:id/credits", handle(async (req, res) => ok(res, await adjustUserCredits(String(req.params.id), Number(req.body?.credits) || 0))));
adminUserRouter.post("/users/:id/quota", handle(async (req, res) => ok(res, await adjustUserQuota(String(req.params.id), Number(req.body?.quota) || 0))));
adminUserRouter.post(
    "/users/:id/reactivate",
    handle(async (req, res) => {
        const user = await reactivateDeletedAccount(String(req.params.id), String(req.body?.username || ""), String(req.body?.password || ""));
        ok(res, { ...user, password: "" });
    }),
);
adminUserRouter.delete(
    "/users/:id",
    handle(async (req, res) => {
        await deleteUser(String(req.params.id));
        ok(res, true);
    }),
);
adminUserRouter.get("/credit-logs", handle(async (req, res) => ok(res, await listCreditLogs(parseQuery(req)))));
adminUserRouter.post("/credit-logs", handle(async (req, res) => ok(res, await saveCreditLog(req.body || {}))));
adminUserRouter.delete(
    "/credit-logs/:id",
    handle(async (req, res) => {
        await deleteCreditLog(String(req.params.id));
        ok(res, true);
    }),
);
