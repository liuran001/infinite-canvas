import { Router } from "express";

import type { JobStatus } from "../db/entities";
import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { cancelJob, createJob, getJob, listJobs, toJobView } from "../services/jobs";

const JOB_STATUSES: JobStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];

export const jobRouter = Router();
jobRouter.use(userAuth);

/**
 * 提交生成任务。clientJobId 是幂等键，重复提交同一个键只会返回已有任务，
 * 因此客户端断网重试不会重复生成，也不会重复扣算力点。
 */
jobRouter.post(
    "/v1/jobs",
    handle(async (req, res) => {
        const body = req.body || {};
        const job = await createJob(requireUser(req).id, {
            clientJobId: String(body.clientJobId || ""),
            kind: body.kind === "video" || body.kind === "audio" ? body.kind : "image",
            model: String(body.model || ""),
            prompt: String(body.prompt || ""),
            params: body.params || {},
            inputFileIds: Array.isArray(body.inputFileIds) ? body.inputFileIds.map(String) : [],
            context: body.context && typeof body.context === "object" ? body.context : {},
        });
        ok(res, await toJobView(job));
    }),
);

/** 客户端重连后拉取未完成任务，据此恢复进度而不是重新发起生成。 */
jobRouter.get(
    "/v1/jobs",
    handle(async (req, res) => {
        const requested = String(req.query.status || "")
            .split(",")
            .map((item) => item.trim())
            .filter((item): item is JobStatus => JOB_STATUSES.includes(item as JobStatus));
        const items = await listJobs(requireUser(req).id, requested, String(req.query.since || ""));
        ok(res, { items: await Promise.all(items.map(toJobView)) });
    }),
);

jobRouter.get("/v1/jobs/:id", handle(async (req, res) => ok(res, await toJobView(await getJob(requireUser(req).id, String(req.params.id))))));

jobRouter.post("/v1/jobs/:id/cancel", handle(async (req, res) => ok(res, await toJobView(await cancelJob(requireUser(req).id, String(req.params.id))))));
