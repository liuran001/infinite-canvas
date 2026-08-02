import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

import { config } from "../config";
import { repo } from "../db/data-source";
import { ProjectAccessLog, ProjectShare, type ShareAccessEvent, type ShareRole } from "../db/entities";
import { fail, newId, now, RATE_LIMITED } from "../lib/errors";

/** 192 bit 随机值，base64url 后固定 32 个字符。 */
const TOKEN_BYTES = 24;
const TOKEN_PREFIX_LENGTH = 8;
/** 短 TTL 让撤销的爆炸半径有上界；长连接的撤销由实时总线当场处理，不靠过期兜底。 */
const GUEST_TOKEN_TTL_SECONDS = 30 * 60;
/** 同一 (分享, 访客, 事件) 五分钟内只落一条，否则一次访问就能把日志表写爆。 */
const ACCESS_LOG_WINDOW_MS = 5 * 60_000;
const UPLOAD_WINDOW_MS = 10 * 60_000;
const UPLOAD_MAX_FILES = 20;
const UPLOAD_MAX_BYTES = 100 << 20;
const ANONYMOUS_ACTOR = /^guest:[\w-]{1,64}:[A-Za-z0-9_-]{8,64}$/;

export type ShareInput = { role: ShareRole; allowAnonymous: boolean; allowClone: boolean; expiresAt: string };
export type GuestSession = {
    kind: "guest";
    shareId: string;
    projectId: string;
    /** 项目真实所有者。只用于建立连接前的快速判定，最终判定一律回库核对。 */
    ownerId: string;
    role: ShareRole;
    actorId: string;
    displayName: string;
    avatarUrl: string;
    anonymous: boolean;
    /** 通过分享进入的已登录账号 id。刻意不叫 userId，避免被账号鉴权当成用户令牌。 */
    accountId: string;
};

const accessLogAt = new Map<string, number>();
const uploadWindows = new Map<string, { since: number; files: number; bytes: number }>();

export function shareTokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

/** 比较用常量时间：等值查询已经定位到唯一行，这一步只为杜绝按哈希前缀做时序探测。 */
function sameToken(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function shareUsable(share: ProjectShare, at = Date.now()) {
    if (!share.enabled) return false;
    return !share.expiresAt || Date.parse(share.expiresAt) > at;
}

export function shareView(share: ProjectShare) {
    return {
        id: share.id,
        projectId: share.projectId,
        role: share.role,
        // 明文只在创建响应里出现一次，列表接口一律只回前缀。
        tokenPrefix: share.tokenPrefix,
        allowAnonymous: share.allowAnonymous,
        allowClone: share.allowClone,
        enabled: share.enabled,
        expiresAt: share.expiresAt,
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
    };
}

export async function createShare(ownerId: string, projectId: string, input: ShareInput) {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const share = repo(ProjectShare).create({
        id: newId("share"),
        projectId,
        ownerId,
        tokenHash: shareTokenHash(token),
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        role: input.role,
        allowAnonymous: input.allowAnonymous,
        allowClone: input.allowClone,
        enabled: true,
        expiresAt: input.expiresAt,
        createdAt: now(),
        updatedAt: now(),
    });
    await repo(ProjectShare).insert(share);
    return { share, token };
}

export async function listShares(projectId: string, ownerId: string) {
    return (await repo(ProjectShare).find({ where: { projectId, ownerId }, order: { createdAt: "DESC" } })).map(shareView);
}

export async function getOwnedShare(shareId: string, projectId: string, ownerId: string) {
    const share = await repo(ProjectShare).findOneBy({ id: shareId, projectId, ownerId });
    if (!share) throw fail("分享链接不存在", 404, "SHARE_NOT_FOUND");
    return share;
}

export async function updateShare(share: ProjectShare, patch: Partial<ShareInput> & { enabled?: boolean }) {
    const next = {
        role: patch.role || share.role,
        allowAnonymous: patch.allowAnonymous ?? share.allowAnonymous,
        allowClone: patch.allowClone ?? share.allowClone,
        enabled: patch.enabled ?? share.enabled,
        expiresAt: patch.expiresAt ?? share.expiresAt,
        updatedAt: now(),
    };
    await repo(ProjectShare).update({ id: share.id }, next);
    return { ...share, ...next };
}

/** 按哈希等值查找。不存在、已撤销、已过期一律回 null，调用方统一按 404 处理，不给 token 探测留信号。 */
export async function findShareByToken(token: string, at = Date.now()) {
    const value = (token || "").trim();
    if (!value) return null;
    const share = await repo(ProjectShare).findOneBy({ tokenHash: shareTokenHash(value) });
    if (!share || !sameToken(share.tokenHash, shareTokenHash(value))) return null;
    return shareUsable(share, at) ? share : null;
}

function anonymousDisplayName(actorId: string) {
    return `访客-${actorId.slice(-4).toUpperCase()}`;
}

/**
 * 组装 guest 身份。访客自报的身份一律不信：
 * 匿名 id 必须是本条分享的格式，昵称与头像只在已登录时取账号信息，其余一概由服务端生成。
 */
export function guestSessionOf(share: ProjectShare, input: { accountId: string; actorId: string; displayName: string; avatarUrl: string }): GuestSession {
    const account = (input.accountId || "").trim();
    if (account) {
        return { kind: "guest", shareId: share.id, projectId: share.projectId, ownerId: share.ownerId, role: share.role, actorId: account, displayName: input.displayName || "协作者", avatarUrl: input.avatarUrl || "", anonymous: false, accountId: account };
    }
    const reused = (input.actorId || "").trim();
    const actorId = ANONYMOUS_ACTOR.test(reused) && reused.startsWith(`guest:${share.id}:`) ? reused : `guest:${share.id}:${randomBytes(9).toString("base64url")}`;
    return { kind: "guest", shareId: share.id, projectId: share.projectId, ownerId: share.ownerId, role: share.role, actorId, displayName: anonymousDisplayName(actorId), avatarUrl: "", anonymous: true, accountId: "" };
}

export function signGuestToken(session: GuestSession) {
    return jwt.sign(session, config.jwtSecret, { expiresIn: GUEST_TOKEN_TTL_SECONDS });
}

export function guestTokenTtl() {
    return GUEST_TOKEN_TTL_SECONDS;
}

/** 只认 kind 为 guest 的载荷。用户令牌走这里必须落空，否则两种身份会互相顶用。 */
export function verifyGuestToken(token: string): GuestSession | null {
    try {
        const payload = jwt.verify(token, config.jwtSecret) as Partial<GuestSession>;
        if (payload?.kind !== "guest" || !payload.shareId || !payload.projectId || !payload.actorId) return null;
        return { ...(payload as GuestSession), accountId: payload.accountId || "" };
    } catch {
        return null;
    }
}

function ipHashOf(ip: string) {
    return ip ? createHash("sha256").update(ip).digest("hex").slice(0, 32) : "";
}

/**
 * 写访问日志。open 与 edit 按 (分享, 访客, 事件) 节流，clone 每次都写：
 * 它低频、有实际副作用，漏一条所有者就再也查不到自己的画布被谁复制走了。
 * 节流状态在进程内存里，多实例下退化为「每实例每 5 分钟一条」，可以接受。
 */
export async function logShareAccess(share: ProjectShare, input: { actorId: string; isAnonymous: boolean; event: ShareAccessEvent; ip?: string; userAgent?: string }, at = Date.now()) {
    const key = `${share.id}:${input.actorId}:${input.event}`;
    if (input.event !== "clone") {
        const last = accessLogAt.get(key);
        if (last !== undefined && at - last < ACCESS_LOG_WINDOW_MS) return;
        accessLogAt.set(key, at);
    }
    await repo(ProjectAccessLog).insert({
        id: newId("access"),
        shareId: share.id,
        projectId: share.projectId,
        actorId: input.actorId,
        isAnonymous: input.isAnonymous,
        event: input.event,
        ipHash: ipHashOf((input.ip || "").trim()),
        userAgent: (input.userAgent || "").slice(0, 200),
        createdAt: new Date(at).toISOString(),
    });
}

export async function listShareLogs(shareId: string, offset: number, pageSize: number) {
    const [items, total] = await repo(ProjectAccessLog).findAndCount({ where: { shareId }, order: { createdAt: "DESC" }, skip: offset, take: pageSize });
    return { items, total };
}

/**
 * 访客上传限流。配额拦的是所有者的总空间，拦不住「一个链接被人拿去当图床」：
 * 单文件都合规、总量也没超，照样能在几分钟里把所有者的空间刷满，所以按 (分享, 访客) 再限一层频次与字节。
 */
export function assertShareUploadAllowed(shareId: string, actorId: string, bytes: number, at = Date.now()) {
    const key = `${shareId}:${actorId}`;
    const window = uploadWindows.get(key);
    const current = window && at - window.since < UPLOAD_WINDOW_MS ? window : { since: at, files: 0, bytes: 0 };
    if (current.files + 1 > UPLOAD_MAX_FILES || current.bytes + bytes > UPLOAD_MAX_BYTES) {
        uploadWindows.set(key, current);
        throw fail("上传太频繁了，请稍后再试", 429, RATE_LIMITED);
    }
    uploadWindows.set(key, { since: current.since, files: current.files + 1, bytes: current.bytes + bytes });
}

/** 只给验证脚本用：节流与限流都是进程内存状态，用例之间必须能清干净。 */
export function resetShareRuntimeState() {
    accessLogAt.clear();
    uploadWindows.clear();
}
