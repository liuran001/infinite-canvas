import { randomUUID } from "node:crypto";

/** 携带用户可见文案的业务错误，未标记的错误一律对外收敛为「操作失败」。 */
export class SafeError extends Error {
    readonly safe = true;
}

export function fail(message: string) {
    return new SafeError(message);
}

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
