import { create } from "zustand";

import type { Team, TeamRole } from "@/services/api/teams";

/** SSE 连接状态。界面据此显示「实时」还是「已降级到轮询」，用户才知道自己看到的数字新不新。 */
export type TeamRealtimeStatus = "idle" | "connecting" | "ready" | "reconnecting" | "polling";

type TeamState = {
    teams: Team[];
    currentTeamId: string;
    /** 当前团队池余额。SSE 的 team.credits 与轮询都写这里，界面只读它，两条来源不会各显示一个数。 */
    credits: number;
    myRole: TeamRole | "";
    realtimeStatus: TeamRealtimeStatus;
    setTeams: (teams: Team[]) => void;
    /** 进入某个团队。切换团队要清掉上一支队伍的余额与角色，否则新页面会先闪一下别人的数字。 */
    setCurrentTeam: (team: Team | null) => void;
    setCredits: (teamId: string, credits: number) => void;
    setMyRole: (teamId: string, role: TeamRole) => void;
    setRealtimeStatus: (status: TeamRealtimeStatus) => void;
    clear: () => void;
};

export const useTeamStore = create<TeamState>((set) => ({
    teams: [],
    currentTeamId: "",
    credits: 0,
    myRole: "",
    realtimeStatus: "idle",
    setTeams: (teams) => set({ teams }),
    setCurrentTeam: (team) => set({ currentTeamId: team?.id || "", credits: team?.credits || 0, myRole: team?.myRole || "", realtimeStatus: team ? "connecting" : "idle" }),
    // 迟到的事件带着别的团队 id 时直接丢掉：用户可能已经切走，写进去就是把 A 队的余额显示在 B 队页面上。
    setCredits: (teamId, credits) => set((state) => (state.currentTeamId === teamId ? { credits } : {})),
    setMyRole: (teamId, role) => set((state) => (state.currentTeamId === teamId ? { myRole: role } : {})),
    setRealtimeStatus: (realtimeStatus) => set({ realtimeStatus }),
    clear: () => set({ currentTeamId: "", credits: 0, myRole: "", realtimeStatus: "idle" }),
}));

/** 界面裁剪用的角色判断。服务端每条写路径都会再判一次，这里只决定按钮显不显示。 */
export const canManageTeam = (role: TeamRole | "") => role === "owner" || role === "admin";
export const canManageMembers = canManageTeam;
export const canManageInvites = canManageTeam;
export const canReadAllLogs = canManageTeam;
export const isTeamOwner = (role: TeamRole | "") => role === "owner";
