import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { optionalAuth } from "../middleware/auth";
import { listAssets } from "../services/assets";
import { listPrompts } from "../services/prompts";
import { publicSettings } from "../services/settings";

export const publicRouter = Router();

publicRouter.get("/settings", handle(async (_req, res) => ok(res, await publicSettings())));

publicRouter.get("/prompts", optionalAuth, handle(async (req, res) => ok(res, await listPrompts(parseQuery(req)))));

publicRouter.get("/assets", optionalAuth, handle(async (req, res) => ok(res, await listAssets(parseQuery(req)))));
