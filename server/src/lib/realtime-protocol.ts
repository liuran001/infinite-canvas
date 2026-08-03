/**
 * 实时协作 WebSocket 的线上协议与硬限制。
 *
 * 单独放在 lib 而不是 hub 里：解析是纯函数，不碰 socket、不碰数据库，
 * 这样协议本身可以被验证脚本直接调用，而不必为了断言一个非法帧去起一条真实连接。
 * 浏览器侧 `web/src/services/realtime/protocol.ts` 保持同样的字段和错误码。
 */

/** 单帧上限。ws 层同样配了 maxPayload，这里再判一次是因为解析函数也会被非 socket 路径调用。 */
export const MAX_FRAME_BYTES = 64 * 1024;
/** 每条连接的逻辑订阅上限。 */
export const MAX_SUBSCRIPTIONS = 32;
/** 待发送缓冲上限，超过说明对端不读了，继续攒只会把服务端内存吃光。 */
export const MAX_SEND_BUFFER_BYTES = 4 * 1024 * 1024;
/** presence 上报的最小间隔。 */
export const PRESENCE_MIN_INTERVAL_MS = 200;

/**
 * 结构深度上限。协议里所有合法 payload 都是浅的（游标、clientId、节点 id 列表），
 * 没有上限的话一个几十层的嵌套数组就能让后续任何递归遍历（序列化、比较、日志）爆栈。
 */
const MAX_FRAME_DEPTH = 8;

/** id 与 channel 的字符集。收窄到这一套是为了让它们能安全地进日志、进 Map key、进错误消息。 */
const IDENTIFIER = /^[A-Za-z0-9_:-]{1,128}$/;

/** 会污染原型链的键名，出现即判非法帧，不做静默丢弃——静默丢弃会让攻击尝试查不到。 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

/** 稳定错误码。前端按这些值决定是重试、提示升级还是停掉单条频道，不能按消息文本判断。 */
export type ProtocolErrorCode = "INVALID_FRAME" | "UNSUPPORTED_VERSION" | "UNKNOWN_TYPE" | "INVALID_SUBSCRIPTION" | "FRAME_TOO_LARGE";

export type ParseResult = { ok: true; frame: ClientFrame } | { ok: false; code: ProtocolErrorCode; message: string };

function invalid(code: ProtocolErrorCode, message: string): ParseResult {
    return { ok: false, code, message };
}

function byteLength(raw: string | Buffer | ArrayBuffer | Uint8Array) {
    if (typeof raw === "string") return Buffer.byteLength(raw, "utf8");
    if (raw instanceof ArrayBuffer) return raw.byteLength;
    return raw.byteLength;
}

/** 深度检查用迭代而不是递归：递归本身就会在超深结构上爆栈，那正是这里要挡住的输入。 */
function tooDeep(root: unknown) {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
    while (stack.length) {
        const { value, depth } = stack.pop()!;
        if (!value || typeof value !== "object") continue;
        if (depth > MAX_FRAME_DEPTH) return true;
        for (const child of Array.isArray(value) ? value : Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
    return false;
}

/**
 * 解析一帧客户端消息。
 *
 * 顺序是刻意的：先按字节数判大小（超大帧必须在 `JSON.parse` 之前就拒掉，否则内存已经付出去了），
 * 再判版本（老客户端发来的未知 type 应当报“版本不支持”，让它去升级，而不是报“未知类型”），
 * 最后才是 type 与订阅字段。
 */
export function parseClientFrame(raw: string | Buffer | ArrayBuffer | Uint8Array): ParseResult {
    if (byteLength(raw) > MAX_FRAME_BYTES) return invalid("FRAME_TOO_LARGE", `frame exceeds ${MAX_FRAME_BYTES} bytes`);

    let parsed: unknown;
    try {
        parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8"), (key, value) => {
            if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError("forbidden key");
            return value;
        });
    } catch {
        return invalid("INVALID_FRAME", "frame is not valid JSON");
    }
    // 顶层必须是普通对象：数组、null、字符串都能通过 JSON.parse，但它们没有 v/type，
    // 放行只会让后面的每个字段判断都要再想一次“如果它是数组呢”。
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("INVALID_FRAME", "frame must be a JSON object");
    if (tooDeep(parsed)) return invalid("INVALID_FRAME", "frame is nested too deeply");

    const envelope = parsed as Record<string, unknown>;
    if (envelope.v !== 1) return invalid("UNSUPPORTED_VERSION", "only protocol version 1 is supported");
    const type = envelope.type;
    if (typeof type !== "string" || !(CLIENT_FRAME_TYPES as readonly string[]).includes(type)) return invalid("UNKNOWN_TYPE", "unknown frame type");

    const id = envelope.id;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) return invalid("INVALID_SUBSCRIPTION", "frame id is missing or malformed");

    const channel = envelope.channel;
    if (channel !== undefined && (typeof channel !== "string" || !IDENTIFIER.test(channel))) return invalid("INVALID_SUBSCRIPTION", "channel is malformed");
    // channel 只对 subscribe 是必需的：unsubscribe 与 presence.update 都按订阅 id 定位，
    // 要求它们重复带上频道名，只会多出一个客户端可以填错、服务端必须再核对一次的字段。
    if (type === "subscribe" && channel === undefined) return invalid("INVALID_SUBSCRIPTION", "subscribe requires a channel");

    // payload 的频道细节在各频道控制器里验，这里只保证它是结构合法、深度可控的 JSON。
    return { ok: true, frame: { v: 1, type: type as ClientFrameType, id, channel: channel as string | undefined, payload: envelope.payload } };
}

/** 构造服务端帧。集中一处是为了让 `v` 不会在某个分支上漏掉。 */
export function serverFrame(type: ServerFrameType, id: string | undefined, channel: string | undefined, payload?: unknown): ServerFrame {
    return { v: 1, type, id, channel, payload };
}
