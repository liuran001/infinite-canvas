import { EventEmitter } from "node:events";
import { In, MoreThan } from "typeorm";

import { config } from "../config";
import { repo } from "../db/data-source";
import { Job, StoredFile, type JobKind, type JobStatus } from "../db/entities";
import { fail, newId, now, SafeError } from "../lib/errors";
import { charge, payerOfJob, payerOfProject, receiptOfJob, refund } from "./billing";
import { listFiles, publicFileUrl, saveFile, saveFileFromUrl } from "./files";
import { createVideoTask, fileToDataUrl, generateAudio, generateImages, generateText, pollVideoTask, type GenerationParams } from "./generation";
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
};

export type JobView = {
    id: string;
    clientJobId: string;
    kind: JobKind;
    status: JobStatus;
    model: string;
    progress: number;
    error: string;
    outputs: Array<{ id: string; kind: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number }>;
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
/** 正在生成的文本任务的最新累积内容。内存里的这份比库里新，订阅时优先用它，避免刚订上就少一段。 */
const runningTexts = new Map<string, string>();
/** 按用户分发的任务事件。没人订阅时事件直接丢弃也不影响正确性：任务本身照常跑完并落库。 */
const jobBus = new EventEmitter();
jobBus.setMaxListeners(0);
/** 每个用户已分配到的最大 seq。存 Promise 而不是数字：同一用户的并发任务同时申请时只会去库里取一次基准值，不会各取各的取出重号。 */
const jobSeqs = new Map<string, Promise<number>>();
let ticking = false;

const jobs = () => repo(Job);

function nextJobSeq(userId: string) {
    // 进程重启后内存计数没了，从库里已分配的最大值续上，保证序号只增不减，老游标不会突然「跑到未来」。
    const base = jobSeqs.get(userId) ?? jobs().findOne({ where: { userId }, order: { seq: "DESC" } }).then((row) => row?.seq || 0, () => 0);
    const next = base.then((value) => value + 1);
    jobSeqs.set(userId, next);
    return next;
}

export async function toJobView(job: Job): Promise<JobView> {
    const outputs = job.outputFileIds?.length ? await repo(StoredFile).findBy({ id: In(job.outputFileIds) }) : [];
    const byId = new Map(outputs.map((file) => [file.id, file]));
    return {
        id: job.id,
        clientJobId: job.clientJobId,
        kind: job.kind,
        status: job.status,
        model: job.model,
        progress: job.progress,
        error: job.error || "",
        outputs: (job.outputFileIds || [])
            .map((id) => byId.get(id))
            .filter((file): file is StoredFile => Boolean(file))
            .map((file) => ({ id: file.id, kind: file.kind, mimeType: file.mimeType, bytes: Number(file.bytes), width: file.width, height: file.height, durationMs: file.durationMs })),
        text: currentJobText(job),
        context: job.context || {},
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt || "",
    };
}

/**
 * clientJobId 是幂等键：同一用户重复提交同一个键只会命中已有任务。
 * 客户端断网重试、页面刷新后重发都不会造成重复生成或重复扣费。
 */
export async function createJob(userId: string, input: JobInput) {
    const clientJobId = input.clientJobId.trim();
    if (!clientJobId) throw fail("缺少任务幂等键");
    const existing = await jobs().findOneBy({ userId, clientJobId });
    if (existing) return existing;

    const model = input.model.trim();
    if (!model) throw fail("缺少模型名称");
    const settings = await publicSettings();
    if (!settings.modelChannel.models.some((item) => item.name === model)) throw fail(`模型不可用：${model}`);

    // 付费方在创建时解析一次并固化到任务行上：任务可能跑几分钟，期间用户可能被移出团队，
    // 而退款必须回到当初扣钱的那个池子。解析只认按 userId 查得到的自己的画布，查不到就是个人。
    const payer = input.billingProjectId ? await payerOfProject(userId, input.billingProjectId) : ({ kind: "user", userId } as const);

    const job = await jobs().save({
        id: newId("job"),
        userId,
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
        seq: await nextJobSeq(userId),
        upstreamTaskId: "",
        payerKind: payer.kind,
        payerTeamId: payer.kind === "team" ? payer.teamId : "",
        payerLogId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: "",
    } as Job);
    // 新任务本身也是一次变化，先广播再排队：已经挂着流的页面能立刻看到「pending」，不用等第一次状态变更。
    jobBus.emit(job.userId, { type: "job", seq: job.seq, job: await toJobView(job) } satisfies JobEvent);
    void tick();
    return job;
}

export async function getJob(userId: string, id: string) {
    const job = await jobs().findOneBy({ id, userId });
    if (!job) throw fail("任务不存在");
    return job;
}

export async function listJobs(userId: string, statuses: JobStatus[], since: string) {
    return jobs().find({
        where: statuses.length ? statuses.map((status) => ({ userId, status })) : { userId },
        order: { updatedAt: "DESC" },
        take: 200,
    }).then((items) => (since ? items.filter((item) => item.updatedAt > since) : items));
}

export async function cancelJob(userId: string, id: string) {
    const job = await getJob(userId, id);
    if (job.status === "succeeded" || job.status === "failed") return job;
    runningJobs.get(job.id)?.abort();
    // 取消时把已经流出来的半截文本一并留下：用户不用为这次生成付费，但已经生成的部分不该被抹掉。
    return patchJob(job, { status: "canceled", text: currentJobText(job), finishedAt: now() });
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
export function subscribeJobs(userId: string, listener: (event: JobEvent) => void) {
    jobBus.on(userId, listener);
    return () => void jobBus.off(userId, listener);
}

/**
 * 断线重连要补齐的任务集合：seq 大于游标的（断线期间状态变过的）加上所有还没结束的。
 * 后一半不能省——文本任务边写内容边推增量并不改 seq，只按 seq 过滤会把「一直在跑、只是内容在长」的任务漏掉。
 * 未结束的任务数量受并发与队列限制，始终是个小集合，无条件带上不会把这次补齐撑爆。
 */
export function listJobsSince(userId: string, sinceSeq: number) {
    const active = { userId, status: In(["pending", "running"] satisfies JobStatus[]) };
    return jobs().find({
        where: sinceSeq > 0 ? [{ userId, seq: MoreThan(sinceSeq) }, active] : [active],
        order: { seq: "ASC" },
        take: CATCH_UP_LIMIT,
    });
}

async function patchJob(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: now(), seq: await nextJobSeq(job.userId) });
    await jobs().save(job);
    // 先落库再广播：订阅方收到的快照一定已经能从库里读到，断线重连按 seq 补齐时不会出现「推过但库里没有」的空档。
    jobBus.emit(job.userId, { type: "job", seq: job.seq, job: await toJobView(job) } satisfies JobEvent);
    return job;
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
    const references = await groupReferences(job.userId, job.inputFileIds || []);
    const images = await generateImages(channel, job.model, settings.modelChannel.systemPrompt, job.prompt, params, references.images, signal);
    await patchJob(job, { progress: 80 });
    const files = [];
    for (const image of images) files.push(await saveFileFromUrl(job.userId, image));
    return files.map((file) => file.id);
}

async function runVideoJob(job: Job, signal: AbortSignal) {
    const channel = await selectModelChannel(job.model);
    const settings = await publicSettings();
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    let taskId = job.upstreamTaskId;
    if (!taskId) {
        const references = await groupReferences(job.userId, job.inputFileIds || []);
        const prompt = settings.modelChannel.systemPrompt.trim() ? `${settings.modelChannel.systemPrompt.trim()}\n\n${job.prompt}` : job.prompt;
        taskId = await createVideoTask(channel, job.model, prompt, params, references, referenceUrlResolver(), signal);
        await patchJob(job, { upstreamTaskId: taskId, progress: 20 });
    }
    for (let attempt = 0; attempt < VIDEO_POLL_LIMIT; attempt += 1) {
        await delay(VIDEO_POLL_INTERVAL_MS, signal);
        const state = await pollVideoTask(channel, job.model, taskId, signal);
        if (state.status === "failed") throw fail(state.error);
        if (state.status === "completed") {
            const file = state.body ? await saveFile(job.userId, state.body, state.mimeType || "video/mp4") : await saveFileFromUrl(job.userId, state.url || "");
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
    const file = await saveFile(job.userId, result.body, result.mimeType);
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
    const references = await groupReferences(job.userId, job.inputFileIds || []);
    let text = "";
    let flushedAt = Date.now();
    let flushedLength = 0;
    runningTexts.set(job.id, "");

    const onDelta = (delta: string) => {
        text += delta;
        runningTexts.set(job.id, text);
        jobBus.emit(job.userId, { type: "text", id: job.id, text } satisfies JobEvent);
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

async function runJob(job: Job) {
    const controller = new AbortController();
    runningJobs.set(job.id, controller);
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const credits = (await modelCost(job.model, params.quality)) * Math.max(1, params.count || 1);
    try {
        await patchJob(job, { status: "running", progress: 10, text: "" });
        // 扣点在实际调用上游之前，失败路径统一返还，避免任务重试重复扣费。
        if (!job.credits && credits > 0) {
            const receipt = await charge(payerOfJob(job), credits, { model: job.model, path: `/jobs/${job.kind}` });
            // 团队池不足回落到个人时，实际付款方已经变成个人，必须把它写回任务行：
            // 否则重启后按旧的 payerKind 退款，钱会退进团队池，个人那边白花一笔。
            await patchJob(job, { credits, payerKind: receipt.payer.kind, payerTeamId: receipt.payer.kind === "team" ? receipt.payer.teamId : "", payerLogId: receipt.logId });
        }
        const text = job.kind === "text" ? await runTextJob(job, controller.signal) : "";
        const outputs = job.kind === "text" ? [] : job.kind === "video" ? await runVideoJob(job, controller.signal) : job.kind === "audio" ? await runAudioJob(job, controller.signal) : await runImageJob(job, controller.signal);
        const latest = await jobs().findOneBy({ id: job.id });
        // 取消已经把终态写进库了，这里不能再改回成功；把最新状态贴回内存，finally 才会广播正确的终态。
        if (latest?.status === "canceled") return void Object.assign(job, latest);
        await patchJob(job, { status: "succeeded", progress: 100, outputFileIds: outputs, text, finishedAt: now(), error: "" });
    } catch (error) {
        const canceled = controller.signal.aborted;
        // 失败与取消都全额返还：让用户「既没拿到完整内容又被扣了钱」是最不能接受的结果，
        // 已经流出来的半截文本照常保留在任务里，用户不花钱也能留住它。
        // 退款按任务行上固化的 payer 走，不重新解析：用户可能已经被移出团队，
        // 重新解析会把当初从团队池扣的钱退进他的个人余额。
        if (job.credits > 0) await refund(receiptOfJob(job), { model: job.model, path: `/jobs/${job.kind}` }).catch(() => undefined);
        const message = error instanceof SafeError ? error.message : "生成失败，请稍后重试";
        if (!canceled) console.error(`job ${job.id} failed:`, error);
        await patchJob(job, { status: canceled ? "canceled" : "failed", credits: 0, payerLogId: "", text: runningTexts.get(job.id) ?? job.text ?? "", error: canceled ? "任务已取消" : message, finishedAt: now() });
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
 * 进程重启后把 running 任务放回队列。视频任务已经把上游任务 ID 落库，
 * 重新执行时会跳过创建、直接续查，不会重复生成。
 */
export async function startJobWorker() {
    await jobs().update({ status: "running" }, { status: "pending", updatedAt: now() });
    setInterval(() => void tick(), 2000).unref();
    void tick();
}
