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
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits: 0, storageQuota: quota, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });

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

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
