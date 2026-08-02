import "reflect-metadata";

import fs from "node:fs";

import Database from "better-sqlite3";
import { IsNull } from "typeorm";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 旧库升级专项验证：用旧版 schema 与旧数据建一个库，再跑一次真实启动流程。
 * 单独一个脚本而不是并进 verify-teams，是因为它必须在 initDatabase 之前把库做成旧样子，
 * 而 verify-teams 一开头就已经建好了新表。
 * 用法：cd server && npx tsx verify-upgrade.ts
 */
const env = prepareEnv("verify-upgrade");

/** 旧版 team_invites：code 是 `varchar NOT NULL DEFAULT ''`，没有唯一索引。 */
function createLegacyDatabase(file: string) {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE "team_invites" (
            "id" varchar(64) PRIMARY KEY NOT NULL,
            "teamId" varchar(255) NOT NULL DEFAULT '',
            "kind" varchar(16) NOT NULL DEFAULT 'link',
            "tokenHash" varchar(128) NOT NULL DEFAULT '',
            "tokenPrefix" varchar(32) NOT NULL DEFAULT '',
            "code" varchar(64) NOT NULL DEFAULT '',
            "role" varchar(32) NOT NULL DEFAULT 'member',
            "maxUses" integer NOT NULL DEFAULT 0,
            "usedCount" integer NOT NULL DEFAULT 0,
            "enabled" boolean NOT NULL DEFAULT 1,
            "expiresAt" varchar(255) NOT NULL DEFAULT '',
            "createdBy" varchar(255) NOT NULL DEFAULT '',
            "note" varchar(255) NOT NULL DEFAULT '',
            "createdAt" varchar(255) NOT NULL DEFAULT ''
        );
        CREATE INDEX "IDX_legacy_team_invites_team" ON "team_invites" ("teamId");
        CREATE INDEX "IDX_legacy_team_invites_token" ON "team_invites" ("tokenHash");
    `);
    const insert = db.prepare(`INSERT INTO "team_invites" ("id","teamId","kind","tokenHash","tokenPrefix","code","role","maxUses","usedCount","enabled","expiresAt","createdBy","note","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // 三条链接邀请，code 全是空串：旧版的常态，也正是让唯一索引建不出来的那批数据。
    insert.run("legacy-link-1", "team-1", "link", "hash-1", "abcd", "", "member", 0, 2, 1, "", "user-owner", "", "2026-01-01T00:00:00.000Z");
    insert.run("legacy-link-2", "team-1", "link", "hash-2", "efgh", "", "viewer", 5, 0, 1, "2030-01-01T00:00:00+08:00", "user-owner", "带时区", "2026-01-02T00:00:00.000Z");
    insert.run("legacy-link-3", "team-2", "link", "hash-3", "ijkl", "", "admin", 0, 0, 0, "", "user-owner", "", "2026-01-03T00:00:00.000Z");
    // 旧版没有唯一约束，于是允许两条邀请共用一个手输码。按码查询本来就只会命中其中一条。
    insert.run("legacy-code-1", "team-1", "code", "", "", "SAMECODE12", "member", 1, 0, 1, "", "user-owner", "先来的", "2026-01-04T00:00:00.000Z");
    insert.run("legacy-code-2", "team-1", "code", "", "", "SAMECODE12", "member", 1, 0, 1, "", "user-owner", "后来的", "2026-01-05T00:00:00.000Z");
    // 小写码：旧版某些入口没做归一化，升级时要一起拉回大写，否则按码查永远查不到。
    insert.run("legacy-code-3", "team-2", "code", "", "", "lowercase9", "member", 1, 0, 1, "", "user-owner", "", "2026-01-06T00:00:00.000Z");
    // 完全解析不了的过期时间：旧库某些入口把用户原样输入的文字写了进去。
    insert.run("legacy-broken", "team-2", "link", "hash-broken", "mnop", "", "member", 0, 0, 1, "明天", "user-owner", "", "2026-01-07T00:00:00.000Z");
    db.close();
}

/** 旧结构的 team_invites，行由调用方决定。用于构造「上次升级中断」的两种断点。 */
const LEGACY_COLUMNS = `"id","teamId","kind","tokenHash","tokenPrefix","code","role","maxUses","usedCount","enabled","expiresAt","createdBy","note","createdAt"`;
const LEGACY_SCHEMA = `
    "id" varchar(64) PRIMARY KEY NOT NULL,
    "teamId" varchar(255) NOT NULL DEFAULT '',
    "kind" varchar(16) NOT NULL DEFAULT 'link',
    "tokenHash" varchar(128) NOT NULL DEFAULT '',
    "tokenPrefix" varchar(32) NOT NULL DEFAULT '',
    "code" varchar(64) NOT NULL DEFAULT '',
    "role" varchar(32) NOT NULL DEFAULT 'member',
    "maxUses" integer NOT NULL DEFAULT 0,
    "usedCount" integer NOT NULL DEFAULT 0,
    "enabled" boolean NOT NULL DEFAULT 1,
    "expiresAt" varchar(255) NOT NULL DEFAULT '',
    "createdBy" varchar(255) NOT NULL DEFAULT '',
    "note" varchar(255) NOT NULL DEFAULT '',
    "createdAt" varchar(255) NOT NULL DEFAULT ''
`;
type LegacyRow = [string, string, string, string, string, string, string, number, number, number, string, string, string, string];
const legacyRow = (id: string, code: string, expiresAt = ""): LegacyRow => [id, "team-1", code ? "code" : "link", code ? "" : `hash-${id}`, "", code, "member", 1, 0, 1, expiresAt, "user-owner", "", `2026-02-01T00:00:0${id.length % 10}.000Z`];

/** 重建库文件：删掉旧文件，按给定的建表/填数逻辑重来一次。config 已经钉死在同一个路径上。 */
function rebuild(file: string, build: (db: Database.Database) => void) {
    fs.rmSync(file, { force: true });
    const db = new Database(file);
    build(db);
    db.close();
}

function fillLegacy(db: Database.Database, table: string, rows: LegacyRow[]) {
    db.exec(`CREATE TABLE "${table}" (${LEGACY_SCHEMA});`);
    const insert = db.prepare(`INSERT INTO "${table}" (${LEGACY_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) insert.run(...row);
}

async function main() {
    const { check, rejects, finish } = createChecker();
    createLegacyDatabase(env.dbFile);

    const { initDatabase, repo } = await import("./src/db/data-source");
    const { TeamInvite } = await import("./src/db/entities");
    const { newId, now } = await import("./src/lib/errors");

    console.log("旧 schema + 旧数据升级");
    // 不做兜底的话，这一步就是新版本第一次启动时的崩溃点：唯一索引建不出来，进程直接退出。
    await initDatabase();
    check("旧库升级后能正常启动", true, true);

    check("旧数据一条不少", await repo(TeamInvite).count(), 7);
    const links = await repo(TeamInvite).findBy({ kind: "link" });
    check("链接类邀请的 code 全部归一化为 NULL", links.every((invite) => invite.code === null), true);
    check("链接邀请的已用次数保留", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-link-1" })).usedCount, 2);
    check("链接邀请的停用状态保留", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-link-3" })).enabled, false);
    check("链接邀请的 tokenHash 保留", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-link-2" })).tokenHash, "hash-2");

    // 带偏移的过期时间必须归一化：不归一化的话，并发领取那条按字符串比大小的 UPDATE
    // 会和 Date.parse 的判定分家，同一张邀请在两条路径上给出相反的结论。
    check("带时区的过期时间归一化为 UTC ISO", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-link-2" })).expiresAt, new Date("2030-01-01T00:00:00+08:00").toISOString());

    // 撞码的两条：先创建的那条保住码，后来的那条降级成「没有码且已停用」——
    // 它按码本来就查不到，留着继续「存在但查不到」比明确停用更难排查。
    check("撞码时最早的一条保留手输码", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-code-1" })).code, "SAMECODE12");
    check("撞码时后来的一条清空手输码", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-code-2" })).code, null);
    check("撞码时后来的一条被停用", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-code-2" })).enabled, false);
    check("小写手输码升级后归一化为大写", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-code-3" })).code, "LOWERCASE9");

    // 唯一索引真的建出来了才算升级成功：能再写一条空码（NULL）而写不进重复的手输码。
    const insertInvite = (id: string, code: string | null) =>
        repo(TeamInvite).insert({ id, teamId: "team-1", kind: code ? "code" : "link", tokenHash: `hash-${id}`, tokenPrefix: "", code, role: "member", maxUses: 1, usedCount: 0, enabled: true, expiresAt: "", createdBy: "user-owner", note: "", createdAt: now() });
    await insertInvite(newId("team-invite"), null);
    await insertInvite(newId("team-invite"), null);
    check("升级后仍可写入多条无码的链接邀请", await repo(TeamInvite).countBy({ code: IsNull() }), 7);
    await rejects("升级后重复手输码写不进库", () => insertInvite(newId("team-invite"), "SAMECODE12"));

    // 备份表必须在回填后删掉，留着的话下次启动会再回填一遍，直接撞主键。
    const { dataSource } = await import("./src/db/data-source");
    const leftover: unknown[] = await dataSource.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_invites_legacy_backup'`);
    check("回填后备份表已删除", leftover.length, 0);

    // 再启动一次（新库已经是新 schema）必须是无操作，不能重复搬数据。
    await dataSource.destroy();
    await initDatabase();
    check("已升级的库再次启动数据不变", await repo(TeamInvite).count(), 9);
    check("无法解析的过期时间被清空", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-broken" })).expiresAt, "");
    // 留着「明天」的话，assertUsable 的 Date.parse 得到 NaN，比较为假，于是它被当成永不过期照常放行。
    check("无法解析过期时间的邀请被停用", (await repo(TeamInvite).findOneByOrFail({ id: "legacy-broken" })).enabled, false);
    await dataSource.destroy();

    // ---- 断点一：CTAS 已完成、DROP 之前崩溃。备份表与旧表同时在库里。
    // 早退直接进回填的话，旧表还带着一堆空串 code，synchronize 建唯一索引照样失败，
    // 而且每次启动都失败——库永远升不上来。
    console.log("崩溃恢复：CTAS 之后、DROP 之前");
    rebuild(env.dbFile, (db) => {
        const rows: LegacyRow[] = [legacyRow("crash-a1", ""), legacyRow("crash-a2", ""), legacyRow("crash-a3", "DUPCODE001")];
        fillLegacy(db, "team_invites", rows);
        fillLegacy(db, "team_invites_legacy_backup", rows);
    });
    await initDatabase();
    check("DROP 前崩溃后仍能启动", true, true);
    check("DROP 前崩溃后数据完整", await repo(TeamInvite).count(), 3);
    check("DROP 前崩溃后链接码归一化为 NULL", await repo(TeamInvite).countBy({ code: IsNull() }), 2);
    check("DROP 前崩溃后手输码保留", (await repo(TeamInvite).findOneByOrFail({ id: "crash-a3" })).code, "DUPCODE001");
    check("DROP 前崩溃恢复后备份表已删除", ((await dataSource.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_invites_legacy_backup'`)) as unknown[]).length, 0);
    await dataSource.destroy();

    // ---- 断点二：回填写到一半崩溃。新表已经是新结构且落了前几行，备份表还在。
    // 逐行 insert 会在第一条已写入的行上撞主键，整个启动流程再次中断，并且每次都停在同一行。
    console.log("崩溃恢复：回填写到一半");
    rebuild(env.dbFile, (db) => fillLegacy(db, "team_invites", [legacyRow("crash-b1", ""), legacyRow("crash-b2", "HALFCODE01"), legacyRow("crash-b3", "")]));
    await initDatabase();
    await dataSource.destroy();
    {
        const db = new Database(env.dbFile);
        // 备份表 = 完整的三行旧数据；新表里只留下已经回填成功的第一行（code 已归一化成 NULL）。
        fillLegacy(db, "team_invites_legacy_backup", [legacyRow("crash-b1", ""), legacyRow("crash-b2", "HALFCODE01"), legacyRow("crash-b3", "")]);
        db.exec(`DELETE FROM "team_invites" WHERE "id" <> 'crash-b1'`);
        // 已写入的那行还要能被更新覆盖，不能因为「已存在」就被跳过而留下半截状态。
        db.prepare(`UPDATE "team_invites" SET "note" = ? WHERE "id" = ?`).run("回填中途的旧值", "crash-b1");
        db.close();
    }
    await initDatabase();
    check("回填中断后仍能启动", true, true);
    check("回填中断后三行都在", await repo(TeamInvite).count(), 3);
    check("已写入的行被覆盖而不是跳过", (await repo(TeamInvite).findOneByOrFail({ id: "crash-b1" })).note, "");
    check("回填中断后剩余行补齐", (await repo(TeamInvite).findOneByOrFail({ id: "crash-b2" })).code, "HALFCODE01");
    check("回填中断恢复后备份表已删除", ((await dataSource.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_invites_legacy_backup'`)) as unknown[]).length, 0);

    // ---- 主键冲突不能被当成「码空间耗尽」：换八次码仍然撞的是 id，报「邀请码生成失败」等于把真故障藏起来。
    console.log("主键冲突与码冲突的区分");
    const { insertWithUniqueCode } = await import("./src/services/team-invites");
    const fixedId = "pk-clash";
    await repo(TeamInvite).insert({ id: fixedId, teamId: "team-1", kind: "code", tokenHash: "", tokenPrefix: "", code: "PKCLASH001", role: "member", maxUses: 1, usedCount: 0, enabled: true, expiresAt: "", createdBy: "user-owner", note: "", createdAt: now() });
    let tries = 0;
    let raised: unknown;
    await insertWithUniqueCode(
        () => `PK${String(tries).padStart(8, "0")}`,
        async (code: string) => {
            tries += 1;
            await repo(TeamInvite).insert({ id: fixedId, teamId: "team-1", kind: "code", tokenHash: "", tokenPrefix: "", code, role: "member", maxUses: 1, usedCount: 0, enabled: true, expiresAt: "", createdBy: "user-owner", note: "", createdAt: now() });
        },
    ).catch((error) => {
        raised = error;
    });
    check("主键冲突不重试", tries, 1);
    check("主键冲突原样抛出而不是报码耗尽", (raised as { code?: string })?.code === "TEAM_INVITE_CODE_EXHAUSTED", false);

    finish(env.root);
}

void main();
