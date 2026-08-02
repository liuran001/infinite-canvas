import { In } from "typeorm";

import { repo, serialTransaction } from "../db/data-source";
import { Team, TeamInvite, TeamMember, type TeamRole } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
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
    return { ...target, role };
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
}

/**
 * 解散。成员与邀请全部清掉，团队本身只置为 disbanded：
 * TeamCreditLog 要留着供审计，而流水行上的 teamId 必须还能查回团队名。
 */
export async function disbandTeam(teamId: string, actorId: string) {
    await requireTeamRole(actorId, teamId, "team.disband", { write: true });
    await serialTransaction(async (manager) => {
        await manager.getRepository(Team).update({ id: teamId }, { status: "disbanded", updatedAt: now() });
        await manager.getRepository(TeamMember).delete({ teamId });
        await manager.getRepository(TeamInvite).update({ teamId }, { enabled: false });
    });
}
