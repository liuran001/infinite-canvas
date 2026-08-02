import { Router } from "express";

import { fail, FORBIDDEN } from "../lib/errors";
import { handle, ok } from "../lib/response";
import { createBufferedWriter, sseWriter } from "../lib/sse";
import { accessContext, projectAuth, requireUser, userAuth } from "../middleware/auth";
import { resolveProjectAccess } from "../services/project-access";
import { getProjectTeam, setProjectTeam } from "../services/project-team";
import { listProjectPresence, removeProjectPresence, subscribeProject, updateProjectPresence, type ProjectActivity } from "../services/project-realtime";
import { logShareAccess } from "../services/project-share";
import { deleteProject, deleteUserAsset, deleteUserPlugin, listProjects, listUserAssets, listUserPlugins, saveProject, saveUserAsset, saveUserPlugin, toProjectView } from "../services/sync";

export const syncRouter = Router();

const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
function readClientId(value: unknown) {
    const clientId = String(value || "").trim();
    if (!CLIENT_ID.test(clientId)) throw fail("缺少有效的客户端标识", 400, "INVALID_CLIENT_ID");
    return clientId;
}

syncRouter.get("/v1/projects", userAuth, handle(async (req, res) => ok(res, { items: await listProjects(requireUser(req).id, String(req.query.since || "")) })));

/** 一张画布一条 SSE，同时承载版本通知和 Presence，不再另外占浏览器连接。 */
syncRouter.get(
    "/v1/projects/:id/realtime",
    projectAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const clientId = readClientId(req.query.clientId);
        const sinceRevision = Math.max(0, Number.parseInt(String(req.query.sinceRevision || "0"), 10) || 0);
        const context = accessContext(req);
        // 先订阅再读库，读权限和 revision 的 await 窗口里发生的保存会进入 buffered。
        // 访客订阅的是所有者的频道，所以频道 id 只能取自 guest 令牌里的所有者，取访客自己的必然订阅到空频道。
        const ownerId = context.guest?.ownerId || context.user?.id || "";
        // sink 一开始什么都不做：响应头还没发，事件只能先进 stream 的缓冲，等 ready 写完再按序放行。
        let sink: (event: unknown) => void = () => undefined;
        const stream = createBufferedWriter((event) => sink(event));
        let keepAlive: NodeJS.Timeout | undefined;
        let released = false;
        // 清理必须在订阅之后立刻挂上：读库这段 await 里对端就可能断开，
        // 等到最后再注册的话，这中间断掉的连接不会有人退订，listener 和 Presence 就永久留在内存里。
        const release = () => {
            if (released) return;
            released = true;
            if (keepAlive) clearInterval(keepAlive);
            unsubscribe();
            removeProjectPresence(ownerId, projectId, clientId);
        };
        const unsubscribe = subscribeProject(ownerId, projectId, (event) => stream.push(event), { shareId: context.guest?.shareId, clientId, close: () => res.end() });
        req.on("close", release);
        let access;
        try {
            access = await resolveProjectAccess(context, projectId, "read");
            // 令牌里的所有者和库里对不上属于异常输入，直接按不存在处理，绝不改订阅频道。
            if (access.ownerId !== ownerId) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
        } catch (error) {
            release();
            throw error;
        }
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        // 写入统一走 sseWriter：连接可能在 flush 补发缓冲事件的中途被 disconnectShare 关掉，
        // 结束后再写会抛 ERR_STREAM_WRITE_AFTER_END，那一抛在 flush 的循环里会把剩余事件整段截断。
        sink = sseWriter(res);
        if (access.project.revision > sinceRevision) sink({ type: "project.saved", projectId, revision: access.project.revision, writerClientId: "" });
        stream.flush({ type: "ready", revision: access.project.revision, role: access.role, members: listProjectPresence(access.ownerId, projectId) });
        // keepalive 同理，而且更凶：它抛在定时器回调里，没有任何调用栈接得住，会直接掀翻整个进程。
        // 连接如果在读库期间就断了，req.close 早已跑过 release，这里再起定时器就没人清得掉了。
        if (res.writableEnded) return release();
        keepAlive = setInterval(() => {
            if (res.writableEnded) return clearInterval(keepAlive);
            res.write(": keep-alive\n\n");
        }, 25_000);
    }),
);

syncRouter.post(
    "/v1/projects/:id/presence",
    projectAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await resolveProjectAccess(accessContext(req), projectId, "read");
        const body = req.body || {};
        const clientId = readClientId(body.clientId);
        const activity = String(body.activity || "idle") as ProjectActivity;
        if (!["idle", "selecting", "editing"].includes(activity)) throw fail("无效的协作状态", 400, "INVALID_ACTIVITY");
        if (!Array.isArray(body.nodeIds) || body.nodeIds.some((id: unknown) => typeof id !== "string" || !id || id.length > 128)) throw fail("无效的节点列表", 400, "INVALID_NODE_IDS");
        ok(res, { members: updateProjectPresence(access.ownerId, projectId, access.actor, { clientId, nodeIds: body.nodeIds, activity }) });
    }),
);

syncRouter.delete(
    "/v1/projects/:id/presence/:clientId",
    projectAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await resolveProjectAccess(accessContext(req), projectId, "read");
        ok(res, { members: removeProjectPresence(access.ownerId, projectId, readClientId(req.params.clientId)) });
    }),
);

syncRouter.get(
    "/v1/projects/:id",
    projectAuth,
    handle(async (req, res) => ok(res, toProjectView((await resolveProjectAccess(accessContext(req), String(req.params.id), "read")).project))),
);
syncRouter.put(
    "/v1/projects/:id",
    projectAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        const revision = Number(body.revision);
        if (!Number.isInteger(revision) || revision < 0) throw fail("缺少有效的画布版本", 400, "INVALID_REVISION");
        const context = accessContext(req);
        const projectId = String(req.params.id);
        // revision 0 是本人新建画布；已有项目与分享访客一律先过统一访问边界。
        const access = revision > 0 || context.guest ? await resolveProjectAccess(context, projectId, "write") : null;
        // 写的是所有者的项目行。这里若用访客自己的 id，可编辑分享会在访客名下另开一份画布，
        // 所有者永远看不到访客的修改，实时广播也会分叉到两个频道。
        const ownerId = access ? access.ownerId : requireUser(req).id;
        const saved = await saveProject(ownerId, { id: projectId, title: String(body.title || ""), data: body.data, revision, clientId: readClientId(body.clientId) });
        if (access?.share) await logShareAccess(access.share, { actorId: access.actorId, isAnonymous: access.anonymous, event: "edit", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") });
        ok(res, saved);
    }),
);
syncRouter.delete(
    "/v1/projects/:id",
    projectAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await resolveProjectAccess(accessContext(req), projectId, "write");
        // 可编辑分享的边界是「改这张画布的内容」，删掉整张画布不在其中。
        if (access.role !== "owner") throw fail("分享访客不能删除画布", 403, FORBIDDEN);
        await deleteProject(access.ownerId, projectId, readClientId(req.headers["x-client-id"]));
        ok(res, true);
    }),
);

/**
 * 画布的团队归属。刻意独立成一个接口而不是给保存接口加字段：
 * 保存每秒都在发生、分享访客也能触发，把归属混进去就等于给「谁付钱」开了一条谁都能写的旁路。
 * 只挂 userAuth：改归属是所有者的决定，分享访客（哪怕是 editor）没有这项权力。
 */
syncRouter.get("/v1/projects/:id/team", userAuth, handle(async (req, res) => ok(res, await getProjectTeam(requireUser(req).id, String(req.params.id)))));
syncRouter.put(
    "/v1/projects/:id/team",
    userAuth,
    handle(async (req, res) => ok(res, await setProjectTeam(requireUser(req).id, String(req.params.id), String((req.body || {}).teamId || "")))),
);

syncRouter.get("/v1/user-assets", userAuth, handle(async (req, res) => ok(res, { items: await listUserAssets(requireUser(req).id, String(req.query.since || "")) })));
syncRouter.put("/v1/user-assets/:id", userAuth, handle(async (req, res) => { const body = req.body || {}; ok(res, await saveUserAsset(requireUser(req).id, { id: String(req.params.id), kind: String(body.kind || "image"), title: String(body.title || ""), data: body.data, revision: body.revision })); }));
syncRouter.delete("/v1/user-assets/:id", userAuth, handle(async (req, res) => { await deleteUserAsset(requireUser(req).id, String(req.params.id)); ok(res, true); }));
syncRouter.get("/v1/user-plugins", userAuth, handle(async (req, res) => ok(res, { items: await listUserPlugins(requireUser(req).id, String(req.query.since || "")) })));
syncRouter.put("/v1/user-plugins/:id", userAuth, handle(async (req, res) => { const body = req.body || {}; ok(res, await saveUserPlugin(requireUser(req).id, { id: String(req.params.id), data: body.data, revision: body.revision })); }));
syncRouter.delete("/v1/user-plugins/:id", userAuth, handle(async (req, res) => { await deleteUserPlugin(requireUser(req).id, String(req.params.id)); ok(res, true); }));
