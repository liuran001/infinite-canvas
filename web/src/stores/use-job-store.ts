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

type JobStore = {
    jobs: Record<string, TrackedJob>;
    trackJob: (clientJobId: string, job: ServerJob, context?: JobContext) => void;
    untrackJob: (clientJobId: string) => void;
    /** 服务器模式下用服务端仍在进行的任务覆盖本地记录，服务端已经没有的记录会被丢弃。 */
    restorePendingJobs: () => Promise<TrackedJob[]>;
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
                    jobs[job.clientJobId] = { clientJobId: job.clientJobId, jobId: job.id, kind: job.kind, status: job.status, progress: job.progress, model: job.model, context: readContext(job, previous[job.clientJobId]?.context) };
                }
                set({ jobs });
                return Object.values(jobs);
            },
        }),
        {
            name: JOB_STORE_KEY,
            storage: createJSONStorage(() => localForageStorage),
            partialize: (state) => ({ jobs: state.jobs }),
        },
    ),
);
