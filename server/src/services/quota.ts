import { repo } from "../db/data-source";
import { DEFAULT_STORAGE_QUOTA, StoredFile, User } from "../db/entities";
import { fail } from "../lib/errors";

/** 已用量不冗余存储，一律从文件对象表实时聚合；bigint 在部分方言下返回字符串，统一转数字。 */
export async function usedBytesOf(userIds: string[]) {
    const rows = userIds.length
        ? await repo(StoredFile)
              .createQueryBuilder("file")
              .select("file.userId", "userId")
              .addSelect("SUM(file.bytes)", "total")
              .where("file.userId IN (:...userIds)", { userIds })
              .groupBy("file.userId")
              .getRawMany<{ userId: string; total: string | number | null }>()
        : [];
    return new Map(rows.map((row) => [row.userId, Number(row.total || 0)]));
}

export async function usedBytes(userId: string) {
    return (await usedBytesOf([userId])).get(userId) || 0;
}

export async function quotaOf(userId: string) {
    const user = await repo(User).findOneBy({ id: userId });
    return user ? Number(user.storageQuota) : DEFAULT_STORAGE_QUOTA;
}

export async function storageOf(userId: string) {
    const [used, quota] = await Promise.all([usedBytes(userId), quotaOf(userId)]);
    return { used, quota };
}

function mb(bytes: number) {
    return `${(bytes / (1 << 20)).toFixed(1)}MB`;
}

/** 写入新文件前校验，命中去重的上传不会走到这里，因此不占新增空间。 */
export async function assertQuota(userId: string, incomingBytes: number) {
    const { used, quota } = await storageOf(userId);
    if (used + incomingBytes > quota) throw fail(`云空间不足：已用 ${mb(used)} / ${mb(quota)}，本次需要 ${mb(incomingBytes)}`);
}
