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
import { jobRouter } from "./routes/jobs";
import { passkeyRouter } from "./routes/passkey";
import { preferenceRouter } from "./routes/preferences";
import { publicRouter } from "./routes/public";
import { syncRouter } from "./routes/sync";

export function createApp() {
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json({ limit: "32mb" }));
    app.use(express.urlencoded({ extended: true, limit: "32mb" }));

    // 前端可以部署在别的域名（例如 Vercel）后再连自建服务端。
    app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
        if (req.method === "OPTIONS") return res.sendStatus(204);
        return next();
    });

    const api = express.Router();
    api.get("/health", (_req, res) => ok(res, "ok"));
    api.use(authRouter);
    api.use(passkeyRouter);
    api.use(preferenceRouter);
    api.use(publicRouter);
    api.use(fileRouter);
    api.use(jobRouter);
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
