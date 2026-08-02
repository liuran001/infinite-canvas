import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { createBufferedWriter, sseWriter } from "../lib/sse";
import { requireUser, userAuth } from "../middleware/auth";
import { requireTeamRole } from "../services/team-access";
import { acceptTeamInvite, createTeamInvite, deleteTeamInvite, listTeamInvites, previewTeamInvite, updateTeamInvite } from "../services/team-invites";
import { subscribeTeam, type TeamRealtimeEvent } from "../services/team-realtime";
import { createTeam, disbandTeam, getTeam, leaveTeam, listMemberViews, listMyTeamCreditLogs, listMyTeams, listTeamCreditLogs, removeMember, transferOwner, updateMember, updateTeam } from "../services/teams";

/**
 * 团队前台。整个 router 走 userAuth（账号身份，分享访客一律拒绝），
 * 每个处理器的权限判定都落在服务层的 requireTeamRole 上：把判定写在路由里，
 * 服务就会多出一条没人守门的调用路径，而验证脚本正是直接调服务的。
 */
export const teamRouter = Router();
teamRouter.use(userAuth);

teamRouter.get("/v1/teams", handle(async (req, res) => ok(res, await listMyTeams(requireUser(req).id))));

teamRouter.post("/v1/teams", handle(async (req, res) => ok(res, await createTeam(requireUser(req).id, req.body || {}))));

/** 手输码加入。放在 /v1/teams/:id 之前，否则 "join" 会被当成团队 id。 */
teamRouter.post("/v1/teams/join", handle(async (req, res) => ok(res, await acceptTeamInvite(String(req.body?.code || ""), requireUser(req).id))));

teamRouter.get("/v1/teams/:id", handle(async (req, res) => ok(res, await getTeam(requireUser(req).id, String(req.params.id)))));

teamRouter.patch("/v1/teams/:id", handle(async (req, res) => ok(res, await updateTeam(String(req.params.id), requireUser(req).id, req.body || {}))));

teamRouter.delete(
    "/v1/teams/:id",
    handle(async (req, res) => {
        await disbandTeam(String(req.params.id), requireUser(req).id);
        ok(res, true);
    }),
);

teamRouter.post(
    "/v1/teams/:id/transfer",
    handle(async (req, res) => {
        await transferOwner(String(req.params.id), requireUser(req).id, String(req.body?.userId || ""));
        ok(res, true);
    }),
);

teamRouter.post(
    "/v1/teams/:id/leave",
    handle(async (req, res) => {
        await leaveTeam(String(req.params.id), requireUser(req).id);
        ok(res, true);
    }),
);

teamRouter.get("/v1/teams/:id/members", handle(async (req, res) => ok(res, await listMemberViews(requireUser(req).id, String(req.params.id)))));

teamRouter.patch("/v1/teams/:id/members/:userId", handle(async (req, res) => ok(res, await updateMember(String(req.params.id), requireUser(req).id, String(req.params.userId), req.body || {}))));

teamRouter.delete(
    "/v1/teams/:id/members/:userId",
    handle(async (req, res) => {
        await removeMember(String(req.params.id), requireUser(req).id, String(req.params.userId));
        ok(res, true);
    }),
);

teamRouter.get("/v1/teams/:id/invites", handle(async (req, res) => ok(res, await listTeamInvites(String(req.params.id), requireUser(req).id))));

/** 创建响应里的 token 是这条链接明文唯一一次露面，之后连服务端自己都只剩哈希。 */
teamRouter.post("/v1/teams/:id/invites", handle(async (req, res) => ok(res, await createTeamInvite(String(req.params.id), requireUser(req).id, req.body || {}))));

teamRouter.patch("/v1/teams/:id/invites/:inviteId", handle(async (req, res) => ok(res, await updateTeamInvite(String(req.params.id), requireUser(req).id, String(req.params.inviteId), req.body || {}))));

teamRouter.delete(
    "/v1/teams/:id/invites/:inviteId",
    handle(async (req, res) => {
        await deleteTeamInvite(String(req.params.id), requireUser(req).id, String(req.params.inviteId));
        ok(res, true);
    }),
);

teamRouter.get("/v1/teams/:id/credit-logs/mine", handle(async (req, res) => ok(res, await listMyTeamCreditLogs(requireUser(req).id, String(req.params.id), parseQuery(req)))));

teamRouter.get("/v1/teams/:id/credit-logs", handle(async (req, res) => ok(res, await listTeamCreditLogs(requireUser(req).id, String(req.params.id), parseQuery(req)))));

teamRouter.get("/v1/team-invites/:token", handle(async (req, res) => ok(res, await previewTeamInvite(String(req.params.token)))));

teamRouter.post("/v1/team-invites/:token/accept", handle(async (req, res) => ok(res, await acceptTeamInvite(String(req.params.token), requireUser(req).id))));

/**
 * 团队 SSE。先订阅再读库，鉴权与读团队的 await 窗口里发生的事件先进 buffered，
 * 等 ready 写完再按序 flush：反过来的话，订阅之后拿着旧快照写下的 ready 会带着一个过期余额，
 * 而这期间真正发生的 team.credits 已经先一步发了出去，客户端最后落在旧值上，
 * 而且它没有任何理由怀疑这个数——界面上的余额会一直错到用户自己刷新。
 * 鉴权失败那条路径必须显式退订，否则就是一个永久泄漏的 listener。
 */
teamRouter.get(
    "/v1/teams/:id/realtime",
    handle(async (req, res) => {
        const teamId = String(req.params.id);
        const userId = requireUser(req).id;
        // sink 一开始只往缓冲里塞，响应头都还没发；flush 之后才真正写进这条连接。
        let sink: (event: unknown) => void = () => undefined;
        const stream = createBufferedWriter((event) => sink(event));
        const unsubscribe = subscribeTeam(teamId, userId, (event: TeamRealtimeEvent) => stream.push(event), () => res.end());
        let team;
        let role;
        try {
            ({ team, role } = await requireTeamRole(userId, teamId, "team.read"));
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
        // 被移除或降级时由服务层调 closeTeamConnectionsOf 关掉这条连接，同时退订总线 listener。
        // 写入统一走 sseWriter：连接可能在 flush 补发的中途就被关掉，结束后再写会抛错并截断剩余事件。
        sink = sseWriter(res);
        stream.flush({ type: "ready", teamId, role, credits: team.credits });
        // keepalive 同理。它抛在定时器里，没有任何调用栈接得住，会直接掀翻整个进程。
        const keepAlive = setInterval(() => {
            if (res.writableEnded) return clearInterval(keepAlive);
            res.write(": keep-alive\n\n");
        }, 25_000);
        req.on("close", () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
    }),
);
