import type { NextFunction, Request, RequestHandler, Response } from "express";

import { failResponse } from "../lib/response";
import { currentAuthUser, type AuthUser } from "../services/auth";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}

async function readUser(req: Request) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    return token.trim() ? currentAuthUser(token) : null;
}

function guard(check: (user: AuthUser | null) => boolean): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        readUser(req)
            .then((user) => {
                // 用 401 而不是 200 + code:1，前端才能可靠识别登录态失效并清理本地会话。
                if (!check(user)) return failResponse(res.status(401), "未登录或权限不足");
                if (user) req.user = user;
                next();
            })
            .catch(() => failResponse(res.status(401), "未登录或权限不足"));
    };
}

export const userAuth = guard((user) => Boolean(user && user.role !== "guest"));
export const adminAuth = guard((user) => user?.role === "admin");
export const optionalAuth = guard(() => true);

/** 已通过 userAuth/adminAuth 的路由里取当前用户。 */
export function requireUser(req: Request) {
    if (!req.user) throw new Error("missing authenticated user");
    return req.user;
}
