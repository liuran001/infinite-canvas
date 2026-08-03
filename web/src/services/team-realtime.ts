import { Modal } from "antd";

import { serverApiUrl } from "@/services/api/server";
import { teamApi, type TeamRole } from "@/services/api/teams";
import { decodeSseFrames, parseSseJson } from "@/services/sse-frames";
import { subscribeRealtime } from "@/services/realtime/connection";
import { useServerStore } from "@/stores/use-server-store";
import { useTeamStore } from "@/stores/use-team-store";

/** 服务端 teams.ts 的 /v1/teams/:id/realtime 推的事件；ready 一定是第一条，带着当时的角色、余额与云空间。 */
export type TeamRealtimeEvent =
    | { type: "ready"; teamId: string; role: TeamRole; credits: number; storageUsed: number; storageQuota: number }
    | { type: "team.credits"; teamId: string; credits: number }
    | { type: "team.storage"; teamId: string; storageUsed: number; storageQuota: number }
    | { type: "member.joined" | "member.left" | "member.removed" | "member.roleChanged" | "member.suspended"; teamId: string; userId: string; role: TeamRole };

/** 重连退避。前几次快，后面拉开，避免服务端刚重启就被一群客户端打满。 */
const RETRIES = [1500, 3000, 6000];
/**
 * 连续这么多次连接失败就转轮询。服务端的实时总线是进程内 EventEmitter，
 * 多实例部署下本来就收不到别的实例发的事件，轮询是这种部署形态唯一能保证余额不长期停在旧值的路径。
 */
const FAILURES_BEFORE_POLLING = 3;
const POLL_INTERVAL = 30_000;
/** WebSocket 健康时的纠偏间隔。比降级轮询稀疏一倍：推送正常时它只是兜住跨实例丢事件。 */
const CORRECTION_INTERVAL = 60_000;

/** 连接失败要带上 HTTP 状态码：只留一句中文文案的话，调用方只能去匹配字符串来决定还要不要重连。 */
class TeamStreamError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/**
 * 永久失败的状态码。401 的会话已经被就地清掉，403 是被挂起或降级，404 是团队没了或人已被移出——
 * 这三种重连一万次都是同一个结果，继续转只是每几秒打一次必然失败的请求，外加一个永远停不下来的轮询。
 */
const TERMINAL_STATUS = [401, 403, 404];

function terminalMessage(status: number) {
    if (status === 401) return "登录状态已失效，请重新登录";
    if (status === 403) return "你在这个团队中的权限已变更，请刷新页面";
    return "你已不在这个团队里，或团队已解散";
}

/** ServerApiError 与 TeamStreamError 都带 status，这里统一取。不是永久失败就返回 0。 */
function terminalStatusOf(error: unknown) {
    const status = error && typeof error === "object" ? Number((error as { status?: unknown }).status) : 0;
    return TERMINAL_STATUS.includes(status) ? status : 0;
}

// 正常睡醒也要把 abort 监听摘掉：signal 活到整个团队页的生命周期，每退避一次就挂一个不再有用的监听，
// 一晚上下来这个 signal 上会积满闭包，连同它捕获的 timer 一起留在内存里。
const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        let timer = 0 as unknown as ReturnType<typeof setTimeout>;
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
    });

/** 读流并按帧回调。分帧与解析都交给 sse-frames，坏帧只跳过它自己，不会掀翻整条连接。 */
async function readSse(response: Response, onEvent: (event: TeamRealtimeEvent) => void) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("团队实时连接没有返回内容");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const decoded = decodeSseFrames(buffer + decoder.decode(value, { stream: true }));
        buffer = decoded.rest;
        for (const frame of decoded.data) {
            const event = parseSseJson<TeamRealtimeEvent>(frame);
            if (event) onEvent(event);
        }
    }
}

async function openStream(teamId: string, onEvent: (event: TeamRealtimeEvent) => void, signal: AbortSignal) {
    const token = useServerStore.getState().token;
    const response = await fetch(serverApiUrl(`/v1/teams/${encodeURIComponent(teamId)}/realtime`), {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "text/event-stream" },
        signal,
    }).catch(() => {
        throw new Error("团队实时连接失败：无法连接服务端，请检查网络");
    });
    if (response.status === 401) {
        useServerStore.getState().clearSession();
        useServerStore.getState().setLoginOpen(true);
        throw new TeamStreamError("登录状态已失效，请重新登录", 401);
    }
    if (!response.ok) throw new TeamStreamError(`团队实时连接失败（HTTP ${response.status}）`, response.status);
    await readSse(response, onEvent);
}

/**
 * 已上线的 SSE 实现，保留为 WebSocket 的降级路径，行为一字未改。
 *
 * 连续 FAILURES_BEFORE_POLLING 次失败后起一个 30 秒轮询兜底，但重连循环不停：SSE 一旦重新连上
 * （收到 ready）就立刻把轮询停掉，否则降级会变成永久的——用户看到的余额永远慢 30 秒。
 * 定时器只此一处创建、由 clearPolling 统一清理，abort 时连同 fetch 一起收尾，不会留下野定时器。
 */
function watchTeamViaSse(teamId: string, signal: AbortSignal) {
    const store = () => useTeamStore.getState();
    let poller = 0;
    const clearPolling = () => {
        if (!poller) return;
        window.clearInterval(poller);
        poller = 0;
    };
    const pollOnce = async () => {
        try {
            const team = await teamApi.team(teamId);
            store().setCredits(teamId, team.credits);
            // 云空间也要跟着轮：漏掉它的话，降级之后余额每 30 秒动一次而用量永远停在进页面时的值，
            // 用户照着那个偏小的数字继续传，直到某一次上传突然失败才知道其实早就满了。
            store().setStorage(teamId, team.storageUsed, team.storageQuota);
            store().setMyRole(teamId, team.myRole);
        } catch (error) {
            // 已经卸载/切走就什么都别写：这一轮请求是切走之前发出去的，它的失败只属于上一支队伍。
            if (signal.aborted) return;
            // 轮询是降级路径，不该比主连接更执着：撞上同样的永久失败就一起收手。
            const terminal = terminalStatusOf(error);
            if (!terminal) return;
            clearPolling();
            store().setRealtimeStatus(teamId, "failed", terminalMessage(terminal));
        }
    };
    const startPolling = () => {
        if (poller || signal.aborted) return;
        store().setRealtimeStatus(teamId, "polling");
        void pollOnce();
        poller = window.setInterval(() => void pollOnce(), POLL_INTERVAL);
    };

    void (async () => {
        let failure = 0;
        while (!signal.aborted) {
            // 已经降级到轮询时状态必须保持 polling：改回 reconnecting 的话，界面会说「正在连接实时同步」，
            // 用户以为马上就好，实际上他正看着一个每 30 秒才动一次的数字。轮询停下来之前这条降级提示不能消失。
            store().setRealtimeStatus(teamId, poller ? "polling" : failure ? "reconnecting" : "connecting");
            try {
                await openStream(
                    teamId,
                    (event) => {
                        if (event.type === "ready") {
                            // 连上了就把降级轮询撤掉：留着它等于永远比实时慢一拍，还白白多打一份请求。
                            failure = 0;
                            clearPolling();
                            store().setCredits(teamId, event.credits);
                            store().setStorage(teamId, event.storageUsed, event.storageQuota);
                            store().setMyRole(teamId, event.role);
                            store().setRealtimeStatus(teamId, "ready");
                        } else if (event.type === "team.credits") {
                            store().setCredits(teamId, event.credits);
                        } else if (event.type === "team.storage") {
                            store().setStorage(teamId, event.storageUsed, event.storageQuota);
                        }
                    },
                    signal,
                );
                // 服务端正常 EOF 也是一次失败：多实例部署下另一个实例的事件本来就推不过来，
                // 而一条秒断秒连的流会让 failure 永远停在 0，轮询兜底永远不启动，余额可以一整天不动。
                // 只有真正收到 ready 才把计数清零——那才是「这条连接确实在工作」的唯一证据。
                failure += 1;
            } catch (error) {
                if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) break;
                const terminal = terminalStatusOf(error);
                if (terminal) {
                    clearPolling();
                    store().setRealtimeStatus(teamId, "failed", terminalMessage(terminal));
                    break;
                }
                failure += 1;
            }
            if (signal.aborted) break;
            if (failure >= FAILURES_BEFORE_POLLING) startPolling();
            await sleep(RETRIES[Math.min(failure, RETRIES.length - 1)], signal).catch(() => undefined);
        }
        clearPolling();
    })();

    // 调用方在卸载时 abort：fetch 随之取消，循环退出，轮询定时器在上面的 finally 位置被清掉。
    signal.addEventListener("abort", clearPolling, { once: true });
}

/**
 * WebSocket 订阅的终态码到 HTTP 状态的映射。服务端团队守卫发的是 TEAM_* 系列而不是通用 FORBIDDEN，
 * 只认 FORBIDDEN 的话，被挂起、被移出团队、团队被停用这三种人都会看到「正在重连」，
 * 然后被推去起一条同样连不上的 SSE，界面上永远停在连接中。
 */
const TERMINAL_CODE_STATUS: Record<string, number> = {
    FORBIDDEN: 403,
    REVOKED: 403,
    TEAM_FORBIDDEN: 403,
    TEAM_MEMBER_SUSPENDED: 403,
    TEAM_DISABLED: 403,
    TEAM_NOT_FOUND: 404,
    NOT_FOUND: 404,
};

/**
 * 订阅团队余额与成员变更。优先走共享 WebSocket；它连不上（旧服务端、反代不放行 Upgrade）
 * 才退回原来的 SSE 循环，SSE 又连续失败才起 30 秒轮询。
 *
 * WebSocket 健康时仍保留一份低频纠偏轮询：服务端的实时总线是进程内 EventEmitter，
 * 多实例部署下别的实例发的事件本来就推不过来，只靠推送的话余额可以一整天停在旧值。
 */
export function watchTeam(teamId: string, signal: AbortSignal) {
    const store = () => useTeamStore.getState();
    let sse: AbortController | null = null;
    let corrector = 0;
    const stopSse = () => {
        sse?.abort();
        sse = null;
    };
    const stopCorrector = () => {
        if (!corrector) return;
        window.clearInterval(corrector);
        corrector = 0;
    };
    const startSse = () => {
        if (sse || signal.aborted) return;
        sse = new AbortController();
        signal.addEventListener("abort", () => sse?.abort(), { once: true });
        watchTeamViaSse(teamId, sse.signal);
    };
    /** 纠偏轮询：只在 WebSocket 已经 ready 时跑，间隔取降级轮询的两倍，纯粹用来兜住跨实例丢事件。 */
    const startCorrector = () => {
        if (corrector || signal.aborted) return;
        corrector = window.setInterval(() => {
            void teamApi
                .team(teamId)
                .then((team) => {
                    if (signal.aborted) return;
                    store().setCredits(teamId, team.credits);
                    store().setStorage(teamId, team.storageUsed, team.storageQuota);
                    store().setMyRole(teamId, team.myRole);
                })
                .catch(() => undefined);
        }, CORRECTION_INTERVAL);
    };

    const subscription = subscribeRealtime<TeamRealtimeEvent>({
        channel: `team:${teamId}`,
        onReady: (payload) => {
            const ready = (payload || {}) as { role?: TeamRole; credits?: number; storage?: { used?: number; quota?: number } };
            stopSse();
            store().setCredits(teamId, Number(ready.credits) || 0);
            store().setStorage(teamId, Number(ready.storage?.used) || 0, Number(ready.storage?.quota) || 0);
            if (ready.role) store().setMyRole(teamId, ready.role);
            store().setRealtimeStatus(teamId, "ready");
            startCorrector();
        },
        onEvent: (event) => {
            if (event.type === "team.credits") store().setCredits(teamId, event.credits);
            else if (event.type === "team.storage") store().setStorage(teamId, event.storageUsed, event.storageQuota);
        },
        onDegrade: () => {
            stopCorrector();
            // 状态交给降级路径自己写：SSE 可能已经退到轮询，这里再写一次 reconnecting
            // 就会让界面说「马上就好」，而用户看的其实是一个每 30 秒才动一次的数字。
            if (!sse) store().setRealtimeStatus(teamId, "reconnecting");
            startSse();
        },
        onRecover: stopSse,
        onTerminal: (failure) => {
            stopCorrector();
            // 权限类终态与 SSE 那边判定一致：换传输也是同一个结果，直接落到失败提示，不再重连。
            const status = TERMINAL_CODE_STATUS[failure.code];
            if (status) {
                stopSse();
                store().setRealtimeStatus(teamId, "failed", terminalMessage(status));
                return;
            }
            startSse();
        },
    });
    store().setRealtimeStatus(teamId, "connecting");
    signal.addEventListener(
        "abort",
        () => {
            subscription.close();
            stopSse();
            stopCorrector();
        },
        { once: true },
    );
}

/** 服务端 billing.ts 里团队池不足时的错误码。 */
export const TEAM_CREDITS_EXHAUSTED = "TEAM_CREDITS_EXHAUSTED";
/**
 * 服务端对应的中文文案。生成任务是异步跑的，失败原因只以字符串落在任务行的 error 上，
 * 错误码到不了前端，所以这条路径只能按文案认；同步调用那条路径仍然优先按错误码判。
 */
const TEAM_CREDITS_EXHAUSTED_TEXT = "团队算力点不足";

export function isTeamCreditsExhausted(error: unknown) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === TEAM_CREDITS_EXHAUSTED) return true;
    const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    return text.includes(TEAM_CREDITS_EXHAUSTED_TEXT);
}

/** 同一时刻只弹一个：一次批量生成会有好几张图同时失败，不去重就是连开十个一模一样的弹窗。 */
let exhaustedModalOpen = false;

/** 服务端 quota.ts 里团队云空间不足时的错误码，与个人的 QUOTA_EXCEEDED 分开。 */
export const TEAM_QUOTA_EXCEEDED = "TEAM_QUOTA_EXCEEDED";
/**
 * 服务端对应的中文文案。和积分那条一样，异步任务的失败原因只以字符串落在任务行的 error 上，
 * 错误码到不了前端，只能按文案认；同步调用仍然优先按错误码判。
 */
const TEAM_QUOTA_EXCEEDED_TEXT = "团队云空间不足";

export function isTeamQuotaExceeded(error: unknown) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === TEAM_QUOTA_EXCEEDED) return true;
    const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    return text.includes(TEAM_QUOTA_EXCEEDED_TEXT);
}

/** 和积分那个开关分开：两种失败可能在同一批任务里同时发生，共用一个开关会让后弹的那条被永久吞掉。 */
let quotaModalOpen = false;

/**
 * 团队云空间不足时的提示。刻意和个人空间的提示分开：两者是两本独立的账，
 * 说成「你的云空间不足」的话，用户会跑去删自己的画布，删完发现一点用都没有——
 * 占满的是团队的空间，而清理它需要的是团队里有权限的人，或者管理员调大团队配额。
 */
export function notifyTeamQuotaExceeded(error: unknown) {
    if (!isTeamQuotaExceeded(error) || quotaModalOpen) return false;
    quotaModalOpen = true;
    Modal.confirm({
        title: "团队云空间已满",
        content: "这次上传没有成功。占满的是团队的云空间，不是你个人的——删你自己的个人画布不会腾出空间。可以去团队里清理不再需要的画布与素材，或请平台管理员调大这个团队的配额。",
        okText: "去团队页看看",
        cancelText: "知道了",
        afterClose: () => {
            quotaModalOpen = false;
        },
        onOk: () => {
            void import("@/router").then((module) => module.router.navigate("/teams"));
        },
    });
    return true;
}

/**
 * 团队积分用尽时的提示。刻意给两个出口而不是一句「余额不足」：
 * 用户此刻真正能做的只有两件事——让管理员充值，或者自己开启回落用个人积分，
 * 不把这两条路指出来，他就只能对着一个自己无权解决的错误反复重试。
 */
export function notifyTeamCreditsExhausted(error: unknown) {
    if (!isTeamCreditsExhausted(error) || exhaustedModalOpen) return false;
    exhaustedModalOpen = true;
    Modal.confirm({
        title: "团队积分已用尽",
        content: "这次生成没有扣款也没有生成内容。团队积分只能由平台管理员充值；你也可以改成用自己的个人积分继续，两本账互相独立。",
        okText: "去设置开启回落",
        cancelText: "去团队页联系管理员充值",
        afterClose: () => {
            exhaustedModalOpen = false;
        },
        onOk: () => {
            void import("@/router").then((module) => module.router.navigate("/config"));
        },
        onCancel: () => {
            void import("@/router").then((module) => module.router.navigate("/teams"));
        },
    });
    return true;
}
