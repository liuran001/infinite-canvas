import bcrypt from "bcryptjs";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { Like } from "typeorm";

import { config, warnDefaultSecurityConfig } from "../config";
import { repo } from "../db/data-source";
import { CreditLog, User, type CreditLogType, type UserRole, type UserStatus } from "../db/entities";
import { fail, firstNonEmpty, newAffCode, newId, now } from "../lib/errors";
import type { Query } from "../lib/response";
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
    };
}

export function guestUser(): AuthUser {
    return { id: "", username: "guest", displayName: "", avatarUrl: "", role: "guest", credits: 0, createdAt: "", updatedAt: "" };
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
    return jwt.sign({ userId: user.id, username: user.username, role: user.role }, config.jwtSecret, { expiresIn: `${config.jwtExpireHours}h`, subject: user.id });
}

async function newSession(user: User): Promise<AuthSession> {
    return { token: signToken(user), user: publicUser(user) };
}

export async function ensureDefaultAdmin() {
    if (!config.adminUsername || !config.adminPassword) return;
    warnDefaultSecurityConfig();
    const users = repo(User);
    if (await users.findOneBy({ role: "admin" })) return;
    await users.save(newUser({ username: config.adminUsername, password: await bcrypt.hash(config.adminPassword, 10), role: "admin" }));
}

export async function register(username: string, password: string) {
    const settings = await getSettings();
    if (!settings.public.auth.allowRegister) throw fail("当前未开放注册");
    const name = (username || "").trim();
    if (/\s/.test(name)) throw fail("用户名不能包含空格");
    if (!name || !password) throw fail("用户名和密码不能为空");
    const users = repo(User);
    if (await users.findOneBy({ username: name })) throw fail("用户名已存在");
    const user = await users.save(newUser({ username: name, password: await bcrypt.hash(password, 10) }));
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
        userId = String((jwt.verify(token, config.jwtSecret) as { userId?: string }).userId || "");
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
    return { items: items.map((user) => ({ ...user, password: "" })), total };
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
        : newUser({ username, email: input.email || "", displayName: input.displayName || "", role, status });
    if (password) user.password = await bcrypt.hash(password, 10);
    if (!user.password) throw fail("密码不能为空");
    return { ...(await users.save(user)), password: "" };
}

export async function deleteUser(id: string) {
    await repo(User).delete({ id });
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
    const users = repo(User);
    const user = await users.findOneBy({ id });
    if (!user) throw fail("用户不存在");
    const previous = user.credits;
    user.credits = credits;
    user.updatedAt = now();
    const saved = await users.save(user);
    if (previous !== credits) await writeCreditLog(id, "admin_adjust", credits - previous, credits, "后台手动调整");
    return { ...saved, password: "" };
}

/** 扣点走带条件的原子更新，余额不足时不会扣成负数。 */
export async function consumeUserCredits(userId: string, model: string, credits: number, path: string) {
    if (credits <= 0) return;
    const users = repo(User);
    const result = await users
        .createQueryBuilder()
        .update(User)
        .set({ credits: () => "credits - :credits", updatedAt: now() })
        .where("id = :userId AND credits >= :credits", { userId, credits })
        .setParameter("credits", credits)
        .execute();
    if (!result.affected) throw fail("算力点不足");
    const user = await users.findOneBy({ id: userId });
    await writeCreditLog(userId, "ai_consume", -credits, user?.credits || 0, `调用模型 ${model}`, { model, path });
}

export async function refundUserCredits(userId: string, model: string, credits: number, path: string) {
    if (credits <= 0) return;
    const users = repo(User);
    await users
        .createQueryBuilder()
        .update(User)
        .set({ credits: () => "credits + :credits", updatedAt: now() })
        .where("id = :userId", { userId })
        .setParameter("credits", credits)
        .execute();
    const user = await users.findOneBy({ id: userId });
    await writeCreditLog(userId, "ai_refund", credits, user?.credits || 0, `模型调用失败返还 ${model}`, { model, path });
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

export async function linuxDoAuthorizeUrl(req: Request, redirect: string) {
    const settings = await getSettings();
    if (!settings.public.auth.linuxDo.enabled) throw fail("Linux.do 登录未开启");
    const { clientId, clientSecret } = settings.private.auth.linuxDo;
    if (!clientId || !clientSecret) throw fail("Linux.do 登录未配置");
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: linuxDoRedirectUri(req),
        response_type: "code",
        scope: "read",
        state: Buffer.from(redirect || "/").toString("base64url"),
    });
    return `${config.linuxDo.authorizeUrl}?${params}`;
}

type LinuxDoProfile = { id?: number; username?: string; name?: string; avatar_template?: string };

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

export async function loginWithLinuxDo(req: Request, code: string, state: string) {
    const redirect = safeRedirectPath(Buffer.from(state || "", "base64url").toString("utf8") || "/");
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
    let user = await users.findOneBy({ linuxDoId });
    if (!user) {
        if (!settings.public.auth.allowRegister) throw Object.assign(fail("当前未开放注册"), { redirect });
        const base = (profile.username || "").trim() || `linuxdo-${linuxDoId}`;
        const username = (await users.findOneBy({ username: base })) ? `${base}-${linuxDoId}` : base;
        user = newUser({ username, displayName: (profile.name || "").trim(), avatarUrl: linuxDoAvatar(profile.avatar_template || ""), linuxDoId });
    } else if (user.status === "ban") {
        throw Object.assign(fail("账号已被禁用"), { redirect });
    }
    user.displayName = firstNonEmpty(profile.name, user.displayName);
    user.avatarUrl = firstNonEmpty(linuxDoAvatar(profile.avatar_template || ""), user.avatarUrl);
    user.lastLoginAt = now();
    user.updatedAt = now();
    user.extra = JSON.stringify({ linuxDo: profile });
    return { session: await newSession(await users.save(user)), redirect };
}
