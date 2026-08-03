import "reflect-metadata";

import { createChecker, objectExists, prepareEnv } from "./verify-common";

/**
 * 存储去重与引用计数专项验证：跨用户物理去重、逻辑配额独立、并发上传、最后引用回收。
 * 这些语义只靠端到端 smoke 覆盖会很脆（依赖起服务、端口、上游 mock），所以在服务层直接验证。
 * 用法：cd server && npx tsx verify-storage.ts
 */
const env = prepareEnv("verify-storage");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { PhysicalBlob, StoredFile, User } = await import("./src/db/entities");
    const { deleteFile, saveFile } = await import("./src/services/files");
    const { collectPendingBlobs } = await import("./src/services/blob-gc");
    const { usedBytes } = await import("./src/services/quota");
    const { now } = await import("./src/lib/errors");

    await initDatabase();
    const files = repo(StoredFile);
    const blobs = repo(PhysicalBlob);
    const users = repo(User);
    const makeUser = async (id: string, quota: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, displayNameCustomized: false, avatarUrl: "", role: "user", credits: 0, storageQuota: quota, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });

    await makeUser("user-a", 1 << 20);
    await makeUser("user-b", 1 << 20);
    await makeUser("user-tight", 32);

    // 1x1 PNG：saveFile 会解析图片元信息，用真实 PNG 才能覆盖这条分支。
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const otherPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

    console.log("跨用户物理去重与逻辑配额");
    const fileA = await saveFile("user-a", png, "image/png");
    const fileB = await saveFile("user-b", png, "image/png");
    check("不同用户拿到不同 fileId", fileA.id !== fileB.id, true);
    check("两个引用指向同一 checksum", fileA.checksum, fileB.checksum);
    check("全局只有一个物理对象", await blobs.countBy({ checksum: fileA.checksum }), 1);
    check("物理对象 refCount 为 2", (await blobs.findOneByOrFail({ checksum: fileA.checksum })).refCount, 2);
    check("两个引用共用同一物理 path", fileA.path, fileB.path);
    check("用户 A 按完整体积计费", await usedBytes("user-a"), png.length);
    check("用户 B 也按完整体积计费", await usedBytes("user-b"), png.length);
    check("物理对象实际只写了一份", objectExists(env.filesDir, fileA.path), true);

    console.log("同用户重复上传");
    const again = await saveFile("user-a", png, "image/png");
    check("同用户重复上传返回原 fileId", again.id, fileA.id);
    check("同用户重复上传不增加用量", await usedBytes("user-a"), png.length);
    check("同用户重复上传不增加 refCount", (await blobs.findOneByOrFail({ checksum: fileA.checksum })).refCount, 2);

    console.log("逻辑配额独立于物理去重");
    await rejects("配额不足的新内容被拒绝", () => saveFile("user-tight", otherPng, "image/png"));
    check("被拒绝的上传不留下逻辑引用", await files.countBy({ userId: "user-tight" }), 0);
    // 去重命中路径不做配额校验：物理上不占新空间，用户此前也已经为这份内容付过账。
    await users.update({ id: "user-a" }, { storageQuota: 1 });
    check("超配额时命中去重的重复上传仍放行", (await saveFile("user-a", png, "image/png")).id, fileA.id);
    await users.update({ id: "user-a" }, { storageQuota: 1 << 20 });

    console.log("并发上传同一新内容");
    const fresh = Buffer.from(`concurrent-${Date.now()}`);
    const results = await Promise.all(Array.from({ length: 8 }, () => saveFile("user-a", fresh, "application/octet-stream")));
    const ids = new Set(results.map((row) => row.id));
    check("8 个并发上传只产生一个逻辑引用", ids.size, 1);
    check("并发上传只建一个物理对象", await blobs.countBy({ checksum: results[0].checksum }), 1);
    check("并发上传后 refCount 为 1", (await blobs.findOneByOrFail({ checksum: results[0].checksum })).refCount, 1);
    check("并发上传只计一次用量", await usedBytes("user-a"), png.length + fresh.length);
    await deleteFile(results[0].id, "user-a");
    await collectPendingBlobs({ graceMs: 0 });

    console.log("最后一个引用才回收物理对象");
    const sharedPath = fileA.path;
    await deleteFile(fileA.id, "user-a");
    check("删除 A 后 A 的引用消失", await files.countBy({ id: fileA.id }), 0);
    check("删除 A 后 refCount 降到 1", (await blobs.findOneByOrFail({ checksum: fileB.checksum })).refCount, 1);
    check("删除 A 后 A 的用量释放", await usedBytes("user-a"), 0);
    check("删除 A 后 B 的用量不变", await usedBytes("user-b"), png.length);
    await collectPendingBlobs({ graceMs: 0 });
    check("仍有引用时 GC 不删物理对象", objectExists(env.filesDir, sharedPath), true);

    await deleteFile(fileB.id, "user-b");
    check("最后一个引用删除后 blob 转入待回收", (await blobs.findOneByOrFail({ checksum: fileB.checksum })).state, "pending_delete");
    check("待回收前物理对象仍在", objectExists(env.filesDir, sharedPath), true);
    await collectPendingBlobs({ graceMs: 60_000 });
    check("宽限期内 GC 不动手", objectExists(env.filesDir, sharedPath), true);
    await collectPendingBlobs({ graceMs: 0 });
    check("宽限期过后物理对象被删除", objectExists(env.filesDir, sharedPath), false);
    check("宽限期过后 blob 行被删除", await blobs.countBy({ checksum: fileB.checksum }), 0);

    console.log("删除与重新上传交错");
    const raced = await saveFile("user-a", png, "image/png");
    await deleteFile(raced.id, "user-a");
    const revived = await saveFile("user-b", png, "image/png");
    check("待回收状态下的新上传把 blob 复活", (await blobs.findOneByOrFail({ checksum: revived.checksum })).state, "active");
    check("复活后 refCount 正确", (await blobs.findOneByOrFail({ checksum: revived.checksum })).refCount, 1);
    await collectPendingBlobs({ graceMs: 0 });
    check("复活后的物理对象不会被 GC 误删", objectExists(env.filesDir, revived.path), true);
    check("复活后引用仍可用", await files.countBy({ id: revived.id }), 1);

    console.log("待回收 blob 上还挂着同用户引用");
    const stale = await saveFile("user-a", otherPng, "image/png");
    await blobs.update({ checksum: stale.checksum }, { state: "pending_delete", pendingSince: "2000-01-01T00:00:00.000Z", refCount: 0 });
    const staleAgain = await saveFile("user-a", otherPng, "image/png");
    check("命中已有引用时也会复活 blob", (await blobs.findOneByOrFail({ checksum: stale.checksum })).state, "active");
    check("命中已有引用返回原 fileId", staleAgain.id, stale.id);
    await collectPendingBlobs({ graceMs: 0 });
    check("复活后物理对象仍在", objectExists(env.filesDir, stale.path), true);

    console.log("GC 对账兜底");
    const guarded = await saveFile("user-b", otherPng, "image/png");
    await blobs.update({ checksum: guarded.checksum }, { state: "pending_delete", pendingSince: "2000-01-01T00:00:00.000Z", refCount: 0 });
    await collectPendingBlobs({ graceMs: 0 });
    check("仍有引用的待回收 blob 被恢复为 active", (await blobs.findOneByOrFail({ checksum: guarded.checksum })).state, "active");
    check("恢复时 refCount 按实际引用重算", (await blobs.findOneByOrFail({ checksum: guarded.checksum })).refCount, 2);
    check("恢复后物理对象没被删", objectExists(env.filesDir, guarded.path), true);

    console.log("删除幂等");
    await deleteFile(guarded.id, "user-b");
    await rejects("重复删除同一引用报错而不是继续扣减", () => deleteFile(guarded.id, "user-b"));
    check("重复删除不会把 refCount 扣穿", (await blobs.findOneByOrFail({ checksum: guarded.checksum })).refCount, 1);
    await rejects("不能删除他人的文件", () => deleteFile(stale.id, "user-b"));
    check("越权删除不影响原引用", await files.countBy({ id: stale.id }), 1);

    // 团队维度加进来之后，没有团队的用户必须一个字节的行为都不变——这一节就是那条底线的回归。
    console.log("无团队用户的行为不变");
    const soloFirst = await saveFile("user-b", Buffer.from("solo-payload"), "text/plain");
    check("不传 teamId 时归属仍是个人", soloFirst.teamId, "");
    check("不传 teamId 时重复上传仍命中去重", (await saveFile("user-b", Buffer.from("solo-payload"), "text/plain")).id, soloFirst.id);
    check("个人用量把这条算进去", await usedBytes("user-b"), otherPng.length + "solo-payload".length);
    // 显式传空串与不传必须完全等价，否则调用方少写一个参数就换了一本账。
    check("显式传空 teamId 等价于不传", (await saveFile("user-b", Buffer.from("solo-payload"), "text/plain", {}, "")).id, soloFirst.id);
    await deleteFile(soloFirst.id, "user-b");
    check("删除后个人用量退回去", await usedBytes("user-b"), otherPng.length);

    // 并发首传的输家会撞 file_blobs 的主键，那一条必须吞掉（下一行重新读就拿到赢家的记录）；
    // 别的错误吞掉就会被翻译成一条毫无线索的「找不到记录」。判定得认「表 + 列」这组身份：
    // 主键约束在 TypeORM 里叫 PK_<hash>，名字里既没有表名也没有列名，按名字匹配在 Postgres 上必然漏判。
    console.log("blob 主键冲突判定");
    const { isBlobChecksumConflict } = await import("./src/lib/db-errors");
    const captured = await blobs
        .insert({ checksum: fileA.checksum, bytes: 1, kind: "image", mimeType: "image/png", width: 0, height: 0, durationMs: 0, storage: "local", path: "dup", refCount: 0, state: "active", pendingSince: "", createdAt: now() })
        .then(() => null)
        .catch((error: unknown) => error);
    check("SQLite 真实主键冲突被认出", isBlobChecksumConflict(captured), true);
    // 反例也用真实驱动错误：另一张表的主键冲突长得几乎一样，但不能被吞。
    const otherTable = await files
        .insert({ id: fileA.id, userId: "user-a", kind: "image", mimeType: "image/png", bytes: 1, width: 0, height: 0, durationMs: 0, storage: "local", path: "dup", checksum: fileA.checksum, createdAt: now() })
        .then(() => null)
        .catch((error: unknown) => error);
    check("其他表的真实主键冲突不被吞", isBlobChecksumConflict(otherTable), false);

    // Postgres 与 MySQL 跑不到真库，这里用两个驱动各自的真实错误形态做判定。
    const pg = (extra: Record<string, unknown>) => ({ query: `INSERT INTO "file_blobs"("checksum") VALUES ($1)`, driverError: { code: "23505", message: 'duplicate key value violates unique constraint "PK_9a1f2c7b3e"', constraint: "PK_9a1f2c7b3e", schema: "public", ...extra } });
    check("Postgres 主键冲突按 table + detail 认出", isBlobChecksumConflict(pg({ table: "file_blobs", detail: "Key (checksum)=(abc) already exists." })), true);
    check("Postgres 缺 detail 时按表名认出", isBlobChecksumConflict(pg({ table: "file_blobs" })), true);
    check("Postgres 其他表的唯一冲突不被吞", isBlobChecksumConflict(pg({ table: "team_invites", detail: "Key (id)=(x) already exists." })), false);
    check("Postgres 同表其他列的唯一冲突不被吞", isBlobChecksumConflict(pg({ table: "file_blobs", detail: "Key (path)=(x) already exists." })), false);
    check("MySQL 8 的 file_blobs.PRIMARY 被认出", isBlobChecksumConflict({ code: "ER_DUP_ENTRY", errno: 1062, message: "Duplicate entry 'abc' for key 'file_blobs.PRIMARY'" }), true);
    // 5.7 的文案里没有表名，只能从 TypeORM 保存的失败 SQL 认。
    check("MySQL 5.7 按失败 SQL 的目标表认出", isBlobChecksumConflict({ code: "ER_DUP_ENTRY", errno: 1062, message: "Duplicate entry 'abc' for key 'PRIMARY'", query: "INSERT INTO `file_blobs`(`checksum`) VALUES (?)" }), true);
    check("MySQL 5.7 其他表的主键冲突不被吞", isBlobChecksumConflict({ code: "ER_DUP_ENTRY", errno: 1062, message: "Duplicate entry 'abc' for key 'PRIMARY'", query: "INSERT INTO `files`(`id`) VALUES (?)" }), false);
    check("SQLite 其他表的唯一冲突不被吞", isBlobChecksumConflict({ code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: team_invites.code" }), false);
    check("非唯一冲突的错误不被吞", isBlobChecksumConflict(new Error("connection lost")), false);

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
