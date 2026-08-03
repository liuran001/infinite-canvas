import { In, Like } from "typeorm";

import { repo } from "../db/data-source";
import { Team, TeamCreditLog, TeamMember, User, type TeamStatus } from "../db/entities";
import { fail, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { nonNegativeInteger } from "../lib/validate";
import { setTeamCredits } from "./billing";
import { usedBytesOfTeam, usedBytesOfTeams } from "./quota";
import { publishTeamStorage } from "./team-realtime";
import { normalizeTeamName } from "./teams";

/** 成员上限的合理天花板。与 DB 的 int 列对齐并留出余量，超过它只可能是拼错了字段而不是真需求。 */
const MEMBER_LIMIT_MAX = 100_000;
/** 团队池余额的天花板。个人余额同样是 int 列，两边保持同一个量级。 */
export const TEAM_CREDITS_MAX = 1_000_000_000;
/** 团队云空间上限的天花板，1e12 字节约合 1TB。列是 bigint，这个量级远在安全整数内，不会被静默截断。 */
export const TEAM_STORAGE_QUOTA_MAX = 1_000_000_000_000;

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
    // 用量与个人用户列表同一套口径：按文件对象实时聚合，不存冗余计数列。
    const used = await usedBytesOfTeams(items.map((team) => team.id));
    return { items: items.map((team) => ({ ...team, memberCount: byTeam.get(team.id) || 0, storageQuota: Number(team.storageQuota), storageUsed: used.get(team.id) || 0 })), total };
}

async function teamOrFail(teamId: string) {
    const team = await repo(Team).findOneBy({ id: teamId });
    // 平台后台不需要「用 404 掩盖存在性」：管理员本来就有权知道全平台有哪些团队。
    if (!team) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    return team;
}

export async function adminGetTeam(teamId: string) {
    const team = await teamOrFail(teamId);
    return { ...team, storageQuota: Number(team.storageQuota), storageUsed: await usedBytesOfTeam(team.id) };
}

/**
 * 停用/启用团队、改成员上限。停用是软开关：成员的读路径仍然放行，写入由 requireTeamRole 掐掉，
 * 停用不该顺手销毁成员对账用的历史流水。
 *
 * 后台只认 active/disabled。disbanded 不在其中：解散是一整套动作（清成员、清邀请、把画布收回个人），
 * 这里只改一列状态的话，画布的 teamId 会留在一个再也进不去的团队上，付费方解析永远卡在「团队不可用」，
 * 画布的主人既不能在上面花钱、也没有任何入口解绑，等于被永久锁死。真要解散只能走团队 owner 的 disbandTeam。
 */
export async function adminUpdateTeam(teamId: string, patch: { status?: unknown; memberLimit?: unknown; name?: unknown; storageQuota?: unknown }) {
    const team = await teamOrFail(teamId);
    const status = patch.status === undefined ? team.status : (String(patch.status) as TeamStatus);
    if (!["active", "disabled"].includes(status)) throw fail("平台后台只能启用或停用团队", 400, "TEAM_STATUS_INVALID");
    // 已解散的团队没有成员也没有入口，改它的名字和上限只会在后台列表上留下误导性的活跃感。
    if (team.status === "disbanded") throw fail("团队已解散，无法再修改", 400, "TEAM_DISBANDED");
    const next = {
        // 与前台 updateTeam 用同一套 normalize：后台绕过截断的话，超长团队名会在这里被数据库静默切断。
        name: patch.name === undefined ? team.name : normalizeTeamName(patch.name, team.name),
        memberLimit: nonNegativeInteger(patch.memberLimit, team.memberLimit, MEMBER_LIMIT_MAX, "成员上限必须是不超过十万的非负整数", "TEAM_MEMBER_LIMIT_INVALID"),
        // bigint 读出来可能是字符串，先 Number 再当兜底值，否则「这次不改」会把 "104857600" 原样写回去。
        storageQuota: nonNegativeInteger(patch.storageQuota, Number(team.storageQuota), TEAM_STORAGE_QUOTA_MAX, "云空间上限必须是不超过 1TB 的非负整数字节数", "TEAM_STORAGE_QUOTA_INVALID"),
        status,
        updatedAt: now(),
    };
    await repo(Team).update({ id: teamId }, next);
    // 上限变了才广播：没变也发的话，每次改个团队名都会让所有成员的界面闪一下配额。
    if (next.storageQuota !== Number(team.storageQuota)) publishTeamStorage(teamId, await usedBytesOfTeam(teamId), next.storageQuota);
    return { ...team, ...next };
}

/**
 * 调整团队积分池。余额与 admin_adjust 流水同事务，并在提交后广播 team.credits。
 * 入参严格校验而不是 `Number(x) || 0`：后者会把一次拼错字段的请求解释成「把余额清零」，
 * 而清零是个不可逆的、事后从流水里也看不出本意的操作。
 */
export async function adminSetTeamCredits(teamId: string, credits: unknown, remark: string) {
    await teamOrFail(teamId);
    // 缺字段同样是错，不是「改成 0」：漏传比传错更容易发生，而两者的后果一样不可逆。
    if (credits === undefined) throw fail("请填写要设置的积分", 400, "TEAM_CREDITS_INVALID");
    return setTeamCredits(teamId, nonNegativeInteger(credits, 0, TEAM_CREDITS_MAX, "积分必须是不超过十亿的非负整数", "TEAM_CREDITS_INVALID"), remark);
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
