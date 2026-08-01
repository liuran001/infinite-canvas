import { Router } from "express";

import { handle, ok, parseQuery } from "../lib/response";
import { adminAuth } from "../middleware/auth";
import { getReviewJob, getReviewProject, listReviewFiles, listReviewJobs, listReviewProjects } from "../services/review";

/** 管理后台的内容审查接口：跨用户查看生成任务、画布与文件。 */
export const adminReviewRouter = Router();
adminReviewRouter.use(adminAuth);

const text = (value: unknown) => String(value || "").trim();

adminReviewRouter.get(
    "/jobs",
    handle(async (req, res) => ok(res, await listReviewJobs(parseQuery(req), { userId: text(req.query.userId), status: text(req.query.status), kind: text(req.query.kind) }))),
);

adminReviewRouter.get("/jobs/:id", handle(async (req, res) => ok(res, await getReviewJob(String(req.params.id)))));

adminReviewRouter.get("/projects", handle(async (req, res) => ok(res, await listReviewProjects(parseQuery(req), text(req.query.userId)))));

adminReviewRouter.get("/projects/:userId/:projectId", handle(async (req, res) => ok(res, await getReviewProject(String(req.params.userId), String(req.params.projectId)))));

adminReviewRouter.get(
    "/files",
    handle(async (req, res) => ok(res, await listReviewFiles(parseQuery(req), { userId: text(req.query.userId), kind: text(req.query.kind) }))),
);
