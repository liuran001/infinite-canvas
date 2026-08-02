import type { NextFunction, Request, RequestHandler, Response } from "express";

import { failResponse } from "../lib/response";
import { currentAuthUser, type AuthUser } from "../services/auth";
import { verifyGuestToken, type GuestSession } from "../services/project-share";
import type { AccessContext } from "../services/project-access";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: AuthUser;
            guest?: GuestSession;
        }
    }
}

function bearer(value: unknown) {
    return String(value || "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * 一次解析出请求身份。分享访客拿的是服务端签发的 guest 令牌，
 * 必须和账号身份分得清清楚楚：guest 只能编辑被分享的那张画布，绝不是「以所有者身份用系统」。
 *
 * 分享页会同时存在两种身份：Authorization 被访客凭据占着，账号 JWT 只能另走 X-User-Authorization。
 * 「匿名进来看了一圈再登录，然后保存到自己账号」就靠这一条，两个头都按同一套签名校验，谁也不比谁松。
 */
async function readPrincipal(req: Request) {
    const token = bearer(req.headers.authorization);
    const guest = token ? verifyGuestToken(token) : null;
    const accountToken = bearer(req.headers["x-user-authorization"]) || (guest ? "" : token);
    const user = accountToken ? await currentAuthUser(accountToken) : null;
    return { user, guest };
}

function guard(check: (user: AuthUser | null) => boolean, allowGuest: boolean): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        readPrincipal(req)
            .then(({ user, guest }) => {
                if (user) req.user = user;
                if (guest) req.guest = guest;
                // 带着账号身份就按账号判权，哪怕这条请求同时挂着访客凭据。
                if (check(user)) return next();
                if (guest) {
                    // 分享访客带着合法凭证走到了不该他用的接口：这是权限不足而不是登录态失效，
                    // 回 401 会让前端把访客的会话清掉，页面直接白掉。
                    if (!allowGuest) return failResponse(res.status(403), "分享访客无法使用该功能");
                    return next();
                }
                // 用 401 而不是 200 + code:1，前端才能可靠识别登录态失效并清理本地会话。
                return failResponse(res.status(401), "未登录或权限不足");
            })
            .catch(() => failResponse(res.status(401), "未登录或权限不足"));
    };
}

export const userAuth = guard((user) => Boolean(user && user.role !== "guest"), false);
export const adminAuth = guard((user) => user?.role === "admin", false);
export const optionalAuth = guard(() => true, true);
/** 画布资源入口：账号与分享访客都放行，具体能不能碰这张画布交给 resolveProjectAccess 判。 */
export const projectAuth = guard((user) => Boolean(user && user.role !== "guest"), true);

/** 已通过 userAuth/adminAuth 的路由里取当前用户。 */
export function requireUser(req: Request) {
    if (!req.user) throw new Error("missing authenticated user");
    return req.user;
}

/** 交给 resolveProjectAccess 的请求身份。 */
export function accessContext(req: Request): AccessContext {
    return { user: req.user ? { id: req.user.id, displayName: req.user.displayName || req.user.username, avatarUrl: req.user.avatarUrl || "" } : null, guest: req.guest || null };
}
