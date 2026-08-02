import "reflect-metadata";

import express from "express";

import { config } from "./config";
import { errorJson, notFoundJson, ok } from "./lib/response";
import { adminRouter } from "./routes/admin";
import { adminReviewRouter } from "./routes/admin-review";
import { agentRouter } from "./routes/agent";
import { aiRouter } from "./routes/ai";
import { adminUserRouter, authRouter } from "./routes/auth";
import { fileRouter } from "./routes/files";
import { inviteRouter } from "./routes/invites";
import { jobRouter } from "./routes/jobs";
import { passkeyRouter } from "./routes/passkey";
import { preferenceRouter } from "./routes/preferences";
import { publicRouter } from "./routes/public";
import { shareRouter } from "./routes/share";
import { syncRouter } from "./routes/sync";

export function createApp() {
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "32mb" }));
    app.use(express.urlencoded({ extended: true, limit: "32mb" }));

    // 前端可以部署在别的域名（例如 Vercel）后再连自建服务端。
    app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
        // 分享页会同时带访客凭据与账号 JWT，两个自定义头必须在允许列表里，否则跨域部署下浏览器直接把请求拦在预检。
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Client-Id, X-Share-Guest, X-User-Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        return next();
    });

    // 分享页不进搜索引擎索引。响应头这一层管的是代理与非 HTML 资源，页面里的 meta 和 robots.txt 各管一段抓取路径。
    app.use("/s", (_req, res, next) => {
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        next();
    });

    const api = express.Router();
    api.get("/health", (_req, res) => ok(res, "ok"));
    api.use(authRouter);
    api.use(inviteRouter);
    api.use(passkeyRouter);
    api.use(preferenceRouter);
    api.use(publicRouter);
    api.use(fileRouter);
    api.use(jobRouter);
    api.use(shareRouter);
    api.use(syncRouter);
    api.use(aiRouter);
    api.use(agentRouter);
    api.use("/admin", adminUserRouter);
    api.use("/admin", adminRouter);
    api.use("/admin", adminReviewRouter);

    app.use("/api", api);
    app.use("/api", notFoundJson);
    app.use(errorJson);
    return app;
}
