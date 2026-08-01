import { Router } from "express";

import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { getPreferences, savePreferences } from "../services/preferences";

export const preferenceRouter = Router();

// 鉴权逐个路由挂，避免整个 router 的中间件拦下同层挂载的公开接口。
preferenceRouter.get("/v1/preferences", userAuth, handle(async (req, res) => ok(res, await getPreferences(requireUser(req).id))));

preferenceRouter.put("/v1/preferences", userAuth, handle(async (req, res) => ok(res, await savePreferences(requireUser(req).id, req.body || {}))));
