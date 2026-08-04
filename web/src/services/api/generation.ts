import { nanoid } from "nanoid";

import { normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { boolConfig, buildSeedancePromptText, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution } from "@/lib/seedance-video";
import { adoptServerMedia, getMediaBlob, type UploadedFile } from "@/services/file-storage";
import { adoptServerImage, imageToDataUrl, serverFileIdOf, type UploadedImage } from "@/services/image-storage";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { useJobStore, type JobContext, type TrackedJob } from "@/stores/use-job-store";
import { serverModelFormat, useServerStore, type ServerCapability } from "@/stores/use-server-store";
import { normalizeBackground, normalizeQuality, resolveRequestSize } from "./image";
import { waitJobFinished } from "./job-stream";
import { serverApi, serverFileUrl, type ServerFile, type ServerJobKind } from "./server";
import { ShareApiError, shareApi } from "./share";
import { useShareStore } from "@/stores/use-share-store";
import { ensureShareBillingConsent } from "@/services/share-billing-consent";
import { normalizeVideoResolution, normalizeVideoSeconds, normalizeVideoSize } from "./video";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** clientJobId 由调用方持有，重发同一个键服务端只会生成一次，也不会重复扣算力点。 */
export type GenerationOptions = { signal?: AbortSignal; clientJobId?: string; onProgress?: (progress: number) => void; context?: JobContext; acceptSelfPay?: boolean };
export type ImageGenerationOptions = GenerationOptions & { mask?: ReferenceImage };

/** 生成结果都落在服务端，转存时直接登记引用，不重复上传。 */
export type GeneratedImage = { id: string; dataUrl: string; file: ServerFile };

export type VideoTask = { id: string; model: string; clientJobId: string };
export type VideoTaskState = { status: "completed"; file: ServerFile } | { status: "failed"; error: string };

const SHARE_JOB_RETRY_DELAYS = [1000, 2000, 4000, 8000, 12000];

function waitDelay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = window.setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

function serverSettings() {
    return useServerStore.getState().settings;
}

/** 模型必须来自服务端模型列表，选择的模型名对不上时退回服务端默认模型。 */
function serverModel(config: AiConfig, capability: ServerCapability) {
    const channel = serverSettings()?.modelChannel;
    if (!channel) throw new Error("服务端配置尚未就绪，请稍后重试");
    const selected = modelOptionName(config.model || (capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel));
    if (channel.models.some((item) => item.name === selected && item.capability === capability)) return selected;
    const fallback = capability === "image" ? channel.defaultImageModel : capability === "video" ? channel.defaultVideoModel : capability === "audio" ? channel.defaultAudioModel : channel.defaultTextModel;
    if (!fallback) throw new Error(`服务端没有配置可用的${capability === "image" ? "图片" : capability === "video" ? "视频" : capability === "audio" ? "音频" : "文本"}模型`);
    return fallback;
}

/** 服务端配了可用模型就算就绪。 */
export function isGenerationReady() {
    return Boolean(serverSettings()?.modelChannel.models.length);
}

async function imageFileId(image: ReferenceImage, context?: JobContext) {
    const existing = serverFileIdOf(image.storageKey);
    if (existing) return existing;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请重新上传");
    const share = shareGenerationContext(context);
    const blob = await (await fetch(dataUrl)).blob();
    return (await (share ? shareApi.uploadFile(share.project!.id, share.guestToken, blob, { filename: image.name }) : serverApi.uploadFile(blob, { filename: image.name }))).id;
}

function shareGenerationContext(context?: JobContext) {
    const share = useShareStore.getState();
    if (!share.fullCanvas || !share.guestToken || !share.project?.id) return null;
    return context?.source === "canvas" && context.projectId === share.project.id ? share : null;
}

/** 分享任务查询的临时网络故障不能被当成生成失败；每次重试都现取续期后的 guest token。 */
async function pollShareJob(jobId: string, context: JobContext | undefined, signal?: AbortSignal) {
    let failures = 0;
    for (;;) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const share = shareGenerationContext(context);
        if (!share) throw new Error("分享画布权限已变更，请刷新后重试");
        try {
            return await shareApi.job(share.guestToken, jobId);
        } catch (error) {
            const retryable = error instanceof ShareApiError && (error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500);
            if (!retryable) throw error;
            await waitDelay(SHARE_JOB_RETRY_DELAYS[Math.min(failures++, SHARE_JOB_RETRY_DELAYS.length - 1)], signal);
        }
    }
}

async function mediaFileId(media: { name?: string; url?: string; storageKey?: string; durationMs?: number }, context?: JobContext) {
    const existing = serverFileIdOf(media.storageKey);
    if (existing) return existing;
    const blob = (media.storageKey ? await getMediaBlob(media.storageKey) : null) || (media.url ? await (await fetch(media.url)).blob() : null);
    if (!blob) throw new Error("参考素材读取失败，请重新上传");
    const share = shareGenerationContext(context);
    return (await (share ? shareApi.uploadFile(share.project!.id, share.guestToken, blob, { filename: media.name, durationMs: media.durationMs }) : serverApi.uploadFile(blob, { filename: media.name, durationMs: media.durationMs }))).id;
}

/** 分享协作者在画布进入任何生成态之前先完成扣点确认，取消时不会留下 loading 占位节点。 */
export async function ensureGenerationBillingConsent(context?: JobContext) {
    const share = shareGenerationContext(context);
    return share ? ensureShareBillingConsent({ shareId: share.shareId, selfPayRequired: share.selfPayRequired, userId: useServerStore.getState().user?.id, anonymous: share.anonymous, ownerPays: share.ownerPays }) : false;
}

/** 提交任务：clientJobId 交给服务端做幂等去重，同一个键只会生成一次。 */
async function submitJob(kind: ServerJobKind, model: string, prompt: string, params: Record<string, unknown>, inputFileIds: string[], clientJobId: string, context?: JobContext, acceptedSelfPay?: boolean) {
    const share = shareGenerationContext(context);
    const acceptSelfPay = share ? acceptedSelfPay ?? (await ensureGenerationBillingConsent(context)) : false;
    const job = share
        ? await shareApi.createJob(share.guestToken, { clientJobId, kind, model, prompt, params, inputFileIds, context, billingProjectId: share.project!.id, acceptSelfPay })
        : await serverApi.createJob({ clientJobId, kind, model, prompt, params, inputFileIds, context });
    useJobStore.getState().trackJob(clientJobId, job, context);
    return job;
}

/**
 * 等任务跑到终态。进度与结果都来自共用的那条事件流，不再逐个任务轮询。
 * 主动取消才顺带把服务端任务也取消掉；页面刷新走不到这里，任务因此能继续跑完。
 */
async function waitJob(jobId: string, clientJobId: string, options?: GenerationOptions) {
    const store = useJobStore.getState();
    try {
        const share = shareGenerationContext(options?.context);
        if (share) {
            for (;;) {
                if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                const item = await pollShareJob(jobId, options?.context, options?.signal);
                store.trackJob(clientJobId, item, options?.context);
                options?.onProgress?.(item.progress);
                if (["succeeded", "failed", "canceled"].includes(item.status)) {
                    if (item.status === "failed") throw new Error(item.error || "生成失败");
                    if (item.status === "canceled") throw new DOMException("Aborted", "AbortError");
                    return item.outputs;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        const job = await waitJobFinished(jobId, {
            signal: options?.signal,
            onJob: (item) => {
                store.trackJob(clientJobId, item);
                options?.onProgress?.(item.progress);
            },
        });
        if (job.status === "failed") throw new Error(job.error || "生成失败");
        if (job.status === "canceled") throw new DOMException("Aborted", "AbortError");
        return job.outputs;
    } catch (error) {
        if (options?.signal?.aborted) {
            const share = shareGenerationContext(options.context);
            void (share ? shareApi.cancelJob(share.guestToken, jobId) : serverApi.cancelJob(jobId)).catch(() => undefined);
        }
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

async function runJob(kind: ServerJobKind, model: string, prompt: string, params: Record<string, unknown>, inputFileIds: string[], options?: GenerationOptions) {
    const clientJobId = options?.clientJobId || nanoid();
    const job = await submitJob(kind, model, prompt, params, inputFileIds, clientJobId, options?.context, options?.acceptSelfPay);
    return waitJob(job.id, clientJobId, options);
}

function toGeneratedImages(outputs: ServerFile[]): GeneratedImage[] {
    return outputs.map((file) => ({ id: file.id, dataUrl: serverFileUrl(file.id), file }));
}

/** 续查一个已经存在的服务端任务，不会重新提交，用于刷新或断线重连后恢复进度。 */
export async function resumeImages(job: TrackedJob, options?: GenerationOptions): Promise<GeneratedImage[]> {
    const outputs = await waitJob(job.jobId, job.clientJobId, options);
    if (!outputs.length) throw new Error("接口没有返回图片");
    return toGeneratedImages(outputs);
}

/** 续查视频或音频任务，产物已经在服务端，直接登记引用。 */
export async function resumeMedia(job: TrackedJob, options?: GenerationOptions): Promise<UploadedFile> {
    const outputs = await waitJob(job.jobId, job.clientJobId, options);
    if (!outputs[0]) throw new Error(`任务成功但没有返回${job.kind === "video" ? "视频" : "音频"}`);
    return adoptServerMedia(outputs[0]);
}

/** 把恢复出来的任务还原成视频任务对象，交给视频页原有的轮询流程继续跑。 */
export function serverVideoTask(job: TrackedJob): VideoTask {
    return { id: job.jobId, model: job.model, clientJobId: job.clientJobId };
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

/** 推理档位由服务端按渠道协议决定要不要带，前端只负责透传用户选的那档。 */
function textParams(config: AiConfig) {
    return { reasoningEffort: config.reasoningEffort };
}

/** 生成图片：提交服务端任务并轮询结果。 */
export async function generateImages(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: ImageGenerationOptions): Promise<GeneratedImage[]> {
    if (options?.mask) throw new Error("服务端生成暂不支持蒙版编辑");
    const model = serverModel(config, "image");
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const inputFileIds = await Promise.all(references.map((image) => imageFileId(image, options?.context)));
    const outputs = await runJob("image", model, withUserSystemPrompt(config, buildImageReferencePromptText(prompt, references)), imageParams(config, count), inputFileIds, options);
    if (!outputs.length) throw new Error("接口没有返回图片");
    return toGeneratedImages(outputs);
}

/** 生成结果已经在服务端，落存储时直接登记引用。 */
export function storeGeneratedImage(image: GeneratedImage): UploadedImage {
    return adoptServerImage(image.file);
}

/** 创建视频任务，返回的任务可持久化，页面刷新后凭它续查同一个任务，不会重复生成。 */
export async function createVideoTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: GenerationOptions): Promise<VideoTask> {
    const model = serverModel(config, "video");
    const clientJobId = options?.clientJobId || nanoid();
    const inputFileIds = [...(await Promise.all(references.map((image) => imageFileId(image, options?.context)))), ...(await Promise.all([...videoReferences, ...audioReferences].map((media) => mediaFileId(media, options?.context))))];
    const requestPrompt = isServerSeedanceModel(model) ? buildSeedancePromptText(prompt, references, videoReferences, audioReferences) : prompt;
    const job = await submitJob("video", model, requestPrompt, videoParams(config, model), inputFileIds, clientJobId, options?.context, options?.acceptSelfPay);
    return { id: job.id, model, clientJobId };
}

/** 等一个已存在的视频任务跑完。事件流推状态，不再轮询；超时判定由服务端负责。 */
export async function awaitVideoTask(task: VideoTask, options?: GenerationOptions): Promise<VideoTaskState> {
    try {
        const file = (await waitJob(task.id, task.clientJobId, options))[0];
        return file ? { status: "completed", file } : { status: "failed", error: "任务成功但没有返回视频" };
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return { status: "failed", error: "任务已取消" };
        return { status: "failed", error: error instanceof Error ? error.message : "生成失败" };
    }
}

/** 生成视频（创建 + 轮询一次做完），画布与插件用这个入口。 */
export async function generateVideo(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: GenerationOptions): Promise<UploadedFile> {
    const model = serverModel(config, "video");
    const inputFileIds = [...(await Promise.all(references.map((image) => imageFileId(image, options?.context)))), ...(await Promise.all([...videoReferences, ...audioReferences].map((media) => mediaFileId(media, options?.context))))];
    const requestPrompt = isServerSeedanceModel(model) ? buildSeedancePromptText(prompt, references, videoReferences, audioReferences) : prompt;
    const outputs = await runJob("video", model, requestPrompt, videoParams(config, model), inputFileIds, options);
    if (!outputs[0]) throw new Error("任务成功但没有返回视频");
    return adoptServerMedia(outputs[0]);
}

/** 生成音频：走服务端任务队列。 */
export async function generateAudio(config: AiConfig, prompt: string, options?: GenerationOptions): Promise<UploadedFile> {
    const model = serverModel(config, "audio");
    const outputs = await runJob("audio", model, prompt, audioParams(config), [], options);
    if (!outputs[0]) throw new Error("任务成功但没有返回音频");
    return adoptServerMedia(outputs[0]);
}

/**
 * 订阅文本任务并把增量喂给调用方，返回完整文本。
 * 走的是全应用共用的那条事件流：断线重连、补齐都由它统一处理，这里只关心内容和终态。
 * 主动取消才顺带把服务端任务也取消掉，页面刷新不会走到这里，任务因此能继续跑完。
 */
async function streamJobText(jobId: string, clientJobId: string, onDelta: (text: string) => void, options?: GenerationOptions): Promise<string> {
    let text = "";
    try {
        const share = shareGenerationContext(options?.context);
        if (share) {
            for (;;) {
                if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
                const item = await pollShareJob(jobId, options?.context, options?.signal);
                useJobStore.getState().trackJob(clientJobId, item, options?.context);
                const next = item.text || "";
                if (next !== text) { text = next; onDelta(text); }
                options?.onProgress?.(item.progress);
                if (["succeeded", "failed", "canceled"].includes(item.status)) {
                    if (item.status === "canceled") throw new DOMException("Aborted", "AbortError");
                    if (item.status !== "succeeded") throw new Error(item.error || "生成失败");
                    return text;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
        const job = await waitJobFinished(jobId, {
            signal: options?.signal,
            onJob: (item) => useJobStore.getState().trackJob(clientJobId, item),
            onText: (value) => {
                text = value;
                onDelta(value);
            },
        });
        if (job.status === "canceled") throw new DOMException("Aborted", "AbortError");
        if (job.status !== "succeeded") throw new Error(job.error || "生成失败");
        return text;
    } catch (error) {
        if (options?.signal?.aborted) {
            const share = shareGenerationContext(options?.context);
            void (share ? shareApi.cancelJob(share.guestToken, jobId) : serverApi.cancelJob(jobId)).catch(() => undefined);
        }
        throw error;
    } finally {
        useJobStore.getState().untrackJob(clientJobId);
    }
}

/** 生成文本：提交服务端任务并订阅增量，刷新或断网后可凭任务恢复已经生成出来的内容。 */
export async function generateText(config: AiConfig, prompt: string, references: ReferenceImage[] = [], onDelta: (text: string) => void, options?: GenerationOptions): Promise<string> {
    const model = serverModel(config, "text");
    const inputFileIds = await Promise.all(references.map((image) => imageFileId(image, options?.context)));
    const clientJobId = options?.clientJobId || nanoid();
    const job = await submitJob("text", model, withUserSystemPrompt(config, prompt), textParams(config), inputFileIds, clientJobId, options?.context, options?.acceptSelfPay);
    return streamJobText(job.id, clientJobId, onDelta, options);
}

/** 续订一个已存在的文本任务，不会重新提交；任务已经结束时会一次性拿回完整内容。 */
export function resumeText(job: TrackedJob, onDelta: (text: string) => void, options?: GenerationOptions): Promise<string> {
    return streamJobText(job.jobId, job.clientJobId, onDelta, options);
}
