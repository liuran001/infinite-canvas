import { Router } from "express";

import type { JobKind, JobStatus } from "../db/entities";
import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { cancelJob, createJob, currentJobText, getJob, isJobFinished, listJobs, subscribeJobText, toJobView, type JobTextEvent } from "../services/jobs";

const JOB_STATUSES: JobStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];
const JOB_KINDS: JobKind[] = ["image", "video", "audio", "text"];

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
            kind: JOB_KINDS.includes(body.kind as JobKind) ? (body.kind as JobKind) : "image",
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

/**
 * 文本任务的实时增量。断开只是取消订阅，任务照常在服务端跑完并落库，
 * 重连时带上已经收到的字符数（since）就能补齐断线期间的内容，不用整段重来。
 */
jobRouter.get(
    "/v1/jobs/:id/text",
    handle(async (req, res) => {
        const userId = requireUser(req).id;
        const id = String(req.params.id);
        const job = await getJob(userId, id);
        let sent = Math.max(0, Number.parseInt(String(req.query.since || "0"), 10) || 0);

        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        // 反向代理常见的空闲超时是 60s，定期发注释帧保活。
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
        let closed = false;
        let unsubscribe = () => {};
        const close = () => {
            closed = true;
            clearInterval(keepAlive);
            unsubscribe();
        };
        // 事件带的是完整文本，这里只推还没推过的尾巴；任务重跑导致文本变短时把游标归零整段重发。
        const push = (text: string) => {
            if (text.length < sent) sent = 0;
            if (text.length === sent) return;
            res.write(`data: ${JSON.stringify({ type: "delta", offset: sent, text: text.slice(sent) })}\n\n`);
            sent = text.length;
        };
        // 终态可能同时来自订阅事件和下面的补查，只允许收尾一次，否则会往已经结束的响应里写数据。
        const finish = (status: JobStatus, error: string, text: string) => {
            if (closed) return;
            close();
            push(text);
            res.write(`data: ${JSON.stringify({ type: "status", status, error })}\n\n`);
            res.end();
        };

        push(currentJobText(job));
        if (isJobFinished(job.status)) return finish(job.status, job.error || "", job.text || "");

        unsubscribe = subscribeJobText(id, (event: JobTextEvent) => {
            if (closed) return;
            push(event.text);
            if (isJobFinished(event.status)) finish(event.status, event.error, event.text);
        });
        req.on("close", () => close());

        // 订阅之前任务可能刚好跑完，那样一个事件都收不到，前端会一直干等；补查一次终态兜住这个缝隙。
        const latest = await getJob(userId, id).catch(() => null);
        if (latest && isJobFinished(latest.status)) finish(latest.status, latest.error || "", latest.text || "");
    }),
);
