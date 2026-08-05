import "reflect-metadata";

import { createHash } from "node:crypto";

import { createChecker, objectExists, prepareEnv, removeObject, writeObject } from "./verify-common";

/**
 * 旧库升级验证：构造只有旧版 files 表的 SQLite，跑真实 initDatabase() + migratePhysicalBlobs()，
 * 断言 fileId 原样保留、跨用户同 checksum 只留一个物理对象、refCount 正确、重复执行幂等。
 * 用法：cd server && npx tsx verify-file-migration.ts
 *
 * 业务模块一律 await import：config 在模块加载时就把环境变量读死了，静态 import 会被提升到
 * prepareEnv() 之前执行，脚本就会连到真实数据目录。
 */
const env = prepareEnv("verify-file-migration");

const sharedBody = Buffer.from("shared-content-across-users");
const soloBody = Buffer.from("solo-content");
const fallbackBody = Buffer.from("first-candidate-is-broken");
const sharedChecksum = createHash("sha256").update(sharedBody).digest("hex");
const soloChecksum = createHash("sha256").update(soloBody).digest("hex");
const fallbackChecksum = createHash("sha256").update(fallbackBody).digest("hex");

// 旧版 files 表：本批没有改动它的列，因此按上一版 DDL 建表，file_blobs 完全不存在，交给 synchronize 建。
const OLD_FILES_DDL = `CREATE TABLE "files" (
    "id" varchar(64) PRIMARY KEY NOT NULL,
    "userId" varchar(255) NOT NULL DEFAULT (''),
    "kind" varchar(32) NOT NULL DEFAULT ('image'),
    "mimeType" varchar(128) NOT NULL DEFAULT ('application/octet-stream'),
    "bytes" bigint NOT NULL DEFAULT (0),
    "width" integer NOT NULL DEFAULT (0),
    "height" integer NOT NULL DEFAULT (0),
    "durationMs" integer NOT NULL DEFAULT (0),
    "storage" varchar(16) NOT NULL DEFAULT ('local'),
    "path" varchar(512) NOT NULL DEFAULT (''),
    "checksum" varchar(128) NOT NULL DEFAULT (''),
    "createdAt" varchar(255) NOT NULL DEFAULT ('')
)`;

type OldRow = { id: string; userId: string; path: string; checksum: string; bytes: number; createdAt: string };
const rows: OldRow[] = [
    { id: "file-a", userId: "user-a", path: "2025/01/a.bin", checksum: sharedChecksum, bytes: sharedBody.length, createdAt: "2025-01-01T00:00:00.000Z" },
    { id: "file-b", userId: "user-b", path: "2025/01/b.bin", checksum: sharedChecksum, bytes: sharedBody.length, createdAt: "2025-01-02T00:00:00.000Z" },
    { id: "file-c", userId: "user-a", path: "2025/01/c.bin", checksum: soloChecksum, bytes: soloBody.length, createdAt: "2025-01-03T00:00:00.000Z" },
    // 历史空 checksum 行：迁移必须回读对象重算，并归入 solo 组。
    { id: "file-d", userId: "user-c", path: "2025/01/d.bin", checksum: "", bytes: soloBody.length, createdAt: "2025-01-04T00:00:00.000Z" },
    // 同组第一条对象已丢失，迁移必须回退到同组下一条可读候选，而不是整体失败。
    { id: "file-e", userId: "user-d", path: "2025/01/missing-e.bin", checksum: fallbackChecksum, bytes: fallbackBody.length, createdAt: "2025-01-05T00:00:00.000Z" },
    { id: "file-f", userId: "user-e", path: "2025/01/f.bin", checksum: fallbackChecksum, bytes: fallbackBody.length, createdAt: "2025-01-06T00:00:00.000Z" },
];

async function seedLegacyDatabase() {
    writeObject(env.filesDir, "2025/01/a.bin", sharedBody);
    writeObject(env.filesDir, "2025/01/b.bin", sharedBody);
    writeObject(env.filesDir, "2025/01/c.bin", soloBody);
    writeObject(env.filesDir, "2025/01/d.bin", soloBody);
    writeObject(env.filesDir, "2025/01/f.bin", fallbackBody);
    // 迁移前就存在的 blob 指向这个对象：只允许补齐缺失字段，不允许改写 path/storage。
    writeObject(env.filesDir, "legacy/solo.bin", soloBody);

    const { default: Database } = await import("better-sqlite3");
    const seed = new Database(env.dbFile);
    seed.exec(OLD_FILES_DDL);
    const insert = seed.prepare(`INSERT INTO "files" ("id","userId","kind","mimeType","bytes","width","height","durationMs","storage","path","checksum","createdAt")
        VALUES (@id,@userId,'image','image/png',@bytes,0,0,0,'local',@path,@checksum,@createdAt)`);
    for (const row of rows) insert.run(row);
    seed.close();
}

async function main() {
    await seedLegacyDatabase();

    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { PhysicalBlob, StoredFile } = await import("./src/db/entities");
    const { migratePhysicalBlobs } = await import("./src/services/file-migration");

    await initDatabase();
    const files = repo(StoredFile);
    const blobs = repo(PhysicalBlob);
    // 半迁移状态：字段缺失、path 是历史 key，迁移必须补齐字段但保留 path。
    await blobs.insert({ checksum: soloChecksum, bytes: 0, kind: "other", mimeType: "", width: 0, height: 0, durationMs: 0, storage: "local", path: "legacy/solo.bin", refCount: 0, state: "active", pendingSince: "", createdAt: "" });

    await migratePhysicalBlobs();

    const allIds = async () => (await files.find({ order: { id: "ASC" } })).map((row) => row.id);

    console.log("首次迁移");
    check("旧文件行一条不少", await files.count(), rows.length);
    check("旧 fileId 原样保留", await allIds(), rows.map((row) => row.id));
    check("跨用户同 checksum 只建一个物理对象", await blobs.countBy({ checksum: sharedChecksum }), 1);
    check("跨用户同 checksum 的 refCount 为 2", (await blobs.findOneByOrFail({ checksum: sharedChecksum })).refCount, 2);
    check("物理对象保留最早候选的历史 path", (await blobs.findOneByOrFail({ checksum: sharedChecksum })).path, "2025/01/a.bin");
    check("空 checksum 行被回填", (await files.findOneByOrFail({ id: "file-d" })).checksum, soloChecksum);
    check("回填后并入同内容分组", (await blobs.findOneByOrFail({ checksum: soloChecksum })).refCount, 2);
    check("已存在 blob 的 path 不被覆盖", (await blobs.findOneByOrFail({ checksum: soloChecksum })).path, "legacy/solo.bin");
    check("已存在 blob 的缺失 mimeType 被补齐", (await blobs.findOneByOrFail({ checksum: soloChecksum })).mimeType, "image/png");
    check("已存在 blob 的缺失 bytes 被补齐", Number((await blobs.findOneByOrFail({ checksum: soloChecksum })).bytes), soloBody.length);
    check("首个候选不可读时回退到下一个可读候选", (await blobs.findOneByOrFail({ checksum: fallbackChecksum })).path, "2025/01/f.bin");
    check("回退分组 refCount 正确", (await blobs.findOneByOrFail({ checksum: fallbackChecksum })).refCount, 2);
    check("物理对象总数等于内容种类数", await blobs.count(), 3);
    check("全量校验后删除落选历史对象", objectExists(env.filesDir, "2025/01/b.bin"), false);
    check("已存在 blob 胜出时旧 files 路径也会回收", objectExists(env.filesDir, "2025/01/c.bin"), false);

    console.log("重复执行");
    await migratePhysicalBlobs();
    check("重复迁移后文件行数不变", await files.count(), rows.length);
    check("重复迁移后 fileId 不变", await allIds(), rows.map((row) => row.id));
    check("重复迁移后物理对象数不变", await blobs.count(), 3);
    check("重复迁移后 refCount 不累加", (await blobs.findOneByOrFail({ checksum: sharedChecksum })).refCount, 2);

    console.log("refCount 漂移与残留");
    await blobs.update({ checksum: sharedChecksum }, { refCount: 99, state: "pending_delete", pendingSince: "2025-01-01T00:00:00.000Z" });
    await migratePhysicalBlobs();
    check("漂移的 refCount 被绝对重算", (await blobs.findOneByOrFail({ checksum: sharedChecksum })).refCount, 2);
    check("仍有引用的 blob 被恢复为 active", (await blobs.findOneByOrFail({ checksum: sharedChecksum })).state, "active");

    await files.delete({ id: "file-e" });
    await files.delete({ id: "file-f" });
    await migratePhysicalBlobs();
    check("没有引用的 blob 转入待回收", (await blobs.findOneByOrFail({ checksum: fallbackChecksum })).state, "pending_delete");
    check("待回收 blob 的 refCount 归零", (await blobs.findOneByOrFail({ checksum: fallbackChecksum })).refCount, 0);

    console.log("不可读历史对象");
    await files.insert({ id: "file-x", userId: "user-x", kind: "image", mimeType: "image/png", bytes: 3, width: 0, height: 0, durationMs: 0, storage: "local", path: "2025/01/never-written.bin", checksum: "", createdAt: "2025-02-01T00:00:00.000Z" });
    await rejects("空 checksum 且对象不可读时中止启动", () => migratePhysicalBlobs());
    check("中止后不静默删除问题行", await files.countBy({ id: "file-x" }), 1);
    await files.delete({ id: "file-x" });

    removeObject(env.filesDir, "2025/01/c.bin");
    removeObject(env.filesDir, "legacy/solo.bin");
    await blobs.delete({ checksum: soloChecksum });
    await files.delete({ id: "file-d" });
    await rejects("整组候选都不可读时中止启动", () => migratePhysicalBlobs());

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
