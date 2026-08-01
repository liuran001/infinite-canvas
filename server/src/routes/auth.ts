import { Router } from "express";

import { fail } from "../lib/errors";
import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth, optionalAuth, requireUser, userAuth } from "../middleware/auth";
import {
    adjustUserCredits,
    adjustUserQuota,
    changePassword,
    deleteCreditLog,
    deleteUser,
    guestUser,
    linuxDoAuthorizeUrl,
    listCreditLogs,
    listUsers,
    login,
    loginWithLinuxDo,
    register,
    requestOrigin,
    saveCreditLog,
    saveUser,
    unbindLinuxDo,
} from "../services/auth";

export const authRouter = Router();

authRouter.post("/auth/register", handle(async (req, res) => ok(res, await register(String(req.body?.username || ""), String(req.body?.password || "")))));

authRouter.post("/auth/login", handle(async (req, res) => ok(res, await login(String(req.body?.username || ""), String(req.body?.password || "")))));

authRouter.post(
    "/admin/login",
    handle(async (req, res) => {
        const session = await login(String(req.body?.username || ""), String(req.body?.password || ""));
        if (session.user.role !== "admin") throw fail("需要管理员权限");
        ok(res, session);
    }),
);

authRouter.get("/auth/me", optionalAuth, handle((req, res) => ok(res, req.user || guestUser())));

authRouter.get(
    "/auth/linux-do/authorize",
    handle(async (req, res) => {
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

/** OAuth 回调统一重定向回前端，令牌与错误都通过查询参数传递。 */
authRouter.get("/auth/linux-do/callback", async (req, res) => {
    const params = new URLSearchParams();
    let target = "/login";
    try {
        const { session, redirect, bound } = await loginWithLinuxDo(req, String(req.query.code || ""), String(req.query.state || ""));
        // 绑定场景用户本来就登录着，直接回原页面提示成功，不换发令牌。
        if (bound) {
            target = redirect || "/";
            params.set("bound", "linux-do");
        } else {
            params.set("token", session?.token || "");
            if (redirect) params.set("redirect", redirect);
        }
    } catch (error) {
        params.set("error", error instanceof Error ? error.message : "Linux.do 授权失败");
        const redirect = (error as { redirect?: string }).redirect;
        if (redirect) params.set("redirect", redirect);
    }
    res.redirect(`${requestOrigin(req)}${target}?${params}`);
});

export const adminUserRouter = Router();
adminUserRouter.use(adminAuth);
adminUserRouter.get("/users", handle(async (req, res) => ok(res, await listUsers(parseQuery(req)))));
adminUserRouter.post("/users", handle(async (req, res) => ok(res, await saveUser(req.body || {}, String(req.body?.password || "")))));
adminUserRouter.post("/users/:id/credits", handle(async (req, res) => ok(res, await adjustUserCredits(String(req.params.id), Number(req.body?.credits) || 0))));
adminUserRouter.post("/users/:id/quota", handle(async (req, res) => ok(res, await adjustUserQuota(String(req.params.id), Number(req.body?.quota) || 0))));
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
