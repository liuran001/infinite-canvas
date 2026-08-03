import { create } from "zustand";

import type { Team, TeamRole } from "@/services/api/teams";

/**
 * SSE 连接状态。界面据此显示「实时」「已降级到轮询」还是「已断开」，用户才知道自己看到的数字新不新。
 * failed 是终态：401/403/404 重连多少次都是同一个结果，停手之后必须在界面上说明白，
 * 否则余额停在某个数上，用户会把它当成真值。
 */
export type TeamRealtimeStatus = "idle" | "connecting" | "ready" | "reconnecting" | "polling" | "failed";

type TeamState = {
    teams: Team[];
    currentTeamId: string;
    /** 当前团队池余额。SSE 的 team.credits 与轮询都写这里，界面只读它，两条来源不会各显示一个数。 */
    credits: number;
    myRole: TeamRole | "";
    realtimeStatus: TeamRealtimeStatus;
    /** 终态的原因，直接显示给用户。 */
    realtimeError: string;
    setTeams: (teams: Team[]) => void;
    /**
     * 占位：进入某个团队页时立刻调用，早于任何异步结果。
     * 实时连接一建好就会推 ready，而 REST 那边还要排队等事务；不先占位的话，
     * setCredits 认不出这个 teamId，第一份余额被直接丢掉，界面停在 0 直到下一次有人花钱。
     */
    bindTeam: (teamId: string) => void;
    /** REST 快照。只在实时还没接管时填充，接管之后一律不覆盖。 */
    applyTeamSnapshot: (team: Team) => void;
    setCredits: (teamId: string, credits: number) => void;
    setMyRole: (teamId: string, role: TeamRole) => void;
    setRealtimeStatus: (status: TeamRealtimeStatus, error?: string) => void;
    clear: () => void;
};

const EMPTY = { currentTeamId: "", credits: 0, myRole: "" as TeamRole | "", realtimeStatus: "idle" as TeamRealtimeStatus, realtimeError: "" };

export const useTeamStore = create<TeamState>((set) => ({
    teams: [],
    ...EMPTY,
    setTeams: (teams) => set({ teams }),
    // 同一个团队重复绑定（重渲染、严格模式的双次挂载）必须是空操作，否则会把已经收到的实时值清掉。
    bindTeam: (teamId) => set((state) => (state.currentTeamId === teamId ? {} : { ...EMPTY, currentTeamId: teamId, realtimeStatus: "connecting" })),
    applyTeamSnapshot: (team) =>
        set((state) => {
            if (state.currentTeamId !== team.id) return { ...EMPTY, currentTeamId: team.id, credits: team.credits, myRole: team.myRole, realtimeStatus: "connecting" };
            // 改个团队名就会触发一次 refetch，而那份快照是实时推送之前拉的。
            // 盖回去等于余额自己往回跳一格，用户会以为刚才那笔消费没记上。
            if (state.realtimeStatus === "ready") return {};
            return { credits: team.credits, myRole: team.myRole };
        }),
    // 迟到的事件带着别的团队 id 时直接丢掉：用户可能已经切走，写进去就是把 A 队的余额显示在 B 队页面上。
    setCredits: (teamId, credits) => set((state) => (state.currentTeamId === teamId ? { credits } : {})),
    setMyRole: (teamId, role) => set((state) => (state.currentTeamId === teamId ? { myRole: role } : {})),
    setRealtimeStatus: (realtimeStatus, realtimeError = "") => set({ realtimeStatus, realtimeError }),
    clear: () => set(EMPTY),
}));

/** 界面裁剪用的角色判断。服务端每条写路径都会再判一次，这里只决定按钮显不显示。 */
export const canManageTeam = (role: TeamRole | "") => role === "owner" || role === "admin";
export const canManageMembers = canManageTeam;
export const canManageInvites = canManageTeam;
export const canReadAllLogs = canManageTeam;
export const isTeamOwner = (role: TeamRole | "") => role === "owner";
