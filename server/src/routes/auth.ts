import { Router } from "express";

import { fail } from "../lib/errors";
import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth, optionalAuth } from "../middleware/auth";
import {
    adjustUserCredits,
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

/** OAuth 回调统一重定向回前端登录页，令牌与错误都通过查询参数传递。 */
authRouter.get("/auth/linux-do/callback", async (req, res) => {
    const params = new URLSearchParams();
    try {
        const { session, redirect } = await loginWithLinuxDo(req, String(req.query.code || ""), String(req.query.state || ""));
        params.set("token", session.token);
        if (redirect) params.set("redirect", redirect);
    } catch (error) {
        params.set("error", error instanceof Error ? error.message : "Linux.do 登录失败");
        const redirect = (error as { redirect?: string }).redirect;
        if (redirect) params.set("redirect", redirect);
    }
    res.redirect(`${requestOrigin(req)}/login?${params}`);
});

export const adminUserRouter = Router();
adminUserRouter.use(adminAuth);
adminUserRouter.get("/users", handle(async (req, res) => ok(res, await listUsers(parseQuery(req)))));
adminUserRouter.post("/users", handle(async (req, res) => ok(res, await saveUser(req.body || {}, String(req.body?.password || "")))));
adminUserRouter.post("/users/:id/credits", handle(async (req, res) => ok(res, await adjustUserCredits(String(req.params.id), Number(req.body?.credits) || 0))));
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
