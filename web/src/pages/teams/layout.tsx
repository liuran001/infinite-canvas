import { useQuery } from "@tanstack/react-query";
import { Tag } from "antd";
import { useEffect } from "react";
import { Link, Outlet, useLocation, useOutletContext, useParams } from "react-router-dom";

import { teamApi, type Team, type TeamRole } from "@/services/api/teams";
import { watchTeam } from "@/services/team-realtime";
import { useTeamStore } from "@/stores/use-team-store";

const roleLabels: Record<TeamRole, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读" };

const tabs = [
    { key: "", label: "概览" },
    { key: "members", label: "成员" },
    { key: "invites", label: "邀请" },
    { key: "logs", label: "流水" },
];

/** 子页面通过 outlet context 拿团队，不必各自再请求一次同一个接口。 */
export type TeamOutletContext = { team: Team; refresh: () => void };

export function useTeamContext() {
    return useOutletContext<TeamOutletContext>();
}

/**
 * 团队各页共用的外壳：拉团队、开实时连接、画头部与导航。
 *
 * 做成布局路由而不是每个页面各自引一遍：概览、成员、邀请、流水之间来回点时，外壳不重挂，
 * SSE 连接就不会被反复拆建。每次拆建都要重新鉴权、重发一次 ready，界面上的余额会闪回旧值再跳回来。
 * 只有离开整个团队区（或换团队 id）才 abort，届时 fetch 与降级轮询的定时器一起收掉。
 */
export default function TeamLayout() {
    const { id = "" } = useParams();
    const { pathname } = useLocation();
    const bindTeam = useTeamStore((state) => state.bindTeam);
    const applyTeamSnapshot = useTeamStore((state) => state.applyTeamSnapshot);
    const clear = useTeamStore((state) => state.clear);
    const credits = useTeamStore((state) => state.credits);
    const myRole = useTeamStore((state) => state.myRole);
    const realtimeStatus = useTeamStore((state) => state.realtimeStatus);
    const realtimeError = useTeamStore((state) => state.realtimeError);
    const { data, isPending, error, refetch } = useQuery({ queryKey: ["team", id], queryFn: () => teamApi.team(id), enabled: Boolean(id) });

    useEffect(() => {
        if (!id) return;
        // 占位必须发生在开流之前：连接一建好就推 ready，而 REST 那边还在排队，
        // 没占位的话 store 认不出这个 teamId，第一份余额被直接丢掉，界面停在 0。
        bindTeam(id);
        const controller = new AbortController();
        watchTeam(id, controller.signal);
        return () => {
            controller.abort();
            clear();
        };
    }, [bindTeam, clear, id]);

    // 快照只在实时还没接管时填充，接管之后由 store 挡住，不会把推来的新余额盖回旧值。
    useEffect(() => {
        if (data) applyTeamSnapshot(data);
    }, [applyTeamSnapshot, data]);

    if (isPending) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">加载中…</main>;
    if (error || !data) return <main className="flex h-full items-center justify-center bg-background text-sm text-red-500">{error instanceof Error ? error.message : "团队不存在或你不在这个团队里"}</main>;

    const active = pathname.replace(/\/+$/, "").split("/")[3] || "";
    // 角色以实时连接推下来的为准：被降级的人如果还留着旧角色，页面上会挂着一堆点了必然被拒的按钮。
    const role = (myRole || data.myRole) as TeamRole;
    // 401/403/404 之后我们对「你现在还是什么角色」已经没有可信的答案了：403 正是被降级或挂起，
    // 404 是团队没了或人已被移出，401 连会话都没了。这时候继续按最后一次已知角色渲染管理入口，
    // 用户会对着一排点了必然报错的按钮反复试。头衔照旧显示，但操作一律按只读收起来。
    const contextRole: TeamRole = realtimeStatus === "failed" ? "viewer" : role;

    return (
        <main className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto w-full max-w-5xl px-6 py-10">
                <header className="border-b border-stone-200 pb-5 dark:border-stone-800">
                    <Link to="/teams" className="text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">
                        ← 返回我的团队
                    </Link>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h1 className="truncate text-2xl font-semibold">{data.name}</h1>
                            <p className="mt-1 text-sm text-stone-500">{data.description || "暂无简介"}</p>
                        </div>
                        <div className="text-right">
                            <div className="text-xs text-stone-500">团队积分</div>
                            <div className="text-2xl font-semibold tabular-nums" data-testid="team-credits">
                                {credits}
                            </div>
                            {/* 断开之后余额就停在最后收到的那个数上，不说明白的话用户会一直把它当成真值。 */}
                            {realtimeStatus === "failed" ? (
                                <div className="mt-1 text-xs text-red-500">{realtimeError || "实时同步已断开，请刷新页面"}</div>
                            ) : (
                                <div className="mt-1 text-xs text-stone-400">{realtimeStatus === "polling" ? "实时推送不可用，正在每 30 秒刷新" : realtimeStatus === "ready" ? "余额实时同步中" : "正在连接实时同步…"}</div>
                            )}
                        </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Tag className="m-0">我的角色：{roleLabels[role]}</Tag>
                        {data.status !== "active" ? <Tag color="warning">该团队已被平台停用，只能查看</Tag> : null}
                    </div>
                    <nav className="mt-4 flex items-center gap-4 text-sm" aria-label="团队导航">
                        {tabs.map((tab) => (
                            <Link
                                key={tab.key || "overview"}
                                to={`/teams/${id}${tab.key ? `/${tab.key}` : ""}`}
                                aria-current={active === tab.key ? "page" : undefined}
                                className={active === tab.key ? "font-medium text-stone-950 underline underline-offset-8 dark:text-stone-100" : "text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"}
                            >
                                {tab.label}
                            </Link>
                        ))}
                    </nav>
                </header>
                <div className="mt-6">
                    <Outlet context={{ team: { ...data, myRole: contextRole }, refresh: () => void refetch() } satisfies TeamOutletContext} />
                </div>
            </div>
        </main>
    );
}
