import { Router } from "express";

import type { JobKind, JobStatus } from "../db/entities";
import { handle, ok } from "../lib/response";
import { accessContext, projectAuth } from "../middleware/auth";
import { resolveProjectAccess } from "../services/project-access";
import { fail } from "../lib/errors";
import { deleteUserGenerationHistoryJob } from "../services/generation-history";
import { cancelJob, createJob, findJobByClientId, getJob, listJobsPage, listJobsSince, subscribeJobs, toJobView, type JobEvent } from "../services/jobs";

const JOB_STATUSES: JobStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];
const JOB_KINDS: JobKind[] = ["image", "video", "audio", "text"];

export const jobRouter = Router();

async function jobActor(req: Parameters<typeof accessContext>[0], permission: "read" | "write" = "read") {
    if (req.guest) return (await resolveProjectAccess(accessContext(req), req.guest.projectId, permission)).actorId;
    if (req.user) return req.user.id;
    throw fail("未登录或权限不足", 401);
}

// 鉴权逐个路由挂：router 级中间件会拦下同层挂载在它之后的每一个接口，分享的匿名入口首当其冲。

/**
 * 提交生成任务。clientJobId 是幂等键，重复提交同一个键只会返回已有任务，
 * 因此客户端断网重试不会重复生成，也不会重复扣算力点。
 */
jobRouter.post(
    "/v1/jobs",
    projectAuth,
    handle(async (req, res) => {
        const body = req.body || {};
        const clientJobId = String(body.clientJobId || "").trim();
        const projectId = String(body.billingProjectId || req.guest?.projectId || "").trim();
        // 分享任务先按读权限解析并查幂等键：任务已经创建后，房主切换代付策略或把链接降为只读，
        // 原请求的网络重试仍应只命中旧任务，而不是套用新策略后误报需要确认或重复扣费。
        let access = projectId ? await resolveProjectAccess(accessContext(req), projectId, req.guest ? "read" : "write") : null;
        const actorId = access?.actorId || req.user?.id || "";
        if (!actorId) throw fail("未登录或权限不足", 401);
        const existing = await findJobByClientId(actorId, clientJobId, access?.share?.id || "");
        if (existing) return ok(res, await toJobView(existing));
        if (access?.share) access = await resolveProjectAccess(accessContext(req), projectId, "write");
        const ownerUsesOwnCredits = Boolean(access?.share && req.user?.id === access.ownerId);
        if (access?.share && !access.share.ownerPays && !ownerUsesOwnCredits) {
            if (access.anonymous || !req.user || req.user.id !== access.actorId) throw fail("请先登录后再使用个人算力点", 401, "SELF_PAY_LOGIN_REQUIRED");
            if (body.acceptSelfPay !== true) throw fail("请先确认由本人支付", 403, "SELF_PAY_CONFIRM_REQUIRED");
        }
        const ownerId = access?.ownerId || actorId;
        const payerUserId = access?.share ? (access.share.ownerPays ? ownerId : req.user!.id) : actorId;
        const job = await createJob(actorId, {
            clientJobId,
            kind: JOB_KINDS.includes(body.kind as JobKind) ? (body.kind as JobKind) : "image",
            model: String(body.model || ""),
            prompt: String(body.prompt || ""),
            params: body.params || {},
            inputFileIds: Array.isArray(body.inputFileIds) ? body.inputFileIds.map(String) : [],
            context: body.context && typeof body.context === "object" ? body.context : {},
            // 计费归属只认这个显式字段，而且服务端还要按当前用户回库核对画布与团队成员资格；
            // context 里的 projectId 是客户端自定义的展示信息，伪造它改不了付费方。
            billingProjectId: projectId,
            storageUserId: access?.ownerId || actorId,
            payerUserId,
            shareId: access?.share?.id || "",
        });
        ok(res, await toJobView(job));
    }),
);

/** 客户端重连后拉取未完成任务，据此恢复进度而不是重新发起生成。 */
jobRouter.get(
    "/v1/jobs",
    projectAuth,
    handle(async (req, res) => {
        const requested = String(req.query.status || "")
            .split(",")
            .map((item) => item.trim())
            .filter((item): item is JobStatus => JOB_STATUSES.includes(item as JobStatus));
        const actor = await jobActor(req);
        const parsedLimit = Number.parseInt(String(req.query.limit || "200"), 10);
        const limit = Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, parsedLimit)) : 200;
        const page = await listJobsPage(actor, requested, String(req.query.before || ""), limit, req.guest?.shareId || "");
        ok(res, { items: await Promise.all(page.items.map(toJobView)), nextBefore: page.nextBefore });
    }),
);

/**
 * 当前用户所有任务的事件流：状态、进度、文本增量与产物都走这一条连接。
 * 必须放在 /v1/jobs/:id 之前注册，否则 "stream" 会被当成任务 ID 吃掉。
 *
 * 只开一条而不是每个任务一条：浏览器对同源只允许 6 个并发连接，
 * 每任务一条的话同时跑几个生成就把连接池占满，页面其它请求都得排队。
 *
 * 断线重连带上最后收到的 seq，服务端把断线期间变化过的任务连同所有未结束的任务补一遍。
 */
jobRouter.get(
    "/v1/jobs/stream",
    projectAuth,
    handle(async (req, res) => {
        // 分享画布当前明确走带 guest 令牌的低频查询。若允许 guest 保持这条长连接，
        // 链接被撤销后已经建立的订阅不会再次鉴权，仍可能收到同一分享后续任务事件。
        if (req.guest) throw fail("分享任务请使用任务查询接口", 403, "SHARE_JOB_STREAM_UNAVAILABLE");
        const userId = await jobActor(req);
        const shareId = "";
        const sinceSeq = Math.max(0, Number.parseInt(String(req.query.sinceSeq || "0"), 10) || 0);

        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        // 反向代理常见的空闲超时是 60s，定期发注释帧保活。
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
        let closed = false;
        const write = (event: unknown) => {
            if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        // 这条连接已经推给客户端的文本字符数，按任务分开记。
        // 事件带的是完整文本，这里只推还没推过的尾巴；任务重跑导致文本变短时把游标归零整段重发。
        const sent = new Map<string, number>();
        const pushText = (id: string, text: string) => {
            const previous = sent.get(id) ?? 0;
            const offset = previous > text.length ? 0 : previous;
            if (text.length === offset) return;
            write({ type: "text", id, offset, text: text.slice(offset) });
            sent.set(id, text.length);
        };
        const deliver = (event: JobEvent) => {
            if (event.type === "text") return pushText(event.id, event.text);
            // 文本任务的终态快照里带着最终文本，先把文本补齐再推状态，客户端拿到终态时内容一定是完整的。
            if (event.job.kind === "text") pushText(event.job.id, event.job.text);
            write(event);
        };

        // 先挂订阅再读库补齐：补齐要等数据库，这中间产生的事件先攒着，补齐完再回放。
        // 反过来「先补齐再订阅」会漏掉这段空窗里的变化，而任务是后台跑的，漏了就再也不会重发。
        const buffered: JobEvent[] = [];
        let replaying = true;
        const unsubscribe = subscribeJobs(userId, (event) => {
            if (closed) return;
            if (replaying) buffered.push(event);
            else deliver(event);
        }, shareId, () => res.end());
        req.on("close", () => {
            closed = true;
            clearInterval(keepAlive);
            unsubscribe();
        });

        // 补齐的是任务的最新快照：状态「最新值即真相」，中间的进度值补不补都不影响结果。
        const replayed = new Map<string, number>();
        let maxSeq = sinceSeq;
        for (const row of await listJobsSince(userId, sinceSeq, shareId)) {
            replayed.set(row.id, row.seq);
            maxSeq = Math.max(maxSeq, row.seq);
            deliver({ type: "job", seq: row.seq, job: await toJobView(row) });
        }
        write({ type: "ready", seq: maxSeq });
        replaying = false;
        // 攒下的事件按任务逐个去重：只丢掉「快照已经比它新」的那些。
        // 不能用全局 maxSeq 一刀切——补齐读到的是各任务各自的快照，别的任务序号更大不代表这条已经被覆盖。
        for (const event of buffered) {
            if (event.type === "job" && (replayed.get(event.job.id) ?? 0) >= event.seq) continue;
            deliver(event);
        }
        buffered.length = 0;
    }),
);

jobRouter.get("/v1/jobs/:id", projectAuth, handle(async (req, res) => ok(res, await toJobView(await getJob(await jobActor(req), String(req.params.id), req.guest?.shareId || "")))));

jobRouter.delete(
    "/v1/jobs/:id",
    projectAuth,
    handle(async (req, res) => {
        // 分享页历史与协作者私有历史刻意隔离；删除只开放给账号通道，由云空间所有者处理。
        if (req.guest || !req.user) throw fail("分享访客不能删除生成历史", 403, "SHARE_HISTORY_DELETE_FORBIDDEN");
        await deleteUserGenerationHistoryJob(req.user.id, String(req.params.id));
        ok(res, true);
    }),
);

// 降级为只读只禁止继续修改画布，不应把发起者已经在跑的任务变成无法止损；取消按读权限确认仍属于该分享。
jobRouter.post("/v1/jobs/:id/cancel", projectAuth, handle(async (req, res) => ok(res, await toJobView(await cancelJob(await jobActor(req, "read"), String(req.params.id), req.guest?.shareId || "")))));
