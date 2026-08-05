import { EventEmitter } from "node:events";
import { In, LessThan, MoreThan, Not } from "typeorm";

import { config } from "../config";
import { repo, serialTransaction } from "../db/data-source";
import { Job, StoredFile, type JobKind, type JobStatus } from "../db/entities";
import { isUniqueViolation } from "../lib/db-errors";
import { fail, newId, now, SafeError } from "../lib/errors";
import { charge, payerOfJob, payerOfProject, receiptOfJob, refund } from "./billing";
import { listFiles, publicFileUrl, saveFile, saveFileFromUrl } from "./files";
import { createVideoTask, fileToDataUrl, generateAudio, generateImages, generateText, pollVideoTask, type GenerationParams } from "./generation";
import { archiveJobOutputsWithManager, generationOutputViews } from "./generation-history";
import { requireActiveAccounts } from "./account-fence";
import { storageTeamOfProject } from "./project-team";
import { modelCost, publicSettings, selectModelChannel } from "./settings";

export type JobInput = {
    clientJobId: string;
    kind: JobKind;
    model: string;
    prompt: string;
    params: GenerationParams;
    inputFileIds: string[];
    context?: Record<string, unknown>;
    /**
     * 计费归属画布。刻意与 `context` 分开：context 是客户端自定义的展示信息，前端能往里写任何东西，
     * 拿它决定付费方等于让请求体自己点名让哪个团队付钱。这个字段只由服务端可信的调用点填，
     * 而且填进来之后仍要按 userId 回库查一次画布并校验团队成员资格，伪造一个别人的画布 id 也串不了账。
     */
    billingProjectId?: string;
    storageUserId?: string;
    payerUserId?: string;
    shareId?: string;
};

export type JobView = {
    id: string;
    clientJobId: string;
    kind: JobKind;
    status: JobStatus;
    model: string;
    progress: number;
    error: string;
    outputs: Array<{ id: string; kind: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number; cleared: boolean }>;
    /** 文本任务已经生成出来的内容，中途断开也能凭它拿回已生成的那一半。 */
    text: string;
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    finishedAt: string;
};

/**
 * 推给订阅方的任务事件。
 * `job` 是任务的完整快照，带上分配到的 seq；状态是「最新值即真相」，所以补齐时只发最新快照就够，
 * 不用把中间每一次进度变化都补一遍。
 * `text` 带的是「到目前为止的完整文本」而不是单次增量：订阅方按已收到的长度截尾，重复收到或漏收都不会错位。
 */
export type JobEvent = { type: "job"; seq: number; job: JobView } | { type: "text"; id: string; text: string };

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_LIMIT = 240;
const TEXT_TIMEOUT_MS = 600000;
/**
 * 落库节奏：每 1 秒或每攒够 400 字写一次。
 * 每个 token 写一次库在长文本下会打出上千次写；只在结束时写一次又等于没有中途保护，
 * 这个节奏下最坏丢掉的也就是最后 1 秒的内容，而写库次数是常数级的。
 */
const TEXT_FLUSH_INTERVAL_MS = 1000;
const TEXT_FLUSH_CHARS = 400;
/** 补齐时一次最多回放多少个任务，和 listJobs 保持同一个上限。 */
const CATCH_UP_LIMIT = 200;
const runningJobs = new Map<string, AbortController>();
const streamConnections = new Set<{ userId: string; close: () => void }>();
/** 正在生成的文本任务的最新累积内容。内存里的这份比库里新，订阅时优先用它，避免刚订上就少一段。 */
const runningTexts = new Map<string, string>();
/** 账号任务按用户、分享任务按分享链接分发。没人订阅时事件丢弃也不影响正确性：任务本身照常落库。 */
const jobBus = new EventEmitter();
jobBus.setMaxListeners(0);
/** 每个账号/分享作用域已分配到的最大 seq。存 Promise，避免并发申请时各自读出同一个基准值。 */
const jobSeqs = new Map<string, Promise<number>>();
let ticking = false;

const jobs = () => repo(Job);

function jobScopeKey(userId: string, shareId = "") {
    return shareId ? `share:${shareId}` : `user:${userId}`;
}

function jobScopeWhere(userId: string, shareId = "") {
    return shareId ? { shareId } : { userId, shareId: "" };
}

/**
 * 账号任务列表除了本人直接发起的任务，也要带上写入本人画布的分享任务。
 * 后者的发起者可能已经离开分享页；所有者仍要能恢复 loading 节点并在异常时止损。
 */
function accountJobScopes(userId: string) {
    return [{ userId, shareId: "" }, { storageUserId: userId, shareId: Not("") }];
}

function nextJobSeq(userId: string, shareId = "") {
    const key = jobScopeKey(userId, shareId);
    // 进程重启后内存计数没了，从库里已分配的最大值续上，保证序号只增不减，老游标不会突然「跑到未来」。
    const base = jobSeqs.get(key) ?? jobs().findOne({ where: jobScopeWhere(userId, shareId), order: { seq: "DESC" } }).then((row) => row?.seq || 0, () => 0);
    const next = base.then((value) => value + 1);
    jobSeqs.set(key, next);
    return next;
}

export async function toJobView(job: Job): Promise<JobView> {
    return {
        id: job.id,
        clientJobId: job.clientJobId,
        kind: job.kind,
        status: job.status,
        model: job.model,
        progress: job.progress,
        error: job.error || "",
        outputs: await generationOutputViews(job),
        text: currentJobText(job),
        context: job.context || {},
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt || "",
    };
}

/**
 * 按客户端幂等键查任务。分享任务仍绑定最初发起者：同一分享里的其他协作者可以按任务 ID 查看，
 * 但不能拿别人的 clientJobId 冒充一次重试。路由会在应用当前分享策略之前先查这一层，
 * 这样任务创建后即使房主切换了代付策略，原请求的网络重试仍只会命中旧任务，不会被当成新扣费。
 */
export function findJobByClientId(userId: string, clientJobId: string, shareId = "") {
    const key = clientJobId.trim();
    return key ? jobs().findOneBy({ userId, shareId, clientJobId: key }) : Promise.resolve(null);
}

/**
 * clientJobId 是幂等键：同一用户重复提交同一个键只会命中已有任务。
 * 客户端断网重试、页面刷新后重发都不会造成重复生成或重复扣费。
 */
export async function createJob(userId: string, input: JobInput) {
    const clientJobId = input.clientJobId.trim();
    if (!clientJobId) throw fail("缺少任务幂等键");
    const existing = await findJobByClientId(userId, clientJobId, input.shareId || "");
    if (existing) return existing;

    const model = input.model.trim();
    if (!model) throw fail("缺少模型名称");
    const settings = await publicSettings();
    if (!settings.modelChannel.models.some((item) => item.name === model)) throw fail(`模型不可用：${model}`);

    // 付费方在创建时解析一次并固化到任务行上：任务可能跑几分钟，期间用户可能被移出团队，
    // 而退款必须回到当初扣钱的那个池子。解析只认按 userId 查得到的自己的画布，查不到就是个人。
    const payer = input.shareId
        ? ({ kind: "user", userId: input.payerUserId || userId } as const)
        : input.billingProjectId
          ? await payerOfProject(userId, input.billingProjectId)
          : ({ kind: "user", userId } as const);
    // 产出文件的云空间归属单独解析并单独固化：它跟画布走，不跟着付费方回落。
    const storageTeamId = await storageTeamOfProject(input.storageUserId || userId, input.billingProjectId || "");

    let job: Job;
    try {
        job = jobs().create({
            id: newId("job"),
            userId,
            storageUserId: input.storageUserId || userId,
            payerUserId: input.payerUserId || userId,
            shareId: input.shareId || "",
            clientJobId,
            kind: input.kind,
            status: "pending",
            model,
            prompt: input.prompt || "",
            params: JSON.stringify(input.params || {}),
            inputFileIds: input.inputFileIds || [],
            outputFileIds: [],
            text: "",
            context: input.context || {},
            error: "",
            credits: 0,
            progress: 0,
            seq: await nextJobSeq(userId, input.shareId || ""),
            upstreamTaskId: "",
            payerKind: payer.kind,
            payerTeamId: payer.kind === "team" ? payer.teamId : "",
            payerLogId: "",
            storageTeamId,
            createdAt: now(),
            updatedAt: now(),
            finishedAt: "",
        } as Job);
        await serialTransaction(async (manager) => {
            await requireActiveAccounts(manager, [input.storageUserId || userId, input.payerUserId || userId, userId]);
            await manager.getRepository(Job).insert(job as never);
        });
    } catch (error) {
        // 并发重试会同时通过上面的预查，最终由唯一索引裁掉一笔。输家回读赢家即可；
        // 若撞的是主键等其它唯一约束，按幂等键查不到记录，就把原始故障继续抛出。
        if (!isUniqueViolation(error)) throw error;
        const raced = await findJobByClientId(userId, clientJobId, input.shareId || "");
        if (!raced) throw error;
        return raced;
    }
    // 新任务本身也是一次变化，先广播再排队：已经挂着流的页面能立刻看到「pending」，不用等第一次状态变更。
    const event = { type: "job", seq: job.seq, job: await toJobView(job) } satisfies JobEvent;
    jobBus.emit(jobScopeKey(job.userId, job.shareId), event);
    void tick();
    return job;
}

export async function getJob(userId: string, id: string, shareId = "") {
    const job = await jobs().findOne({
        where: shareId ? { id, shareId } : [{ id, userId, shareId: "" }, { id, storageUserId: userId, shareId: Not("") }],
    });
    if (!job) throw fail("任务不存在");
    return job;
}

export async function listJobs(userId: string, statuses: JobStatus[], since: string, shareId = "") {
    const scopes = shareId ? [jobScopeWhere(userId, shareId)] : accountJobScopes(userId);
    return jobs().find({
        where: statuses.length ? scopes.flatMap((scope) => statuses.map((status) => ({ ...scope, status }))) : scopes,
        order: { updatedAt: "DESC" },
        take: 200,
    }).then((items) => (since ? items.filter((item) => item.updatedAt > since) : items));
}

type JobListCursor = { updatedAt: string; id: string };

function decodeJobListCursor(value: string): JobListCursor | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" || !parsed[0] || !parsed[1]) throw new Error();
        return { updatedAt: parsed[0], id: parsed[1] };
    } catch {
        throw fail("分页游标无效");
    }
}

function encodeJobListCursor(job: Job) {
    return Buffer.from(JSON.stringify([job.updatedAt, job.id]), "utf8").toString("base64url");
}

/**
 * 历史列表用 updatedAt + id 组成稳定游标。同一毫秒完成多条任务时，id 负责打破平局；
 * 多取一条只用于判断是否还有下一页，不会把 SSE 的回放上限与历史分页耦合起来。
 */
export async function listJobsPage(userId: string, statuses: JobStatus[], before: string, limit: number, shareId = "") {
    const scopes = shareId ? [jobScopeWhere(userId, shareId)] : accountJobScopes(userId);
    const statusScopes = statuses.length ? scopes.flatMap((scope) => statuses.map((status) => ({ ...scope, status }))) : scopes;
    const cursor = decodeJobListCursor(before);
    const where = cursor
        ? statusScopes.flatMap((scope) => [
              { ...scope, updatedAt: LessThan(cursor.updatedAt) },
              { ...scope, updatedAt: cursor.updatedAt, id: LessThan(cursor.id) },
          ])
        : statusScopes;
    const rows = await jobs().find({ where, order: { updatedAt: "DESC", id: "DESC" }, take: limit + 1 });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextBefore: hasMore ? encodeJobListCursor(items[items.length - 1]) : "" };
}

export async function cancelJob(userId: string, id: string, shareId = "") {
    // 分享内仍只允许最初发起者取消；账号通道额外允许画布所有者停止写入自己画布的分享任务。
    const job = await jobs().findOne({
        where: shareId ? { id, userId, shareId } : [{ id, userId, shareId: "" }, { id, storageUserId: userId, shareId: Not("") }],
    });
    if (!job) throw fail("任务不存在");
    runningJobs.get(job.id)?.abort();
    // 状态转换必须带旧状态：成功与取消可能同时落库，谁先把 running 改成终态谁赢，
    // 后到的一方只能读回结果，不能再把 succeeded 改成 canceled 或把 canceled 改回成功。
    while (job.status === "pending" || job.status === "running") {
        // 取消时把已经流出来的半截文本一并留下：用户不用为这次生成付费，但已经生成的部分不该被抹掉。
        if (await patchJobStatus(job, job.status, { status: "canceled", text: currentJobText(job), finishedAt: now() })) return job;
    }
    return job;
}

/**
 * 账号注销前停止所有由该账号发起、或写入该账号云空间的任务，并等后台协程真正退出。
 * 只把数据库改成 canceled 就立刻删行会留下竞态：协程可能随后又保存一个产出文件，形成无人可见的孤儿对象。
 */
export async function stopJobsForAccount(userId: string, timeoutMs = 30_000) {
    const rows = await jobs()
        .createQueryBuilder("job")
        .where("job.userId = :userId OR job.storageUserId = :userId", { userId })
        .getMany();
    const active = rows.filter((row) => row.status === "pending" || row.status === "running");
    await Promise.all(
        active.map((row) =>
            cancelJob(userId, row.id).catch(() => cancelJob(row.userId, row.id, row.shareId).catch(() => undefined)),
        ),
    );
    const deadline = Date.now() + timeoutMs;
    while (active.some((row) => runningJobs.has(row.id)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (active.some((row) => runningJobs.has(row.id))) throw fail("仍有生成任务正在结束，请稍后重试注销");
    return rows;
}

/** 文本任务已经生成出来的内容。内存里那份比库里新，正在跑的任务优先取它。 */
function currentJobText(job: Job) {
    return runningTexts.get(job.id) ?? job.text ?? "";
}

/**
 * 订阅当前用户所有任务的事件。断开只是取消监听，任务照常在服务端跑完并落库。
 * 只开一条按用户订阅的流而不是每个任务一条：浏览器对同源只给 6 个并发连接，
 * 同时跑几个生成就会把连接池占满，页面其它请求都会被卡住。
 */
export function subscribeJobs(userId: string, listener: (event: JobEvent) => void, shareId = "", onClose?: () => void) {
    const key = jobScopeKey(userId, shareId);
    jobBus.on(key, listener);
    const connection = onClose ? { userId, close: onClose } : null;
    if (connection) streamConnections.add(connection);
    return () => {
        jobBus.off(key, listener);
        if (connection) streamConnections.delete(connection);
    };
}

export function disconnectJobSubscribers(userId: string) {
    let closed = 0;
    for (const connection of [...streamConnections]) {
        if (connection.userId !== userId) continue;
        streamConnections.delete(connection);
        closed += 1;
        try {
            connection.close();
        } catch (error) {
            console.warn("关闭账号任务连接失败：", error);
        }
    }
    return closed;
}

/**
 * 断线重连要补齐的任务集合：seq 大于游标的（断线期间状态变过的）加上所有还没结束的。
 * 后一半不能省——文本任务边写内容边推增量并不改 seq，只按 seq 过滤会把「一直在跑、只是内容在长」的任务漏掉。
 * 未结束的任务数量受并发与队列限制，始终是个小集合，无条件带上不会把这次补齐撑爆。
 */
export function listJobsSince(userId: string, sinceSeq: number, shareId = "") {
    const scope = jobScopeWhere(userId, shareId);
    const active = { ...scope, status: In(["pending", "running"] satisfies JobStatus[]) };
    return jobs().find({
        where: sinceSeq > 0 ? [{ ...scope, seq: MoreThan(sinceSeq) }, active] : [active],
        order: { seq: "ASC" },
        take: CATCH_UP_LIMIT,
    });
}

/**
 * 只更新 patch 里的列，再把整行读回来。
 * 整行覆写（save）会把内存里那份可能已经过期的快照连同没改过的列一起写回去：
 * 取消发生在扣费之后时，取消那条路径手里的 job 快照还是扣费之前的，
 * 一次 save 就会把 payerLogId 与 credits 抹成空，那笔已经扣掉的钱从此没人退得了。
 */
async function patchJobWhere(job: Job, where: Partial<Pick<Job, "status">>, patch: Partial<Job>, archiveOutputs = false) {
    const seq = await nextJobSeq(job.userId, job.shareId);
    const next = { ...patch, updatedAt: now(), seq };
    let affected = false;
    let checksums: string[] = [];
    if (archiveOutputs) {
        await serialTransaction(async (manager) => {
            const result = await manager.getRepository(Job).update({ id: job.id, ...where }, next as never);
            affected = Boolean(result.affected);
            if (affected) checksums = await archiveJobOutputsWithManager(manager, { ...job, ...next } as Job, true);
        });
    } else {
        affected = Boolean((await jobs().update({ id: job.id, ...where }, next as never)).affected);
    }
    // 读回库里的真实行：并发路径改过的列也要带进内存，之后的判断才不会基于陈旧值。
    const latest = await jobs().findOneBy({ id: job.id });
    if (latest) Object.assign(job, latest);
    if (!affected) return false;
    // 历史引用已与终态同事务提交；refCount 是可重建缓存，提交后异步对账即可，不能因对账瞬时失败把已成功任务改判失败。
    for (const checksum of checksums) {
        void import("./blob-gc").then(({ reconcileBlobReferences }) => reconcileBlobReferences(checksum)).catch((error) => console.error(`reconcile archived output ${checksum} failed:`, error));
    }
    // 先落库再广播：订阅方收到的快照一定已经能从库里读到，断线重连按 seq 补齐时不会出现「推过但库里没有」的空档。
    const event = { type: "job", seq: job.seq, job: await toJobView(job) } satisfies JobEvent;
    jobBus.emit(jobScopeKey(job.userId, job.shareId), event);
    return true;
}

async function patchJob(job: Job, patch: Partial<Job>) {
    await patchJobWhere(job, {}, patch);
    return job;
}

/** 任务状态机的 CAS：只有仍处于 expected 时才允许写入下一状态或终态附加数据。 */
function patchJobStatus(job: Job, expected: JobStatus, patch: Partial<Job>, archiveOutputs = false) {
    return patchJobWhere(job, { status: expected }, patch, archiveOutputs);
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new SafeError("任务已取消"));
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new SafeError("任务已取消"));
        }, { once: true });
    });
}

async function groupReferences(userId: string, ids: string[]) {
    const files = await listFiles(userId, ids);
    const ordered = ids.map((id) => files.find((file) => file.id === id)).filter((file): file is StoredFile => Boolean(file));
    return {
        images: ordered.filter((file) => file.kind === "image"),
        videos: ordered.filter((file) => file.kind === "video"),
        audios: ordered.filter((file) => file.kind === "audio"),
    };
}

/** 配了公网地址就给上游直链，否则退回 data url，避免上游回源不到本地文件。 */
function referenceUrlResolver() {
    return async (file: StoredFile) => (config.publicBaseUrl ? publicFileUrl(config.publicBaseUrl, file.id) : fileToDataUrl(file));
}

async function runImageJob(job: Job, signal: AbortSignal) {
    const channel = await selectModelChannel(job.model);
    const settings = await publicSettings();
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const references = await groupReferences(job.storageUserId || job.userId, job.inputFileIds || []);
    const images = await generateImages(channel, job.model, settings.modelChannel.systemPrompt, job.prompt, params, references.images, signal);
    await patchJob(job, { progress: 80 });
    const files = [];
    for (const image of images) files.push(await saveFileFromUrl(job.storageUserId || job.userId, image, undefined, job.storageTeamId || ""));
    return files.map((file) => file.id);
}

async function runVideoJob(job: Job, signal: AbortSignal) {
    const channel = await selectModelChannel(job.model);
    const settings = await publicSettings();
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    let taskId = job.upstreamTaskId;
    if (!taskId) {
        const references = await groupReferences(job.storageUserId || job.userId, job.inputFileIds || []);
        const prompt = settings.modelChannel.systemPrompt.trim() ? `${settings.modelChannel.systemPrompt.trim()}\n\n${job.prompt}` : job.prompt;
        taskId = await createVideoTask(channel, job.model, prompt, params, references, referenceUrlResolver(), signal);
        await patchJob(job, { upstreamTaskId: taskId, progress: 20 });
    }
    for (let attempt = 0; attempt < VIDEO_POLL_LIMIT; attempt += 1) {
        await delay(VIDEO_POLL_INTERVAL_MS, signal);
        const state = await pollVideoTask(channel, job.model, taskId, signal);
        if (state.status === "failed") throw fail(state.error);
        if (state.status === "completed") {
            const file = state.body ? await saveFile(job.storageUserId || job.userId, state.body, state.mimeType || "video/mp4", {}, job.storageTeamId || "") : await saveFileFromUrl(job.storageUserId || job.userId, state.url || "", undefined, job.storageTeamId || "");
            return [file.id];
        }
        if (attempt % 6 === 5) await patchJob(job, { progress: Math.min(90, 20 + Math.floor((attempt / VIDEO_POLL_LIMIT) * 70)) });
    }
    throw fail("视频生成超时，请稍后重试");
}

async function runAudioJob(job: Job, signal: AbortSignal) {
    const channel = await selectModelChannel(job.model);
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const result = await generateAudio(channel, job.model, job.prompt, params, signal);
    const file = await saveFile(job.storageUserId || job.userId, result.body, result.mimeType, {}, job.storageTeamId || "");
    return [file.id];
}

/**
 * 文本任务：边收上游流边把累积内容落库并广播。
 * 落库是「攒够字数或攒够时间」触发的，不跟着 token 走，否则一段长文本要打上千次写库。
 */
async function runTextJob(job: Job, signal: AbortSignal) {
    const channel = await selectModelChannel(job.model);
    const settings = await publicSettings();
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const references = await groupReferences(job.storageUserId || job.userId, job.inputFileIds || []);
    let text = "";
    let flushedAt = Date.now();
    let flushedLength = 0;
    runningTexts.set(job.id, "");

    const onDelta = (delta: string) => {
        text += delta;
        runningTexts.set(job.id, text);
        jobBus.emit(jobScopeKey(job.userId, job.shareId), { type: "text", id: job.id, text } satisfies JobEvent);
        if (Date.now() - flushedAt < TEXT_FLUSH_INTERVAL_MS && text.length - flushedLength < TEXT_FLUSH_CHARS) return;
        flushedAt = Date.now();
        flushedLength = text.length;
        // 落库失败不该中断生成：下一次 flush 会把完整内容再写一遍，内容不会缺。
        void jobs().update({ id: job.id }, { text, updatedAt: now() }).catch(() => undefined);
    };

    // 上游卡住时不能一直占着并发槽，超时和取消一起纳入同一个信号。
    const timed = AbortSignal.any([signal, AbortSignal.timeout(TEXT_TIMEOUT_MS)]);
    await generateText(channel, job.model, settings.modelChannel.systemPrompt, job.prompt, params, references.images, onDelta, timed);
    if (!text.trim()) throw fail("文本生成失败：接口没有返回内容");
    return text;
}

/**
 * 退掉任务行上「已扣未结」的那一笔，返回这笔账是不是已经结清。
 * 只有 refund 正常返回（真退了，或撞唯一约束说明早已退过）才算结清；抛错一律算没结清，
 * 调用方必须原样保留 payerLogId / credits，否则这笔钱就此失去唯一的线索，再也退不回去。
 */
async function settleRefund(job: Job) {
    if (!(job.credits > 0 && job.payerLogId)) return true;
    try {
        await refund(receiptOfJob(job), { model: job.model, path: `/jobs/${job.kind}` });
        return true;
    } catch (error) {
        console.error(`job ${job.id} refund failed:`, error);
        return false;
    }
}

async function runJob(job: Job) {
    const controller = new AbortController();
    runningJobs.set(job.id, controller);
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const credits = (await modelCost(job.model, params.quality)) * Math.max(1, params.count || 1);
    let producedOutputs: string[] = [];
    try {
        // tick 读到 pending 后，用户可能已经取消。CAS 失败就说明这份快照过期，不能继续扣费或调用上游。
        if (!(await patchJobStatus(job, "pending", { status: "running", progress: 10, text: "" }))) return;
        // 扣点在实际调用上游之前，失败路径统一返还，避免任务重试重复扣费。
        // 回执由 charge 在扣费成功的同一个事务里写回任务行：分两步做的话，进程崩在中间就是钱扣了、
        // 任务行上却查不到那笔流水，重启后既退不掉也没人认领。
        // 反过来也不能在外面套事务：团队池不足时 charge 抛错会把同事务里的 insufficient 留痕一起回滚。
        if (!job.credits && credits > 0) {
            const receipt = await charge(payerOfJob(job), credits, { model: job.model, path: `/jobs/${job.kind}` }, async (manager, paid) => {
                // 团队池不足回落到个人时，实际付款方已经变成个人，必须把它写回任务行：
                // 否则重启后按旧的 payerKind 退款，钱会退进团队池，个人那边白花一笔。
                await manager.getRepository(Job).update({ id: job.id }, {
                    credits: paid.credits,
                    payerKind: paid.payer.kind,
                    payerTeamId: paid.payer.kind === "team" ? paid.payer.teamId : "",
                    payerLogId: paid.logId,
                });
            });
            await patchJob(job, { credits, payerKind: receipt.payer.kind, payerTeamId: receipt.payer.kind === "team" ? receipt.payer.teamId : "", payerLogId: receipt.logId });
        }
        const text = job.kind === "text" ? await runTextJob(job, controller.signal) : "";
        producedOutputs = job.kind === "text" ? [] : job.kind === "video" ? await runVideoJob(job, controller.signal) : job.kind === "audio" ? await runAudioJob(job, controller.signal) : await runImageJob(job, controller.signal);
        if (await patchJobStatus(job, "running", { status: "succeeded", progress: 100, outputFileIds: producedOutputs, text, finishedAt: now(), error: "" }, true)) return;
        // 产物已经保存后才收到取消：状态保持 canceled，但文件不能变成没人引用的孤儿，
        // 已扣的点也必须在本次进程里结清，不能拖到下次重启扫描。
        if (job.status === "canceled") {
            const settled = await settleRefund(job);
            await patchJobStatus(job, "canceled", {
                progress: 100,
                outputFileIds: producedOutputs,
                text,
                ...(settled ? { credits: 0, payerLogId: "" } : {}),
                error: settled ? "任务已取消" : "任务已取消（算力点返还失败，稍后会自动重试）",
                finishedAt: job.finishedAt || now(),
            }, true);
        }
    } catch (error) {
        // charge 的回执可能刚由事务写回，取消路径手里的对象也可能更旧；退款前先读真实行。
        Object.assign(job, (await jobs().findOneBy({ id: job.id })) || job);
        const canceled = controller.signal.aborted || job.status === "canceled";
        // 失败与取消都全额返还：让用户「既没拿到完整内容又被扣了钱」是最不能接受的结果，
        // 已经流出来的半截文本照常保留在任务里，用户不花钱也能留住它。
        // 退款按任务行上固化的 payer 走，不重新解析：用户可能已经被移出团队，
        // 重新解析会把当初从团队池扣的钱退进他的个人余额。
        const settled = await settleRefund(job);
        const message = error instanceof SafeError ? error.message : "生成失败，请稍后重试";
        if (!canceled) console.error(`job ${job.id} failed:`, error);
        // 退款没退成时绝不清回执：清了就再没有任何地方记得这笔钱，谁都退不了了。
        // 保留下来，下次启动的扫描会照着它再退一次（退款本身幂等，不会退成两笔）。
        const terminalPatch: Partial<Job> = {
            ...(settled ? { credits: 0, payerLogId: "" } : {}),
            ...(producedOutputs.length ? { outputFileIds: producedOutputs } : {}),
            text: runningTexts.get(job.id) ?? job.text ?? "",
            error: canceled ? "任务已取消" : settled ? message : `${message}（算力点返还失败，稍后会自动重试）`,
            finishedAt: now(),
        };
        const archiveOutputs = producedOutputs.length > 0;
        if (canceled) {
            if (job.status === "canceled") await patchJobStatus(job, "canceled", terminalPatch, archiveOutputs);
            else if (!(await patchJobStatus(job, "running", { status: "canceled", ...terminalPatch }, archiveOutputs))) {
                const latest = await jobs().findOneBy({ id: job.id });
                if (latest?.status === "canceled") {
                    Object.assign(job, latest);
                    await patchJobStatus(job, "canceled", terminalPatch, archiveOutputs);
                }
            }
        } else if (!(await patchJobStatus(job, "running", { status: "failed", ...terminalPatch }, archiveOutputs))) {
            const latest = await jobs().findOneBy({ id: job.id });
            if (latest?.status === "canceled") {
                Object.assign(job, latest);
                // 失败与取消同时发生时取消先赢；退款已经完成，只把结算字段补到 canceled 行上。
                await patchJobStatus(job, "canceled", { ...terminalPatch, error: settled ? "任务已取消" : "任务已取消（算力点返还失败，稍后会自动重试）" }, archiveOutputs);
            }
        }
    } finally {
        // 终态由上面的 patchJob 广播（快照里带着最终文本），这里只清内存；
        // 清在广播之后，之后新来的订阅直接读库里的最终内容。
        runningTexts.delete(job.id);
        runningJobs.delete(job.id);
    }
}

async function tick() {
    if (ticking) return;
    ticking = true;
    try {
        const slots = config.jobConcurrency - runningJobs.size;
        if (slots <= 0) return;
        const pending = await jobs().find({ where: { status: "pending" }, order: { createdAt: "ASC" }, take: slots });
        for (const job of pending) {
            if (runningJobs.has(job.id)) continue;
            void runJob(job).finally(() => void tick());
        }
    } catch (error) {
        console.error("job scheduler failed:", error);
    } finally {
        ticking = false;
    }
}

/**
 * 把上一次进程留下的账结清，并把 running 任务放回队列。
 *
 * 扫描范围不能只有 running：退款失败的行会被标成 failed 并原样留着回执，
 * 那笔钱要靠下一次启动再试一遍，只扫 running 就等于永远不再重试。
 * 已成功的任务不在扫描内——它们的回执是交付完成的凭据，留着供对账，不是待结的账。
 *
 * 每一行都是「先退，退成了才清」：不退，用户就为一次没跑完的任务白付了钱；
 * 退成了不清零，重跑时 `!job.credits` 判定为假，整个任务就成了免费的。
 * 退款本身幂等（refundOf 唯一索引），所以崩在退款与清零之间、下次启动再走一遍也不会退第二次。
 */
export async function resetRunningJobs() {
    const outstanding = { credits: MoreThan(0), payerLogId: Not("") };
    const stale = await jobs().find({
        where: [{ status: "running" }, { status: "pending", ...outstanding }, { status: "failed", ...outstanding }, { status: "canceled", ...outstanding }],
    });
    for (const job of stale) {
        if (!(job.credits > 0 && job.payerLogId)) {
            if (job.status !== "running") continue;
            // credits 记着钱、却没有回执：可能是这一列还没上线时留下的存量行，也可能是哪里写坏了。
            // 这笔钱已经没有任何线索能原路退回，但更不能放着不管——留着 credits，重跑时
            // `!job.credits` 判定为假，这次生成一分钱不收。清零让它照常重新扣一次，同时把这行喊出来人工对账。
            if (job.credits > 0) console.error(`job ${job.id} has credits ${job.credits} but no payer log; clearing so the retry charges again`);
            await jobs().update({ id: job.id }, { status: "pending", credits: 0, updatedAt: now() });
            continue;
        }
        if (!(await settleRefund(job))) {
            // 退款没成功：回执必须原样留着等下次启动重试，同时不能让它以 running 的样子回到队列——
            // 那会拿着一笔没退掉的钱重跑一遍，用户等于付了两次。
            if (job.status === "running") await jobs().update({ id: job.id }, { status: "failed", error: "服务已重启，算力点返还失败，稍后会自动重试", finishedAt: now(), updatedAt: now() });
            continue;
        }
        await jobs().update({ id: job.id }, { credits: 0, payerLogId: "", ...(job.status === "running" ? { status: "pending" as JobStatus } : {}), updatedAt: now() });
    }
}

/**
 * 进程重启后把 running 任务放回队列。视频任务已经把上游任务 ID 落库，
 * 重新执行时会跳过创建、直接续查，不会重复生成。
 */
export async function startJobWorker() {
    await resetRunningJobs();
    setInterval(() => void tick(), 2000).unref();
    void tick();
}
