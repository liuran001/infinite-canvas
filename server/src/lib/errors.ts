import { randomUUID } from "node:crypto";

/** 携带用户可见文案和协议字段的业务错误，未标记的错误一律对外收敛为「操作失败」。 */
export class SafeError extends Error {
    readonly safe = true;

    constructor(
        message: string,
        readonly status = 400,
        readonly code: string | number = 1,
        readonly data: unknown = null,
    ) {
        super(message);
    }
}

export function fail(message: string, status = 400, code: string | number = 1, data: unknown = null) {
    return new SafeError(message, status, code, data);
}

/**
 * 分享链路的稳定错误码。前端要靠它区分「链接失效」「只读」「超频」这几种完全不同的处置方式，
 * 所以集中在这里定义，不散落成各处的字符串字面量。
 */
export const SHARE_READ_ONLY = "SHARE_READ_ONLY";
export const CLONE_DISABLED = "CLONE_DISABLED";
export const RATE_LIMITED = "RATE_LIMITED";
export const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
/** 团队云空间不足。与个人分开一个码：两者是两本独立的账，前端要据此决定是引导清个人文件还是找管理员加团队额度。 */
export const TEAM_QUOTA_EXCEEDED = "TEAM_QUOTA_EXCEEDED";
export const FORBIDDEN = "FORBIDDEN";
export const NOT_FOUND = "NOT_FOUND";

export function safeMessage(error: unknown) {
    if (error instanceof SafeError) return error.message;
    console.error("request failed:", error);
    return "操作失败";
}

export function newId(prefix: string) {
    return `${prefix}-${randomUUID()}`;
}

export function newAffCode() {
    return randomUUID().slice(0, 8).replace(/-/g, "").toUpperCase();
}

export function now() {
    return new Date().toISOString();
}

export function firstNonEmpty(...values: Array<string | undefined>) {
    return values.find((value) => (value || "").trim())?.trim() || "";
}
