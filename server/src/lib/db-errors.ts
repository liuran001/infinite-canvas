/**
 * 驱动错误的判定规则。放在 lib 而不是某个 service：files 与 team-invites 都要用它，
 * 从 services 互相 import 会把 data-source 拖成环。
 *
 * TypeORM 把 driverError 的自有属性一并复制到 QueryFailedError 上，并额外挂了失败的 SQL（query），
 * 所以下面这些字段在包装后的错误和原始驱动错误上都可能出现，取值时两处都要看。
 */
type ErrorCarrier = {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
    sqlMessage?: unknown;
    table?: unknown;
    detail?: unknown;
    constraint?: unknown;
    query?: unknown;
    driverError?: ErrorCarrier;
};

/** 同一个字段先看错误本身，再看包在里面的 driverError。 */
function field(error: unknown, key: keyof ErrorCarrier) {
    const carrier = error as ErrorCarrier | null;
    return String(carrier?.[key] ?? carrier?.driverError?.[key] ?? "");
}

function errorText(error: unknown) {
    return [field(error, "message"), field(error, "sqlMessage"), field(error, "constraint"), field(error, "detail")].join(" ");
}

/** 三种驱动报唯一冲突的方式各不相同，这里按各自的稳定标识判断，不去猜中文/英文错误文案。 */
export function isUniqueViolation(error: unknown) {
    const carrier = error as ErrorCarrier | null;
    const code = String(carrier?.driverError?.code ?? carrier?.code ?? "");
    // SQLite: SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT；MySQL: ER_DUP_ENTRY(1062)；Postgres: 23505。
    return code.startsWith("SQLITE_CONSTRAINT") || code === "ER_DUP_ENTRY" || String(carrier?.errno ?? carrier?.driverError?.errno ?? "") === "1062" || code === "23505";
}

/**
 * 冲突的是不是 team_invites.code 这条唯一约束。
 * 只判断「是唯一冲突」是不够的：同一条 INSERT 也可能撞主键 id，
 * 那种情况换个码重试八次仍然会撞，最后被伪装成一条「邀请码生成失败」，
 * 把「id 生成重复」这个真正的故障彻底掩埋。
 *
 * 这条约束能靠名字认出来，因为它在实体上是显式命名的（`uq_team_invites_code`）：
 * SQLite 的文案是 `team_invites.code`，MySQL 是 `for key 'uq_team_invites_code'`，Postgres 的 constraint 字段同名。
 * 主键则相反——TypeORM 生成的主键约束叫 `PK_<hash>`，名字里既没有表名也没有列名，
 * 于是主键冲突在这里一律匹配不上而被原样抛出，正是想要的结果。
 */
export function isInviteCodeUniqueViolation(error: unknown) {
    if (!isUniqueViolation(error)) return false;
    const text = errorText(error);
    return /uq_team_invites_code/i.test(text) || /team_invites\.code\b/i.test(text);
}

const BLOB_TABLE = "file_blobs";

const REFUND_TABLES = ["credit_logs", "team_credit_logs"];

/**
 * 冲突的是不是流水表上的 refundOf 唯一约束——也就是「这笔扣费已经退过了」。
 * 只判断「是唯一冲突」远远不够：同一条 INSERT 也可能撞主键 id，那是 ID 生成出了问题，
 * 一旦被当成「已经退过」，这笔钱就再也没人退了，而且现场干干净净什么都查不到。
 *
 * 约束在实体上是显式命名的（`uq_credit_logs_refund_of` / `uq_team_credit_logs_refund_of`），
 * 所以 MySQL 的 `for key '...'`、Postgres 的 constraint 字段都能直接认出来；
 * SQLite 的文案里没有索引名，给的是 `表名.列名`；
 * Postgres 另有一条结构化的 table + detail(`Key ("refundOf")=(...) already exists.`)。
 * 主键冲突在这三条路径上都匹配不上：TypeORM 生成的主键约束叫 `PK_<hash>`，
 * SQLite 报的是 `credit_logs.id`，Postgres 的 detail 里写的是 `Key (id)=`。
 */
export function isRefundOfUniqueViolation(error: unknown) {
    if (!isUniqueViolation(error)) return false;
    const text = errorText(error);
    if (/uq_(?:team_)?credit_logs_refund_of/i.test(text)) return true;
    if (/\b(?:team_)?credit_logs\.refundOf\b/i.test(text)) return true;
    const table = field(error, "table").toLowerCase();
    if (!table || !REFUND_TABLES.includes(table)) return false;
    return /\(\s*"?refundOf"?\s*\)/i.test(field(error, "detail"));
}

/**
 * 冲突的是不是 file_blobs 的主键（checksum）。
 * 并发首传时输家会撞这条约束，那是可以吞的；而列长度、连接断开这些必须原样抛，
 * 否则紧接着的 findOneByOrFail 会把真实故障翻译成一条毫无线索的「找不到记录」。
 *
 * 主键约束认不了名字：TypeORM 给它生成的名字是 `PK_<hash>`，Postgres 的 constraint 字段拿到的就是这串
 * 哈希，message 里同样只有它——按名字匹配的写法在 Postgres 上永远返回 false，
 * 于是并发首传的输家直接把 500 抛给用户。所以这里改成认「表 + 列」这组身份：
 *   Postgres：错误对象带结构化的 table 与 detail（`Key (checksum)=(...) already exists.`）；
 *   SQLite：文案里就是 `file_blobs.checksum`（varchar 主键在 SQLite 里本就是一条唯一索引）；
 *   MySQL：`for key 'file_blobs.PRIMARY'`(8.0) 或 `for key 'PRIMARY'`(5.7)，5.7 的文案里没有表名，
 *          只能从 TypeORM 保存的失败 SQL 里认——那条 INSERT 的目标表就写在里面。
 * 三条路径都要求表名对得上，所以别的表的唯一冲突不会被这里吞掉。
 */
export function isBlobChecksumConflict(error: unknown) {
    if (!isUniqueViolation(error)) return false;
    const table = field(error, "table");
    if (table) {
        if (table.toLowerCase() !== BLOB_TABLE) return false;
        // detail 缺失时（服务端没下发）只能凭表名判断：这张表眼下只有 checksum 一条唯一约束。
        // 将来若加了第二条，带 detail 的错误会因为列名对不上而原样抛出——宁可多抛也不要吞错。
        const detail = field(error, "detail");
        return !detail || /\(\s*checksum\s*\)/i.test(detail);
    }
    const text = errorText(error);
    if (/file_blobs\.checksum\b/i.test(text)) return true;
    if (!/for key '(?:file_blobs\.)?primary'/i.test(text)) return false;
    return new RegExp(`\\b${BLOB_TABLE}\\b`, "i").test(`${text} ${field(error, "query")}`);
}
