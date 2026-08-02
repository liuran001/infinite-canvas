import { In, type EntityManager } from "typeorm";

import { repo, serialTransaction } from "../db/data-source";
import { Project, Team, TeamCreditLog, TeamInvite, TeamMember, User, type TeamLimitWindow, type TeamMemberStatus, type TeamRole } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { nonNegativeInteger } from "../lib/validate";
import { usedCreditsOfTeam } from "./billing";
import { assertCanManageMember, canTeamAction, requireTeamRole } from "./team-access";
import { closeTeamConnectionsOf, publishTeamMember } from "./team-realtime";

export type TeamInput = {
    name?: unknown;
    description?: unknown;
    avatarUrl?: unknown;
};

const NAME_MAX = 64;

/** 团队名归一化。前台与平台后台共用：后台绕过它的话，超长名字会在数据库层被静默截断。 */
export function normalizeTeamName(value: unknown, fallback = "") {
    const name = String(value || "")
        .trim()
        .slice(0, NAME_MAX);
    if (!name) {
        if (fallback) return fallback;
        throw fail("请填写团队名称", 400, "TEAM_NAME_REQUIRED");
    }
    return name;
}

function normalizeName(value: unknown) {
    return normalizeTeamName(value);
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
 * 聚合按「窗口」批量做，最多三条 GROUP BY（day/month/total），不再按人各查一次：
 * 逐人查不但是 N+1，每一次还要排进全进程唯一的事务队列，几十人的团队打开一次列表
 * 就把扣费和领邀请堵在后面几十个来回。
 */
export async function listMemberViews(userId: string, teamId: string) {
    const members = await listMembers(userId, teamId);
    const users = members.length ? await repo(User).find({ where: { id: In(members.map((member) => member.userId)) } }) : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    const windows = [...new Set(members.map((member) => member.limitWindow))];
    const usedByWindow = new Map(await Promise.all(windows.map(async (window) => [window, await usedCreditsOfTeam(teamId, window)] as const)));
    return members.map((member) => ({
        teamId: member.teamId,
        userId: member.userId,
        username: byId.get(member.userId)?.username || "",
        displayName: byId.get(member.userId)?.displayName || byId.get(member.userId)?.username || "",
        avatarUrl: byId.get(member.userId)?.avatarUrl || "",
        role: member.role,
        creditLimit: member.creditLimit,
        limitWindow: member.limitWindow,
        status: member.status,
        usedCredits: usedByWindow.get(member.limitWindow)?.get(member.userId) || 0,
        joinedAt: member.joinedAt,
        updatedAt: member.updatedAt,
    }));
}

async function memberOrFail(teamId: string, userId: string) {
    const member = await repo(TeamMember).findOneBy({ teamId, userId });
    if (!member) throw fail("该用户不在团队中", 404, "TEAM_MEMBER_NOT_FOUND");
    return member;
}

/**
 * 改成员角色。owner 完全不经这条路径进出：升 owner 只能走 transferOwner，
 * 否则「团队恒有且仅有一个 owner」这条不变量就得靠每个调用点自觉维护。
 * 实现直接复用 updateMember：两条路径各写一份判定的话，收紧其中一处就等于给另一处开了扇没人看守的门。
 */
export async function updateMemberRole(teamId: string, actorId: string, targetId: string, role: TeamRole) {
    return updateMember(teamId, actorId, targetId, { role });
}

export type TeamMemberPatch = {
    role?: unknown;
    creditLimit?: unknown;
    limitWindow?: unknown;
    status?: unknown;
};

const LIMIT_WINDOWS: TeamLimitWindow[] = ["day", "month", "total"];
/** 能通过成员设置赋予的角色。owner 不在其中：进出 owner 只能走 transferOwner。 */
const ASSIGNABLE_ROLES: TeamRole[] = ["admin", "member", "viewer"];
/** 成员额度上限。与 DB 的 int 列对齐，留出余量，避免写进去被静默截断成一个谁也解释不了的数。 */
const CREDIT_LIMIT_MAX = 1_000_000_000;
const MEMBER_RETRIES = 5;

/**
 * 事务内的成员变更：读成员、判权限、写回全在同一个 manager 上。
 * 分成「先改角色再改额度」两段的话，中间失败会留下只改了一半的成员，
 * 而两段各自读一次成员，后一段还会拿着过期的快照把前一段刚写下的值覆盖回去。
 * 更新用读到的旧值当条件，被并发抢先就整体作废重来，绝不覆盖别人的写入。
 */
async function applyMemberPatch(manager: EntityManager, teamId: string, actorId: string, targetId: string, patch: TeamMemberPatch) {
    const members = manager.getRepository(TeamMember);
    const team = await manager.getRepository(Team).findOneBy({ id: teamId });
    const actor = team ? await members.findOneBy({ teamId, userId: actorId }) : null;
    // 判定必须在事务内重做一遍：事务外先过一次 requireTeamRole 只能证明「刚才有权限」。
    if (!team || !actor) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    if (actor.status !== "active") throw fail("你在该团队中的状态已被挂起", 403, "TEAM_MEMBER_SUSPENDED");
    if (team.status !== "active") throw fail("团队已被平台停用", 403, "TEAM_DISABLED");
    const target = await members.findOneBy({ teamId, userId: targetId });
    if (!target) throw fail("该用户不在团队中", 404, "TEAM_MEMBER_NOT_FOUND");
    assertCanManageMember(actor.role, target.role);

    let role = target.role;
    if (patch.role !== undefined && String(patch.role) !== target.role) {
        role = String(patch.role) as TeamRole;
        if (target.role === "owner") throw fail("不能修改 owner 的角色，请先转让", 400, "TEAM_OWNER_IMMUTABLE");
        if (role === "owner") throw fail("提升为 owner 只能通过转让", 400, "TEAM_OWNER_MUST_TRANSFER");
        // 白名单而不是黑名单：只挡 owner 的话，随手传一个 "boss" 就能在库里种下一个谁都判不了的角色，
        // 权限矩阵查不到它，于是这个人处处被拒，却又没有任何一条规则说明为什么。
        if (!ASSIGNABLE_ROLES.includes(role)) throw fail("无效的成员角色", 400, "TEAM_ROLE_INVALID");
        if (role === "admin" && !canTeamAction(actor.role, "member.promoteAdmin")) throw fail("只有 owner 可以任命 admin", 403, "TEAM_FORBIDDEN");
    }
    if (patch.limitWindow !== undefined && !LIMIT_WINDOWS.includes(String(patch.limitWindow) as TeamLimitWindow)) throw fail("无效的额度周期", 400, "TEAM_LIMIT_WINDOW_INVALID");
    const status = patch.status === undefined ? target.status : (String(patch.status) as TeamMemberStatus);
    if (!["active", "suspended"].includes(status)) throw fail("无效的成员状态", 400, "TEAM_MEMBER_STATUS_INVALID");
    // owner 不能被挂起：挂起的人过不了 requireTeamRole，团队就再也没有能转让、能解散的人了。
    if (target.role === "owner" && status !== "active") throw fail("不能挂起 owner", 400, "TEAM_OWNER_IMMUTABLE");
    const next = {
        role,
        creditLimit: nonNegativeInteger(patch.creditLimit, target.creditLimit, CREDIT_LIMIT_MAX, "额度上限必须是不超过十亿的非负整数", "TEAM_CREDIT_LIMIT_INVALID"),
        limitWindow: patch.limitWindow === undefined ? target.limitWindow : (String(patch.limitWindow) as TeamLimitWindow),
        status,
        updatedAt: now(),
    };
    const result = await members.update({ teamId, userId: targetId, role: target.role, creditLimit: target.creditLimit, limitWindow: target.limitWindow, status: target.status }, next);
    if (!result.affected) return null;
    return { member: { ...target, ...next }, roleChanged: role !== target.role, suspended: status !== "active" };
}

/**
 * 成员设置的统一入口：角色、额度、挂起状态一次事务改完。
 * 广播放在提交之后：事务里发出去的话，回滚时事件已经收不回来，界面会显示一次没发生的变更。
 */
export async function updateMember(teamId: string, actorId: string, targetId: string, patch: TeamMemberPatch) {
    for (let attempt = 0; attempt < MEMBER_RETRIES; attempt += 1) {
        const settled = await serialTransaction((manager) => applyMemberPatch(manager, teamId, actorId, targetId, patch));
        if (!settled) continue;
        const { member, roleChanged, suspended } = settled;
        if (roleChanged) publishTeamMember(teamId, { type: "member.roleChanged", userId: targetId, role: member.role });
        if (suspended) publishTeamMember(teamId, { type: "member.suspended", userId: targetId, role: member.role });
        // 角色一变或被挂起就断掉他自己的长连接。SSE 建好之后不重连就不再鉴权，
        // 连接建立那一刻发下去的角色会一直被前端当成有效值，降级后他的界面还留着一堆点了会被拒的按钮。
        // 断开是让他立刻重连、重新拿一次角色，而不是把人挡在外面。
        if (roleChanged || suspended) closeTeamConnectionsOf(teamId, targetId);
        return member;
    }
    throw fail("该成员正在被其他人修改，请稍后重试", 409, "TEAM_MEMBER_BUSY");
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
    // 成员名单在事务内读：读在事务外的话，这中间刚加入的人不在名单里，
    // 团队没了他的长连接却还挂着，页面上留着一个点进去必然 404 的团队。
    const members = await serialTransaction(async (manager) => {
        const rows = await manager.getRepository(TeamMember).findBy({ teamId });
        await manager.getRepository(Team).update({ id: teamId }, { status: "disbanded", updatedAt: now() });
        await manager.getRepository(Project).update({ teamId }, { teamId: "", updatedAt: now() });
        await manager.getRepository(TeamMember).delete({ teamId });
        await manager.getRepository(TeamInvite).update({ teamId }, { enabled: false });
        return rows;
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
