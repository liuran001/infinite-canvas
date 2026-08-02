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
