import { EventEmitter } from "node:events";
import { In } from "typeorm";

import { config } from "../config";
import { repo } from "../db/data-source";
import { Job, StoredFile, type JobKind, type JobStatus } from "../db/entities";
import { fail, newId, now, SafeError } from "../lib/errors";
import { consumeUserCredits, refundUserCredits } from "./auth";
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

/** 事件里带的是「到目前为止的完整文本」而不是单次增量：订阅方按已收到的长度截尾，重复收到或漏收都不会错位。 */
export type JobTextEvent = { text: string; status: JobStatus; error: string };

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
const runningJobs = new Map<string, AbortController>();
/** 正在生成的文本任务的最新累积内容。内存里的这份比库里新，订阅时优先用它，避免刚订上就少一段。 */
const runningTexts = new Map<string, string>();
const textBus = new EventEmitter();
textBus.setMaxListeners(0);
let ticking = false;

const jobs = () => repo(Job);

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
        text: job.text || "",
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
        upstreamTaskId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: "",
    } as Job);
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

export function isJobFinished(status: JobStatus) {
    return status === "succeeded" || status === "failed" || status === "canceled";
}

/** 文本任务已经生成出来的内容。内存里那份比库里新，正在跑的任务优先取它。 */
export function currentJobText(job: Job) {
    return runningTexts.get(job.id) ?? job.text ?? "";
}

/**
 * 订阅文本任务的实时增量。断开只是取消订阅，任务照常跑完并落库，
 * 重新订阅时按已收到的字符数续上即可，不用把整段重来。
 */
export function subscribeJobText(jobId: string, listener: (event: JobTextEvent) => void) {
    textBus.on(jobId, listener);
    return () => void textBus.off(jobId, listener);
}

async function patchJob(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: now() });
    return jobs().save(job);
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
        textBus.emit(job.id, { text, status: "running", error: "" } satisfies JobTextEvent);
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
            await consumeUserCredits(job.userId, job.model, credits, `/jobs/${job.kind}`);
            await patchJob(job, { credits });
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
        if (job.credits > 0) await refundUserCredits(job.userId, job.model, job.credits, `/jobs/${job.kind}`).catch(() => undefined);
        const message = error instanceof SafeError ? error.message : "生成失败，请稍后重试";
        if (!canceled) console.error(`job ${job.id} failed:`, error);
        await patchJob(job, { status: canceled ? "canceled" : "failed", credits: 0, text: runningTexts.get(job.id) ?? job.text ?? "", error: canceled ? "任务已取消" : message, finishedAt: now() });
    } finally {
        // 广播终态后再清内存：订阅方据此结束等待，之后新来的订阅直接读库里的最终内容。
        textBus.emit(job.id, { text: job.text || "", status: job.status, error: job.error || "" } satisfies JobTextEvent);
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
