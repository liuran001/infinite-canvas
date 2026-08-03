import { notifyTeamCreditsExhausted, notifyTeamQuotaExceeded } from "@/services/team-realtime";
import { serverApi, serverJobStream, type ServerJob, type ServerJobEvent, type ServerJobStatus } from "./server";

/**
 * 全应用共用一条生成任务事件流。
 *
 * 为什么必须共用一条：反代是 HTTP/1.1，浏览器对同源只允许 6 个并发连接。
 * 每个任务挂一条流的话，同时跑几个生成就会把连接池占满，画布同步、拉图片这些普通请求都会被卡住。
 * 所以这里只维护一条连接，所有等待中的任务复用它，没有任务在等时立刻断开，不留空连接。
 */

/** 断流后的重连退避，接上一次就清零。 */
const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 10000;
/** 连续失败到这个次数就打开兜底轮询；再失败到这个次数就不再重连，只留轮询把任务收敛掉。 */
const FALLBACK_AFTER = 3;
const GIVE_UP_AFTER = 6;
/**
 * 兜底轮询间隔。SSE 建不起来（反代掐流、代理不支持分块）时退化成低频轮询而不是直接报错：
 * 任务已经在服务端跑着、算力点也已经扣了，报错等于把用户已经付过费的结果丢掉；
 * 5 秒一次只是保证最终能收敛，实时性交给 SSE。
 */
const FALLBACK_POLL_MS = 5000;

const FINISHED: ServerJobStatus[] = ["succeeded", "failed", "canceled"];

export type JobWatchOptions = {
    /** 每次收到任务快照都会回调，用于刷新进度与本地任务记录。 */
    onJob?: (job: ServerJob) => void;
    /** 文本任务的最新完整内容，增量已经按 offset 拼好。 */
    onText?: (text: string) => void;
    signal?: AbortSignal;
};

type Waiter = {
    jobId: string;
    options: JobWatchOptions;
    text: string;
    /** 本次连接的补齐里有没有带到这个任务，用来判断它是不是已经结束了。 */
    seen: boolean;
    resolve: (job: ServerJob) => void;
    reject: (error: unknown) => void;
};

const waiters = new Set<Waiter>();
let lastSeq = 0;
let controller: AbortController | null = null;
let streaming = false;
let fallbackTimer = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等一个服务端任务跑到终态，期间把进度和文本增量喂给调用方。
 * 不轮询：状态和增量都来自共用的那条事件流；只有流彻底建不起来才退化成低频轮询。
 */
export function waitJobFinished(jobId: string, options: JobWatchOptions = {}) {
    return new Promise<ServerJob>((resolve, reject) => {
        if (options.signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const waiter: Waiter = { jobId, options, text: "", seen: false, resolve, reject };
        waiters.add(waiter);
        options.signal?.addEventListener(
            "abort",
            () => {
                if (!waiters.delete(waiter)) return;
                reject(new DOMException("Aborted", "AbortError"));
                stopWhenIdle();
            },
            { once: true },
        );
        startStream();
    });
}

function settle(waiter: Waiter, job: ServerJob) {
    if (!waiters.delete(waiter)) return;
    waiter.resolve(job);
    stopWhenIdle();
}

function abandon(waiter: Waiter, error: unknown) {
    if (!waiters.delete(waiter)) return;
    waiter.reject(error);
    stopWhenIdle();
}

/** 按 offset 覆盖写入：重连补发、任务重跑导致的整段重发都能落到正确位置。 */
function applyText(waiter: Waiter, offset: number, delta: string) {
    waiter.text = waiter.text.slice(0, offset) + delta;
    waiter.options.onText?.(waiter.text);
}

function applyJob(waiter: Waiter, job: ServerJob) {
    waiter.seen = true;
    waiter.options.onJob?.(job);
    // 快照里的文本是服务端权威值，比本地长才覆盖；实时增量已经先到时不要用旧快照把它顶回去。
    if (job.text.length > waiter.text.length) applyText(waiter, 0, job.text);
    // 团队积分被扣光是所有生成路径的共同结局，弹窗挂在这里而不是各个页面：
    // 画布、生图、视频、Agent 都从这条流拿终态，写在页面里就得复制四份，漏一处那条路径就只剩一句干巴巴的红字。
    if (job.status === "failed") {
        notifyTeamCreditsExhausted(job.error);
        // 生成结果要写回云空间，团队画布写的是团队那本账。和积分同样挂在这条汇聚点上，
        // 否则画布、生图、视频、Agent 四条路径各自只会显示一句「上传失败」，用户完全不知道该去清理谁的空间。
        notifyTeamQuotaExceeded(job.error);
    }
    if (FINISHED.includes(job.status)) settle(waiter, job);
}

function onEvent(event: ServerJobEvent) {
    if (event.type === "text") {
        for (const waiter of [...waiters]) if (waiter.jobId === event.id) applyText(waiter, event.offset, event.text);
        return;
    }
    lastSeq = Math.max(lastSeq, event.seq);
    if (event.type === "job") {
        for (const waiter of [...waiters]) if (waiter.jobId === event.job.id) applyJob(waiter, event.job);
        return;
    }
    // 流通了就不需要兜底轮询了。
    stopFallback();
    // 补齐里一定带上了所有还没结束的任务，没被带到的说明它已经结束（或在断线期间就结束了）。
    // 这种任务补查一次就能收尾，不用为它一直轮询。
    for (const waiter of [...waiters]) if (!waiter.seen) void reconcile(waiter);
}

async function reconcile(waiter: Waiter) {
    const job = await serverApi.job(waiter.jobId).catch(() => null);
    if (!job) return startFallback();
    if (waiters.has(waiter)) applyJob(waiter, job);
}

function startStream() {
    if (streaming) return;
    streaming = true;
    void streamLoop().finally(() => {
        streaming = false;
    });
}

async function streamLoop() {
    let failures = 0;
    while (waiters.size && failures < GIVE_UP_AFTER) {
        const current = new AbortController();
        controller = current;
        // 每次重连都重新判定：补齐会把还在跑的任务重新推一遍，推不到的才需要单独补查。
        for (const waiter of waiters) waiter.seen = false;
        let connected = false;
        await serverJobStream(lastSeq, (event) => {
            if (event.type === "ready") connected = true;
            onEvent(event);
        }, current.signal).catch(() => undefined);
        controller = null;
        if (!waiters.size) return;
        // 上一批任务等完时连接会被主动断开，紧接着又来了新任务：这不算失败，直接重连，不用退避。
        if (current.signal.aborted) continue;
        // 接上过就把失败次数清零；一次都没接上（反代直接掐、握手就失败）才算一次失败。
        failures = connected ? 0 : failures + 1;
        if (failures >= FALLBACK_AFTER) startFallback();
        await sleep(Math.min(RETRY_BASE_MS * (failures + 1), RETRY_MAX_MS));
    }
    // 流反复建不起来就别再耗着重连了，交给兜底轮询把任务收敛掉，下次有新任务时再试一次流。
    if (waiters.size) startFallback();
}

/** 没有在等的任务就断开：空连接会白占浏览器对同源的并发连接数。 */
function stopWhenIdle() {
    if (waiters.size) return;
    stopFallback();
    controller?.abort();
    controller = null;
    // 游标只在有人等的时候才有意义，清掉它下次重新建连会按「所有未结束的任务」补齐，换账号也不会用错游标。
    lastSeq = 0;
}

function startFallback() {
    if (fallbackTimer || !waiters.size) return;
    fallbackTimer = window.setInterval(() => void pollWaiters(), FALLBACK_POLL_MS);
    void pollWaiters();
}

function stopFallback() {
    if (!fallbackTimer) return;
    window.clearInterval(fallbackTimer);
    fallbackTimer = 0;
}

/** 兜底轮询：按任务逐个查一次。查不动就把错误抛给调用方，界面该报错报错，不会一直转圈。 */
async function pollWaiters() {
    for (const jobId of new Set([...waiters].map((item) => item.jobId))) {
        const result: ServerJob | Error = await serverApi.job(jobId).catch((error: unknown) => (error instanceof Error ? error : new Error("查询生成任务失败")));
        for (const waiter of [...waiters]) {
            if (waiter.jobId !== jobId) continue;
            if (result instanceof Error) abandon(waiter, result);
            else applyJob(waiter, result);
        }
    }
}
