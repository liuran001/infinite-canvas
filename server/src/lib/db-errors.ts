/**
 * 驱动错误的判定规则。放在 lib 而不是某个 service：files 与 team-invites 都要用它，
 * 从 services 互相 import 会把 data-source 拖成环。
 */

function errorText(error: unknown) {
    const carrier = error as { message?: unknown; constraint?: unknown; driverError?: { message?: unknown; constraint?: unknown } } | null;
    return [carrier?.message, carrier?.constraint, carrier?.driverError?.message, carrier?.driverError?.constraint].map((part) => String(part ?? "")).join(" ");
}

/** 三种驱动报唯一冲突的方式各不相同，这里按各自的稳定标识判断，不去猜中文/英文错误文案。 */
export function isUniqueViolation(error: unknown) {
    const carrier = error as { code?: unknown; errno?: unknown; driverError?: { code?: unknown } } | null;
    const code = String(carrier?.driverError?.code ?? carrier?.code ?? "");
    // SQLite: SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT；MySQL: ER_DUP_ENTRY(1062)；Postgres: 23505。
    return code.startsWith("SQLITE_CONSTRAINT") || code === "ER_DUP_ENTRY" || String(carrier?.errno ?? "") === "1062" || code === "23505";
}

/**
 * 冲突的是不是 team_invites.code 这条唯一约束。
 * 只判断「是唯一冲突」是不够的：同一条 INSERT 也可能撞主键 id，
 * 那种情况换个码重试八次仍然会撞，最后被伪装成一条「邀请码生成失败」，
 * 把「id 生成重复」这个真正的故障彻底掩埋。三种驱动的报错文案里都带得出约束身份：
 * SQLite 是 `team_invites.code`，MySQL 是 `for key 'uq_team_invites_code'`，Postgres 的 constraint 字段同名。
 */
export function isInviteCodeUniqueViolation(error: unknown) {
    if (!isUniqueViolation(error)) return false;
    const text = errorText(error);
    return /uq_team_invites_code/i.test(text) || /team_invites\.code\b/i.test(text);
}

/**
 * 冲突的是不是 file_blobs 的主键（checksum）。
 * 并发首传时输家会撞这条约束，那是可以吞的；而列长度、连接断开这些必须原样抛，
 * 否则紧接着的 findOneByOrFail 会把真实故障翻译成一条毫无线索的「找不到记录」。
 */
export function isBlobChecksumConflict(error: unknown) {
    if (!isUniqueViolation(error)) return false;
    const text = errorText(error);
    return /file_blobs/i.test(text) || /\bPRIMARY\b/i.test(text);
}
