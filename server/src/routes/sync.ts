import { Router } from "express";

import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { deleteProject, deleteUserAsset, deleteUserPlugin, getProject, listProjects, listUserAssets, listUserPlugins, saveProject, saveUserAsset, saveUserPlugin } from "../services/sync";

export const syncRouter = Router();
syncRouter.use(userAuth);

/** since 传上次同步时间即可增量拉取，返回结果包含软删除记录用于同步删除。 */
syncRouter.get("/v1/projects", handle(async (req, res) => ok(res, { items: await listProjects(requireUser(req).id, String(req.query.since || "")) })));

syncRouter.get("/v1/projects/:id", handle(async (req, res) => ok(res, await getProject(requireUser(req).id, String(req.params.id)))));

syncRouter.put(
    "/v1/projects/:id",
    handle(async (req, res) => {
        const body = req.body || {};
        ok(res, await saveProject(requireUser(req).id, { id: String(req.params.id), title: String(body.title || ""), data: body.data, revision: body.revision }));
    }),
);

syncRouter.delete(
    "/v1/projects/:id",
    handle(async (req, res) => {
        await deleteProject(requireUser(req).id, String(req.params.id));
        ok(res, true);
    }),
);

syncRouter.get("/v1/user-assets", handle(async (req, res) => ok(res, { items: await listUserAssets(requireUser(req).id, String(req.query.since || "")) })));

syncRouter.put(
    "/v1/user-assets/:id",
    handle(async (req, res) => {
        const body = req.body || {};
        ok(res, await saveUserAsset(requireUser(req).id, { id: String(req.params.id), kind: String(body.kind || "image"), title: String(body.title || ""), data: body.data, revision: body.revision }));
    }),
);

syncRouter.delete(
    "/v1/user-assets/:id",
    handle(async (req, res) => {
        await deleteUserAsset(requireUser(req).id, String(req.params.id));
        ok(res, true);
    }),
);

syncRouter.get("/v1/user-plugins", handle(async (req, res) => ok(res, { items: await listUserPlugins(requireUser(req).id, String(req.query.since || "")) })));

syncRouter.put(
    "/v1/user-plugins/:id",
    handle(async (req, res) => {
        const body = req.body || {};
        ok(res, await saveUserPlugin(requireUser(req).id, { id: String(req.params.id), data: body.data, revision: body.revision }));
    }),
);

syncRouter.delete(
    "/v1/user-plugins/:id",
    handle(async (req, res) => {
        await deleteUserPlugin(requireUser(req).id, String(req.params.id));
        ok(res, true);
    }),
);
