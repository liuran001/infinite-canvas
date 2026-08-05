import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type AuthenticatorTransportFuture,
    type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Request } from "express";

import { repo, serialTransaction } from "../db/data-source";
import { Passkey, User } from "../db/entities";
import { fail, newAffCode, newId, now } from "../lib/errors";
import { finishAccountLogin, requestOrigin } from "./auth";
import { requireActiveAccountForMembership } from "./account-deletion";

const RP_NAME = "Infinite Canvas";
/** challenge 只在一次握手内有效，放内存即可，不必落库。 */
const CHALLENGE_TTL = 5 * 60 * 1000;

const challenges = new Map<string, { value: string; expiresAt: number }>();

function saveChallenge(key: string, value: string) {
    challenges.forEach((item, id) => item.expiresAt < Date.now() && challenges.delete(id));
    challenges.set(key, { value, expiresAt: Date.now() + CHALLENGE_TTL });
}

/** challenge 一次性消费，无论后续校验成功与否都不能复用。 */
function takeChallenge(key: string) {
    const found = challenges.get(key);
    challenges.delete(key);
    if (!found || found.expiresAt < Date.now()) throw fail("操作已超时，请重试");
    return found.value;
}

/** rpID 必须等于用户当前访问的域名，所以从请求推导而不是写死在配置里。 */
function relyingParty(req: Request) {
    const origin = requestOrigin(req);
    const rpID = URL.canParse(origin) ? new URL(origin).hostname : "";
    if (!rpID) throw fail("无法识别站点域名，Passkey 不可用");
    return { origin, rpID };
}

function allowedCredential(item: Passkey) {
    return { id: item.credentialId, transports: item.transports as AuthenticatorTransportFuture[] };
}

function publicPasskey(item: Passkey) {
    return { id: item.id, name: item.name, createdAt: item.createdAt };
}

export async function passkeyRegisterOptions(req: Request, userId: string) {
    const user = await repo(User).findOneBy({ id: userId });
    if (!user) throw fail("用户不存在");
    const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: relyingParty(req).rpID,
        userName: user.username,
        userDisplayName: user.displayName || user.username,
        userID: new TextEncoder().encode(user.id),
        // 已注册的凭证要排除掉，同一把钥匙不会被重复登记。
        excludeCredentials: (await repo(Passkey).findBy({ userId })).map(allowedCredential),
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    saveChallenge(`register:${userId}`, options.challenge);
    return options;
}

export async function passkeyRegisterVerify(req: Request, userId: string, response: RegistrationResponseJSON, name: string) {
    const { origin, rpID } = relyingParty(req);
    const expectedChallenge = takeChallenge(`register:${userId}`);
    const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // 生成 options 时用的是 preferred，这里再强制要求会把没做验证的设备挡在外面。
        requireUserVerification: false,
    }).catch(() => {
        throw fail("Passkey 校验失败，请重试");
    });
    if (!verification.verified) throw fail("Passkey 校验失败，请重试");
    const { credential } = verification.registrationInfo;
    const saved = await serialTransaction(async (manager) => {
        await requireActiveAccountForMembership(manager, userId);
        const item = manager.getRepository(Passkey).create({
            id: newId("passkey"),
            credentialId: credential.id,
            userId,
            publicKey: Buffer.from(credential.publicKey).toString("base64"),
            counter: credential.counter,
            transports: credential.transports || [],
            name: name.trim() || "我的 Passkey",
            createdAt: now(),
        });
        await manager.getRepository(Passkey).insert(item);
        return item;
    });
    return publicPasskey(saved);
}

/**
 * 不传用户名时 allowCredentials 留空，走 discoverable credential：
 * 由浏览器列出本机可用的 Passkey 让用户挑，登录页不需要先填账号。
 */
export async function passkeyLoginOptions(req: Request, username: string) {
    const name = (username || "").trim();
    const user = name ? await repo(User).findOneBy({ username: name }) : null;
    if (name && !user) throw fail("该账号不存在或未添加 Passkey");
    const credentials = user ? await repo(Passkey).findBy({ userId: user.id }) : [];
    if (name && !credentials.length) throw fail("该账号不存在或未添加 Passkey");
    const options = await generateAuthenticationOptions({
        rpID: relyingParty(req).rpID,
        allowCredentials: credentials.map(allowedCredential),
        userVerification: "preferred",
    });
    const flowId = newId("passkey-login");
    saveChallenge(flowId, options.challenge);
    return { flowId, options };
}

export async function passkeyLoginVerify(req: Request, flowId: string, response: AuthenticationResponseJSON) {
    const { origin, rpID } = relyingParty(req);
    const expectedChallenge = takeChallenge(flowId);
    const passkeys = repo(Passkey);
    const credential = await passkeys.findOneBy({ credentialId: String(response?.id || "") });
    if (!credential) throw fail("该 Passkey 未注册，请改用密码登录");
    const users = repo(User);
    const user = await users.findOneBy({ id: credential.userId });
    if (!user) throw fail("用户不存在");
    if (user.status === "ban") throw fail("账号已被禁用");
    const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
            id: credential.credentialId,
            publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64")),
            counter: credential.counter,
            transports: credential.transports as AuthenticatorTransportFuture[],
        },
    }).catch(() => {
        throw fail("Passkey 校验失败，请重试");
    });
    if (!verification.verified) throw fail("Passkey 校验失败，请重试");
    // counter 单调递增，回写后重放旧签名会被认证器计数校验挡下。
    const newCounter = verification.authenticationInfo.newCounter;
    await passkeys.update({ id: credential.id, userId: credential.userId, counter: credential.counter }, { counter: newCounter });
    const freshCredential = await passkeys.findOneBy({ id: credential.id, userId: credential.userId });
    if (!freshCredential || freshCredential.counter !== newCounter) throw fail("Passkey 状态已变化，请重试");
    return finishAccountLogin(user, { lastLoginAt: now(), affCode: user.affCode || newAffCode() });
}

export async function listPasskeys(userId: string) {
    const items = await repo(Passkey).find({ where: { userId }, order: { createdAt: "ASC" } });
    return items.map(publicPasskey);
}

export async function renamePasskey(userId: string, id: string, name: string) {
    const passkeys = repo(Passkey);
    const item = await passkeys.findOneBy({ id, userId });
    if (!item) throw fail("Passkey 不存在");
    if (!name.trim()) throw fail("名称不能为空");
    const next = name.trim();
    await serialTransaction(async (manager) => {
        await requireActiveAccountForMembership(manager, userId);
        const changed = await manager.getRepository(Passkey).update({ id, userId }, { name: next });
        if (!changed.affected) throw fail("Passkey 不存在");
    });
    return publicPasskey({ ...item, name: next });
}

/** 没有密码的账号删掉最后一个 Passkey 就再也登不进来，这里直接拦住。 */
export async function deletePasskey(userId: string, id: string) {
    const passkeys = repo(Passkey);
    if (!(await passkeys.findOneBy({ id, userId }))) throw fail("Passkey 不存在");
    const user = await repo(User).findOneBy({ id: userId });
    if (!user?.password && (await passkeys.countBy({ userId })) <= 1) throw fail("请先设置登录密码，否则删除后将无法登录");
    await passkeys.delete({ id, userId });
}
