import "reflect-metadata";

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
    db.close();
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

    check("旧数据一条不少", await repo(TeamInvite).count(), 6);
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
    check("升级后仍可写入多条无码的链接邀请", await repo(TeamInvite).countBy({ code: IsNull() }), 6);
    await rejects("升级后重复手输码写不进库", () => insertInvite(newId("team-invite"), "SAMECODE12"));

    // 备份表必须在回填后删掉，留着的话下次启动会再回填一遍，直接撞主键。
    const { dataSource } = await import("./src/db/data-source");
    const leftover: unknown[] = await dataSource.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_invites_legacy_backup'`);
    check("回填后备份表已删除", leftover.length, 0);

    // 再启动一次（新库已经是新 schema）必须是无操作，不能重复搬数据。
    await dataSource.destroy();
    await initDatabase();
    check("已升级的库再次启动数据不变", await repo(TeamInvite).count(), 8);

    finish(env.root);
}

void main();
