import { serverRequest } from "./server";

/** 团队角色。与服务端 team-access 的权限矩阵一一对应，界面只按它裁剪入口，判定仍由服务端做。 */
export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type TeamStatus = "active" | "disabled" | "disbanded";
export type TeamMemberStatus = "active" | "suspended";
export type TeamLimitWindow = "day" | "month" | "total";
export type TeamInviteKind = "link" | "code";

/** 服务端 teamView() 的形状。myRole 是「我在这个团队里的角色」，创建接口回的是团队实体，没有这个字段。 */
export type Team = {
    id: string;
    name: string;
    description: string;
    avatarUrl: string;
    ownerId: string;
    credits: number;
    /**
     * 团队云空间，单位字节。团队画布上传的文件计进这里，不动成员的个人配额——
     * 反过来也一样，所以界面上这两个数字必须分开显示，混在一起用户会以为自己的空间被队友吃掉了。
     */
    storageUsed: number;
    storageQuota: number;
    memberLimit: number;
    status: TeamStatus;
    myRole: TeamRole;
    createdAt: string;
    updatedAt: string;
};

/** POST /v1/teams 回的是团队实体本身，没有 myRole：建团队的人一定是 owner，由调用方补上。 */
export type TeamEntity = Omit<Team, "myRole">;

/** 服务端 listMemberViews() 的形状。usedCredits 按 limitWindow 实时聚合，与扣费判定同源。 */
export type TeamMemberView = {
    teamId: string;
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: TeamRole;
    creditLimit: number;
    limitWindow: TeamLimitWindow;
    status: TeamMemberStatus;
    usedCredits: number;
    joinedAt: string;
    updatedAt: string;
};

/** 列表里只有 tokenPrefix，链接明文只在创建响应的 token 里出现一次；手输码 code 常驻。 */
export type TeamInvite = {
    id: string;
    teamId: string;
    kind: TeamInviteKind;
    tokenPrefix: string;
    code: string;
    role: TeamRole;
    maxUses: number;
    usedCount: number;
    enabled: boolean;
    expiresAt: string;
    createdBy: string;
    note: string;
    createdAt: string;
};

export type TeamInviteCreated = TeamInvite & { token: string };

export type TeamCreditLogType = "topup" | "admin_adjust" | "ai_consume" | "ai_refund" | "insufficient";

export type TeamCreditLog = {
    id: string;
    teamId: string;
    userId: string;
    type: TeamCreditLogType;
    amount: number;
    balance: number;
    model: string;
    relatedId: string;
    refundOf: string | null;
    remark: string;
    extra: string;
    createdAt: string;
};

export type TeamInvitePreview = { teamId: string; teamName: string; teamAvatarUrl: string; role: TeamRole; memberCount: number };

export type TeamMemberRecord = { teamId: string; userId: string; role: TeamRole; status: TeamMemberStatus };

export type TeamLogQuery = { page?: number; pageSize?: number };

function jsonBody(body: unknown) {
    return { body: JSON.stringify(body) };
}

function logQuery(query: TeamLogQuery = {}) {
    const params = new URLSearchParams({ page: String(query.page || 1), pageSize: String(query.pageSize || 20) });
    return `?${params}`;
}

export const teamApi = {
    teams: () => serverRequest<Team[]>("/v1/teams", {}, "读取团队列表失败"),
    createTeam: (body: { name: string; description?: string }) => serverRequest<TeamEntity>("/v1/teams", { method: "POST", ...jsonBody(body) }, "创建团队失败"),
    team: (id: string) => serverRequest<Team>(`/v1/teams/${id}`, {}, "读取团队失败"),
    updateTeam: (id: string, body: { name?: string; description?: string }) => serverRequest<Team>(`/v1/teams/${id}`, { method: "PATCH", ...jsonBody(body) }, "保存团队失败"),
    disbandTeam: (id: string) => serverRequest<boolean>(`/v1/teams/${id}`, { method: "DELETE" }, "解散团队失败"),
    transferOwner: (id: string, userId: string) => serverRequest<boolean>(`/v1/teams/${id}/transfer`, { method: "POST", ...jsonBody({ userId }) }, "转让团队失败"),
    leaveTeam: (id: string) => serverRequest<boolean>(`/v1/teams/${id}/leave`, { method: "POST" }, "退出团队失败"),

    members: (id: string) => serverRequest<TeamMemberView[]>(`/v1/teams/${id}/members`, {}, "读取成员失败"),
    updateMember: (id: string, userId: string, patch: { role?: TeamRole; creditLimit?: number; limitWindow?: TeamLimitWindow; status?: TeamMemberStatus }) =>
        serverRequest<TeamMemberView>(`/v1/teams/${id}/members/${userId}`, { method: "PATCH", ...jsonBody(patch) }, "保存成员设置失败"),
    removeMember: (id: string, userId: string) => serverRequest<boolean>(`/v1/teams/${id}/members/${userId}`, { method: "DELETE" }, "移除成员失败"),

    invites: (id: string) => serverRequest<TeamInvite[]>(`/v1/teams/${id}/invites`, {}, "读取邀请失败"),
    /** 只有这一次响应里带 token 明文，服务端之后只剩哈希，界面必须当场让用户复制走。 */
    createInvite: (id: string, body: { kind: TeamInviteKind; role: TeamRole; maxUses?: number; expiresAt?: string; note?: string }) => serverRequest<TeamInviteCreated>(`/v1/teams/${id}/invites`, { method: "POST", ...jsonBody(body) }, "创建邀请失败"),
    updateInvite: (id: string, inviteId: string, patch: { enabled?: boolean; maxUses?: number; expiresAt?: string; note?: string }) =>
        serverRequest<TeamInvite>(`/v1/teams/${id}/invites/${inviteId}`, { method: "PATCH", ...jsonBody(patch) }, "保存邀请失败"),
    deleteInvite: (id: string, inviteId: string) => serverRequest<boolean>(`/v1/teams/${id}/invites/${inviteId}`, { method: "DELETE" }, "删除邀请失败"),

    creditLogs: (id: string, query?: TeamLogQuery) => serverRequest<{ items: TeamCreditLog[]; total: number }>(`/v1/teams/${id}/credit-logs${logQuery(query)}`, {}, "读取团队流水失败"),
    myCreditLogs: (id: string, query?: TeamLogQuery) => serverRequest<{ items: TeamCreditLog[]; total: number }>(`/v1/teams/${id}/credit-logs/mine${logQuery(query)}`, {}, "读取我的流水失败"),

    previewInvite: (token: string) => serverRequest<TeamInvitePreview>(`/v1/team-invites/${encodeURIComponent(token)}`, {}, "邀请链接无效或已失效"),
    acceptInvite: (token: string) => serverRequest<TeamMemberRecord>(`/v1/team-invites/${encodeURIComponent(token)}/accept`, { method: "POST" }, "加入团队失败"),
    /** 手输码走独立接口：它在 /v1/teams/:id 之前注册，"join" 不会被当成团队 id。 */
    joinByCode: (code: string) => serverRequest<TeamMemberRecord>("/v1/teams/join", { method: "POST", ...jsonBody({ code }) }, "加入团队失败"),
};
