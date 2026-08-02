import { fail } from "./errors";

/**
 * 非负整数入参校验。写成公共函数而不是各处 `Math.max(0, Math.floor(Number(x) || 0))`：
 * 那个写法把 "abc"、NaN、Infinity、null 一律折成 0，于是一次拼错字段名的请求会被当成
 * 「管理员要求把额度改成 0」照单执行，事后从流水里也看不出它本来想改成多少。
 * 上界不是防御性的余量而是必需的：DB 上是 int 列，超出后写入会被静默截断成一个谁也解释不了的数。
 * 传 undefined 表示「这次不改」，直接返回原值。
 */
export function nonNegativeInteger(value: unknown, fallback: number, max: number, message: string, code: string) {
    if (value === undefined) return fallback;
    const parsed = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw fail(message, 400, code);
    return parsed;
}
