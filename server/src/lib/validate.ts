import { fail } from "./errors";

/** 纯十进制数字串。允许前导零（"007"），不允许正负号、小数点、下划线、进制前缀与科学计数。 */
const DECIMAL_DIGITS = /^[0-9]+$/;

/**
 * 非负整数入参校验。写成公共函数而不是各处 `Math.max(0, Math.floor(Number(x) || 0))`：
 * 那个写法把 "abc"、NaN、Infinity、null 一律折成 0，于是一次拼错字段名的请求会被当成
 * 「管理员要求把额度改成 0」照单执行，事后从流水里也看不出它本来想改成多少。
 *
 * 判定刻意不走 `Number(...)`，而是先按类型分流、字符串再过正则。`Number()` 在这里全是陷阱：
 * `Number("")`、`Number("   ")`、`Number([])`、`Number(false)` 都是 0——也就是「清零」，
 * 而这几个值的真实含义是「这个字段根本没填」；`Number("0x10")` 是 16、`Number("1e2")` 是 100，
 * 用户以为自己写的是十进制，落库的却是另一个数量级。这些都不该由本函数替调用方猜测。
 *
 * 上界不是防御性的余量而是必需的：DB 上是 int 列，超出后写入会被静默截断成一个谁也解释不了的数。
 * 传 undefined 表示「这次不改」，直接返回原值——只有它是「没传」，空串和空数组都不是。
 */
export function nonNegativeInteger(value: unknown, fallback: number, max: number, message: string, code: string) {
    if (value === undefined) return fallback;
    // 字符串分支存在只是因为表单与 query 天然只会送字符串来；它必须是纯十进制，不接受任何等价写法。
    const parsed = typeof value === "string" && DECIMAL_DIGITS.test(value.trim()) ? Number(value.trim()) : value;
    // boolean 会被 Number.isInteger 之外的判断放过，这里靠 typeof 挡住：true 不是 1。
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw fail(message, 400, code);
    // -0 归一成 0：库里两者没有区别，但它会顺着写进流水与返回值，留一个没人解释得清的负零。
    return parsed === 0 ? 0 : parsed;
}
