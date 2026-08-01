import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth } from "../middleware/auth";
import { createInviteCodes, deleteInviteCode, listInviteCodes, listInviteUses, updateInviteCode } from "../services/invites";

/** 邀请码管理接口。鉴权逐个路由挂，避免 router.use 把同层的公开接口一起拦成 401。 */
export const inviteRouter = Router();

inviteRouter.get("/admin/invites", adminAuth, handle(async (req, res) => ok(res, await listInviteCodes(parseQuery(req)))));

inviteRouter.post("/admin/invites", adminAuth, handle(async (req, res) => ok(res, await createInviteCodes(req.body || {}))));

inviteRouter.get("/admin/invites/:code/uses", adminAuth, handle(async (req, res) => ok(res, await listInviteUses(String(req.params.code), parseQuery(req)))));

inviteRouter.patch("/admin/invites/:code", adminAuth, handle(async (req, res) => ok(res, await updateInviteCode(String(req.params.code), req.body || {}))));

inviteRouter.delete(
    "/admin/invites/:code",
    adminAuth,
    handle(async (req, res) => {
        await deleteInviteCode(String(req.params.code));
        ok(res, true);
    }),
);
