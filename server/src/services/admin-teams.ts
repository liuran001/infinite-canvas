import { In, Like } from "typeorm";

import { repo } from "../db/data-source";
import { Team, TeamCreditLog, TeamMember, User, type TeamStatus } from "../db/entities";
import { fail, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { setTeamCredits } from "./billing";
import { closeTeamConnectionsOf, publishTeamMember } from "./team-realtime";

/**
 * 平台管理员视角的团队数据。刻意不引用 team-access 里的任何函数：
 * 那套判定回答的是「你在这个团队里是什么角色」，平台管理员一个团队都不在，
 * 借用它就得先给管理员编一个角色出来，而编出来的角色迟早会被别处当成真的成员身份。
 * 这里的门禁只有一道，且在路由层：adminAuth。
 */
export async function adminListTeams(query: Query) {
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const base = query.type ? { status: query.type as TeamStatus } : {};
    const where = like ? [{ ...base, name: like }, { ...base, id: like }, { ...base, ownerId: like }] : base;
    const [items, total] = await repo(Team).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const counts = await repo(TeamMember)
        .createQueryBuilder("member")
        .select("member.teamId", "teamId")
        .addSelect("COUNT(1)", "count")
        .groupBy("member.teamId")
        .getRawMany<{ teamId: string; count: string | number }>();
    const byTeam = new Map(counts.map((row) => [row.teamId, Number(row.count)]));
    return { items: items.map((team) => ({ ...team, memberCount: byTeam.get(team.id) || 0 })), total };
}

async function teamOrFail(teamId: string) {
    const team = await repo(Team).findOneBy({ id: teamId });
    // 平台后台不需要「用 404 掩盖存在性」：管理员本来就有权知道全平台有哪些团队。
    if (!team) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    return team;
}

export async function adminGetTeam(teamId: string) {
    return teamOrFail(teamId);
}

/**
 * 停用/启用团队、改成员上限。停用是软开关：成员的读路径仍然放行，写入由 requireTeamRole 掐掉，
 * 停用不该顺手销毁成员对账用的历史流水。
 */
export async function adminUpdateTeam(teamId: string, patch: { status?: unknown; memberLimit?: unknown; name?: unknown }) {
    const team = await teamOrFail(teamId);
    const status = patch.status === undefined ? team.status : (String(patch.status) as TeamStatus);
    if (!["active", "disabled", "disbanded"].includes(status)) throw fail("无效的团队状态", 400, "TEAM_STATUS_INVALID");
    const next = {
        name: patch.name === undefined ? team.name : String(patch.name || "").trim() || team.name,
        memberLimit: patch.memberLimit === undefined ? team.memberLimit : Math.max(0, Math.floor(Number(patch.memberLimit) || 0)),
        status,
        updatedAt: now(),
    };
    await repo(Team).update({ id: teamId }, next);
    // 平台解散会把成员踢下线：团队都不在了，长连接留着只会让每个成员的页面挂着一个进不去的团队。
    if (status === "disbanded" && team.status !== "disbanded") {
        for (const member of await repo(TeamMember).findBy({ teamId })) {
            publishTeamMember(teamId, { type: "member.removed", userId: member.userId, role: member.role });
            closeTeamConnectionsOf(teamId, member.userId);
        }
    }
    return { ...team, ...next };
}

/** 调整团队积分池。余额与 admin_adjust 流水同事务，并在提交后广播 team.credits。 */
export async function adminSetTeamCredits(teamId: string, credits: number, remark: string) {
    await teamOrFail(teamId);
    return setTeamCredits(teamId, credits, remark);
}

export async function adminListTeamMembers(teamId: string) {
    await teamOrFail(teamId);
    const members = await repo(TeamMember).find({ where: { teamId }, order: { joinedAt: "ASC" } });
    const users = members.length ? await repo(User).find({ where: { id: In(members.map((member) => member.userId)) } }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    return members.map((member) => ({ ...member, username: byId.get(member.userId)?.username || "", displayName: byId.get(member.userId)?.displayName || "" }));
}

/** 全平台团队流水。与个人流水页查的是两张表，互不混入。 */
export async function adminListTeamCreditLogs(query: Query) {
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ teamId: like }, { userId: like }, { remark: like }, { model: like }] : {};
    const [items, total] = await repo(TeamCreditLog).findAndCount({ where, order: { createdAt: "DESC", id: "DESC" }, skip: query.offset, take: query.pageSize });
    return { items, total };
}
