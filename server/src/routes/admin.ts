import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth } from "../middleware/auth";
import { deleteAsset, listAssets, saveAsset } from "../services/assets";
import { deletePrompt, deletePromptCategory, deletePrompts, listPromptCategories, listPrompts, refreshPromptSyncScheduler, savePrompt, savePromptCategory, syncPromptCategory, syncRemotePromptCategories } from "../services/prompts";
import { adminSettings, fetchChannelModels, saveSettings, testChannelModel } from "../services/settings";

export const adminRouter = Router();
adminRouter.use(adminAuth);

adminRouter.get("/settings", handle(async (_req, res) => ok(res, await adminSettings())));

adminRouter.post(
    "/settings",
    handle(async (req, res) => {
        const settings = await saveSettings(req.body || {});
        // 提示词定时同步的 cron 存在系统设置里，保存后立即按新配置重建任务。
        await refreshPromptSyncScheduler();
        ok(res, settings);
    }),
);

adminRouter.post("/settings/channel-models", handle(async (req, res) => ok(res, await fetchChannelModels(req.body?.index, req.body?.channel || {}))));

adminRouter.post("/settings/channel-test", handle(async (req, res) => ok(res, await testChannelModel(req.body?.index, req.body?.channel || {}, String(req.body?.model || "")))));

adminRouter.get("/prompt-categories", handle(async (_req, res) => ok(res, await listPromptCategories())));

adminRouter.post("/prompt-categories", handle(async (req, res) => ok(res, await savePromptCategory(req.body || {}))));

adminRouter.delete(
    "/prompt-categories/:category",
    handle(async (req, res) => {
        await deletePromptCategory(String(req.params.category));
        ok(res, true);
    }),
);

adminRouter.post(
    "/prompt-categories/sync",
    handle(async (req, res) => {
        const category = String(req.body?.category || "").trim();
        ok(res, category ? [await syncPromptCategory(category)] : await syncRemotePromptCategories());
    }),
);

adminRouter.get("/prompts", handle(async (req, res) => ok(res, await listPrompts(parseQuery(req)))));

adminRouter.post("/prompts", handle(async (req, res) => ok(res, await savePrompt(req.body || {}))));

adminRouter.post(
    "/prompts/batch-delete",
    handle(async (req, res) => {
        await deletePrompts(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
        ok(res, true);
    }),
);

adminRouter.delete(
    "/prompts/:id",
    handle(async (req, res) => {
        await deletePrompt(String(req.params.id));
        ok(res, true);
    }),
);

adminRouter.get("/assets", handle(async (req, res) => ok(res, await listAssets(parseQuery(req)))));

adminRouter.post("/assets", handle(async (req, res) => ok(res, await saveAsset(req.body || {}))));

adminRouter.delete(
    "/assets/:id",
    handle(async (req, res) => {
        await deleteAsset(String(req.params.id));
        ok(res, true);
    }),
);
