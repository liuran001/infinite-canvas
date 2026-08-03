import { randomInt } from "node:crypto";

/**
 * 邀请码的字母表与归一化规则。刻意放在 lib 而不是 services/invites：
 * 启动时的旧库升级也要用同一套规则，而 services 那层会连带把 data-source 拖进来，
 * 形成 data-source → upgrade → services → data-source 的循环。规则本身不需要数据库。
 *
 * 字母表去掉 0/O/1/I/L 这些形近字：邀请码是要人手抄手输的，
 * 留着它们的唯一结果就是用户反复输错然后来问「为什么说我的码无效」。
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
/**
 * 管理员自定义码值的长度区间。下限 4 是防「随手敲一个 A 就发出去」——那种码几次就被人撞出来；
 * 上限对齐 InviteCode.code 这一列的 varchar(64)，超了会在 MySQL 上被静默截断成另一个码，
 * 管理员发出去的和库里存着的从此不是同一个。
 */
const CUSTOM_CODE_MIN = 4;
const CUSTOM_CODE_MAX = 64;

/** 用 CSPRNG 逐位取字符，31^10 ≈ 8e14 种组合，既猜不出也扫不完，不会被枚举出来。 */
export function newInviteCode() {
    let code = "";
    for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
}

/**
 * 大小写策略：字母表本来就只有大写，所以存与比对一律先 trim 再转大写，
 * 用户输 abc 还是 ABC 都能命中，各个入口不用各写一套归一化。
 */
export function normalizeInviteCode(code: string) {
    return String(code || "")
        .trim()
        .toUpperCase();
}

/**
 * 管理员指定的码值。归一化之后必须完全落在同一张字母表里——不是洁癖：
 * 放行 0/O/1/I/L 的话，用户照着纸条输入时把 0 输成 O 就会得到「邀请码无效」，
 * 而管理员看着自己手里那张确实存在的码，完全无从判断问题出在哪。
 * 返回归一化后的值，调用方直接拿它落库，别再各自 trim 一遍。
 */
export function normalizeCustomInviteCode(input: unknown, message: (reason: string) => Error): string {
    const code = normalizeInviteCode(String(input ?? ""));
    if (code.length < CUSTOM_CODE_MIN || code.length > CUSTOM_CODE_MAX) throw message(`邀请码长度需要在 ${CUSTOM_CODE_MIN} 到 ${CUSTOM_CODE_MAX} 位之间`);
    const illegal = [...code].filter((char) => !CODE_ALPHABET.includes(char));
    if (illegal.length) throw message(`邀请码只能使用 ${CODE_ALPHABET} 这些字符，不能包含 ${[...new Set(illegal)].join("")}`);
    return code;
}
