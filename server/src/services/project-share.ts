import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

import { config } from "../config";
import { repo, serialTransaction } from "../db/data-source";
import { ProjectAccessLog, ProjectShare, type ShareAccessEvent, type ShareRole } from "../db/entities";
import { fail, newId, now, RATE_LIMITED } from "../lib/errors";
import { requireActiveAccount } from "./account-fence";

/**
 * 分享 token 的存储形态：哈希与明文各存一列，职责完全分开。
 *
 * tokenHash 是校验的唯一入口——唯一索引上的等值查询，一个字都不走明文列。
 * token 是明文，只为了让所有者随时能把链接复制出来；这是一个知情的取舍：
 * 只显示一次的链接，用户没存下来就只能重建一条、作废已经发出去的旧链接，
 * 代价则是拖库或备份泄露时所有链接（含可编辑链接）直接可用。
 *
 * 由此引出这个模块最要紧的一条规矩：明文只允许经 ownerShareView 出去，
 * 默认的 shareView 永远不带它。改这里之前先想清楚新的调用点是谁在调。
 */
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
const MAX_TIMER_MS = 0x7fffffff;

export type ShareInput = { role: ShareRole; allowAnonymous: boolean; allowClone: boolean; expiresAt: string; ownerPays?: boolean; allowAnonymousEdit?: boolean };
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

/**
 * 在分享的绝对过期时间主动收回长连接。Node 的 setTimeout 超过约 24.8 天会被压成 1ms，
 * 所以远期日期要分段重挂；返回的清理函数供连接正常关闭或被改策略时取消计时器。
 */
export function scheduleShareExpiry(expiresAt: string, expire: () => void): () => void {
    const deadline = Date.parse(expiresAt);
    if (!Number.isFinite(deadline)) return () => undefined;
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;
    const arm = () => {
        if (cancelled) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            // 始终异步收权：SSE 可能刚完成权限校验、还没来得及设置响应头，
            // 同步 end() 后继续 setHeader() 会触发 ERR_HTTP_HEADERS_SENT。
            timer = setTimeout(() => {
                if (!cancelled) expire();
            }, 0);
            timer.unref();
            return;
        }
        timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
        timer.unref();
    };
    arm();
    return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
    };
}

const accessLogAt = new Map<string, number>();
const uploadWindows = new Map<string, { since: number; files: number; bytes: number }>();

export function shareTokenHash(token: string) {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * 常量时间比较。注意：上游是按 tokenHash 等值查询定位到唯一行的，真正的时序信息在数据库索引里，
 * 走到这一步时两个值必然相等——所以它防不住时序探测，只是万一以后改成前缀匹配时的一道保险。
 * 别把它当作"该面向已被覆盖"的依据。
 */
function sameToken(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function shareUsable(share: ProjectShare, at = Date.now()) {
    if (!share.enabled) return false;
    return !share.expiresAt || Date.parse(share.expiresAt) > at;
}

/**
 * 对外的分享视图。**这个函数永远不带明文 token**，是给所有非所有者路径用的默认形态。
 *
 * 做成「默认安全的函数 + 一个显式的所有者版本」，而不是「一个函数加个 includeToken 参数」：
 * 加参数的话，将来任何一个新调用点只要忘了传（或者传错），泄露的就是一条能直接编辑别人画布的链接，
 * 而这种遗漏在 review 里几乎看不出来。现在要泄露必须主动改用另一个名字里就写着 owner 的函数。
 */
export function shareView(share: ProjectShare) {
    return {
        id: share.id,
        projectId: share.projectId,
        role: share.role,
        tokenPrefix: share.tokenPrefix,
        // 恒为 false：这个视图本来就不带明文，调用方不必再自己判断身份。
        copyable: false,
        allowAnonymous: share.allowAnonymous,
        ownerPays: share.ownerPays,
        allowAnonymousEdit: share.allowAnonymousEdit,
        allowClone: share.allowClone,
        enabled: share.enabled,
        expiresAt: share.expiresAt,
        createdAt: share.createdAt,
        updatedAt: share.updatedAt,
    };
}

/**
 * 画布所有者视角的分享视图，带完整明文链接。只允许在已经确认过所有者身份之后调用。
 *
 * copyable 是给前端的显式状态，而不是让它拿 token 是否为空串去猜：
 * 「旧链接取不回明文」和「这次请求出了别的岔子」在前端看来都是一个空字符串，
 * 猜错的后果是把一条残缺链接渲染成可复制的样子让用户发出去。
 */
export function ownerShareView(share: ProjectShare) {
    const token = share.token || "";
    return { ...shareView(share), copyable: Boolean(token), ...(token ? { token } : {}) };
}

export async function createShare(ownerId: string, projectId: string, input: ShareInput) {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const share = repo(ProjectShare).create({
        id: newId("share"),
        projectId,
        ownerId,
        tokenHash: shareTokenHash(token),
        token,
        tokenPrefix: token.slice(0, TOKEN_PREFIX_LENGTH),
        role: input.role,
        allowAnonymous: input.allowAnonymous,
        ownerPays: input.ownerPays === true,
        allowAnonymousEdit: input.role === "editor" && input.allowAnonymous === true && input.ownerPays === true && input.allowAnonymousEdit === true,
        allowClone: input.allowClone,
        enabled: true,
        expiresAt: input.expiresAt,
        createdAt: now(),
        updatedAt: now(),
    });
    await serialTransaction(async (manager) => {
        await requireActiveAccount(manager, ownerId);
        await manager.getRepository(ProjectShare).insert(share);
    });
    return { share, token };
}

/** 查询条件里带着 ownerId，所以这里返回的每一条都属于调用者本人，可以带明文。 */
export async function listShares(projectId: string, ownerId: string) {
    return (await repo(ProjectShare).find({ where: { projectId, ownerId }, order: { createdAt: "DESC" } })).map(ownerShareView);
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
        ownerPays: patch.ownerPays ?? share.ownerPays,
        allowAnonymousEdit: (patch.role || share.role) === "editor" && (patch.allowAnonymous ?? share.allowAnonymous) === true && (patch.ownerPays ?? share.ownerPays) === true && (patch.allowAnonymousEdit ?? share.allowAnonymousEdit) === true,
        allowClone: patch.allowClone ?? share.allowClone,
        enabled: patch.enabled ?? share.enabled,
        // 前端清空过期时间发的是 null，语义是「改为永不过期」，只有整个字段缺席才算没改。
        expiresAt: "expiresAt" in patch ? patch.expiresAt || "" : share.expiresAt,
        updatedAt: now(),
    };
    await repo(ProjectShare).update({ id: share.id }, next);
    return { ...share, ...next };
}

/** 按哈希等值查找。不存在、已撤销、已过期一律回 null，调用方统一按 404 处理，不给 token 探测留信号。 */
/**
 * 改动是否必须把在线连接踢下线。已建立的 SSE 不会重新鉴权；角色、匿名编辑与付款策略
 * 无论放权还是收权都要当场重换 session，否则界面会在旧策略上停到令牌自然续期。
 */
export function shareRevokesAccess(before: ProjectShare, after: ProjectShare, at = Date.now()) {
    if (!after.enabled) return true;
    // 角色与计费策略都会改变客户端可见能力，统一断开让它立即重换 session；
    // 否则升级、开启代扣或关闭代扣都要等到短期令牌自然续期才生效。
    if (before.role !== after.role) return true;
    if (before.allowAnonymous && !after.allowAnonymous) return true;
    if (before.ownerPays !== after.ownerPays) return true;
    if (before.allowAnonymousEdit !== after.allowAnonymousEdit) return true;
    if (before.expiresAt !== after.expiresAt) return true;
    return Boolean(after.expiresAt) && Date.parse(after.expiresAt) <= at;
}

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
