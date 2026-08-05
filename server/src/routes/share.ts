import { Router } from "express";

import { fail, FORBIDDEN, NOT_FOUND } from "../lib/errors";
import { handle, ok, parseQuery } from "../lib/response";
import { accessContext, optionalAuth, requireUser, userAuth } from "../middleware/auth";
import { disconnectAgentShareSubscribers } from "../services/agent";
import { requestOrigin } from "../services/auth";
import { cloneSharedProject } from "../services/project-clone";
import { resolveProjectAccess } from "../services/project-access";
import { disconnectShare } from "../services/project-realtime";
import { createShare, findShareByToken, getOwnedShare, guestSessionOf, guestTokenTtl, listShareLogs, listShares, logShareAccess, ownerShareView, shareRevokesAccess, signGuestToken, updateShare, verifyGuestToken, type ShareInput } from "../services/project-share";

// 鉴权逐个路由挂：分享管理必须是本人，token 交换却要给未登录的访客留入口，整段套一个中间件必然堵死其中一边。
export const shareRouter = Router();

const MAX_LOG_PAGE = 200;

/**
 * 拼出完整分享地址。在路由层拼而不是在 service 里：主机名只有请求头知道，
 * 反向代理后面尤其如此，service 拿不到也不该去猜。
 * 取不回明文的历史记录不带 url——给一条 `/s/` 结尾的残缺地址，用户照样会把它复制出去。
 */
function withShareUrl<T extends { token?: string }>(req: Parameters<typeof requestOrigin>[0], view: T) {
    return view.token ? { ...view, url: `${requestOrigin(req)}/s/${view.token}` } : view;
}

function readShareInput(body: Record<string, unknown>): ShareInput {
    const role = body.role === "editor" ? "editor" : "viewer";
    const expiresAt = String(body.expiresAt || "").trim();
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw fail("过期时间格式不正确", 400, "INVALID_EXPIRES_AT");
    return { role, allowAnonymous: body.allowAnonymous !== false, allowClone: body.allowClone !== false, ownerPays: body.ownerPays === true, allowAnonymousEdit: body.allowAnonymousEdit === true, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "" };
}

/** 分享管理一律要求账号身份且必须是画布所有者，guest 令牌在中间件那层就被挡成 403。 */
async function ownerAccess(req: Parameters<typeof requireUser>[0], projectId: string) {
    const access = await resolveProjectAccess(accessContext(req), projectId, "write");
    if (access.role !== "owner") throw fail("只有画布所有者可以管理分享", 403, FORBIDDEN);
    return access;
}

shareRouter.post(
    "/v1/projects/:id/shares",
    userAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await ownerAccess(req, projectId);
        const { share } = await createShare(access.ownerId, projectId, readShareInput(req.body || {}));
        ok(res, withShareUrl(req, ownerShareView(share)));
    }),
);

shareRouter.get(
    "/v1/projects/:id/shares",
    userAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await ownerAccess(req, projectId);
        ok(res, (await listShares(projectId, access.ownerId)).map((view) => withShareUrl(req, view)));
    }),
);

shareRouter.patch(
    "/v1/projects/:id/shares/:shareId",
    userAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await ownerAccess(req, projectId);
        const share = await getOwnedShare(String(req.params.shareId), projectId, access.ownerId);
        const body = (req.body || {}) as Record<string, unknown>;
        // 只认请求里真正出现的字段：把 null 当成「没传」的话，前端就永远清不掉已经设过的过期时间。
        const patch = {
            ...readShareInput({
                role: body.role || share.role,
                allowAnonymous: body.allowAnonymous ?? share.allowAnonymous,
                allowClone: body.allowClone ?? share.allowClone,
                ownerPays: body.ownerPays ?? share.ownerPays,
                allowAnonymousEdit: body.allowAnonymousEdit ?? share.allowAnonymousEdit,
                expiresAt: "expiresAt" in body ? body.expiresAt : share.expiresAt,
            }),
            enabled: body.enabled === undefined ? share.enabled : body.enabled !== false,
        };
        const updated = await updateShare(share, patch);
        // 角色、匿名编辑与付款策略变化后，在线客户端必须立刻重换 session；旧 SSE 自己不会重新鉴权。
        if (shareRevokesAccess(share, updated)) {
            disconnectShare(access.ownerId, projectId, share.id);
            disconnectAgentShareSubscribers(share.id);
        }
        ok(res, withShareUrl(req, ownerShareView(updated)));
    }),
);

shareRouter.delete(
    "/v1/projects/:id/shares/:shareId",
    userAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await ownerAccess(req, projectId);
        const share = await getOwnedShare(String(req.params.shareId), projectId, access.ownerId);
        await updateShare(share, { enabled: false });
        disconnectShare(access.ownerId, projectId, share.id);
        disconnectAgentShareSubscribers(share.id);
        ok(res, true);
    }),
);

shareRouter.get(
    "/v1/projects/:id/shares/:shareId/logs",
    userAuth,
    handle(async (req, res) => {
        const projectId = String(req.params.id);
        const access = await ownerAccess(req, projectId);
        const share = await getOwnedShare(String(req.params.shareId), projectId, access.ownerId);
        const query = parseQuery(req);
        const limit = Math.min(MAX_LOG_PAGE, Math.max(1, Number.parseInt(String(req.query.limit || ""), 10) || query.pageSize));
        ok(res, await listShareLogs(share.id, query.offset, limit));
    }),
);

/**
 * 拿分享 token 换一枚短期 guest 令牌。
 * 之后所有请求都用这枚令牌，原始 token 只出现在这一次交换里，不会散落进每条 API 日志和 SSE 的查询串。
 */
shareRouter.post(
    "/v1/shares/:token/session",
    optionalAuth,
    handle(async (req, res) => {
        const share = await findShareByToken(String(req.params.token));
        // 不存在、已撤销、已过期、要求登录却没登录，统一 404，不给 token 探测留任何信号。
        if (!share || (!share.allowAnonymous && !req.user)) throw fail("链接不存在或已失效", 404, NOT_FOUND);
        // 刷新页面沿用同一个访客身份，依据是上一枚 guest 令牌而不是前端自报的 id：
        // 令牌是服务端签的，验过签才认，否则任何人都能声称自己是这条分享里的另一个访客。
        const previous = verifyGuestToken(String(req.body?.previousToken || ""));
        const reusedActorId = previous?.anonymous && previous.shareId === share.id ? previous.actorId : "";
        const session = guestSessionOf(share, { accountId: req.user?.id || "", actorId: reusedActorId, displayName: req.user?.displayName || req.user?.username || "", avatarUrl: req.user?.avatarUrl || "" });
        // 画布本体也只能经统一入口取，分享页要显示的标题和 revision 同样走这一条判定。
        const access = await resolveProjectAccess({ user: null, guest: session }, share.projectId, "read");
        await logShareAccess(share, { actorId: session.actorId, isAnonymous: session.anonymous, event: "open", ip: req.ip, userAgent: String(req.headers["user-agent"] || "") });
        ok(res, {
            token: signGuestToken(session),
            expiresIn: guestTokenTtl(),
            expiresAt: new Date(Date.now() + guestTokenTtl() * 1000).toISOString(),
            // role 与 permission 同值：前者对齐设计文档，后者是前端已经在用的字段名。
            role: access.role,
            permission: access.role,
            allowClone: share.allowClone,
            shareId: share.id,
            anonymous: session.anonymous,
            fullCanvas: access.role === "editor",
            ownerPays: share.ownerPays,
            selfPayRequired: !session.anonymous && access.role === "editor" && !share.ownerPays && req.user?.id !== share.ownerId,
            allowAnonymousEdit: share.allowAnonymousEdit,
            actorId: session.actorId,
            displayName: session.displayName,
            project: { id: share.projectId, title: access.project.title, revision: access.project.revision },
        });
    }),
);

/** 保存到自己的画布。必须是真实账号：匿名访客先登录，再带着 token 回来。 */
shareRouter.post(
    "/v1/shares/:token/clone",
    userAuth,
    handle(async (req, res) => {
        const share = await findShareByToken(String(req.params.token));
        if (!share) throw fail("链接不存在或已失效", 404, NOT_FOUND);
        ok(res, await cloneSharedProject(share, requireUser(req).id, { ip: req.ip, userAgent: String(req.headers["user-agent"] || "") }));
    }),
);
