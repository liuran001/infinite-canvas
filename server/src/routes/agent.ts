import { Router } from "express";

import { handle, ok } from "../lib/response";
import { accessContext, projectAuth } from "../middleware/auth";
import { resolveAgentScope, resolveExistingAgentBillingScope, resolveExistingAgentSession } from "../services/agent-access";
import { abortAgentSession, createAgentSession, deleteAgentSession, getAgentSession, listAgentMessages, listAgentSessions, resolveAgentSession, sendAgentMessage, subscribeAgentSession, type AgentEvent } from "../services/agent";
import { resolveProjectAccess } from "../services/project-access";
import { scheduleShareExpiry } from "../services/project-share";

export const agentRouter = Router();

function agentActor(req: any) { return req.guest?.actorId || req.user?.id || ""; }

// 鉴权逐个路由挂，避免整个 router 的中间件拦下同层挂载的公开接口。
agentRouter.get(
    "/v1/agent/sessions",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const requestedProjectId = String(req.query.projectId || "");
        if (req.guest) {
            const projectId = requestedProjectId || req.guest.projectId;
            const access = await resolveProjectAccess(accessContext(req), projectId, "read");
            return ok(res, { items: await listAgentSessions(actorId, projectId, access.share?.id || "") });
        }
        ok(res, { items: await listAgentSessions(actorId, requestedProjectId, "") });
    }),
);

agentRouter.post(
    "/v1/agent/sessions",
    projectAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        const projectId = String(body.projectId || "");
        const scope = await resolveAgentScope(accessContext(req), projectId, "write", body.acceptSelfPay === true);
        ok(res, await createAgentSession(scope.actorId, { sessionId: String(body.sessionId || ""), projectId, title: String(body.title || ""), model: String(body.model || "") }, scope));
    }),
);

agentRouter.get(
    "/v1/agent/sessions/:id",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        await resolveExistingAgentSession(accessContext(req), actorId, sessionId, "read");
        ok(res, await getAgentSession(actorId, sessionId));
    }),
);

agentRouter.delete(
    "/v1/agent/sessions/:id",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        await resolveExistingAgentSession(accessContext(req), actorId, sessionId, "read");
        await deleteAgentSession(actorId, sessionId);
        ok(res, true);
    }),
);

/** 断线重连带上最后看到的 seq 即可补齐增量，不用重放整段会话。 */
agentRouter.get(
    "/v1/agent/sessions/:id/messages",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        await resolveExistingAgentSession(accessContext(req), actorId, sessionId, "read");
        const sinceSeq = Number.parseInt(String(req.query.sinceSeq || "0"), 10) || 0;
        ok(res, { items: await listAgentMessages(actorId, sessionId, sinceSeq) });
    }),
);

agentRouter.post(
    "/v1/agent/sessions/:id/messages",
    projectAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        const current = await resolveExistingAgentBillingScope(accessContext(req), actorId, sessionId, body.acceptSelfPay === true);
        ok(
            res,
            await sendAgentMessage(actorId, sessionId, {
                clientMessageId: String(body.clientMessageId || ""),
                content: String(body.content || ""),
                model: String(body.model || ""),
                // 上传的图片只传文件 ID，服务端再按归属与类型校验一遍。
                attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map((item: unknown) => String(item || "")) : [],
                // 画布节点引用只收 nodeId，类型与标题一律以服务端当前画布为准，不信客户端传的。
                references: Array.isArray(body.references) ? body.references.map((item: Record<string, unknown>) => ({ nodeId: String(item?.nodeId || ""), type: "", title: "" })) : [],
            }, current.scope),
        );
    }),
);

agentRouter.post(
    "/v1/agent/sessions/:id/abort",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        await resolveExistingAgentSession(accessContext(req), actorId, sessionId, "read");
        ok(res, await abortAgentSession(actorId, sessionId));
    }),
);

/** 答复服务端发出的待确认请求（续跑、改画布标题）。批准就接着执行，拒绝就正常结束本次。 */
agentRouter.post(
    "/v1/agent/sessions/:id/resolve",
    projectAuth,
    handle(async (req, res) => {
        const actorId = agentActor(req);
        const sessionId = String(req.params.id);
        const body = req.body || {};
        // 拒绝确认只会结束等待态，降级成只读后仍应允许；批准才需要当前写权限。
        const current = await resolveExistingAgentSession(accessContext(req), actorId, sessionId, body.approved === true ? "write" : "read");
        const billing = current.session.shareId && current.session.pendingAction?.type === "continue"
            ? await resolveExistingAgentBillingScope(accessContext(req), actorId, sessionId, body.acceptSelfPay === true)
            : null;
        ok(res, await resolveAgentSession(actorId, sessionId, body.approved === true, billing?.scope));
    }),
);

/**
 * SSE 实时订阅。断开只是取消监听，服务端的推理循环照常跑完并落库，
 * 前端重连时先按 sinceSeq 补齐历史增量，再挂上流继续收。
 */
agentRouter.get(
    "/v1/agent/sessions/:id/stream",
    projectAuth,
    handle(async (req, res) => {
        const userId = agentActor(req);
        const sessionId = String(req.params.id);
        const sinceSeq = Number.parseInt(String(req.query.sinceSeq || "0"), 10) || 0;
        const current = await resolveExistingAgentSession(accessContext(req), userId, sessionId, "read");
        const session = await getAgentSession(userId, sessionId);

        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const send = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

        // 先补齐订阅建立之前产生的增量，再收实时事件，中间不会漏消息。
        for (const message of await listAgentMessages(userId, sessionId, sinceSeq)) send({ type: "message", message });
        // 首帧带上当前标题与待确认请求：刷新或换设备重连时，靠这一帧就能把「正在等你确认」原样恢复出来。
        send({ type: "status", status: session.status, error: session.error, title: session.title, pendingAction: session.pendingAction });

        const unsubscribe = subscribeAgentSession(userId, sessionId, send, () => res.end(), current.session.shareId);
        const cancelExpiry = scheduleShareExpiry(current.access?.share?.expiresAt || "", () => res.end());
        // 反向代理常见的空闲超时是 60s，定期发注释帧保活。
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
        req.on("close", () => {
            clearInterval(keepAlive);
            cancelExpiry();
            unsubscribe();
            res.end();
        });
    }),
);
