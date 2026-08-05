import bcrypt from "bcryptjs";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { Like } from "typeorm";

import { config, warnDefaultSecurityConfig } from "../config";
import { repo } from "../db/data-source";
import { CreditLog, DEFAULT_STORAGE_QUOTA, User, type CreditLogType, type UserRole, type UserStatus } from "../db/entities";
import { fail, firstNonEmpty, newAffCode, newId, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { setUserCredits } from "./billing";
import { assertAccountLoginAllowed, finalizeAccountDeletion, requestAccountDeletion } from "./account-deletion";
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
        displayNameCustomized: false,
        avatarUrl: "",
        role: "user",
        credits: 0,
        storageQuota: DEFAULT_STORAGE_QUOTA,
        affCode: newAffCode(),
        affCount: 0,
        inviterId: "",
        linuxDoId: "",
        status: "active",
        sessionVersion: 0,
        deleteRequestedAt: "",
        deleteFinalizingAt: "",
        deletedAt: "",
        deletedUsername: "",
        lastLoginAt: "",
        extra: "",
        createdAt: now(),
        updatedAt: now(),
        ...patch,
    } as User;
}

function signToken(user: User) {
    // kind 用来和分享访客的 guest 令牌区分：两种令牌用同一把密钥签，只有载荷能证明这是账号身份。
    return jwt.sign({ kind: "user", userId: user.id, username: user.username, role: user.role, sessionVersion: user.sessionVersion }, config.jwtSecret, { expiresIn: `${config.jwtExpireHours}h`, subject: user.id });
}

type LoginPatch = Partial<Pick<User, "lastLoginAt" | "affCode" | "displayName" | "avatarUrl" | "extra">>;

/** 只更新明确列，并用 active + sessionVersion 把旧快照挡在注销状态之外。 */
async function patchActiveUser(snapshot: User, patch: Partial<User>) {
    const users = repo(User);
    await users.update({ id: snapshot.id, status: "active", sessionVersion: snapshot.sessionVersion }, patch);
    const fresh = await users.findOneBy({ id: snapshot.id });
    return fresh?.status === "active" && fresh.sessionVersion === snapshot.sessionVersion ? fresh : null;
}

/** 密码、Passkey、OAuth 在凭据校验完成后统一从这里签发，不能再整行 save 旧 User。 */
export async function finishAccountLogin(snapshot: User, patch: LoginPatch = {}): Promise<AuthSession> {
    const fresh = await patchActiveUser(snapshot, { ...patch, updatedAt: now() });
    if (!fresh) {
        const current = await repo(User).findOneBy({ id: snapshot.id });
        if (current) await assertAccountLoginAllowed(current);
        throw fail("账号状态已变化，请重新登录");
    }
    return { token: signToken(fresh), user: publicUser(fresh) };
}

export async function newSession(user: User): Promise<AuthSession> {
    const fresh = await repo(User).findOneBy({ id: user.id });
    if (!fresh) throw fail("用户名或密码错误");
    await assertAccountLoginAllowed(fresh);
    if (fresh.sessionVersion !== user.sessionVersion) throw fail("账号状态已变化，请重新登录");
    return { token: signToken(fresh), user: publicUser(fresh) };
}

export async function ensureDefaultAdmin() {
    if (!config.adminUsername || !config.adminPassword) return;
    warnDefaultSecurityConfig();
    const users = repo(User);
    // 已注销管理员只是一条审计墓碑，不能阻止系统补建可登录的默认管理员。
    if (await users.findOneBy({ role: "admin", status: "active" })) return;
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
    return finishAccountLogin(user, { lastLoginAt: now(), affCode: user.affCode || newAffCode() });
}

export async function currentAuthUser(token: string): Promise<AuthUser | null> {
    let userId = "";
    let sessionVersion = 0;
    try {
        const payload = jwt.verify(token, config.jwtSecret) as { userId?: string; kind?: string; sessionVersion?: number };
        // 分享访客的令牌签名同样有效，绝不能在这里被兑换成账号身份。签发早于本次改动的老令牌没有 kind，按账号处理。
        if (payload.kind && payload.kind !== "user") return null;
        userId = String(payload.userId || "");
        sessionVersion = Number(payload.sessionVersion || 0);
    } catch {
        return null;
    }
    const user = userId ? await repo(User).findOneBy({ id: userId }) : null;
    if (!user || user.status !== "active" || user.sessionVersion !== sessionVersion) return null;
    return publicUser(user);
}

export async function listUsers(query: Query) {
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ username: like }, { deletedUsername: like }, { displayName: like }, { email: like }, { linuxDoId: like }] : {};
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
    if (saved?.status === "deleted") throw fail("已注销账号请使用重新启用操作");
    if (saved?.status === "deleting" || saved?.status === "finalizing") throw fail("账号正在注销，不能直接修改");
    const role: UserRole = input.role && input.role !== "guest" ? input.role : "user";
    const status: UserStatus = input.status === "ban" ? "ban" : "active";
    if (!saved) {
        const user = newUser({ username, email: input.email || "", displayName: input.displayName || "", role, status, storageQuota: (await getSettings()).public.storage.defaultQuota });
        if (password) user.password = await bcrypt.hash(password, 10);
        if (!user.password) throw fail("密码不能为空");
        return { ...(await users.save(user)), password: "" };
    }

    const nextPassword = password ? await bcrypt.hash(password, 10) : saved.password;
    if (!nextPassword) throw fail("密码不能为空");
    const nextVersion = saved.sessionVersion + (saved.status === status ? 0 : 1);
    const updated = await users.update(
        { id: saved.id, status: saved.status, sessionVersion: saved.sessionVersion },
        {
            username,
            email: input.email || "",
            displayName: input.displayName || "",
            role,
            status,
            password: nextPassword,
            sessionVersion: nextVersion,
            updatedAt: now(),
        },
    );
    if (!updated.affected) throw fail("账号状态已变化，请刷新后重试");
    return { ...(await users.findOneByOrFail({ id: saved.id, sessionVersion: nextVersion })), password: "" };
}

export async function deleteUser(id: string) {
    const user = await repo(User).findOneBy({ id });
    if (!user || user.status === "deleted") return;
    await requestAccountDeletion(id);
    await finalizeAccountDeletion(id);
}

/** 修改密码。第三方登录创建的账号本来就没有密码，这种情况允许直接设置。 */
export async function changePassword(userId: string, oldPassword: string, newPassword: string) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user || user.status !== "active") throw fail("用户不存在");
    if (user.password && !(await bcrypt.compare(oldPassword || "", user.password))) throw fail("原密码不正确");
    if ((newPassword || "").length < 6) throw fail("新密码至少 6 位");
    const fresh = await patchActiveUser(user, { password: await bcrypt.hash(newPassword, 10), updatedAt: now() });
    if (!fresh) throw fail("账号状态已变化，请重新登录");
}

/**
 * 第三方登录时昵称该取哪个值。抽成函数而不是在 loginWithLinuxDo 里写一行：
 * 这条规则要被验证脚本直接盯住，内联的话脚本只能照抄一份，抄出来的那份怎么改都不会红。
 *
 * 用户自己改过昵称就不再被第三方覆盖——登录一次就把人家改的名字打回去，而且不给任何提示，
 * 用户只会以为「改昵称这个功能坏了」。没改过的账号仍然跟随 Linux.do，行为与改动前一致。
 */
export function syncedDisplayName(user: Pick<User, "displayName" | "displayNameCustomized">, incoming: string | undefined) {
    if (user.displayNameCustomized) return user.displayName;
    return firstNonEmpty(incoming, user.displayName);
}

/**
 * 昵称的长度上限。列是 varchar(255)，超了在 MySQL/Postgres 上会直接报错或被截断，
 * 而 64 已经远超任何正常昵称——真正的作用是挡住「把一整段文本粘进昵称框」。
 */
const DISPLAY_NAME_MAX = 64;

/**
 * 用户自助改昵称。只开放 displayName，username 仍然不可改：
 * 它是登录凭据、是 Linux.do 撞名时拼后缀的基准，也散落在各处的历史记录里，改它是另一件事。
 *
 * 空昵称是允许的，等于「取消自定义、回落到用户名」——各处展示本来就是 displayName || username。
 * 但即便清空也要把 displayNameCustomized 置上：用户清空之后再用 Linux.do 登录，
 * 不置的话第三方昵称会立刻填回来，在他看来就是「清空没生效」。
 */
export async function updateDisplayName(userId: string, displayName: unknown) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user || user.status !== "active") throw fail("用户不存在");
    const next = String(displayName ?? "").trim();
    if (next.length > DISPLAY_NAME_MAX) throw fail(`昵称最多 ${DISPLAY_NAME_MAX} 个字符`);
    const fresh = await patchActiveUser(user, { displayName: next, displayNameCustomized: true, updatedAt: now() });
    if (!fresh) throw fail("账号状态已变化，请重新登录");
    return publicUser(fresh);
}

/** 解绑第三方登录。没有密码时解绑会导致再也登不进来，必须先设密码。 */
export async function unbindLinuxDo(userId: string) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user || user.status !== "active") throw fail("用户不存在");
    if (!user.linuxDoId) throw fail("当前账号未绑定 Linux.do");
    if (!user.password) throw fail("请先设置登录密码，否则解绑后将无法登录");
    const fresh = await patchActiveUser(user, { linuxDoId: "", updatedAt: now() });
    if (!fresh) throw fail("账号状态已变化，请重新登录");
    return publicUser(fresh);
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
    if (!user || user.status !== "active") throw fail("用户不存在");
    const fresh = await patchActiveUser(user, { storageQuota: Math.max(0, Math.floor(quota)), updatedAt: now() });
    if (!fresh) throw fail("账号状态已变化，请刷新后重试");
    return { ...fresh, password: "" };
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

const LINUX_DO_STATE_KIND = "linux-do-oauth";

/**
 * 发起 Linux.do 授权。传 bindUserId 表示这是「给已登录账号绑定」而不是登录。
 * state 用 JWT 签名：OAuth 回调是无鉴权的浏览器跳转，只有签名过的 state 才能安全携带用户身份。
 */
export async function linuxDoAuthorizeUrl(req: Request, redirect: string, bindUserId = "") {
    const settings = await getSettings();
    if (!settings.public.auth.linuxDo.enabled) throw fail("Linux.do 登录未开启");
    const { clientId, clientSecret } = settings.private.auth.linuxDo;
    if (!clientId || !clientSecret) throw fail("Linux.do 登录未配置");
    const bindUser = bindUserId ? await repo(User).findOneBy({ id: bindUserId, status: "active" }) : null;
    if (bindUserId && !bindUser) throw fail("账号状态已变化，请重新登录");
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: linuxDoRedirectUri(req),
        response_type: "code",
        scope: "read",
        state: jwt.sign(
            {
                kind: LINUX_DO_STATE_KIND,
                redirect: safeRedirectPath(redirect || "/"),
                bindUserId,
                bindSessionVersion: bindUser?.sessionVersion,
                bindLinuxDoId: bindUser?.linuxDoId || "",
            },
            config.jwtSecret,
            { expiresIn: "10m" },
        ),
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
    let bindSessionVersion: number | undefined;
    let bindLinuxDoId = "";
    try {
        const payload = jwt.verify(state, config.jwtSecret) as { kind?: string; redirect?: string; bindUserId?: string; bindSessionVersion?: number; bindLinuxDoId?: string };
        if (payload.kind !== LINUX_DO_STATE_KIND) throw new Error("invalid oauth state kind");
        redirect = safeRedirectPath(payload.redirect || "/");
        bindUserId = payload.bindUserId || "";
        bindSessionVersion = payload.bindSessionVersion;
        bindLinuxDoId = payload.bindLinuxDoId || "";
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
        if (!Number.isInteger(bindSessionVersion)) throw Object.assign(fail("授权状态已失效，请重新发起"), { redirect });
        if (bound && bound.id !== bindUserId) throw Object.assign(fail("该 Linux.do 账号已绑定其他用户"), { redirect });
        const user = await users.findOneBy({ id: bindUserId });
        if (!user || user.status !== "active" || user.sessionVersion !== bindSessionVersion || user.linuxDoId !== bindLinuxDoId) {
            throw Object.assign(fail("账号状态已变化，请重新发起绑定"), { redirect });
        }
        await users.update(
            { id: bindUserId, status: "active", sessionVersion: bindSessionVersion, linuxDoId: bindLinuxDoId },
            {
                linuxDoId,
                displayName: firstNonEmpty(user.displayName, profile.name),
                avatarUrl: firstNonEmpty(user.avatarUrl, linuxDoAvatar(profile.avatar_template || "")),
                updatedAt: now(),
                extra: JSON.stringify({ linuxDo: profile }),
            },
        );
        const fresh = await users.findOneBy({ id: bindUserId });
        if (!fresh || fresh.status !== "active" || fresh.sessionVersion !== bindSessionVersion || fresh.linuxDoId !== linuxDoId) {
            throw Object.assign(fail("账号状态已变化，请重新发起绑定"), { redirect });
        }
        return { session: null, redirect, bound: true, pendingToken: "" };
    }

    if (!bound) {
        if (!settings.public.auth.allowRegister) throw Object.assign(fail("当前未开放注册"), { redirect });
        // 需要邀请码时这一步绝不能建号：只签一张待注册凭据交给前端，
        // 用户补完邀请码走 /auth/linux-do/complete 才真正开户，在那之前始终是未登录状态。
        if (settings.public.auth.requireInvite) return { session: null, redirect, bound: false, pendingToken: signPendingRegister(linuxDoId, profile) };
        const username = await linuxDoUsername(linuxDoId, profile);
        const user = await users.save(
            newUser({
                username,
                displayName: (profile.name || "").trim(),
                avatarUrl: linuxDoAvatar(profile.avatar_template || ""),
                linuxDoId,
                storageQuota: settings.public.storage.defaultQuota,
                lastLoginAt: now(),
                extra: JSON.stringify({ linuxDo: profile }),
            }),
        );
        return { session: await newSession(user), redirect, bound: false, pendingToken: "" };
    }
    try {
        const session = await finishAccountLogin(bound, {
            displayName: syncedDisplayName(bound, profile.name),
            avatarUrl: firstNonEmpty(linuxDoAvatar(profile.avatar_template || ""), bound.avatarUrl),
            lastLoginAt: now(),
            extra: JSON.stringify({ linuxDo: profile }),
        });
        return { session, redirect, bound: false, pendingToken: "" };
    } catch (error) {
        throw Object.assign(error as Error, { redirect });
    }
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
        return finishAccountLogin(bound, { lastLoginAt: now(), affCode: bound.affCode || newAffCode() });
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
