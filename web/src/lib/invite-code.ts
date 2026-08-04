/**
 * 指定邀请码的前端校验，与服务端 invites 服务里的同一套规则对齐。
 *
 * 单独抽出来而不是写在弹窗里，是因为这几条规则要在三个地方同时成立：输入框的 maxLength、
 * 提交前的校验、以及「填了指定码就把数量锁成 1」的联动。散在组件里的话，改了一处漏了另一处，
 * 表现就是用户按提示填完仍然被服务端打回来，而界面上看不出哪里错了。
 */

/**
 * 指定码值允许的字符，与服务端 CUSTOM_CODE_PATTERN 一字不差。
 * 随机码那张去掉 0/O/1/I/L 的字母表只管随机码：那种码由机器挑、由人手抄，混进形近字就是在制造客服工单。
 * 管理员自己写的码是他自己定的，WELCOME2026 或 VIP001 都该放行。这里只挡会把注册链接搞坏的字符。
 */
export const INVITE_CODE_PATTERN = /^[A-Z0-9_-]+$/;
/** 给用户看的规则描述，跟上面那条正则同进同出。 */
export const INVITE_CODE_RULE_TEXT = "字母、数字、- 和 _";
/**
 * 长度区间对齐服务端 invite-code.ts 的 CUSTOM_CODE_MIN / CUSTOM_CODE_MAX。
 * 随机码固定 10 位；指定码下界 4（再短就能被人猜中），上界 64 对齐 code 列的 varchar(64)。
 */
export const INVITE_CODE_MIN_LENGTH = 4;
export const INVITE_CODE_MAX_LENGTH = 64;

/** 码值只存大写，输入随手打的小写要先归一，否则用户照着自己填的小写去发码，兑换时对不上。 */
export function normalizeInviteCode(code: string) {
    return String(code || "")
        .trim()
        .toUpperCase();
}

/**
 * 校验指定码值，通过返回空串，不通过返回可直接展示给用户的中文原因。
 * 空串视为「不指定」，交给调用方决定要不要当成错误——批量生成时留空就是现在的随机行为。
 */
export function validateInviteCode(code: string) {
    const value = normalizeInviteCode(code);
    if (!value) return "";
    if (value.length < INVITE_CODE_MIN_LENGTH || value.length > INVITE_CODE_MAX_LENGTH) return `指定邀请码长度需在 ${INVITE_CODE_MIN_LENGTH}-${INVITE_CODE_MAX_LENGTH} 位之间`;
    if (INVITE_CODE_PATTERN.test(value)) return "";
    // 把违规字符原样列出来：只说「含有非法字符」的话，用户盯着一串码也看不出是哪一位。
    const illegal = [...value].filter((char) => !/[A-Z0-9_-]/.test(char));
    return `指定邀请码只能使用${INVITE_CODE_RULE_TEXT}，不支持：${[...new Set(illegal)].join(" ")}`;
}
