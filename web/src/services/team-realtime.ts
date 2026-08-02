import { Modal } from "antd";

import { serverApiUrl } from "@/services/api/server";
import { teamApi, type TeamRole } from "@/services/api/teams";
import { useServerStore } from "@/stores/use-server-store";
import { useTeamStore } from "@/stores/use-team-store";

/** 服务端 teams.ts 的 /v1/teams/:id/realtime 推的事件；ready 一定是第一条，带着当时的角色与余额。 */
export type TeamRealtimeEvent =
    | { type: "ready"; teamId: string; role: TeamRole; credits: number }
    | { type: "team.credits"; teamId: string; credits: number }
    | { type: "member.joined" | "member.left" | "member.removed" | "member.roleChanged" | "member.suspended"; teamId: string; userId: string; role: TeamRole };

/** 重连退避。前几次快，后面拉开，避免服务端刚重启就被一群客户端打满。 */
const RETRIES = [1500, 3000, 6000];
/**
 * 连续这么多次连接失败就转轮询。服务端的实时总线是进程内 EventEmitter，
 * 多实例部署下本来就收不到别的实例发的事件，轮询是这种部署形态唯一能保证余额不长期停在旧值的路径。
 */
const FAILURES_BEFORE_POLLING = 3;
const POLL_INTERVAL = 30_000;

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });

/** SSE 按空行分块，保活帧是没有 data 行的注释，天然被跳过。 */
async function readSse(response: Response, onEvent: (event: TeamRealtimeEvent) => void) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("团队实时连接没有返回内容");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
            const data = buffer
                .slice(0, index)
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("");
            buffer = buffer.slice(index + 2);
            if (data) onEvent(JSON.parse(data) as TeamRealtimeEvent);
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
        throw new Error("登录状态已失效，请重新登录");
    }
    if (!response.ok) throw new Error(`团队实时连接失败（HTTP ${response.status}）`);
    await readSse(response, onEvent);
}

/**
 * 订阅团队余额与成员变更。
 *
 * 连续 FAILURES_BEFORE_POLLING 次失败后起一个 30 秒轮询兜底，但重连循环不停：SSE 一旦重新连上
 * （收到 ready）就立刻把轮询停掉，否则降级会变成永久的——用户看到的余额永远慢 30 秒。
 * 定时器只此一处创建、由 clearPolling 统一清理，abort 时连同 fetch 一起收尾，不会留下野定时器。
 */
export function watchTeam(teamId: string, signal: AbortSignal) {
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
            store().setMyRole(teamId, team.myRole);
        } catch {
            // 轮询失败只是这一轮没拿到新数字，下一轮照常再来；这里报错只会刷屏。
        }
    };
    const startPolling = () => {
        if (poller || signal.aborted) return;
        store().setRealtimeStatus("polling");
        void pollOnce();
        poller = window.setInterval(() => void pollOnce(), POLL_INTERVAL);
    };

    void (async () => {
        let failure = 0;
        while (!signal.aborted) {
            store().setRealtimeStatus(failure ? "reconnecting" : "connecting");
            try {
                await openStream(
                    teamId,
                    (event) => {
                        if (event.type === "ready") {
                            // 连上了就把降级轮询撤掉：留着它等于永远比实时慢一拍，还白白多打一份请求。
                            failure = 0;
                            clearPolling();
                            store().setCredits(teamId, event.credits);
                            store().setMyRole(teamId, event.role);
                            store().setRealtimeStatus("ready");
                        } else if (event.type === "team.credits") {
                            store().setCredits(teamId, event.credits);
                        }
                    },
                    signal,
                );
            } catch (error) {
                if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) break;
                // 团队没了或自己已经不在里面，再怎么重连都是同一个 404，直接收手。
                if (error instanceof Error && /HTTP 404/.test(error.message)) {
                    clearPolling();
                    store().setRealtimeStatus("idle");
                    break;
                }
                failure += 1;
            }
            if (signal.aborted) break;
            // 服务端正常结束连接（被移除、被降级）也走到这里，按失败计数重连，重连时会重新鉴权。
            if (failure >= FAILURES_BEFORE_POLLING) startPolling();
            await sleep(RETRIES[Math.min(failure, RETRIES.length - 1)], signal).catch(() => undefined);
        }
        clearPolling();
    })();

    // 调用方在卸载时 abort：fetch 随之取消，循环退出，轮询定时器在上面的 finally 位置被清掉。
    signal.addEventListener("abort", clearPolling, { once: true });
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
