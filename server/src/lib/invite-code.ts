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
 * 管理员指定码值的长度区间。下限 4 是防「随手敲一个 A 就发出去」——那种码几次就被人撞出来；
 * 上限对齐 InviteCode.code 这一列的 varchar(64)，超了会在 MySQL 上被静默截断成另一个码，
 * 管理员发出去的和库里存着的从此不是同一个。
 */
const CUSTOM_CODE_MIN = 4;
const CUSTOM_CODE_MAX = 64;
/**
 * 指定码值允许的字符。刻意比随机码的字母表宽：形近字之所以被排除，是因为随机码没人挑得动，
 * 而管理员自己写的码是他自己定的——WELCOME2026、VIP001 一眼就能读，不该被随机码的规则挡在门外，
 * 万一真挑了个 0/O 混着的码，代价也由他自己承担。
 * 仍然只放行大写字母、数字、- 和 _：邀请码要能原样放进注册链接，
 * 空格、中文和 /?#& 这些要么得转义、要么直接把链接从中间截断。
 */
const CUSTOM_CODE_PATTERN = /^[A-Z0-9_-]+$/;

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
 * 管理员指定的码值。归一化之后按 CUSTOM_CODE_PATTERN 校验，比随机码宽松得多——
 * 随机码要避开形近字是因为它由机器挑、由人手抄；指定码是管理员自己写的，那是他的决定。
 * 返回归一化后的值，调用方直接拿它落库，别再各自 trim 一遍。
 */
export function normalizeCustomInviteCode(input: unknown, message: (reason: string) => Error): string {
    const code = normalizeInviteCode(String(input ?? ""));
    if (code.length < CUSTOM_CODE_MIN || code.length > CUSTOM_CODE_MAX) throw message(`邀请码长度需要在 ${CUSTOM_CODE_MIN} 到 ${CUSTOM_CODE_MAX} 位之间`);
    if (!CUSTOM_CODE_PATTERN.test(code)) {
        // 把违规字符原样列出来：只说「含有非法字符」的话，管理员盯着一串码也看不出是哪一位。
        const illegal = [...code].filter((char) => !/[A-Z0-9_-]/.test(char));
        throw message(`邀请码只能使用字母、数字、- 和 _，不能包含 ${[...new Set(illegal)].join("")}`);
    }
    return code;
}
