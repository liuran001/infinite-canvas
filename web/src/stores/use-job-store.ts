import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { serverApi, type ServerJob, type ServerJobKind, type ServerJobStatus } from "@/services/api/server";
import { isServerMode } from "@/stores/use-server-store";

export type JobSource = "image" | "video" | "canvas";

/** 任务归属，用于刷新后把服务端任务定位回发起它的界面。 */
export type JobContext = { source: JobSource; prompt: string; projectId?: string; nodeId?: string };

/** 本地发起的服务端生成任务，clientJobId 是幂等键，重发同一个键不会重复生成。 */
export type TrackedJob = {
    clientJobId: string;
    jobId: string;
    kind: ServerJobKind;
    status: ServerJobStatus;
    progress: number;
    model: string;
    context: JobContext;
};

const EMPTY_CONTEXT: JobContext = { source: "canvas", prompt: "" };
const JOB_SOURCES: JobSource[] = ["image", "video", "canvas"];
/** 已结束任务的补拉窗口：够覆盖「关掉页面隔一晚再打开」，又不至于把历史任务全拉回来重新取一遍结果。 */
const FINISHED_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;

function optionalText(value: unknown) {
    return typeof value === "string" && value ? value : undefined;
}

/**
 * 服务端存的是任意 JSON，取用前先做形状校验：source 必须是合法来源，其余字段必须是字符串。
 * 校验不过就退回本地记录，避免脏数据把任务错误地挂到别的界面或节点上。
 */
function readContext(job: ServerJob, previous?: JobContext): JobContext {
    const context = (job.context || {}) as Record<string, unknown>;
    const source = JOB_SOURCES.find((item) => item === context.source);
    if (!source) return previous || EMPTY_CONTEXT;
    return { source, prompt: typeof context.prompt === "string" ? context.prompt : "", projectId: optionalText(context.projectId), nodeId: optionalText(context.nodeId) };
}

function toTrackedJob(job: ServerJob, previous?: JobContext): TrackedJob {
    return { clientJobId: job.clientJobId, jobId: job.id, kind: job.kind, status: job.status, progress: job.progress, model: job.model, context: readContext(job, previous) };
}

type JobStore = {
    jobs: Record<string, TrackedJob>;
    trackJob: (clientJobId: string, job: ServerJob, context?: JobContext) => void;
    untrackJob: (clientJobId: string) => void;
    /** 服务器模式下用服务端仍在进行的任务覆盖本地记录，服务端已经没有的记录会被丢弃。 */
    restorePendingJobs: () => Promise<TrackedJob[]>;
    /**
     * 最近已结束的任务。刷新那一刻任务可能刚好跑完，只查进行中的任务会漏掉结果，
     * 界面就会把已经生成好的内容误报成中断。这些任务不再进行，只返回给调用方回填，不进 jobs 记录。
     */
    restoreFinishedJobs: () => Promise<TrackedJob[]>;
};

export const JOB_STORE_KEY = "infinite-canvas:job_store";

export const useJobStore = create<JobStore>()(
    persist(
        (set, get) => ({
            jobs: {},
            trackJob: (clientJobId, job, context) =>
                set((state) => ({
                    jobs: {
                        ...state.jobs,
                        [clientJobId]: { clientJobId, jobId: job.id, kind: job.kind, status: job.status, progress: job.progress, model: job.model, context: context || readContext(job, state.jobs[clientJobId]?.context) },
                    },
                })),
            untrackJob: (clientJobId) => set((state) => ({ jobs: Object.fromEntries(Object.entries(state.jobs).filter(([key]) => key !== clientJobId)) })),
            restorePendingJobs: async () => {
                if (!isServerMode()) {
                    set({ jobs: {} });
                    return [];
                }
                const items = (await serverApi.jobs(["pending", "running"]).catch(() => ({ items: [] }))).items;
                const previous = get().jobs;
                const jobs: Record<string, TrackedJob> = {};
                for (const job of items) {
                    jobs[job.clientJobId] = toTrackedJob(job, previous[job.clientJobId]?.context);
                }
                set({ jobs });
                return Object.values(jobs);
            },
            restoreFinishedJobs: async () => {
                if (!isServerMode()) return [];
                // 单独查一次而不是和进行中的任务合并成一个请求：已结束的任务数量远多于在跑的，
                // 混在一起会把仍在跑的任务挤出服务端的条数上限，反而丢掉更该恢复的进度。
                const since = new Date(Date.now() - FINISHED_JOB_WINDOW_MS).toISOString();
                const items = (await serverApi.jobs(["succeeded", "failed"], since).catch(() => ({ items: [] }))).items;
                const previous = get().jobs;
                return items.map((job) => toTrackedJob(job, previous[job.clientJobId]?.context));
            },
        }),
        {
            name: JOB_STORE_KEY,
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ jobs: state.jobs }),
        },
    ),
);
