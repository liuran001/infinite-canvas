import { In } from "typeorm";

import { repo, serialTransaction } from "../db/data-source";
import { Project, Team, TeamCreditLog, TeamInvite, TeamMember, User, type TeamLimitWindow, type TeamMemberStatus, type TeamRole } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { usedCreditsOfMember } from "./billing";
import { assertCanManageMember, canTeamAction, requireTeamRole } from "./team-access";
import { closeTeamConnectionsOf, publishTeamMember } from "./team-realtime";

export type TeamInput = {
    name?: unknown;
    description?: unknown;
    avatarUrl?: unknown;
};

const NAME_MAX = 64;

function normalizeName(value: unknown) {
    const name = String(value || "")
        .trim()
        .slice(0, NAME_MAX);
    if (!name) throw fail("请填写团队名称", 400, "TEAM_NAME_REQUIRED");
    return name;
}

export function teamView(team: Team, role: TeamRole) {
    return {
        id: team.id,
        name: team.name,
        description: team.description || "",
        avatarUrl: team.avatarUrl || "",
        ownerId: team.ownerId,
        credits: team.credits,
        memberLimit: team.memberLimit,
        status: team.status,
        myRole: role,
        createdAt: team.createdAt,
        updatedAt: team.updatedAt,
    };
}

/**
 * 建团队。团队与 owner 成员必须同事务写入：
 * 分两步写的话中间失败就会留下一个没有 owner 的团队，谁都改不动也解散不了，只能进库里手工修。
 */
export async function createTeam(userId: string, input: TeamInput) {
    const name = normalizeName(input.name);
    const team = repo(Team).create({
        id: newId("team"),
        name,
        description: String(input.description || "").trim(),
        avatarUrl: String(input.avatarUrl || "").trim(),
        ownerId: userId,
        credits: 0,
        memberLimit: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
    });
    await serialTransaction(async (manager) => {
        await manager.getRepository(Team).insert(team);
        await manager.getRepository(TeamMember).insert({
            teamId: team.id,
            userId,
            role: "owner",
            creditLimit: 0,
            limitWindow: "month",
            status: "active",
            invitedBy: "",
            joinedAt: now(),
            updatedAt: now(),
        });
    });
    return team;
}

/** 已解散的团队不出现在任何人的列表里：成员记录已经删光，留着只会是一行点不进去的死数据。 */
export async function listMyTeams(userId: string) {
    const members = await repo(TeamMember).find({
        where: { userId },
        order: { joinedAt: "ASC" },
    });
    if (!members.length) return [];
    const teams = await repo(Team).find({
        where: { id: In(members.map((member) => member.teamId)) },
    });
    const byId = new Map(teams.map((team) => [team.id, team]));
    return members
        .map((member) => ({ member, team: byId.get(member.teamId) }))
        .filter((row): row is { member: TeamMember; team: Team } => Boolean(row.team) && row.team!.status !== "disbanded")
        .map((row) => teamView(row.team, row.member.role));
}

export async function getTeam(userId: string, teamId: string) {
    const { team, role } = await requireTeamRole(userId, teamId, "team.read");
    return teamView(team, role);
}

export async function updateTeam(teamId: string, actorId: string, input: TeamInput) {
    const { team, role } = await requireTeamRole(actorId, teamId, "team.update", { write: true });
    const next = {
        name: input.name === undefined ? team.name : normalizeName(input.name),
        description: input.description === undefined ? team.description : String(input.description || "").trim(),
        avatarUrl: input.avatarUrl === undefined ? team.avatarUrl : String(input.avatarUrl || "").trim(),
        updatedAt: now(),
    };
    await repo(Team).update({ id: teamId }, next);
    return teamView({ ...team, ...next }, role);
}

export async function listMembers(userId: string, teamId: string) {
    await requireTeamRole(userId, teamId, "team.read");
    return repo(TeamMember).find({
        where: { teamId },
        order: { joinedAt: "ASC" },
    });
}

/**
 * 成员列表的展示视图：带上本窗口已用额度与显示名。
 * 已用额度按流水实时聚合而不是读冗余列，与扣费判定用的是同一个函数，
 * 界面上看到的数字和真正会拦住人的那个数字永远是同一个。
 */
export async function listMemberViews(userId: string, teamId: string) {
    const members = await listMembers(userId, teamId);
    const users = members.length ? await repo(User).find({ where: { id: In(members.map((member) => member.userId)) } }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    return Promise.all(
        members.map(async (member) => ({
            teamId: member.teamId,
            userId: member.userId,
            username: byId.get(member.userId)?.username || "",
            displayName: byId.get(member.userId)?.displayName || byId.get(member.userId)?.username || "",
            avatarUrl: byId.get(member.userId)?.avatarUrl || "",
            role: member.role,
            creditLimit: member.creditLimit,
            limitWindow: member.limitWindow,
            status: member.status,
            usedCredits: await usedCreditsOfMember(teamId, member.userId, member.limitWindow),
            joinedAt: member.joinedAt,
            updatedAt: member.updatedAt,
        })),
    );
}

async function memberOrFail(teamId: string, userId: string) {
    const member = await repo(TeamMember).findOneBy({ teamId, userId });
    if (!member) throw fail("该用户不在团队中", 404, "TEAM_MEMBER_NOT_FOUND");
    return member;
}

/**
 * 改成员角色。owner 完全不经这条路径进出：升 owner 只能走 transferOwner，
 * 否则「团队恒有且仅有一个 owner」这条不变量就得靠每个调用点自觉维护。
 */
export async function updateMemberRole(teamId: string, actorId: string, targetId: string, role: TeamRole) {
    const actor = await requireTeamRole(actorId, teamId, "member.manage", {
        write: true,
    });
    const target = await memberOrFail(teamId, targetId);
    if (target.role === "owner") throw fail("不能修改 owner 的角色，请先转让", 400, "TEAM_OWNER_IMMUTABLE");
    if (role === "owner") throw fail("提升为 owner 只能通过转让", 400, "TEAM_OWNER_MUST_TRANSFER");
    // admin 之间互不干涉，且只有 owner 能造出新的 admin。判定本身在 team-access，这里只负责调用。
    assertCanManageMember(actor.role, target.role);
    if (role === "admin" && !canTeamAction(actor.role, "member.promoteAdmin")) throw fail("只有 owner 可以任命 admin", 403, "TEAM_FORBIDDEN");
    await repo(TeamMember).update({ teamId, userId: targetId }, { role, updatedAt: now() });
    publishTeamMember(teamId, { type: "member.roleChanged", userId: targetId, role });
    // 角色一变就断掉他自己的长连接。SSE 建好之后不重连就不再鉴权，
    // 连接建立那一刻发下去的角色会一直被前端当成有效值，降级后他的界面还留着一堆点了会被拒的按钮。
    // 断开是让他立刻重连、重新拿一次角色，而不是把人挡在外面。
    closeTeamConnectionsOf(teamId, targetId);
    return { ...target, role };
}

export type TeamMemberPatch = {
    role?: unknown;
    creditLimit?: unknown;
    limitWindow?: unknown;
    status?: unknown;
};

const LIMIT_WINDOWS: TeamLimitWindow[] = ["day", "month", "total"];

/**
 * 成员设置的统一入口：角色、额度、挂起状态一条路径改完。
 * 角色仍然委托给 updateMemberRole，那里守着「owner 只能靠转让进出」这条不变量，
 * 复制一份判定到这里就等于给它开了第二扇没人看守的门。
 */
export async function updateMember(teamId: string, actorId: string, targetId: string, patch: TeamMemberPatch) {
    const actor = await requireTeamRole(actorId, teamId, "member.manage", { write: true });
    const target = await memberOrFail(teamId, targetId);
    assertCanManageMember(actor.role, target.role);
    if (patch.role !== undefined && patch.role !== target.role) await updateMemberRole(teamId, actorId, targetId, String(patch.role) as TeamRole);
    if (patch.creditLimit === undefined && patch.limitWindow === undefined && patch.status === undefined) return memberOrFail(teamId, targetId);
    if (patch.limitWindow !== undefined && !LIMIT_WINDOWS.includes(String(patch.limitWindow) as TeamLimitWindow)) throw fail("无效的额度周期", 400, "TEAM_LIMIT_WINDOW_INVALID");
    const status = patch.status === undefined ? target.status : (String(patch.status) as TeamMemberStatus);
    if (!["active", "suspended"].includes(status)) throw fail("无效的成员状态", 400, "TEAM_MEMBER_STATUS_INVALID");
    // owner 不能被挂起：挂起的人过不了 requireTeamRole，团队就再也没有能转让、能解散的人了。
    if (target.role === "owner" && status !== "active") throw fail("不能挂起 owner", 400, "TEAM_OWNER_IMMUTABLE");
    await repo(TeamMember).update(
        { teamId, userId: targetId },
        {
            creditLimit: patch.creditLimit === undefined ? target.creditLimit : Math.max(0, Math.floor(Number(patch.creditLimit) || 0)),
            limitWindow: patch.limitWindow === undefined ? target.limitWindow : (String(patch.limitWindow) as TeamLimitWindow),
            status,
            updatedAt: now(),
        },
    );
    if (status !== "active") {
        // 挂起之后他连读都过不了 requireTeamRole，留着长连接等于让一个已经没有权限的人继续收团队事件。
        publishTeamMember(teamId, { type: "member.suspended", userId: targetId, role: target.role });
        closeTeamConnectionsOf(teamId, targetId);
    }
    return memberOrFail(teamId, targetId);
}

export async function removeMember(teamId: string, actorId: string, targetId: string) {
    const actor = await requireTeamRole(actorId, teamId, "member.manage", {
        write: true,
    });
    const target = await memberOrFail(teamId, targetId);
    if (target.role === "owner") throw fail("不能移除 owner，请先转让团队", 400, "TEAM_OWNER_IMMUTABLE");
    assertCanManageMember(actor.role, target.role);
    await repo(TeamMember).delete({ teamId, userId: targetId });
    // 先广播再断连：被移除的人自己那条连接已经关了，这条事件是发给团队里剩下的人更新成员列表的。
    publishTeamMember(teamId, { type: "member.removed", userId: targetId, role: target.role });
    closeTeamConnectionsOf(teamId, targetId);
}

/**
 * 退出团队。这里刻意不传 `{ write: true }`：团队被平台停用时其余写入都该掐掉，
 * 但退出是「解除自己与团队的关系」，连它也拦住等于把人永久锁在一个已经停用的团队里。
 */
export async function leaveTeam(teamId: string, userId: string) {
    const { role } = await requireTeamRole(userId, teamId, "team.leave");
    if (role === "owner") throw fail("请先把团队转让给其他成员，再退出", 400, "TEAM_OWNER_MUST_TRANSFER");
    await repo(TeamMember).delete({ teamId, userId });
    publishTeamMember(teamId, { type: "member.left", userId, role });
    closeTeamConnectionsOf(teamId, userId);
}

/** 转让在单事务内完成两条角色更新与 Team.ownerId 同步，中途失败不会出现两个 owner 或零个 owner。 */
export async function transferOwner(teamId: string, actorId: string, targetId: string) {
    await requireTeamRole(actorId, teamId, "team.transfer", { write: true });
    const target = await repo(TeamMember).findOneBy({ teamId, userId: targetId });
    if (!target || target.status !== "active") throw fail("只能转让给团队内正常状态的成员", 400, "TEAM_MEMBER_NOT_FOUND");
    if (targetId === actorId) throw fail("不能转让给自己", 400, "TEAM_TRANSFER_INVALID");
    await serialTransaction(async (manager) => {
        const members = manager.getRepository(TeamMember);
        // 旧 owner 降为 admin 而不是踢出：转让通常是交接而非退出，直接降成 member 会让他连成员都管不了。
        await members.update({ teamId, userId: actorId }, { role: "admin", updatedAt: now() });
        await members.update({ teamId, userId: targetId }, { role: "owner", updatedAt: now() });
        await manager.getRepository(Team).update({ id: teamId }, { ownerId: targetId, updatedAt: now() });
    });
    // 广播放在提交之后：事务里发出去的话，回滚时事件已经收不回来，界面会显示一次没发生的转让。
    // 新旧 owner 各发一条：只发新 owner 的话，其他人页面上会同时看到两个 owner，
    // 而旧 owner 自己的界面还留着「解散团队」这种他已经点不动的入口。
    publishTeamMember(teamId, { type: "member.roleChanged", userId: actorId, role: "admin" });
    publishTeamMember(teamId, { type: "member.roleChanged", userId: targetId, role: "owner" });
}

/**
 * 解散。成员与邀请全部清掉，团队本身只置为 disbanded：
 * TeamCreditLog 要留着供审计，而流水行上的 teamId 必须还能查回团队名。
 * 挂在这个团队名下的画布必须同事务收回个人：teamId 留着的话，画布的付费方解析会一直卡在
 * 「团队不可用」，画布的主人从此既不能在上面花钱、也没有任何入口把它解绑，等于被永久锁死。
 */
export async function disbandTeam(teamId: string, actorId: string) {
    await requireTeamRole(actorId, teamId, "team.disband", { write: true });
    const members = await repo(TeamMember).findBy({ teamId });
    await serialTransaction(async (manager) => {
        await manager.getRepository(Team).update({ id: teamId }, { status: "disbanded", updatedAt: now() });
        await manager.getRepository(Project).update({ teamId }, { teamId: "", updatedAt: now() });
        await manager.getRepository(TeamMember).delete({ teamId });
        await manager.getRepository(TeamInvite).update({ teamId }, { enabled: false });
    });
    // 团队没了，所有人的长连接都得断：留着的话每个成员页面上都会挂着一个点进去必然 404 的团队。
    for (const member of members) {
        publishTeamMember(teamId, { type: "member.removed", userId: member.userId, role: member.role });
        closeTeamConnectionsOf(teamId, member.userId);
    }
}

/**
 * 团队流水。全员视图要 logs.readAll，个人视图只查自己：
 * 两者共用一个函数并靠一个布尔切换的话，哪天多一个调用点忘了传，member 就直接看到了全团队的消费。
 */
export async function listTeamCreditLogs(userId: string, teamId: string, query: Query) {
    await requireTeamRole(userId, teamId, "logs.readAll");
    const [items, total] = await repo(TeamCreditLog).findAndCount({
        where: { teamId },
        order: { createdAt: "DESC", id: "DESC" },
        skip: query.offset,
        take: query.pageSize,
    });
    return { items, total };
}

export async function listMyTeamCreditLogs(userId: string, teamId: string, query: Query) {
    await requireTeamRole(userId, teamId, "logs.readMine");
    const [items, total] = await repo(TeamCreditLog).findAndCount({
        where: { teamId, userId },
        order: { createdAt: "DESC", id: "DESC" },
        skip: query.offset,
        take: query.pageSize,
    });
    return { items, total };
}
