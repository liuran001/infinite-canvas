import bcrypt from "bcryptjs";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { Like } from "typeorm";

import { config, warnDefaultSecurityConfig } from "../config";
import { repo } from "../db/data-source";
import { CreditLog, DEFAULT_STORAGE_QUOTA, User, type CreditLogType, type UserRole, type UserStatus } from "../db/entities";
import { fail, firstNonEmpty, newAffCode, newId, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { charge, refund, setUserCredits } from "./billing";
import { claimInviteCode, recordInviteUse, releaseInviteCode } from "./invites";
import { usedBytesOf } from "./quota";
import { getSettings } from "./settings";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
    /** 是否已绑定 Linux.do。只回布尔，账号设置据此决定给「绑定」还是「解绑」，不外泄第三方 ID。 */
    linuxDoBound: boolean;
};

export type AuthSession = { token: string; user: AuthUser };

export function publicUser(user: User): AuthUser {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName || "",
        avatarUrl: user.avatarUrl || "",
        role: user.role,
        credits: user.credits,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        linuxDoBound: Boolean(user.linuxDoId),
    };
}

export function guestUser(): AuthUser {
    return { id: "", username: "guest", displayName: "", avatarUrl: "", role: "guest", credits: 0, createdAt: "", updatedAt: "", linuxDoBound: false };
}

function newUser(patch: Partial<User>): User {
    return {
        id: newId("user"),
        username: "",
        password: "",
        email: "",
        displayName: "",
        avatarUrl: "",
        role: "user",
        credits: 0,
        storageQuota: DEFAULT_STORAGE_QUOTA,
        affCode: newAffCode(),
        affCount: 0,
        inviterId: "",
        linuxDoId: "",
        status: "active",
        lastLoginAt: "",
        extra: "",
        createdAt: now(),
        updatedAt: now(),
        ...patch,
    } as User;
}

function signToken(user: User) {
    // kind 用来和分享访客的 guest 令牌区分：两种令牌用同一把密钥签，只有载荷能证明这是账号身份。
    return jwt.sign({ kind: "user", userId: user.id, username: user.username, role: user.role }, config.jwtSecret, { expiresIn: `${config.jwtExpireHours}h`, subject: user.id });
}

export async function newSession(user: User): Promise<AuthSession> {
    return { token: signToken(user), user: publicUser(user) };
}

export async function ensureDefaultAdmin() {
    if (!config.adminUsername || !config.adminPassword) return;
    warnDefaultSecurityConfig();
    const users = repo(User);
    if (await users.findOneBy({ role: "admin" })) return;
    await users.save(newUser({ username: config.adminUsername, password: await bcrypt.hash(config.adminPassword, 10), role: "admin" }));
}

type ClaimedInvite = { code: string; credits: number };

/**
 * 邀请码赠送算力点：先落使用记录，再按「原子加余额 + 写流水」走一遍正常的算力点通道。
 * 不直接把余额写死，是为了让后台在流水里能看到这笔点数是哪个邀请码送的，而不是凭空多出来的余额。
 */
async function grantInviteReward(user: User, invite: ClaimedInvite) {
    await recordInviteUse(invite.code, user.id, invite.credits);
    if (invite.credits <= 0) return user;
    const users = repo(User);
    await users
        .createQueryBuilder()
        .update(User)
        .set({ credits: () => "credits + :credits", updatedAt: now() })
        .where("id = :userId", { userId: user.id })
        .setParameter("credits", invite.credits)
        .execute();
    const fresh = (await users.findOneBy({ id: user.id })) || user;
    await writeCreditLog(user.id, "invite_gift", invite.credits, fresh.credits, `邀请码 ${invite.code} 注册赠送`, { code: invite.code });
    return fresh;
}

/**
 * 建号并结算邀请码。名额是在这之前就原子占掉的，
 * 所以建号失败必须把名额还回去，否则一次用户名冲突就白白吃掉一个名额。
 */
async function createInvitedUser(patch: Partial<User>, invite: ClaimedInvite | null) {
    let user: User;
    try {
        user = await repo(User).save(newUser(patch));
    } catch (error) {
        if (invite) await releaseInviteCode(invite.code);
        throw error;
    }
    return invite ? grantInviteReward(user, invite) : user;
}

export async function register(username: string, password: string, inviteCode = "") {
    const settings = await getSettings();
    if (!settings.public.auth.allowRegister) throw fail("当前未开放注册");
    const name = (username || "").trim();
    if (/\s/.test(name)) throw fail("用户名不能包含空格");
    if (!name || !password) throw fail("用户名和密码不能为空");
    const users = repo(User);
    if (await users.findOneBy({ username: name })) throw fail("用户名已存在");
    // 先占名额再建号：反过来的话，名额没抢到时用户已经建出来了，再删又要处理一堆半成品数据。
    const invite = settings.public.auth.requireInvite ? await claimInviteCode(inviteCode) : null;
    const user = await createInvitedUser({ username: name, password: await bcrypt.hash(password, 10), storageQuota: settings.public.storage.defaultQuota }, invite);
    return newSession(user);
}

export async function login(username: string, password: string) {
    const users = repo(User);
    const user = await users.findOneBy({ username: (username || "").trim() });
    if (!user || !user.password || !(await bcrypt.compare(password || "", user.password))) throw fail("用户名或密码错误");
    if (user.status === "ban") throw fail("账号已被禁用");
    user.lastLoginAt = now();
    user.updatedAt = now();
    if (!user.affCode) user.affCode = newAffCode();
    return newSession(await users.save(user));
}

export async function currentAuthUser(token: string): Promise<AuthUser | null> {
    let userId = "";
    try {
        const payload = jwt.verify(token, config.jwtSecret) as { userId?: string; kind?: string };
        // 分享访客的令牌签名同样有效，绝不能在这里被兑换成账号身份。签发早于本次改动的老令牌没有 kind，按账号处理。
        if (payload.kind && payload.kind !== "user") return null;
        userId = String(payload.userId || "");
    } catch {
        return null;
    }
    const user = userId ? await repo(User).findOneBy({ id: userId }) : null;
    if (!user || user.status === "ban") return null;
    return publicUser(user);
}

export async function listUsers(query: Query) {
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ username: like }, { displayName: like }, { email: like }, { linuxDoId: like }] : {};
    const [items, total] = await repo(User).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const used = await usedBytesOf(items.map((user) => user.id));
    return { items: items.map((user) => ({ ...user, password: "", storageQuota: Number(user.storageQuota), storageUsed: used.get(user.id) || 0 })), total };
}

export async function saveUser(input: Partial<User>, password: string) {
    const users = repo(User);
    const username = (input.username || "").trim();
    if (/\s/.test(username)) throw fail("用户名不能包含空格");
    if (!username) throw fail("用户名不能为空");
    const duplicated = await users.findOneBy({ username });
    if (duplicated && duplicated.id !== input.id) throw fail("用户名已存在");
    const saved = input.id ? await users.findOneBy({ id: input.id }) : null;
    const role: UserRole = input.role && input.role !== "guest" ? input.role : "user";
    const status: UserStatus = input.status || "active";
    const user = saved
        ? { ...saved, username, email: input.email || "", displayName: input.displayName || "", role, status, updatedAt: now() }
        : newUser({ username, email: input.email || "", displayName: input.displayName || "", role, status, storageQuota: (await getSettings()).public.storage.defaultQuota });
    if (password) user.password = await bcrypt.hash(password, 10);
    if (!user.password) throw fail("密码不能为空");
    return { ...(await users.save(user)), password: "" };
}

export async function deleteUser(id: string) {
    await repo(User).delete({ id });
}

/** 修改密码。第三方登录创建的账号本来就没有密码，这种情况允许直接设置。 */
export async function changePassword(userId: string, oldPassword: string, newPassword: string) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user) throw fail("用户不存在");
    if (user.password && !(await bcrypt.compare(oldPassword || "", user.password))) throw fail("原密码不正确");
    if ((newPassword || "").length < 6) throw fail("新密码至少 6 位");
    user.password = await bcrypt.hash(newPassword, 10);
    user.updatedAt = now();
    await users.save(user);
}

/** 解绑第三方登录。没有密码时解绑会导致再也登不进来，必须先设密码。 */
export async function unbindLinuxDo(userId: string) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user) throw fail("用户不存在");
    if (!user.linuxDoId) throw fail("当前账号未绑定 Linux.do");
    if (!user.password) throw fail("请先设置登录密码，否则解绑后将无法登录");
    user.linuxDoId = "";
    user.updatedAt = now();
    await users.save(user);
    return publicUser(user);
}

async function writeCreditLog(userId: string, type: CreditLogType, amount: number, balance: number, remark: string, extra?: unknown) {
    await repo(CreditLog).save({
        id: newId("credit"),
        userId,
        type,
        amount,
        balance,
        relatedId: "",
        remark,
        extra: extra ? JSON.stringify(extra) : "",
        createdAt: now(),
    });
}

export async function adjustUserCredits(id: string, credits: number) {
    return { ...(await setUserCredits(id, credits)), password: "" };
}

/** 调整云空间配额。已用量按文件对象实时聚合，这里只改上限。 */
export async function adjustUserQuota(id: string, quota: number) {
    const users = repo(User);
    const user = await users.findOneBy({ id });
    if (!user) throw fail("用户不存在");
    user.storageQuota = Math.max(0, Math.floor(quota));
    user.updatedAt = now();
    return { ...(await users.save(user)), password: "" };
}

/**
 * 扣点与退款的实现都在 billing.ts（扣费、读回余额、写流水同事务）。
 * 这两个是保留给现有调用点的薄封装，签名与语义一字不变。
 */
export async function consumeUserCredits(userId: string, model: string, credits: number, path: string) {
    await charge({ kind: "user", userId }, credits, { model, path });
}

export async function refundUserCredits(userId: string, model: string, credits: number, path: string) {
    await refund({ payer: { kind: "user", userId }, credits, logId: "" }, { model, path });
}

export async function listCreditLogs(query: Query) {
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ userId: like }, { type: like as never }, { remark: like }, { relatedId: like }] : {};
    const [items, total] = await repo(CreditLog).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    return { items, total };
}

export async function saveCreditLog(input: Partial<CreditLog>) {
    return repo(CreditLog).save({ ...input, id: input.id || newId("credit"), createdAt: input.createdAt || now() } as CreditLog);
}

export async function deleteCreditLog(id: string) {
    await repo(CreditLog).delete({ id });
}

export function requestOrigin(req: Request) {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").trim();
    const proto = String(req.headers["x-forwarded-proto"] || "").trim() || req.protocol || "http";
    return `${proto}://${host}`;
}

/**
 * 只放行站内相对路径。浏览器会忽略 URL 里的制表符与换行，并把 //host、/\host
 * 解析成协议相对的跨站地址，所以先剥离控制字符再拒绝这两种前缀。
 */
function safeRedirectPath(redirect: string) {
    const cleaned = redirect.replace(/[\t\r\n]/g, "");
    if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) return "/";
    return cleaned;
}

function linuxDoRedirectUri(req: Request) {
    return `${requestOrigin(req)}/api/auth/linux-do/callback`;
}

/**
 * 发起 Linux.do 授权。传 bindUserId 表示这是「给已登录账号绑定」而不是登录。
 * state 用 JWT 签名：OAuth 回调是无鉴权的浏览器跳转，只有签名过的 state 才能安全携带用户身份。
 */
export async function linuxDoAuthorizeUrl(req: Request, redirect: string, bindUserId = "") {
    const settings = await getSettings();
    if (!settings.public.auth.linuxDo.enabled) throw fail("Linux.do 登录未开启");
    const { clientId, clientSecret } = settings.private.auth.linuxDo;
    if (!clientId || !clientSecret) throw fail("Linux.do 登录未配置");
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: linuxDoRedirectUri(req),
        response_type: "code",
        scope: "read",
        state: jwt.sign({ redirect: safeRedirectPath(redirect || "/"), bindUserId }, config.jwtSecret, { expiresIn: "10m" }),
    });
    return `${config.linuxDo.authorizeUrl}?${params}`;
}

type LinuxDoProfile = { id?: number; username?: string; name?: string; avatar_template?: string };

/**
 * 待注册凭据。第三方身份这时已经在服务端验过了，但还不能建号（缺邀请码），
 * 所以把已验证的身份签成一张短期 JWT 发给前端，补完邀请码再原样带回来。
 * 关键点是「签名」：如果让前端自己传 linuxDoId，任何人都能声称自己是任意 Linux.do 用户直接开户。
 * kind 用来和 OAuth 的 state 令牌区分，避免两种短期令牌被互相顶用。
 */
type PendingRegister = { kind: "linux-do-register"; linuxDoId: string; profile: LinuxDoProfile };

const PENDING_REGISTER_KIND = "linux-do-register";
/** 10 分钟：够用户去翻一下邀请码，又不至于让一张能开户的凭据长期在外面飘着。 */
const PENDING_REGISTER_EXPIRES = "10m";

function signPendingRegister(linuxDoId: string, profile: LinuxDoProfile) {
    const payload: PendingRegister = { kind: PENDING_REGISTER_KIND, linuxDoId, profile };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: PENDING_REGISTER_EXPIRES });
}

function linuxDoAvatar(template: string) {
    if (!template.trim()) return "";
    const url = template.startsWith("//") ? `https:${template}` : template.startsWith("/") ? `https://linux.do${template}` : template;
    return url.replace("{size}", "120");
}

async function linuxDoJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }).catch(() => {
        throw fail("Linux.do 登录失败");
    });
    if (!response.ok) throw fail("Linux.do 登录失败");
    return (await response.json()) as T;
}

/** Linux.do 用户名可能和站内已有账号撞名，撞了就拼上第三方 ID 保证唯一。 */
async function linuxDoUsername(linuxDoId: string, profile: LinuxDoProfile) {
    const base = (profile.username || "").trim() || `linuxdo-${linuxDoId}`;
    return (await repo(User).findOneBy({ username: base })) ? `${base}-${linuxDoId}` : base;
}

export async function loginWithLinuxDo(req: Request, code: string, state: string) {
    let redirect = "/";
    let bindUserId = "";
    try {
        const payload = jwt.verify(state, config.jwtSecret) as { redirect?: string; bindUserId?: string };
        redirect = safeRedirectPath(payload.redirect || "/");
        bindUserId = payload.bindUserId || "";
    } catch {
        throw Object.assign(fail("授权状态已失效，请重新发起"), { redirect });
    }

    const settings = await getSettings();
    if (!settings.public.auth.linuxDo.enabled) throw Object.assign(fail("Linux.do 登录未开启"), { redirect });
    const { clientId, clientSecret } = settings.private.auth.linuxDo;
    const token = await linuxDoJson<{ access_token?: string }>(config.linuxDo.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: linuxDoRedirectUri(req) }),
    });
    if (!token.access_token) throw Object.assign(fail("Linux.do 登录失败"), { redirect });
    const profile = await linuxDoJson<LinuxDoProfile>(config.linuxDo.userInfoUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
    const linuxDoId = String(profile.id || "");
    if (!linuxDoId || linuxDoId === "0") throw Object.assign(fail("Linux.do 用户信息无效"), { redirect });

    const users = repo(User);
    const bound = await users.findOneBy({ linuxDoId });

    // 绑定流程：把 Linux.do 账号挂到已登录的用户上，不换发登录态。
    if (bindUserId) {
        if (bound && bound.id !== bindUserId) throw Object.assign(fail("该 Linux.do 账号已绑定其他用户"), { redirect });
        const user = await users.findOneBy({ id: bindUserId });
        if (!user) throw Object.assign(fail("用户不存在"), { redirect });
        user.linuxDoId = linuxDoId;
        user.displayName = firstNonEmpty(user.displayName, profile.name);
        user.avatarUrl = firstNonEmpty(user.avatarUrl, linuxDoAvatar(profile.avatar_template || ""));
        user.updatedAt = now();
        user.extra = JSON.stringify({ linuxDo: profile });
        await users.save(user);
        return { session: null, redirect, bound: true, pendingToken: "" };
    }

    let user = bound;
    if (!user) {
        if (!settings.public.auth.allowRegister) throw Object.assign(fail("当前未开放注册"), { redirect });
        // 需要邀请码时这一步绝不能建号：只签一张待注册凭据交给前端，
        // 用户补完邀请码走 /auth/linux-do/complete 才真正开户，在那之前始终是未登录状态。
        if (settings.public.auth.requireInvite) return { session: null, redirect, bound: false, pendingToken: signPendingRegister(linuxDoId, profile) };
        const username = await linuxDoUsername(linuxDoId, profile);
        user = newUser({ username, displayName: (profile.name || "").trim(), avatarUrl: linuxDoAvatar(profile.avatar_template || ""), linuxDoId, storageQuota: settings.public.storage.defaultQuota });
    } else if (user.status === "ban") {
        throw Object.assign(fail("账号已被禁用"), { redirect });
    }
    user.displayName = firstNonEmpty(profile.name, user.displayName);
    user.avatarUrl = firstNonEmpty(linuxDoAvatar(profile.avatar_template || ""), user.avatarUrl);
    user.lastLoginAt = now();
    user.updatedAt = now();
    user.extra = JSON.stringify({ linuxDo: profile });
    return { session: await newSession(await users.save(user)), redirect, bound: false, pendingToken: "" };
}

/**
 * 用待注册凭据 + 邀请码完成第三方注册。
 * 身份只认凭据里的签名内容，请求体里除了邀请码不接受任何身份字段。
 */
export async function completeLinuxDoRegister(pendingToken: string, inviteCode: string) {
    let payload: PendingRegister;
    try {
        payload = jwt.verify(pendingToken, config.jwtSecret) as PendingRegister;
    } catch {
        throw fail("注册凭据已过期，请重新发起 Linux.do 登录");
    }
    if (payload?.kind !== PENDING_REGISTER_KIND || !payload.linuxDoId) throw fail("注册凭据无效，请重新发起 Linux.do 登录");

    const settings = await getSettings();
    if (!settings.public.auth.allowRegister) throw fail("当前未开放注册");
    const users = repo(User);
    // 凭据有效期内对方可能已经从别的入口把号建出来了，这时直接换成登录，不要重复建号也不要再吃一个名额。
    const bound = await users.findOneBy({ linuxDoId: payload.linuxDoId });
    if (bound) {
        if (bound.status === "ban") throw fail("账号已被禁用");
        bound.lastLoginAt = now();
        bound.updatedAt = now();
        return newSession(await users.save(bound));
    }

    const profile = payload.profile || {};
    const invite = settings.public.auth.requireInvite ? await claimInviteCode(inviteCode) : null;
    const user = await createInvitedUser(
        {
            username: await linuxDoUsername(payload.linuxDoId, profile),
            displayName: (profile.name || "").trim(),
            avatarUrl: linuxDoAvatar(profile.avatar_template || ""),
            linuxDoId: payload.linuxDoId,
            storageQuota: settings.public.storage.defaultQuota,
            lastLoginAt: now(),
            extra: JSON.stringify({ linuxDo: profile }),
        },
        invite,
    );
    return newSession(user);
}
