import { nanoid } from "nanoid";

import { normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { boolConfig, buildSeedancePromptText, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution } from "@/lib/seedance-video";
import { adoptServerMedia, getMediaBlob, type UploadedFile } from "@/services/file-storage";
import { adoptServerImage, imageToDataUrl, serverFileIdOf, uploadImage, type UploadedImage } from "@/services/image-storage";
import { isChannelModelValue, modelOptionName, resolveModelScript, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useJobStore, type JobContext, type TrackedJob } from "@/stores/use-job-store";
import { isServerMode, serverModelFormat, useServerStore, type ServerCapability } from "@/stores/use-server-store";
import { requestAudioGeneration, storeGeneratedAudio } from "./audio";
import { normalizeBackground, normalizeQuality, requestEdit, requestGeneration, resolveRequestSize } from "./image";
import { serverApi, serverFileUrl, type ServerFile } from "./server";
import { createVideoGenerationTask, normalizeVideoResolution, normalizeVideoSeconds, normalizeVideoSize, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationResult, type VideoGenerationTask, type VideoGenerationTaskState } from "./video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** clientJobId 由调用方持有，重发同一个键服务端只会生成一次，也不会重复扣算力点。 */
export type GenerationOptions = { signal?: AbortSignal; clientJobId?: string; onProgress?: (progress: number) => void; context?: JobContext };
export type ImageGenerationOptions = GenerationOptions & { mask?: ReferenceImage };

/** 服务器模式下 file 已经落在服务端，转存时直接登记引用，不重复上传。 */
export type GeneratedImage = { id: string; dataUrl: string; file?: ServerFile };

export type ServerVideoTask = { id: string; provider: "server"; model: string; clientJobId: string };
export type VideoTask = VideoGenerationTask | ServerVideoTask;

const IMAGE_POLL_MS = 2000;
const VIDEO_POLL_MS = 5000;
const AUDIO_POLL_MS = 2000;
const SCRIPT_UNSUPPORTED = "模型调用脚本仅在本地模式可用，服务器模式请改用服务端提供的模型";
/** 服务端视频任务的产物文件，落存储时直接引用，省掉一次重复下载上传。 */
const serverVideoFiles = new Map<string, ServerFile>();

function serverSettings() {
    return useServerStore.getState().settings;
}

/** 服务器模式下模型必须来自服务端模型列表，选择的本地模型名对不上时退回服务端默认模型。 */
function serverModel(config: AiConfig, capability: ServerCapability) {
    const channel = serverSettings()?.modelChannel;
    if (!channel) throw new Error("服务端配置尚未就绪，请稍后重试");
    const selected = modelOptionName(config.model || (capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel));
    if (channel.models.some((item) => item.name === selected && item.capability === capability)) return selected;
    const fallback = capability === "image" ? channel.defaultImageModel : capability === "video" ? channel.defaultVideoModel : capability === "audio" ? channel.defaultAudioModel : channel.defaultTextModel;
    if (!fallback) throw new Error(`服务端没有配置可用的${capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "audio" ? "音频" : "文本"}模型`);
    return fallback;
}

/** 服务器模式下模型脚本跑不起来（脚本只在浏览器执行），选中带脚本的本地模型时直接给出明确提示。 */
function assertNoModelScript(config: AiConfig, capability: ModelCapability) {
    const selected = config.model || (capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel);
    if (isChannelModelValue(selected) && resolveModelScript(config, selected)) throw new Error(SCRIPT_UNSUPPORTED);
}

/** 生成前的配置校验：服务器模式只看服务端模型，本地模式沿用渠道密钥校验。 */
export function isGenerationReady(config: AiConfig, model: string, isAiConfigReady: (config: AiConfig, model: string) => boolean) {
    if (!isServerMode()) return isAiConfigReady(config, model);
    return Boolean(serverSettings()?.modelChannel.models.length);
}

async function imageFileId(image: ReferenceImage) {
    const existing = serverFileIdOf(image.storageKey);
    if (existing) return existing;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请重新上传");
    return (await serverApi.uploadFile(await (await fetch(dataUrl)).blob(), { filename: image.name })).id;
}

async function mediaFileId(media: { name?: string; url?: string; storageKey?: string; durationMs?: number }) {
    const existing = serverFileIdOf(media.storageKey);
    if (existing) return existing;
    const blob = (media.storageKey ? await getMediaBlob(media.storageKey) : null) || (media.url ? await (await fetch(media.url)).blob() : null);
    if (!blob) throw new Error("参考素材读取失败，请重新上传");
    return (await serverApi.uploadFile(blob, { filename: media.name, durationMs: media.durationMs })).id;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

/** 提交任务：clientJobId 交给服务端做幂等去重，同一个键只会生成一次。 */
async function submitJob(kind: "image" | "video" | "audio", model: string, prompt: string, params: Record<string, unknown>, inputFileIds: string[], clientJobId: string, context?: JobContext) {
    const job = await serverApi.createJob({ clientJobId, kind, model, prompt, params, inputFileIds, context });
    useJobStore.getState().trackJob(clientJobId, job, context);
    return job;
}

async function waitJob(jobId: string, clientJobId: string, intervalMs: number, options?: GenerationOptions) {
    const store = useJobStore.getState();
    try {
        for (;;) {
            const job = await serverApi.job(jobId);
            store.trackJob(clientJobId, job);
            options?.onProgress?.(job.progress);
            if (job.status === "succeeded") return job.outputs;
            if (job.status === "failed") throw new Error(job.error || "生成失败");
            if (job.status === "canceled") throw new DOMException("Aborted", "AbortError");
            await delay(intervalMs, options?.signal);
        }
    } catch (error) {
        if (options?.signal?.aborted) void serverApi.cancelJob(jobId).catch(() => undefined);
        throw error;
    } finally {
        store.untrackJob(clientJobId);
    }
}

/** 服务端会再拼一层管理员配置的全局系统提示词，这里只负责带上用户自己填的那份。 */
function withUserSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

async function runJob(kind: "image" | "video" | "audio", model: string, prompt: string, params: Record<string, unknown>, inputFileIds: string[], intervalMs: number, options?: GenerationOptions) {
    const clientJobId = options?.clientJobId || nanoid();
    const job = await submitJob(kind, model, prompt, params, inputFileIds, clientJobId, options?.context);
    return waitJob(job.id, clientJobId, intervalMs, options);
}

function toGeneratedImages(outputs: ServerFile[]): GeneratedImage[] {
    return outputs.map((file) => ({ id: file.id, dataUrl: serverFileUrl(file.id), file }));
}

/** 续查一个已经存在的服务端任务，不会重新提交，用于刷新或断线重连后恢复进度。 */
export async function resumeImages(job: TrackedJob, options?: GenerationOptions): Promise<GeneratedImage[]> {
    const outputs = await waitJob(job.jobId, job.clientJobId, IMAGE_POLL_MS, options);
    if (!outputs.length) throw new Error("接口没有返回图片");
    return toGeneratedImages(outputs);
}

/** 续查视频或音频任务，产物已经在服务端，直接登记引用。 */
export async function resumeMedia(job: TrackedJob, options?: GenerationOptions): Promise<UploadedFile> {
    const outputs = await waitJob(job.jobId, job.clientJobId, job.kind === "video" ? VIDEO_POLL_MS : AUDIO_POLL_MS, options);
    if (!outputs[0]) throw new Error(`任务成功但没有返回${job.kind === "video" ? "视频" : "音频"}`);
    return adoptServerMedia(outputs[0]);
}

/** 把恢复出来的任务还原成视频任务对象，交给视频页原有的轮询流程继续跑。 */
export function serverVideoTask(job: TrackedJob): ServerVideoTask {
    return { id: job.jobId, provider: "server", model: job.model, clientJobId: job.clientJobId };
}

function imageParams(config: AiConfig, count: number) {
    const quality = normalizeQuality(config.quality);
    return { size: resolveRequestSize(quality, config.size), quality, background: normalizeBackground(config.background), count };
}

/** 服务端按模型自行选择上游协议，这里按同一规则归一化参数后透传。 */
function isServerSeedanceModel(model: string) {
    return serverModelFormat(model) === "ark" || model.toLowerCase().includes("seedance");
}

function videoParams(config: AiConfig, model: string) {
    if (isServerSeedanceModel(model)) {
        return {
            seconds: String(normalizeSeedanceDuration(config.videoSeconds)),
            ratio: normalizeSeedanceRatio(config.size),
            resolution: normalizeSeedanceResolution(config.vquality),
            generateAudio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
        };
    }
    return { seconds: normalizeVideoSeconds(config.videoSeconds), size: normalizeVideoSize(config.size) || undefined, resolution: normalizeVideoResolution(config.vquality) };
}

function audioParams(config: AiConfig) {
    return {
        voice: normalizeAudioVoiceValue(config.audioVoice),
        format: normalizeAudioFormatValue(config.audioFormat),
        speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
        instructions: config.audioInstructions.trim(),
    };
}

/** 生成图片：服务器模式提交服务端任务并轮询，本地模式直连用户渠道。 */
export async function generateImages(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: ImageGenerationOptions): Promise<GeneratedImage[]> {
    if (!isServerMode()) {
        return references.length ? requestEdit(config, prompt, references, options?.mask, options) : requestGeneration(config, prompt, options);
    }
    assertNoModelScript(config, "image");
    if (options?.mask) throw new Error("服务端生成暂不支持蒙版编辑，请切换到本地模式");
    const model = serverModel(config, "image");
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const inputFileIds = await Promise.all(references.map(imageFileId));
    const outputs = await runJob("image", model, withUserSystemPrompt(config, buildImageReferencePromptText(prompt, references)), imageParams(config, count), inputFileIds, IMAGE_POLL_MS, options);
    if (!outputs.length) throw new Error("接口没有返回图片");
    return toGeneratedImages(outputs);
}

/** 把生成结果落到本地或服务端存储；服务端产物直接登记引用，不重复上传。 */
export async function storeGeneratedImage(image: GeneratedImage): Promise<UploadedImage> {
    return image.file ? adoptServerImage(image.file) : uploadImage(image.dataUrl);
}

/** 创建视频任务，返回的任务可持久化，页面刷新后凭它续查同一个任务，不会重复生成。 */
export async function createVideoTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: GenerationOptions): Promise<VideoTask> {
    if (!isServerMode()) return createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    assertNoModelScript(config, "video");
    const model = serverModel(config, "video");
    const clientJobId = options?.clientJobId || nanoid();
    const inputFileIds = [...(await Promise.all(references.map(imageFileId))), ...(await Promise.all([...videoReferences, ...audioReferences].map(mediaFileId)))];
    const requestPrompt = isServerSeedanceModel(model) ? buildSeedancePromptText(prompt, references, videoReferences, audioReferences) : prompt;
    const job = await submitJob("video", model, requestPrompt, videoParams(config, model), inputFileIds, clientJobId);
    return { id: job.id, provider: "server", model, clientJobId };
}

export async function pollVideoTask(config: AiConfig, task: VideoTask, options?: GenerationOptions): Promise<VideoGenerationTaskState> {
    if (task.provider !== "server") return pollVideoGenerationTask(config, task, options);
    const job = await serverApi.job(task.id);
    useJobStore.getState().trackJob(task.clientJobId, job);
    options?.onProgress?.(job.progress);
    if (job.status === "failed") return { status: "failed", error: job.error || "生成失败" };
    if (job.status === "canceled") return { status: "failed", error: "任务已取消" };
    if (job.status !== "succeeded") return { status: "pending" };
    useJobStore.getState().untrackJob(task.clientJobId);
    const file = job.outputs[0];
    if (!file) return { status: "failed", error: "任务成功但没有返回视频" };
    serverVideoFiles.set(task.id, file);
    return { status: "completed", result: { url: serverFileUrl(file.id), mimeType: file.mimeType } };
}

/** 视频任务轮询间隔：服务端任务与 Seedance 任务都偏慢，用更长的间隔。 */
export function videoPollInterval(task: VideoTask) {
    return task.provider === "seedance" || task.provider === "server" ? VIDEO_POLL_MS : 2500;
}

/** 服务端任务由服务端自己保活，客户端多等一会儿，避免比服务端更早判超时而丢结果。 */
export function videoPollLimit(task: VideoTask) {
    return task.provider === "server" ? 300 : 120;
}

/** 把视频任务结果落到存储；服务端产物已经在服务端，直接登记引用不重复上传。 */
export async function storeVideoResult(task: VideoTask, result: VideoGenerationResult): Promise<UploadedFile> {
    const file = task.provider === "server" ? serverVideoFiles.get(task.id) : undefined;
    if (!file) return storeGeneratedVideo(result);
    serverVideoFiles.delete(task.id);
    return adoptServerMedia(file);
}

/** 生成视频（创建 + 轮询一次做完），画布与插件用这个入口。 */
export async function generateVideo(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: GenerationOptions): Promise<UploadedFile> {
    if (!isServerMode()) return storeGeneratedVideo(await pollLocalVideo(config, prompt, references, videoReferences, audioReferences, options));
    assertNoModelScript(config, "video");
    const model = serverModel(config, "video");
    const inputFileIds = [...(await Promise.all(references.map(imageFileId))), ...(await Promise.all([...videoReferences, ...audioReferences].map(mediaFileId)))];
    const requestPrompt = isServerSeedanceModel(model) ? buildSeedancePromptText(prompt, references, videoReferences, audioReferences) : prompt;
    const outputs = await runJob("video", model, requestPrompt, videoParams(config, model), inputFileIds, VIDEO_POLL_MS, options);
    if (!outputs[0]) throw new Error("任务成功但没有返回视频");
    return adoptServerMedia(outputs[0]);
}

async function pollLocalVideo(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: GenerationOptions) {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        await delay(videoPollInterval(task), options?.signal);
    }
    throw new Error("视频生成超时，请稍后重试");
}

/** 生成音频：服务器模式走任务队列，本地模式直连。 */
export async function generateAudio(config: AiConfig, prompt: string, options?: GenerationOptions): Promise<UploadedFile> {
    if (!isServerMode()) return storeGeneratedAudio(await requestAudioGeneration(config, prompt, options), config.audioFormat);
    assertNoModelScript(config, "audio");
    const model = serverModel(config, "audio");
    const outputs = await runJob("audio", model, prompt, audioParams(config), [], AUDIO_POLL_MS, options);
    if (!outputs[0]) throw new Error("任务成功但没有返回音频");
    return adoptServerMedia(outputs[0]);
}
