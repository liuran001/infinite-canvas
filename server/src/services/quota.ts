import { repo } from "../db/data-source";
import { DEFAULT_STORAGE_QUOTA, DEFAULT_TEAM_STORAGE_QUOTA, StoredFile, Team, User } from "../db/entities";
import { fail, QUOTA_EXCEEDED, TEAM_QUOTA_EXCEEDED } from "../lib/errors";

/**
 * 云空间的归属方。个人与团队是两本完全独立的账：同一份内容分别挂在个人和团队名下时，
 * 物理对象仍然只有一份，但两边各自记一次用量——否则团队买的空间会被某个成员的个人上传悄悄吃掉，
 * 反过来也一样。归属只由画布的 Project.teamId 决定，与上传者是谁无关。
 */
export type StorageOwner = { kind: "user"; userId: string } | { kind: "team"; teamId: string };

/** 上传时按画布归属决定这份文件记谁的账：团队画布记团队，个人画布记画布所有者。 */
export function ownerOfUpload(ownerId: string, teamId: string): StorageOwner {
    return teamId ? { kind: "team", teamId } : { kind: "user", userId: ownerId };
}

/**
 * 已用量不冗余存储，一律从文件对象表实时聚合；bigint 在部分方言下返回字符串，统一转数字。
 * 团队文件不算进任何人的个人用量：它占的是团队的空间，成员退出也带不走，所以过滤条件里 teamId 必须是空串。
 */
export async function usedBytesOf(userIds: string[]) {
    const rows = userIds.length
        ? await repo(StoredFile)
              .createQueryBuilder("file")
              .select("file.userId", "userId")
              .addSelect("file.checksum", "checksum")
              .addSelect("MAX(file.bytes)", "bytes")
              .where("file.userId IN (:...userIds) AND file.teamId = :teamId", { userIds, teamId: "" })
              .groupBy("file.userId")
              .addGroupBy("file.checksum")
              .getRawMany<{ userId: string; checksum: string; bytes: string | number | null }>()
        : [];
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.userId, (totals.get(row.userId) || 0) + Number(row.bytes || 0));
    return totals;
}

export async function usedBytes(userId: string) {
    return (await usedBytesOf([userId])).get(userId) || 0;
}

/** 团队已用量。与个人用量走同一张表、同一套聚合，只是过滤条件换成 teamId。 */
export async function usedBytesOfTeam(teamId: string) {
    const rows = await repo(StoredFile)
        .createQueryBuilder("file")
        .select("file.checksum", "checksum")
        .addSelect("MAX(file.bytes)", "bytes")
        .where("file.teamId = :teamId", { teamId })
        .groupBy("file.checksum")
        .getRawMany<{ checksum: string; bytes: string | number | null }>();
    return rows.reduce((total, row) => total + Number(row.bytes || 0), 0);
}

/** 一批团队的用量，一次 GROUP BY 出结果。后台列表逐个团队各查一次是 N+1，团队一多就把列表拖垮。 */
export async function usedBytesOfTeams(teamIds: string[]) {
    const rows = teamIds.length
        ? await repo(StoredFile)
              .createQueryBuilder("file")
              .select("file.teamId", "teamId")
              .addSelect("file.checksum", "checksum")
              .addSelect("MAX(file.bytes)", "bytes")
              .where("file.teamId IN (:...teamIds)", { teamIds })
              .groupBy("file.teamId")
              .addGroupBy("file.checksum")
              .getRawMany<{ teamId: string; checksum: string; bytes: string | number | null }>()
        : [];
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.teamId, (totals.get(row.teamId) || 0) + Number(row.bytes || 0));
    return totals;
}

export async function quotaOf(userId: string) {
    const user = await repo(User).findOneBy({ id: userId });
    return user ? Number(user.storageQuota) : DEFAULT_STORAGE_QUOTA;
}

export async function quotaOfTeam(teamId: string) {
    const team = await repo(Team).findOneBy({ id: teamId });
    return team ? Number(team.storageQuota) : DEFAULT_TEAM_STORAGE_QUOTA;
}

export async function storageOf(userId: string) {
    const [used, quota] = await Promise.all([usedBytes(userId), quotaOf(userId)]);
    return { used, quota };
}

export async function storageOfTeam(teamId: string) {
    const [used, quota] = await Promise.all([usedBytesOfTeam(teamId), quotaOfTeam(teamId)]);
    return { used, quota };
}

/** 归属方的用量视图。调用方一律走它，不要自己按 kind 分支——分支散出去就会有人漏掉团队那一支。 */
export async function storageOfOwner(owner: StorageOwner) {
    return owner.kind === "team" ? storageOfTeam(owner.teamId) : storageOf(owner.userId);
}

function mb(bytes: number) {
    return `${(bytes / (1 << 20)).toFixed(1)}MB`;
}

/**
 * 写入新文件前校验，命中去重的上传不会走到这里，因此不占新增空间。
 *
 * 个人与团队用两个错误码、两套文案：都回「云空间不足 / QUOTA_EXCEEDED」的话，
 * 成员在团队画布里传图被拒时只会去清自己的个人文件，越清越困惑——而该加额度的是团队。
 */
export async function assertQuota(owner: StorageOwner, incomingBytes: number) {
    const { used, quota } = await storageOfOwner(owner);
    const team = owner.kind === "team";
    const scope = team ? "团队云空间" : "云空间";
    if (used + incomingBytes > quota) throw fail(`${scope}不足：已用 ${mb(used)} / ${mb(quota)}，本次需要 ${mb(incomingBytes)}`, 403, team ? TEAM_QUOTA_EXCEEDED : QUOTA_EXCEEDED);
}
