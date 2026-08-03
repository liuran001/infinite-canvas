/**
 * 浏览器侧实时协议类型。字段、type 白名单、错误码与硬限制都与
 * `server/src/lib/realtime-protocol.ts` 完全一致——两边任何一处改了字段名，
 * 表现都是「连上了但订阅永远 ready 不了」，比编译错误难查得多。
 *
 * 这里刻意不做入站帧的严格解析：服务端发来的帧是可信一方产生的，浏览器要做的是
 * 尽早发现类型不匹配，而不是在热路径上重复一遍服务端的校验。
 */

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_SUBSCRIPTIONS = 32;
export const MAX_SEND_BUFFER_BYTES = 4 * 1024 * 1024;
export const PRESENCE_MIN_INTERVAL_MS = 200;

/** 与服务端同一套 id/channel 字符集，用来在发送前就挡住自己拼错的订阅名。 */
export const REALTIME_IDENTIFIER = /^[A-Za-z0-9_:-]{1,128}$/;

export const CLIENT_FRAME_TYPES = ["subscribe", "unsubscribe", "presence.update"] as const;
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];

export type ClientFrame = {
    v: 1;
    type: ClientFrameType;
    id: string;
    channel?: string;
    payload?: unknown;
};

export type ServerFrameType = "ready" | "event" | "error" | "unsubscribed";

export type ServerFrame = {
    v: 1;
    type: ServerFrameType;
    id?: string;
    channel?: string;
    payload?: unknown;
};

export type ProtocolErrorCode = "INVALID_FRAME" | "UNSUPPORTED_VERSION" | "UNKNOWN_TYPE" | "INVALID_SUBSCRIPTION" | "FRAME_TOO_LARGE";

/** 判断一条入站文本是不是本协议的服务端帧。只认版本和 type，其余字段交给各频道自己解释。 */
export function isServerFrame(value: unknown): value is ServerFrame {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    return frame.v === 1 && (frame.type === "ready" || frame.type === "event" || frame.type === "error" || frame.type === "unsubscribed");
}

/** 构造客户端帧。集中一处，免得某个调用点漏掉 `v` 而被服务端按 UNSUPPORTED_VERSION 拒掉。 */
export function clientFrame(type: ClientFrameType, id: string, channel?: string, payload?: unknown): ClientFrame {
    return { v: 1, type, id, channel, payload };
}
