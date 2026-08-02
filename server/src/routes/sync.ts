import { Router } from "express";

import { fail } from "../lib/errors";
import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { resolveProjectAccess, type ProjectActor } from "../services/project-access";
import { listProjectPresence, removeProjectPresence, subscribeProject, updateProjectPresence, type ProjectActivity } from "../services/project-realtime";
import { deleteProject, deleteUserAsset, deleteUserPlugin, getProject, listProjects, listUserAssets, listUserPlugins, saveProject, saveUserAsset, saveUserPlugin } from "../services/sync";

export const syncRouter = Router();
syncRouter.use(userAuth);

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
function readClientId(value: unknown) {
    const clientId = String(value || "").trim();
    if (!CLIENT_ID.test(clientId)) throw fail("缺少有效的客户端标识", 400, "INVALID_CLIENT_ID");
    return clientId;
}
function actor(req: Parameters<typeof requireUser>[0]): ProjectActor {
    const user = requireUser(req);
    return { id: user.id, displayName: user.displayName || user.username, avatarUrl: user.avatarUrl || "" };
}

syncRouter.get("/v1/projects", handle(async (req, res) => ok(res, { items: await listProjects(requireUser(req).id, String(req.query.since || "")) })));

/** 一张画布一条 SSE，同时承载版本通知和 Presence，不再另外占浏览器连接。 */
syncRouter.get(
    "/v1/projects/:id/realtime",
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const clientId = readClientId(req.query.clientId);
        const sinceRevision = Math.max(0, Number.parseInt(String(req.query.sinceRevision || "0"), 10) || 0);
        const currentActor = actor(req);
        // 先订阅再读库，读权限和 revision 的 await 窗口里发生的保存会进入 buffered。
        let ownerId = currentActor.id;
        let reading = true;
        const buffered: unknown[] = [];
        let write: (event: unknown) => void = (event) => { buffered.push(event); };
        const unsubscribe = subscribeProject(ownerId, projectId, (event) => (reading ? buffered.push(event) : write(event)));
        let access;
        try {
            access = await resolveProjectAccess(currentActor, projectId, "read");
            ownerId = access.ownerId;
        } catch (error) {
            unsubscribe();
            throw error;
        }
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        write = (event: unknown) => void res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (access.project.revision > sinceRevision) write({ type: "project.saved", projectId, revision: access.project.revision, writerClientId: "" });
        write({ type: "ready", revision: access.project.revision, members: listProjectPresence(access.ownerId, projectId) });
        reading = false;
        buffered.forEach(write);
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
        req.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
            removeProjectPresence(access.ownerId, projectId, clientId);
        });
    }),
);

syncRouter.post(
    "/v1/projects/:id/presence",
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const currentActor = actor(req);
        const access = await resolveProjectAccess(currentActor, projectId, "read");
        const body = req.body || {};
        const clientId = readClientId(body.clientId);
        const activity = String(body.activity || "idle") as ProjectActivity;
        if (!["idle", "selecting", "editing"].includes(activity)) throw fail("无效的协作状态", 400, "INVALID_ACTIVITY");
        if (!Array.isArray(body.nodeIds) || body.nodeIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 128)) throw fail("无效的节点列表", 400, "INVALID_NODE_IDS");
        ok(res, { members: updateProjectPresence(access.ownerId, projectId, currentActor, { clientId, nodeIds: body.nodeIds, activity }) });
    }),
);

syncRouter.delete(
    "/v1/projects/:id/presence/:clientId",
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await resolveProjectAccess(actor(req), projectId, "read");
        ok(res, { members: removeProjectPresence(access.ownerId, projectId, readClientId(req.params.clientId)) });
    }),
);

syncRouter.get("/v1/projects/:id", handle(async (req, res) => ok(res, await getProject(requireUser(req).id, String(req.params.id)))));
syncRouter.put(
    "/v1/projects/:id",
    handle(async (req, res) => {
        const body = req.body || {};
        const revision = Number(body.revision);
        if (!Number.isInteger(revision) || revision < 0) throw fail("缺少有效的画布版本", 400, "INVALID_REVISION");
        const currentActor = actor(req);
        const projectId = String(req.params.id);
        // revision 0 允许创建；已有项目必须通过统一访问边界，避免未来分享接入时绕过权限。
        if (revision > 0) await resolveProjectAccess(currentActor, projectId, "write");
        ok(res, await saveProject(currentActor.id, { id: projectId, title: String(body.title || ""), data: body.data, revision, clientId: readClientId(body.clientId) }));
    }),
);
syncRouter.delete(
    "/v1/projects/:id",
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const currentActor = actor(req);
        await resolveProjectAccess(currentActor, projectId, "write");
        await deleteProject(currentActor.id, projectId, readClientId(req.headers["x-client-id"]));
        ok(res, true);
    }),
);

syncRouter.get("/v1/user-assets", handle(async (req, res) => ok(res, { items: await listUserAssets(requireUser(req).id, String(req.query.since || "")) })));
syncRouter.put("/v1/user-assets/:id", handle(async (req, res) => { const body = req.body || {}; ok(res, await saveUserAsset(requireUser(req).id, { id: String(req.params.id), kind: String(body.kind || "image"), title: String(body.title || ""), data: body.data, revision: body.revision })); }));
syncRouter.delete("/v1/user-assets/:id", handle(async (req, res) => { await deleteUserAsset(requireUser(req).id, String(req.params.id)); ok(res, true); }));
syncRouter.get("/v1/user-plugins", handle(async (req, res) => ok(res, { items: await listUserPlugins(requireUser(req).id, String(req.query.since || "")) })));
syncRouter.put("/v1/user-plugins/:id", handle(async (req, res) => { const body = req.body || {}; ok(res, await saveUserPlugin(requireUser(req).id, { id: String(req.params.id), data: body.data, revision: body.revision })); }));
syncRouter.delete("/v1/user-plugins/:id", handle(async (req, res) => { await deleteUserPlugin(requireUser(req).id, String(req.params.id)); ok(res, true); }));
