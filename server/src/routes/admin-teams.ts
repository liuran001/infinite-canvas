import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth } from "../middleware/auth";
import { adminGetTeam, adminListTeamCreditLogs, adminListTeamMembers, adminListTeams, adminSetTeamCredits, adminUpdateTeam } from "../services/admin-teams";

/**
 * 平台管理员的团队后台。单独一个 Router、单独一个文件，且不引用 team-access 的任何函数：
 * `adminAuth` 判的是「你是不是平台管理员」（全局单点），团队内的判定是「你在这个团队里是什么角色」（按资源实例）。
 * 两种语义混进同一个分区，早晚会出现「某个路由忘了校验 teamId，于是任意团队 admin 能操作别人的团队」。
 * 物理分离让这类错误写不出来。
 */
export const adminTeamRouter = Router();
adminTeamRouter.use(adminAuth);

adminTeamRouter.get("/teams", handle(async (req, res) => ok(res, await adminListTeams(parseQuery(req)))));

adminTeamRouter.get("/team-credit-logs", handle(async (req, res) => ok(res, await adminListTeamCreditLogs(parseQuery(req)))));

adminTeamRouter.get("/teams/:id", handle(async (req, res) => ok(res, await adminGetTeam(String(req.params.id)))));

adminTeamRouter.patch("/teams/:id", handle(async (req, res) => ok(res, await adminUpdateTeam(String(req.params.id), req.body || {}))));

adminTeamRouter.post("/teams/:id/credits", handle(async (req, res) => ok(res, await adminSetTeamCredits(String(req.params.id), Number(req.body?.credits) || 0, String(req.body?.remark || "")))));

adminTeamRouter.get("/teams/:id/members", handle(async (req, res) => ok(res, await adminListTeamMembers(String(req.params.id)))));
