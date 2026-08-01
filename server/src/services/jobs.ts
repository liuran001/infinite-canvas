import { In } from "typeorm";

import { config } from "../config";
import { repo } from "../db/data-source";
import { Job, StoredFile, type JobKind, type JobStatus } from "../db/entities";
import { fail, newId, now, SafeError } from "../lib/errors";
import { consumeUserCredits, refundUserCredits } from "./auth";
import { listFiles, publicFileUrl, saveFile, saveFileFromUrl } from "./files";
import { createVideoTask, fileToDataUrl, generateAudio, generateImages, pollVideoTask, type GenerationParams } from "./generation";
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
    context: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    finishedAt: string;
};

const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_LIMIT = 240;
const runningJobs = new Map<string, AbortController>();
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
    return patchJob(job, { status: "canceled", finishedAt: now() });
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

async function runJob(job: Job) {
    const controller = new AbortController();
    runningJobs.set(job.id, controller);
    const params = JSON.parse(job.params || "{}") as GenerationParams;
    const credits = (await modelCost(job.model, params.quality)) * Math.max(1, params.count || 1);
    try {
        await patchJob(job, { status: "running", progress: 10 });
        // 扣点在实际调用上游之前，失败路径统一返还，避免任务重试重复扣费。
        if (!job.credits && credits > 0) {
            await consumeUserCredits(job.userId, job.model, credits, `/jobs/${job.kind}`);
            await patchJob(job, { credits });
        }
        const outputs = job.kind === "video" ? await runVideoJob(job, controller.signal) : job.kind === "audio" ? await runAudioJob(job, controller.signal) : await runImageJob(job, controller.signal);
        const latest = await jobs().findOneBy({ id: job.id });
        if (latest?.status === "canceled") return;
        await patchJob(job, { status: "succeeded", progress: 100, outputFileIds: outputs, finishedAt: now(), error: "" });
    } catch (error) {
        const canceled = controller.signal.aborted;
        if (job.credits > 0) await refundUserCredits(job.userId, job.model, job.credits, `/jobs/${job.kind}`).catch(() => undefined);
        const message = error instanceof SafeError ? error.message : "生成失败，请稍后重试";
        if (!canceled) console.error(`job ${job.id} failed:`, error);
        await patchJob(job, { status: canceled ? "canceled" : "failed", credits: 0, error: canceled ? "任务已取消" : message, finishedAt: now() });
    } finally {
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
