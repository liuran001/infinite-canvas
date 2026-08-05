import type { EntityManager } from "typeorm";

import { dataSource } from "../db/data-source";
import { Team, TeamMember, User } from "../db/entities";
import { fail } from "../lib/errors";

const column = (name: string) => dataSource.driver.escape(name);

/**
 * 在创建账号归属数据的同一事务里锁住并复核 User.active。
 * 注销也先更新这行；两条路径无论谁先获得锁，后执行的一方都只能看到提交后的真实状态。
 */
export async function requireActiveAccount(manager: EntityManager, userId: string) {
    const users = manager.getRepository(User);
    await users
        .createQueryBuilder()
        .update(User)
        .set({ updatedAt: () => column("updatedAt") })
        .where(`${column("id")} = :userId AND ${column("status")} = :status`, { userId, status: "active" })
        .execute();
    const user = await users.findOneBy({ id: userId });
    if (!user || user.status !== "active") throw fail("账号不可用", 403, "ACCOUNT_UNAVAILABLE");
    return user;
}

/** 多账号写入按 id 排序拿锁，避免分享任务同时锁房主/付款方时跨实例死锁。 */
export async function requireActiveAccounts(manager: EntityManager, userIds: string[]) {
    const ids = [...new Set(userIds.map((id) => id.trim()).filter((id) => id && !id.startsWith("guest:")))].sort();
    for (const id of ids) await requireActiveAccount(manager, id);
}

/** 团队文件除了账号 active，还必须确认团队与文件归属成员在同一事务里仍可写。 */
export async function requireActiveStorageOwner(manager: EntityManager, userId: string, teamId = "") {
    await requireActiveAccount(manager, userId);
    if (!teamId) return;
    const teams = manager.getRepository(Team);
    await teams
        .createQueryBuilder()
        .update(Team)
        .set({ updatedAt: () => column("updatedAt") })
        .where(`${column("id")} = :teamId AND ${column("status")} = :status`, { teamId, status: "active" })
        .execute();
    const [team, member] = await Promise.all([
        teams.findOneBy({ id: teamId }),
        manager.getRepository(TeamMember).findOneBy({ teamId, userId, status: "active" }),
    ]);
    if (!team || team.status !== "active" || !member) throw fail("团队不可用", 403, "TEAM_UNAVAILABLE");
}
