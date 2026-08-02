import type { DataSource, QueryRunner } from "typeorm";

// 码值规则来自 lib 而不是 services/invites：后者会把 data-source 拖回来，形成循环导入。
import { normalizeInviteCode } from "../lib/invite-code";
import { TeamInvite } from "./entities";

/**
 * 旧库升级。项目没有 migration 目录，建表全靠 `synchronize: true`，
 * 于是「改一列的约束」这件事必须自己兜住存量数据，否则新版本第一次启动就会在
 * synchronize 里抛错然后进程退出——线上表现是升级后服务根本起不来。
 *
 * 当前唯一需要兜的改动：TeamInvite.code 从 `NOT NULL DEFAULT ''` 改成 `nullable + unique`。
 * 旧库里每一条链接类邀请的 code 都是空串，只要存在两条，唯一索引就建不出来；
 * 旧库还允许两条手输码撞在一起（当时没有唯一约束），同样会把索引卡住。
 *
 * 做法是「重建 + 回填」而不是各方言各写一套 ALTER：
 *   1. 初始化之前用 `CREATE TABLE ... AS SELECT` 把旧数据整表复制进备份表，然后把旧表整个删掉；
 *   2. synchronize 于是在一张干净的表上建出正确的列与唯一索引；
 *   3. 初始化之后把备份表的数据归一化后写回，最后才删备份表。
 *
 * 用 CTAS 复制而不是 `RENAME TABLE`，是因为改名只改表名：索引与主键约束的名字仍留在库里，
 * 而 SQLite 与 Postgres 的索引/约束名是库级唯一的，synchronize 建新表时会直接撞上同名对象。
 * CTAS 出来的备份表不带任何索引与约束，三种方言的行为一致，不必各写一套善后。
 *
 * 中途崩溃不会丢数据：备份表一直在库里，下次启动检测到它就继续第 3 步。
 */
const TABLE = "team_invites";
const BACKUP = "team_invites_legacy_backup";

/**
 * 过期时间的规范形式：UTC ISO。
 * 存 `2026-08-04T00:00:00+08:00` 这种带偏移的字符串时，它与 `...Z` 的字典序和真实先后无关，
 * 而并发领取那条 UPDATE 是按字符串比大小的，于是同一张邀请会出现
 * 「单条路径说已过期、并发路径说还能领」的分裂。返回 null 表示这个值根本解析不了。
 */
export function canonicalExpiresAt(value: unknown) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return null;
    return new Date(at).toISOString();
}

function quote(source: DataSource, name: string) {
    return source.driver.escape(name);
}

/** 只有真的会把唯一索引卡住的数据才值得重建：空串 code 多于一条，或存在重复的非空 code。 */
async function blocksUniqueIndex(source: DataSource, runner: QueryRunner) {
    const code = quote(source, "code");
    const empties: Array<{ total: number | string }> = await runner.query(`SELECT COUNT(*) AS total FROM ${quote(source, TABLE)} WHERE ${code} = ''`);
    if (Number(empties[0]?.total || 0) > 1) return true;
    const duplicated: unknown[] = await runner.query(`SELECT ${code} FROM ${quote(source, TABLE)} WHERE ${code} IS NOT NULL AND ${code} <> '' GROUP BY ${code} HAVING COUNT(*) > 1`);
    return duplicated.length > 0;
}

/**
 * 初始化之前跑：需要重建时把旧表复制成备份表再删掉，返回是否还有待回填的数据。
 * 传入的 DataSource 必须是 `synchronize: false` 的检查用连接——用正式连接的话建表已经先发生了。
 */
export async function prepareTeamInviteUpgrade(source: DataSource) {
    const runner = source.createQueryRunner();
    try {
        await runner.connect();
        const hasBackup = await runner.hasTable(BACKUP);
        const hasTable = await runner.hasTable(TABLE);
        if (hasBackup) {
            // 备份表还在，说明上一次升级写到一半被打断。断点有两种，必须分清：
            //   a) CTAS 完成、DROP 之前崩溃 —— 原表仍是旧结构旧数据，留着它 synchronize 照样建不出唯一索引，
            //      于是新版本这一次启动仍然起不来，而且永远卡在这里；必须把它删掉。
            //   b) 回填写到一半崩溃 —— 此时的原表已经是新结构，里面是回填出来的行，删掉就是真丢数据。
            // 判据就是 blocksUniqueIndex 本身：旧表当初正是因为它为真才走到重建，现在仍然为真；
            // 而新表的链接类邀请存的是 NULL、手输码上带唯一索引，不可能为真。
            if (hasTable && (await blocksUniqueIndex(source, runner))) {
                await runner.query(`DROP TABLE ${quote(source, TABLE)}`);
                console.warn(`[upgrade] 上次升级在删表前中断，已删除残留的旧 ${TABLE}。`);
            }
            return true;
        }
        if (!hasTable) return false;
        if (!(await blocksUniqueIndex(source, runner))) return false;
        // CTAS 三种方言写法一致，且复制出来的备份表不带索引与约束，正好是我们要的。
        await runner.query(`CREATE TABLE ${quote(source, BACKUP)} AS SELECT * FROM ${quote(source, TABLE)}`);
        await runner.query(`DROP TABLE ${quote(source, TABLE)}`);
        console.warn(`[upgrade] 旧版 ${TABLE} 已备份为 ${BACKUP}，建表后将归一化回填。`);
        return true;
    } finally {
        await runner.release();
    }
}

/**
 * 回填。整个过程必须可以从任意一行中断处重跑：备份表要等最后一行落库才删，
 * 所以「写到一半崩溃再启动」是常态而不是意外——按 id 先查后写（存在就 update，不存在才 insert），
 * 三种方言都只用普通 SELECT/UPDATE/INSERT，不依赖各写一套的 upsert 语法。
 * 归一化结果只由备份表内容决定，因此重跑一遍得到的是同一批值，重复执行不会漂移。
 */
async function restoreLegacyInvites(source: DataSource) {
    const runner = source.createQueryRunner();
    let rows: Array<Record<string, unknown>>;
    try {
        await runner.connect();
        if (!(await runner.hasTable(BACKUP))) return;
        rows = await runner.query(`SELECT * FROM ${quote(source, BACKUP)}`);
    } finally {
        await runner.release();
    }
    // 手输码的归一化规则只此一份，与运行时写入共用同一个 lib 函数。
    const invites = source.getRepository(TeamInvite);
    const existing = await invites.find({ select: { id: true, code: true } });
    const backupIds = new Set(rows.map((row) => String(row.id)));
    const known = new Map(existing.map((invite) => [invite.id, invite]));
    // 表里那些不来自备份的行（正常写入的新邀请）已经占住了自己的码，
    // 后面回填时撞上它就得按「撞码」处理，否则这一条 insert 会撞唯一索引把整个启动流程再打断一次。
    const seen = new Set(existing.filter((invite) => invite.code && !backupIds.has(invite.id)).map((invite) => String(invite.code)));
    const ordered = [...rows].sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || String(left.id).localeCompare(String(right.id)));
    for (const row of ordered) {
        const id = String(row.id);
        const code = normalizeInviteCode(String(row.code || ""));
        // 旧库允许两条邀请共用一个码，按码查询本来就只会命中其中一条，另一条的领取路径早已是死的。
        // 保留最早的一条，后来的降级成「没有码且已停用」——不能悄悄让它继续存在却查不到。
        const duplicated = Boolean(code) && seen.has(code);
        if (code && !duplicated) seen.add(code);
        if (duplicated) console.warn(`[upgrade] 邀请 ${id} 与更早的邀请共用手输码 ${code}，已停用并清空该码。`);
        const expiresAt = canonicalExpiresAt(row.expiresAt);
        // 解析不了的过期时间不能原样保留：留着它，assertUsable 会把 NaN 判成「没过期」而放行，
        // 于是一个本该被当作坏数据的值变成了一张永久有效的邀请。停用 + 清空是唯一安全的读法——
        // 管理员仍然能看到这条邀请并自己决定重开，而不是在不知情的情况下继续被领取。
        if (expiresAt === null) console.warn(`[upgrade] 邀请 ${id} 的过期时间 ${String(row.expiresAt)} 无法解析，已停用并清空该字段。`);
        const payload = {
            teamId: String(row.teamId || ""),
            kind: (row.kind === "code" ? "code" : "link") as TeamInvite["kind"],
            tokenHash: String(row.tokenHash || ""),
            tokenPrefix: String(row.tokenPrefix || ""),
            // 链接类邀请在新表里存 NULL：空串会互相冲突，唯一约束与「链接不占码」只有 NULL 能同时成立。
            code: code && !duplicated ? code : null,
            role: String(row.role || "member") as TeamInvite["role"],
            maxUses: Number(row.maxUses || 0),
            usedCount: Number(row.usedCount || 0),
            enabled: duplicated || expiresAt === null ? false : Boolean(row.enabled),
            expiresAt: expiresAt ?? "",
            createdBy: String(row.createdBy || ""),
            note: String(row.note || ""),
            createdAt: String(row.createdAt || ""),
        };
        if (known.has(id)) await invites.update({ id }, payload);
        else await invites.insert({ id, ...payload });
    }
    await source.query(`DROP TABLE ${quote(source, BACKUP)}`);
    console.warn(`[upgrade] ${rows.length} 条旧邀请已回填，${BACKUP} 已删除。`);
}

/** 存量的带时区过期时间就地归一化。与是否重建无关，所以每次启动都跑一遍；已经是规范形式的行不会被写。 */
async function normalizeStoredExpiresAt(source: DataSource) {
    const invites = source.getRepository(TeamInvite);
    const rows = await invites.createQueryBuilder("invite").select(["invite.id", "invite.expiresAt"]).where(`invite.expiresAt <> ''`).getMany();
    for (const row of rows) {
        const canonical = canonicalExpiresAt(row.expiresAt);
        if (canonical === row.expiresAt) continue;
        // 解析不了的值不能留着：assertUsable 走 Date.parse 会得到 NaN 并判成「没过期」，
        // 于是坏数据静默变成一张永不过期的邀请。停用 + 清空让它可见且不可领。
        if (canonical === null) {
            console.warn(`[upgrade] 邀请 ${row.id} 的过期时间 ${row.expiresAt} 无法解析，已停用并清空该字段。`);
            await invites.update({ id: row.id }, { expiresAt: "", enabled: false });
            continue;
        }
        await invites.update({ id: row.id }, { expiresAt: canonical });
    }
}

/** 初始化之后跑：回填备份数据并归一化过期时间。 */
export async function finishTeamInviteUpgrade(source: DataSource, pending: boolean) {
    if (pending) await restoreLegacyInvites(source);
    await normalizeStoredExpiresAt(source);
}
