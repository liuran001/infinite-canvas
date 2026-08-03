import { Router } from "express";

import { handle, ok } from "../lib/response";
import { projectAuth } from "../middleware/auth";
import { issueTicket, TICKET_TTL_MS } from "../services/realtime-tickets";

// 只有一个端点，但仍单独成文件：它是 WebSocket 的唯一入口，混进别的路由文件后很难看出鉴权口径。
export const realtimeRouter = Router();

/**
 * 换一张 30 秒一次性的 WebSocket 票据。
 * 浏览器的 WebSocket 不能带 Authorization 头，而长期 JWT 与 guest 令牌一旦进 URL
 * 就会落到 nginx、CDN 与浏览器诊断日志里，所以只让短期票据出现在 query。
 * 账号与分享访客都能取票；票据只代表连接身份，具体订阅仍要各自查权限。
 */
realtimeRouter.post(
    "/v1/realtime/tickets",
    projectAuth,
    handle(async (req, res) => {
        const user = req.user;
        const identity = {
            userId: user ? user.id : "",
            displayName: user ? user.displayName || user.username : req.guest?.displayName || "",
            avatarUrl: (user ? user.avatarUrl : req.guest?.avatarUrl) || "",
            guest: user ? null : req.guest || null,
        };
        // 票据不进日志：这里返回的字符串就是一次可用的连接凭据。
        ok(res, { ticket: issueTicket(identity, Date.now()), expiresInMs: TICKET_TTL_MS });
    }),
);
