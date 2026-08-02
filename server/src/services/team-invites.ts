import { createHash, randomBytes } from "node:crypto";

import { dataSource, repo, serialTransaction } from "../db/data-source";
import { Team, TeamInvite, TeamInviteUse, TeamMember, type TeamInviteKind, type TeamRole } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
// 手输码的字母表与长度只此一份：复制第二份的下场是某天有人改了形近字规则，另一处还在发旧格式的码。
import { newInviteCode, normalizeInviteCode } from "./invites";
import { requireTeamRole } from "./team-access";

/** 192 bit 随机值，base64url 后固定 32 个字符，远超「至少 128 bit」的要求。 */
const TOKEN_BYTES = 24;
const TOKEN_PREFIX_LENGTH = 8;

export type TeamInviteInput = {
    kind?: unknown;
    role?: unknown;
    maxUses?: unknown;
    expiresAt?: unknown;
    note?: unknown;
};

/** 原子更新里要拼列名，各方言的引号不同，交给驱动去转义。 */
const column = (name: string) => dataSource.driver.escape(name);

export function teamInviteTokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

/** 列表视图只回前缀：链接明文只在创建响应里出现一次，之后服务端自己也拿不回来。 */
export function teamInviteView(invite: TeamInvite) {
    return {
        id: invite.id,
        teamId: invite.teamId,
        kind: invite.kind,
        tokenPrefix: invite.tokenPrefix,
        code: invite.code,
        role: invite.role,
        maxUses: invite.maxUses,
        usedCount: invite.usedCount,
        enabled: invite.enabled,
        expiresAt: invite.expiresAt,
        createdBy: invite.createdBy,
        note: invite.note,
        createdAt: invite.createdAt,
    };
}

export async function createTeamInvite(teamId: string, actorId: string, input: TeamInviteInput) {
    await requireTeamRole(actorId, teamId, ["owner", "admin"], { write: true });
    const kind: TeamInviteKind = input.kind === "code" ? "code" : "link";
    const role = String(input.role || "member") as TeamRole;
    // owner 只能通过转让产生。允许邀请授予 owner 等于把「团队恒有一个 owner」交给一张随时可能被转发的链接。
    if (!["admin", "member", "viewer"].includes(role)) throw fail("不能通过邀请授予该角色", 400, "TEAM_INVITE_INVALID");
    // 手输码熵低，默认一次性；链接默认不限次，语义与 InviteCode.maxUses 一致（0 表示不限）。
    const maxUses = input.maxUses === undefined ? (kind === "code" ? 1 : 0) : Math.max(0, Math.floor(Number(input.maxUses) || 0));
    const token = kind === "link" ? randomBytes(TOKEN_BYTES).toString("base64url") : "";
    const invite = repo(TeamInvite).create({
        id: newId("team-invite"),
        teamId,
        kind,
        tokenHash: token ? teamInviteTokenHash(token) : "",
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        code: kind === "code" ? newInviteCode() : "",
        role,
        maxUses,
        usedCount: 0,
        enabled: true,
        expiresAt: String(input.expiresAt || "").trim(),
        createdBy: actorId,
        note: String(input.note || "").trim(),
        createdAt: now(),
    });
    await repo(TeamInvite).insert(invite);
    return { ...teamInviteView(invite), token };
}

export async function listTeamInvites(teamId: string, actorId: string) {
    await requireTeamRole(actorId, teamId, ["owner", "admin"]);
    return (
        await repo(TeamInvite).find({
            where: { teamId },
            order: { createdAt: "DESC" },
        })
    ).map(teamInviteView);
}

export async function updateTeamInvite(
    teamId: string,
    actorId: string,
    inviteId: string,
    patch: {
        enabled?: unknown;
        maxUses?: unknown;
        expiresAt?: unknown;
        note?: unknown;
    },
) {
    await requireTeamRole(actorId, teamId, ["owner", "admin"], { write: true });
    const invite = await repo(TeamInvite).findOneBy({ id: inviteId, teamId });
    if (!invite) throw fail("邀请不存在", 404, "TEAM_INVITE_NOT_FOUND");
    const next = {
        enabled: patch.enabled === undefined ? invite.enabled : patch.enabled === true,
        // 0 是「不限次」，原样保留；其余不允许改到已领取次数以下，否则界面上会出现 3/2 这种像坏了的数字。
        maxUses:
            patch.maxUses === undefined
                ? invite.maxUses
                : (() => {
                      const value = Math.max(0, Math.floor(Number(patch.maxUses) || 0));
                      return value === 0 ? 0 : Math.max(invite.usedCount, value);
                  })(),
        expiresAt: patch.expiresAt === undefined ? invite.expiresAt : String(patch.expiresAt || "").trim(),
        note: patch.note === undefined ? invite.note : String(patch.note || "").trim(),
    };
    await repo(TeamInvite).update({ id: inviteId }, next);
    return teamInviteView({ ...invite, ...next });
}

export async function deleteTeamInvite(teamId: string, actorId: string, inviteId: string) {
    await requireTeamRole(actorId, teamId, ["owner", "admin"], { write: true });
    await repo(TeamInvite).delete({ id: inviteId, teamId });
}

async function findInvite(tokenOrCode: string) {
    const value = String(tokenOrCode || "").trim();
    if (!value) return null;
    const byToken = await repo(TeamInvite).findOneBy({
        tokenHash: teamInviteTokenHash(value),
    });
    if (byToken) return byToken;
    const code = normalizeInviteCode(value);
    return code ? repo(TeamInvite).findOneBy({ code }) : null;
}

function assertUsable(invite: TeamInvite | null, at: number): asserts invite is TeamInvite {
    // 无效、停用、过期、用完统一一个错误码：区分开来就等于给暴力试码的人一个「这个码存在」的信号。
    if (!invite || !invite.enabled) throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= at) throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
    if (invite.maxUses > 0 && invite.usedCount >= invite.maxUses) throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
}

/**
 * 占一个名额。并发安全全靠这条带条件的 UPDATE：名额判定与自增写在同一条语句里，
 * 十个人同时抢三个名额时数据库只会让其中三条 affected=1，usedCount 不可能越过 maxUses。
 * 上面那次查询只负责给出具体文案，不是门禁。
 */
async function claimSlot(invite: TeamInvite, at: number) {
    const result = await repo(TeamInvite)
        .createQueryBuilder()
        .update(TeamInvite)
        .set({ usedCount: () => `${column("usedCount")} + 1` })
        .where(`${column("id")} = :id AND ${column("enabled")} = :enabled AND (${column("maxUses")} = 0 OR ${column("usedCount")} < ${column("maxUses")}) AND (${column("expiresAt")} = '' OR ${column("expiresAt")} > :at)`, {
            id: invite.id,
            enabled: true,
            at: new Date(at).toISOString(),
        })
        .execute();
    return Boolean(result.affected);
}

/** 名额占了但没能加进团队时还回去，否则一次失败就白吃一个名额。 */
async function releaseSlot(inviteId: string) {
    await repo(TeamInvite)
        .createQueryBuilder()
        .update(TeamInvite)
        .set({ usedCount: () => `${column("usedCount")} - 1` })
        .where(`${column("id")} = :id AND ${column("usedCount")} > 0`, {
            id: inviteId,
        })
        .execute();
}

export async function previewTeamInvite(tokenOrCode: string, at = Date.now()) {
    const invite = await findInvite(tokenOrCode);
    assertUsable(invite, at);
    const team = await repo(Team).findOneBy({ id: invite.teamId });
    if (!team || team.status !== "active") throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
    return {
        teamId: team.id,
        teamName: team.name,
        teamAvatarUrl: team.avatarUrl || "",
        role: invite.role,
        memberCount: await repo(TeamMember).countBy({ teamId: team.id }),
    };
}

export async function acceptTeamInvite(tokenOrCode: string, userId: string, at = Date.now()) {
    const invite = await findInvite(tokenOrCode);
    assertUsable(invite, at);
    const team = await repo(Team).findOneBy({ id: invite.teamId });
    if (!team || team.status !== "active") throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");

    const existing = await repo(TeamMember).findOneBy({
        teamId: invite.teamId,
        userId,
    });
    // 已经在团队里就直接返回，且不占名额：用户点第二次链接不该把一个一次性邀请吃掉。
    if (existing) return existing;

    if (!(await claimSlot(invite, at))) throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
    try {
        return await serialTransaction(async (manager) => {
            const members = manager.getRepository(TeamMember);
            const already = await members.findOneBy({
                teamId: invite.teamId,
                userId,
            });
            if (already) throw fail("已经是团队成员", 409, "TEAM_ALREADY_MEMBER");
            if (team.memberLimit > 0 && (await members.countBy({ teamId: invite.teamId })) >= team.memberLimit) {
                throw fail("团队成员数已达上限", 400, "TEAM_MEMBER_LIMIT");
            }
            const member = members.create({
                teamId: invite.teamId,
                userId,
                role: invite.role,
                creditLimit: 0,
                limitWindow: "month",
                status: "active",
                invitedBy: invite.createdBy,
                joinedAt: now(),
                updatedAt: now(),
            });
            await members.insert(member);
            await manager.getRepository(TeamInviteUse).insert({
                id: newId("team-invite-use"),
                inviteId: invite.id,
                teamId: invite.teamId,
                userId,
                role: invite.role,
                createdAt: now(),
            });
            return member;
        });
    } catch (error) {
        await releaseSlot(invite.id);
        throw error;
    }
}
