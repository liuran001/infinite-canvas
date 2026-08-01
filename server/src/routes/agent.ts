import { Router } from "express";

import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { abortAgentSession, createAgentSession, deleteAgentSession, getAgentSession, listAgentMessages, listAgentSessions, sendAgentMessage, subscribeAgentSession, type AgentEvent } from "../services/agent";

export const agentRouter = Router();

// 鉴权逐个路由挂，避免整个 router 的中间件拦下同层挂载的公开接口。
agentRouter.get("/v1/agent/sessions", userAuth, handle(async (req, res) => ok(res, { items: await listAgentSessions(requireUser(req).id, String(req.query.projectId || "")) })));

agentRouter.post(
    "/v1/agent/sessions",
    userAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        ok(res, await createAgentSession(requireUser(req).id, { sessionId: String(body.sessionId || ""), projectId: String(body.projectId || ""), title: String(body.title || ""), model: String(body.model || "") }));
    }),
);

agentRouter.get("/v1/agent/sessions/:id", userAuth, handle(async (req, res) => ok(res, await getAgentSession(requireUser(req).id, String(req.params.id)))));

agentRouter.delete(
    "/v1/agent/sessions/:id",
    userAuth,
    handle(async (req, res) => {
        await deleteAgentSession(requireUser(req).id, String(req.params.id));
        ok(res, true);
    }),
);

/** 断线重连带上最后看到的 seq 即可补齐增量，不用重放整段会话。 */
agentRouter.get(
    "/v1/agent/sessions/:id/messages",
    userAuth,
    handle(async (req, res) => {
        const sinceSeq = Number.parseInt(String(req.query.sinceSeq || "0"), 10) || 0;
        ok(res, { items: await listAgentMessages(requireUser(req).id, String(req.params.id), sinceSeq) });
    }),
);

agentRouter.post(
    "/v1/agent/sessions/:id/messages",
    userAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        ok(res, await sendAgentMessage(requireUser(req).id, String(req.params.id), { clientMessageId: String(body.clientMessageId || ""), content: String(body.content || ""), model: String(body.model || "") }));
    }),
);

agentRouter.post("/v1/agent/sessions/:id/abort", userAuth, handle(async (req, res) => ok(res, await abortAgentSession(requireUser(req).id, String(req.params.id)))));

/**
 * SSE 实时订阅。断开只是取消监听，服务端的推理循环照常跑完并落库，
 * 前端重连时先按 sinceSeq 补齐历史增量，再挂上流继续收。
 */
agentRouter.get(
    "/v1/agent/sessions/:id/stream",
    userAuth,
    handle(async (req, res) => {
        const userId = requireUser(req).id;
        const sessionId = String(req.params.id);
        const sinceSeq = Number.parseInt(String(req.query.sinceSeq || "0"), 10) || 0;
        const session = await getAgentSession(userId, sessionId);

        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const send = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

        // 先补齐订阅建立之前产生的增量，再收实时事件，中间不会漏消息。
        for (const message of await listAgentMessages(userId, sessionId, sinceSeq)) send({ type: "message", message });
        send({ type: "status", status: session.status, error: session.error });

        const unsubscribe = subscribeAgentSession(userId, sessionId, send);
        // 反向代理常见的空闲超时是 60s，定期发注释帧保活。
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
        req.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
            res.end();
        });
    }),
);
