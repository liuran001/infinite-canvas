import { In, Like } from "typeorm";

import { dataSource, repo } from "../db/data-source";
import { InviteCode, InviteUse, User } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
// 码值规则住在 lib：启动时的旧库升级也要用同一套，而它不能依赖任何 service。
import { newInviteCode, normalizeInviteCode } from "../lib/invite-code";
import type { Query } from "../lib/response";

export { newInviteCode, normalizeInviteCode };

/** 一次批量生成的上限。挡住手滑把 count 填成 100000 直接把库刷爆。 */
const MAX_BATCH = 200;

/** 原子更新里要拼列名，各方言的引号不同，交给驱动去转义。 */
const column = (name: string) => dataSource.driver.escape(name);

export async function createInviteCodes(input: { count?: unknown; maxUses?: unknown; credits?: unknown; note?: unknown }) {
    const count = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(input.count) || 1)));
    // 0 表示不限次。没传这个字段时按一次性码算，默认给「无限次」太容易被误发出去。
    const maxUses = input.maxUses === undefined ? 1 : Math.max(0, Math.floor(Number(input.maxUses) || 0));
    const credits = Math.max(0, Math.floor(Number(input.credits) || 0));
    const note = String(input.note || "").trim();
    const rows = Array.from({ length: count }, () => ({ code: newInviteCode(), maxUses, usedCount: 0, credits, enabled: true, note, createdAt: now() }));
    // 用 insert 而不是 save：save 撞上已有主键会变成更新，等于悄悄改掉别人的码；insert 会直接报冲突。
    await repo(InviteCode).insert(rows);
    return rows;
}

export async function listInviteCodes(query: Query) {
    // 码值只存大写，关键词也要转大写才搜得到；备注是管理员随手写的中文，按原样匹配。
    const where = query.keyword ? [{ code: Like(`%${query.keyword.toUpperCase()}%`) }, { note: Like(`%${query.keyword}%`) }] : {};
    const [items, total] = await repo(InviteCode).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    return { items, total };
}

export async function updateInviteCode(code: string, patch: { enabled?: unknown; maxUses?: unknown; credits?: unknown; note?: unknown }) {
    const codes = repo(InviteCode);
    const found = await codes.findOneBy({ code: normalizeInviteCode(code) });
    if (!found) throw fail("邀请码不存在");
    if (patch.enabled !== undefined) found.enabled = patch.enabled === true;
    // 0 是「不限次」，原样保留；其余情况不允许改到已用次数以下，否则后台会显示出 3/2 这种看着像坏了的数据。
    if (patch.maxUses !== undefined) {
        const next = Math.max(0, Math.floor(Number(patch.maxUses) || 0));
        found.maxUses = next === 0 ? 0 : Math.max(found.usedCount, next);
    }
    if (patch.credits !== undefined) found.credits = Math.max(0, Math.floor(Number(patch.credits) || 0));
    if (patch.note !== undefined) found.note = String(patch.note || "").trim();
    return codes.save(found);
}

/**
 * 删除策略：只删没人用过的码。
 * 用过的码一旦删掉，使用记录就成了孤儿，后台再也查不出「这个用户是拿哪个码进来的、当时送了多少点」，
 * 而这正是邀请码要留档的核心信息，所以这种情况一律要求改成停用。
 */
export async function deleteInviteCode(code: string) {
    const codes = repo(InviteCode);
    const found = await codes.findOneBy({ code: normalizeInviteCode(code) });
    if (!found) throw fail("邀请码不存在");
    if (found.usedCount > 0) throw fail("该邀请码已被使用，不能删除，请改为停用");
    await codes.delete({ code: found.code });
}

/**
 * 占用一个名额。maxUses 为 0 表示不限次。
 * 并发安全靠带条件的原子更新：名额判断和自增写在同一条 UPDATE 里，
 * 两个人同时抢最后一个名额时数据库只会让其中一条 affected=1，另一条拿到 0 直接被拒，usedCount 不可能超过 maxUses。
 * 上面先查一次只是为了给出「无效 / 已停用 / 已用完」这类具体文案，真正的门禁是下面这条 UPDATE。
 */
export async function claimInviteCode(input: string) {
    const code = normalizeInviteCode(input);
    if (!code) throw fail("请输入邀请码");
    const codes = repo(InviteCode);
    const found = await codes.findOneBy({ code });
    if (!found) throw fail("邀请码无效");
    if (!found.enabled) throw fail("邀请码已停用");
    if (found.maxUses > 0 && found.usedCount >= found.maxUses) throw fail("邀请码已用完");
    const result = await codes
        .createQueryBuilder()
        .update(InviteCode)
        .set({ usedCount: () => `${column("usedCount")} + 1` })
        .where(`${column("code")} = :code AND (${column("maxUses")} = 0 OR ${column("usedCount")} < ${column("maxUses")})`, { code })
        .execute();
    if (!result.affected) throw fail("邀请码已用完");
    return { code, credits: found.credits };
}

/** 名额已经占掉但后续建号失败时还回去，否则一次失败就白白吃掉一个名额。 */
export async function releaseInviteCode(code: string) {
    await repo(InviteCode)
        .createQueryBuilder()
        .update(InviteCode)
        .set({ usedCount: () => `${column("usedCount")} - 1` })
        .where(`${column("code")} = :code AND ${column("usedCount")} > 0`, { code })
        .execute();
}

export async function recordInviteUse(code: string, userId: string, credits: number) {
    await repo(InviteUse).insert({ id: newId("invite-use"), code, userId, credits, createdAt: now() });
}

/** 使用记录按用户 ID 关联出用户名，不做冗余快照，改名后后台看到的仍是当前用户名。 */
export async function listInviteUses(code: string, query: Query) {
    const [items, total] = await repo(InviteUse).findAndCount({
        where: { code: normalizeInviteCode(code) },
        order: { createdAt: "DESC" },
        skip: query.offset,
        take: query.pageSize,
    });
    const users = items.length ? await repo(User).find({ where: { id: In(items.map((item) => item.userId)) }, select: { id: true, username: true, displayName: true } }) : [];
    const owners = new Map(users.map((user) => [user.id, user]));
    return {
        // 对外叫 usedAt：这张表里的 createdAt 记的就是「什么时候用掉的」，换个贴切的名字省得前端再解释一遍。
        items: items.map((item) => ({
            code: item.code,
            userId: item.userId,
            username: owners.get(item.userId)?.username || "",
            displayName: owners.get(item.userId)?.displayName || "",
            credits: item.credits,
            usedAt: item.createdAt,
        })),
        total,
    };
}
