import { createHash, randomBytes } from "node:crypto";
import type { EntityManager } from "typeorm";

import { dataSource, repo, serialTransaction } from "../db/data-source";
import { Team, TeamInvite, TeamInviteUse, TeamMember, type TeamInviteKind, type TeamRole } from "../db/entities";
import { canonicalExpiresAt } from "../db/upgrade";
import { fail, newId, now } from "../lib/errors";
import { isInviteCodeUniqueViolation, isUniqueViolation } from "../lib/db-errors";
// 手输码的字母表与长度只此一份：复制第二份的下场是某天有人改了形近字规则，另一处还在发旧格式的码。
import { newInviteCode, normalizeInviteCode } from "../lib/invite-code";
import { requireTeamRole } from "./team-access";
import { publishTeamMember } from "./team-realtime";
import { requireActiveAccountForMembership } from "./account-deletion";

/** 192 bit 随机值，base64url 后固定 32 个字符，远超「至少 128 bit」的要求。 */
const TOKEN_BYTES = 24;
const TOKEN_PREFIX_LENGTH = 8;
/** 撞码重试上限。31^10 的空间里撞第二次已经是天文数字，试不出来只能是别的地方坏了，早点报错好过死循环。 */
const CODE_RETRIES = 8;

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

/**
 * 过期时间归一化成 UTC ISO。库里存什么格式决定了 `claimSlot` 的字符串比较是否等价于时间比较：
 * 原样存下 `2026-08-04T00:00:00+08:00` 的话，它与 `...Z` 的字典序和真实先后毫无关系，
 * 于是 `assertUsable`（Date.parse）说已过期、`claimSlot`（字符串）说还能领，并发路径就漏了。
 * 规则本身在 db/upgrade 里，升级旧数据与新写入必须用同一套，否则升级完的库仍然是分裂的。
 */
function normalizeExpiresAt(value: unknown) {
    const canonical = canonicalExpiresAt(value);
    if (canonical === null) throw fail("过期时间格式不正确", 400, "TEAM_INVITE_INVALID");
    return canonical;
}

/**
 * 生成一个库里还没有的手输码并把邀请写进去。
 *
 * 关键在于重试的是 insert 而不是「先查再写」：先 countBy 再 insert 之间隔着一次网络往返，
 * 两个管理员同时创建时完全可能双双查到「没人用」，然后其中一个撞在唯一约束上收到 500。
 * 唯一索引是唯一可信的裁判，所以直接写、写失败就换个码重来；查重那一步连做都不做。
 * 生成器与写入都从参数进来，测试可以喂脚本化的序列和会冲突的写入，生产接口上不留任何测试开关。
 */
export async function insertWithUniqueCode(generate: () => string, insert: (code: string) => Promise<void>) {
    for (let attempt = 0; attempt < CODE_RETRIES; attempt += 1) {
        const code = generate();
        try {
            await insert(code);
            return code;
        } catch (error) {
            // 只有「码」这条唯一约束的冲突值得换个码重来。列长度、外键、连接断开换几次码也是一样的结果；
            // 主键 id 冲突更要原样抛——重试八次仍然会撞，最后被伪装成「邀请码生成失败」，真故障就没了。
            if (attempt + 1 >= CODE_RETRIES || !isInviteCodeUniqueViolation(error)) throw error;
        }
    }
    throw fail("邀请码生成失败，请重试", 500, "TEAM_INVITE_CODE_EXHAUSTED");
}

/** 唯一冲突判定统一放在 lib，files 那边也用同一套；这里再导出一次是为了不改现有调用方。 */
export { isInviteCodeUniqueViolation, isUniqueViolation };

/** 列表视图只回前缀：链接明文只在创建响应里出现一次，之后服务端自己也拿不回来。 */
export function teamInviteView(invite: TeamInvite) {
    return {
        id: invite.id,
        teamId: invite.teamId,
        kind: invite.kind,
        tokenPrefix: invite.tokenPrefix,
        // 库里链接类邀请的 code 是 NULL（为了让唯一约束不被一堆空串顶住），对外统一成空串。
        code: invite.code || "",
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
    await requireTeamRole(actorId, teamId, "invite.manage", { write: true });
    const kind: TeamInviteKind = input.kind === "code" ? "code" : "link";
    const role = String(input.role || "member") as TeamRole;
    // owner 只能通过转让产生。允许邀请授予 owner 等于把「团队恒有一个 owner」交给一张随时可能被转发的链接。
    if (!["admin", "member", "viewer"].includes(role)) throw fail("不能通过邀请授予该角色", 400, "TEAM_INVITE_INVALID");
    // 手输码熵低，默认一次性；链接默认不限次，语义与 InviteCode.maxUses 一致（0 表示不限）。
    const maxUses = input.maxUses === undefined ? (kind === "code" ? 1 : 0) : Math.max(0, Math.floor(Number(input.maxUses) || 0));
    const expiresAt = normalizeExpiresAt(input.expiresAt);
    const token = kind === "link" ? randomBytes(TOKEN_BYTES).toString("base64url") : "";
    const invite = repo(TeamInvite).create({
        id: newId("team-invite"),
        teamId,
        kind,
        tokenHash: token ? teamInviteTokenHash(token) : "",
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        code: null,
        role,
        maxUses,
        usedCount: 0,
        enabled: true,
        expiresAt,
        createdBy: actorId,
        note: String(input.note || "").trim(),
        createdAt: now(),
    });
    if (kind === "code") {
        // 团队手输码刻意不支持「管理员指定内容」，与平台邀请码不同：平台邀请码只有平台管理员能建，
        // 而团队邀请是任何团队 owner/admin 都能调的接口。一旦允许指定码值，撞码报错就成了一个在线的
        // 「这个码存不存在」探测口——手输码的字母表只有 31 个字符，猜中一个就能直接加进别人的团队。
        // 随机生成的码没有这个面：调用方无法选择要试的值。
        // 码由 insert 本身定夺：撞上唯一索引就换一个再写，不做「先查再写」那种有窗口期的预检。
        invite.code = await insertWithUniqueCode(newInviteCode, async (candidate) => {
            invite.code = candidate;
            await repo(TeamInvite).insert(invite);
        });
    } else {
        await repo(TeamInvite).insert(invite);
    }
    return { ...teamInviteView(invite), token };
}

export async function listTeamInvites(teamId: string, actorId: string) {
    await requireTeamRole(actorId, teamId, "invite.manage");
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
    await requireTeamRole(actorId, teamId, "invite.manage", { write: true });
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
        expiresAt: patch.expiresAt === undefined ? invite.expiresAt : normalizeExpiresAt(patch.expiresAt),
        note: patch.note === undefined ? invite.note : String(patch.note || "").trim(),
    };
    await repo(TeamInvite).update({ id: inviteId }, next);
    return teamInviteView({ ...invite, ...next });
}

export async function deleteTeamInvite(teamId: string, actorId: string, inviteId: string) {
    await requireTeamRole(actorId, teamId, "invite.manage", { write: true });
    await repo(TeamInvite).delete({ id: inviteId, teamId });
}

async function findInvite(manager: EntityManager, tokenOrCode: string) {
    const value = String(tokenOrCode || "").trim();
    if (!value) return null;
    const invites = manager.getRepository(TeamInvite);
    const byToken = await invites.findOneBy({
        tokenHash: teamInviteTokenHash(value),
    });
    if (byToken) return byToken;
    const code = normalizeInviteCode(value);
    return code ? invites.findOneBy({ code }) : null;
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
 * 必须和成员插入同事务：SQLite 全程只有一条连接，事务外的 UPDATE 实际会落进别人已经打开的
 * BEGIN 里，别人一回滚就把这次占位一起抹掉——占位方却以为自己拿到了名额，名额于是被超发。
 */
async function claimSlot(manager: EntityManager, invite: TeamInvite, at: number) {
    const result = await manager
        .getRepository(TeamInvite)
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

export async function previewTeamInvite(tokenOrCode: string, at = Date.now()) {
    const invite = await findInvite(dataSource.manager, tokenOrCode);
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

/**
 * 领取邀请。查邀请、占名额、查成员、插成员、写领取记录全在同一个事务里：
 * 任何一步失败都整体回滚，名额自然还回去，不需要事务外再补一次 releaseSlot
 * ——那种补偿写法在单连接的 SQLite 上会跨进别人的事务，回滚时连别人占的名额一起抹掉。
 */
export async function acceptTeamInvite(tokenOrCode: string, userId: string, at = Date.now()) {
    const joined = await serialTransaction(async (manager) => {
        await requireActiveAccountForMembership(manager, userId);
        const invite = await findInvite(manager, tokenOrCode);
        assertUsable(invite, at);
        const team = await manager.getRepository(Team).findOneBy({ id: invite.teamId });
        if (!team || team.status !== "active") throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");

        const members = manager.getRepository(TeamMember);
        const existing = await members.findOneBy({ teamId: invite.teamId, userId });
        if (existing) {
            // 挂起的人再点一次链接，不能给「加入成功」——他进去什么都做不了，那是个骗人的成功。
            // 邀请也无权解挂：解挂是管理员的动作，一条能被转发的链接不该有这个能力。
            if (existing.status !== "active") throw fail("你在该团队中的状态已被挂起，请联系团队管理员", 403, "TEAM_MEMBER_SUSPENDED");
            // 已经在团队里就直接返回，且不占名额：用户点第二次链接不该把一个一次性邀请吃掉，
            // 也不该因为两次点击撞在一起就给其中一次一个 409。
            return { member: existing, joined: false };
        }

        if (!(await claimSlot(manager, invite, at))) throw fail("邀请无效或已失效", 400, "TEAM_INVITE_INVALID");
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
        return { member, joined: true };
    });
    // 广播放在事务提交之后：事务里发出去的话，回滚时事件已经收不回来了。
    if (joined.joined) publishTeamMember(joined.member.teamId, { type: "member.joined", userId, role: joined.member.role });
    return joined.member;
}
