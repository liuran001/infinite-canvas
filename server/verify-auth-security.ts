import "reflect-metadata";

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request } from "express";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 认证安全专项验证：Turnstile 必须由服务端复核；账号注销必须经历 24 小时冷静期，
 * 申请后所有旧 JWT 失效，完成后只保留墓碑用户行，并且全局去重文件不能误删其他账号的引用。
 * 用法：cd server && npx tsx verify-auth-security.ts
 */
const env = prepareEnv("verify-auth-security");
process.env.ADMIN_USERNAME = "verify-admin";
process.env.ADMIN_PASSWORD = "verify-admin-password";

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const {
        AgentMessage,
        AgentSession,
        CreditLog,
        GenerationOutput,
        Job,
        Passkey,
        PhysicalBlob,
        Project,
        ProjectShare,
        StoredFile,
        Team,
        TeamMember,
        User,
        UserAsset,
        UserPlugin,
    } = await import("./src/db/entities");
    const { adminSettings, getSettings, saveSettings } = await import("./src/services/settings");
    const { verifyTurnstile } = await import("./src/services/turnstile");
    const {
        cancelAccountDeletion,
        processDueAccountDeletions,
        reactivateDeletedAccount,
        requestAccountDeletion,
    } = await import("./src/services/account-deletion");
    const { currentAuthUser, ensureDefaultAdmin, linuxDoAuthorizeUrl, login, loginWithLinuxDo, newSession, register } = await import("./src/services/auth");
    const { charge } = await import("./src/services/billing");
    const { archiveJobOutputs } = await import("./src/services/generation-history");
    const { saveFile } = await import("./src/services/files");
    const { resolveProjectAccess } = await import("./src/services/project-access");
    const { createShare, guestSessionOf } = await import("./src/services/project-share");
    const { acceptTeamInvite, createTeamInvite } = await import("./src/services/team-invites");
    const { createTeam } = await import("./src/services/teams");
    const { newId, now } = await import("./src/lib/errors");

    await initDatabase();

    console.log("Turnstile 配置与服务端复核");
    await rejects("开启 Turnstile 但缺 Site Key 时拒绝保存", () => saveSettings({
        public: { auth: { turnstile: { siteKey: "", loginEnabled: true, registerEnabled: false, oauthCompleteEnabled: false } } },
        private: { auth: { turnstile: { secretKey: "secret-key" } } },
    } as never));
    await rejects("开启 Turnstile 但缺 Secret Key 时拒绝保存", () => saveSettings({
        public: { auth: { turnstile: { siteKey: "site-key", loginEnabled: true, registerEnabled: false, oauthCompleteEnabled: false } } },
        private: { auth: { turnstile: { secretKey: "" } } },
    } as never));
    await saveSettings({
        public: {
            auth: {
                allowRegister: true,
                requireInvite: false,
                linuxDo: { enabled: false },
                turnstile: { siteKey: "site-key", loginEnabled: true, registerEnabled: true, oauthCompleteEnabled: true },
            },
        },
        private: { auth: { turnstile: { secretKey: "secret-key" } } },
    } as never);
    check("后台读取时 Turnstile Secret 被抹空", (await adminSettings()).private.auth.turnstile.secretKey, "");
    await saveSettings({ private: { auth: { turnstile: { secretKey: "" } } } } as never);
    check("保存空 Secret 表示保持原值", (await getSettings()).private.auth.turnstile.secretKey, "secret-key");

    const originalFetch = globalThis.fetch;
    let verifyCalls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        verifyCalls += 1;
        const body = new URLSearchParams(String(init?.body || ""));
        check("Turnstile 校验向 Cloudflare 发送 Secret", body.get("secret"), "secret-key");
        check("Turnstile 校验发送客户端 token", body.get("response"), "captcha-ok");
        return new Response(JSON.stringify({ success: true, action: "login" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await verifyTurnstile("login", "captcha-ok", "127.0.0.1");
    check("开启登录验证码时确实访问 Cloudflare", verifyCalls, 1);
    await rejects("开启验证码但缺少 token 时拒绝", () => verifyTurnstile("login", "", "127.0.0.1"));
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await rejects("Cloudflare 成功但缺少 action 时拒绝", () => verifyTurnstile("login", "captcha-ok", "127.0.0.1"));
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, action: "register" }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    await rejects("Cloudflare action 与入口不一致时拒绝", () => verifyTurnstile("login", "captcha-ok", "127.0.0.1"));
    globalThis.fetch = originalFetch;

    await repo(User).save({
        id: "deleted-admin",
        username: "deleted:admin",
        password: "",
        email: "",
        displayName: "旧管理员",
        avatarUrl: "",
        role: "admin",
        credits: 0,
        storageQuota: 0,
        affCode: "deleted-admin",
        affCount: 0,
        inviterId: "",
        linuxDoId: "",
        status: "deleted",
        lastLoginAt: "",
        preferences: "",
        extra: "",
        createdAt: now(),
        updatedAt: now(),
    });
    await ensureDefaultAdmin();
    check("已注销管理员不阻止补建默认 active 管理员", await repo(User).countBy({ role: "admin", status: "active" }), 1);

    // 账号生命周期测试不依赖外部验证码，关掉三个入口后继续。
    await saveSettings({
        public: { auth: { turnstile: { siteKey: "site-key", loginEnabled: false, registerEnabled: false, oauthCompleteEnabled: false } } },
    } as never);

    console.log("注销申请、冷静期与全端失效");
    const victimSession = await register("victim", "password-1");
    const victim = await repo(User).findOneByOrFail({ id: victimSession.user.id });
    const oldToken = victimSession.token;
    const team = await repo(Team).save({
        id: "team-victim",
        name: "待退出团队",
        description: "",
        avatarUrl: "",
        ownerId: victim.id,
        credits: 0,
        storageQuota: 1 << 20,
        memberLimit: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
    });
    await repo(TeamMember).save({ teamId: team.id, userId: victim.id, role: "owner", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });
    await rejects("仍在团队中时不允许申请注销", () => requestAccountDeletion(victim.id));
    await repo(TeamMember).delete({ teamId: team.id, userId: victim.id });
    await repo(Team).delete({ id: team.id });

    await repo(Project).save({ userId: victim.id, projectId: "deletion-share", title: "注销分享", data: JSON.stringify({ nodes: [], connections: [] }), revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    const deletionShare = await createShare(victim.id, "deletion-share", { role: "viewer", allowAnonymous: true, allowClone: false, expiresAt: "", ownerPays: false, allowAnonymousEdit: false });
    const oldGuest = guestSessionOf(deletionShare.share, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    check("注销前旧 guest 可以访问分享", (await resolveProjectAccess({ user: null, guest: oldGuest }, "deletion-share", "read")).ownerId, victim.id);

    const request = await requestAccountDeletion(victim.id);
    check("注销申请给出 24 小时后的完成时间", Date.parse(request.deletesAt) - Date.parse(request.requestedAt), 24 * 60 * 60 * 1000);
    check("注销申请后账号进入 deleting", (await repo(User).findOneByOrFail({ id: victim.id })).status, "deleting");
    check("注销申请后旧 JWT 立即失效", await currentAuthUser(oldToken), null);
    await rejects("房主进入 deleting 后旧 guest 立即失效", () => resolveProjectAccess({ user: null, guest: oldGuest }, "deletion-share", "read"));
    await repo(User).update({ id: victim.id }, { credits: 10 });
    let deletingChargeError = "";
    try {
        await charge({ kind: "user", userId: victim.id }, 1, { model: "test-model", path: "/shared-owner-pay" });
    } catch (error) {
        deletingChargeError = error instanceof Error ? error.message : String(error);
    }
    check("注销冷静期账号不能继续为分享访客扣点", deletingChargeError, "账号不可用");

    let resumeToken = "";
    try {
        await login("victim", "password-1");
    } catch (error) {
        const pending = error as { code?: string; data?: { resumeToken?: string; deletesAt?: string } };
        check("冷静期登录返回稳定错误码", pending.code, "ACCOUNT_DELETION_PENDING");
        check("冷静期登录返回确认恢复 token", Boolean(pending.data?.resumeToken), true);
        check("冷静期登录返回预计完成时间", pending.data?.deletesAt, request.deletesAt);
        resumeToken = pending.data?.resumeToken || "";
    }
    const restored = await cancelAccountDeletion(resumeToken);
    check("确认登录会取消注销", restored.status, "active");
    check("取消注销后同一分享自动恢复", (await resolveProjectAccess({ user: null, guest: oldGuest }, "deletion-share", "read")).ownerId, victim.id);
    const restoredSession = await newSession(restored);
    check("取消注销后可以获得新登录态", (await currentAuthUser(restoredSession.token))?.id, victim.id);
    check("取消注销不会让申请前旧 token 复活", await currentAuthUser(oldToken), null);

    const collaborator = (await register("share-collaborator", "password-collaborator")).user;
    const collaboratorGuest = guestSessionOf(deletionShare.share, { accountId: collaborator.id, actorId: "", displayName: collaborator.displayName, avatarUrl: collaborator.avatarUrl });
    check("登录协作者注销前可使用分享令牌", (await resolveProjectAccess({ user: null, guest: collaboratorGuest }, "deletion-share", "read")).actorId, collaborator.id);
    await requestAccountDeletion(collaborator.id);
    await rejects("登录协作者申请注销后旧分享令牌立即失效", () => resolveProjectAccess({ user: null, guest: collaboratorGuest }, "deletion-share", "read"));

    console.log("认证完成与团队成员写入不能越过注销状态");
    const loginRaceSession = await register("login-race", "password-race");
    const loginRace = await repo(User).findOneByOrFail({ id: loginRaceSession.user.id });
    // bcrypt 校验期间并发申请注销：登录拿到的是旧 active 快照，完成阶段必须用 sessionVersion CAS，
    // 不能把 deleting 整行 save 回 active。
    await repo(User).update({ id: loginRace.id }, { password: await bcrypt.hash("password-race", 12) });
    const racingLogin = login("login-race", "password-race");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await requestAccountDeletion(loginRace.id);
    let racingLoginCode = "";
    try {
        await racingLogin;
    } catch (error) {
        racingLoginCode = String((error as { code?: string }).code || "");
    }
    check("并发注销后旧密码校验不能再签发登录态", racingLoginCode, "ACCOUNT_DELETION_PENDING");
    check("并发登录不能把 deleting 覆盖回 active", (await repo(User).findOneByOrFail({ id: loginRace.id })).status, "deleting");

    await rejects("deleting 账号不能创建团队", () => createTeam(loginRace.id, { name: "不应创建" }));
    const inviteOwner = (await register("invite-owner", "password-owner")).user;
    const inviteTeam = await createTeam(inviteOwner.id, { name: "邀请测试团队" });
    const invite = await createTeamInvite(inviteTeam.id, inviteOwner.id, { kind: "link", role: "member" });
    await rejects("deleting 账号不能领取团队邀请", () => acceptTeamInvite(invite.token, loginRace.id));

    await saveSettings({
        public: { auth: { linuxDo: { enabled: true } } },
        private: { auth: { linuxDo: { clientId: "linux-client", clientSecret: "linux-secret" } } },
    } as never);
    const bindUrl = await linuxDoAuthorizeUrl(
        { headers: { host: "canvas.example" }, protocol: "https" } as Request,
        "/canvas",
        restored.id,
    );
    const bindState = jwt.verify(String(new URL(bindUrl).searchParams.get("state") || ""), "verify-secret") as { bindSessionVersion?: number };
    check("Linux.do 绑定 state 固化当前 sessionVersion", bindState.bindSessionVersion, restored.sessionVersion);

    await requestAccountDeletion(restored.id);
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ access_token: "oauth-token" }), { status: 200, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ id: 12345, username: "linux-user", name: "Linux User", avatar_template: "" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await rejects("注销开始后旧 OAuth 绑定回调不能写回身份", () => loginWithLinuxDo({ headers: { host: "canvas.example" }, protocol: "https" } as Request, "oauth-code", String(new URL(bindUrl).searchParams.get("state") || "")));
    globalThis.fetch = originalFetch;
    check("被拒的旧 OAuth 回调没有留下三方身份", (await repo(User).findOneByOrFail({ id: restored.id })).linuxDoId, "");
    let secondResumeToken = "";
    try {
        await login("victim", "password-1");
    } catch (error) {
        secondResumeToken = String((error as { data?: { resumeToken?: string } }).data?.resumeToken || "");
    }
    await cancelAccountDeletion(secondResumeToken);

    const finalizingSession = await register("finalizing-user", "password-finalizing");
    await requestAccountDeletion(finalizingSession.user.id);
    let finalizingResumeToken = "";
    try {
        await login("finalizing-user", "password-finalizing");
    } catch (error) {
        finalizingResumeToken = String((error as { data?: { resumeToken?: string } }).data?.resumeToken || "");
    }
    const finalizing = await repo(User).findOneByOrFail({ id: finalizingSession.user.id });
    await repo(User).update(
        { id: finalizing.id },
        { status: "finalizing", sessionVersion: finalizing.sessionVersion + 1, deleteFinalizingAt: now(), updatedAt: now() },
    );
    await rejects("finalizing 租约一旦认领就不能再取消注销", () => cancelAccountDeletion(finalizingResumeToken));
    await repo(User).update({ id: finalizing.id }, { deleteFinalizingAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
    check("过期 finalizing 租约会被定时任务接管", await processDueAccountDeletions(new Date()), 1);
    check("接管后账号完成墓碑化", (await repo(User).findOneByOrFail({ id: finalizing.id })).status, "deleted");

    console.log("到期清理与全局物理文件引用安全");
    const survivorSession = await register("survivor", "password-2");
    const survivor = await repo(User).findOneByOrFail({ id: survivorSession.user.id });
    const bytes = Buffer.from("same-account-deletion-image");
    const victimFile = await saveFile(victim.id, bytes, "image/png");
    const survivorFile = await saveFile(survivor.id, bytes, "image/png");
    check("两个账号的相同图片只存一份物理对象", await repo(PhysicalBlob).count(), 1);

    await repo(Project).save({ userId: victim.id, projectId: "victim-project", title: "待清理画布", data: JSON.stringify({ nodes: [{ metadata: { storageKey: `server:${victimFile.id}` } }], connections: [] }), revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await createShare(victim.id, "victim-project", { role: "editor", allowAnonymous: true, allowClone: false, expiresAt: "", ownerPays: true, allowAnonymousEdit: true });
    await repo(UserAsset).save({ userId: victim.id, assetId: "asset-victim", kind: "image", title: "素材", data: JSON.stringify({ storageKey: `server:${victimFile.id}` }), revision: 1, deleted: false, createdAt: now(), updatedAt: now() });
    await repo(UserPlugin).save({ userId: victim.id, pluginId: "plugin-victim", data: "{}", revision: 1, deleted: false, createdAt: now(), updatedAt: now() });
    await repo(Passkey).save({ id: "passkey-victim", credentialId: "credential-victim", userId: victim.id, publicKey: "AA==", counter: 0, transports: [], name: "测试 Passkey", createdAt: now() });
    await repo(CreditLog).save({ id: "credit-victim", userId: victim.id, type: "admin_adjust", amount: 0, balance: 0, relatedId: "", refundOf: null, remark: "测试", extra: "", createdAt: now() });

    const job = await repo(Job).save({
        id: "job-victim",
        userId: victim.id,
        storageUserId: victim.id,
        payerUserId: victim.id,
        shareId: "",
        clientJobId: newId("client"),
        kind: "image",
        status: "succeeded",
        model: "image-model",
        prompt: "测试",
        params: "{}",
        inputFileIds: [],
        outputFileIds: [victimFile.id],
        text: "",
        context: {},
        error: "",
        credits: 1,
        progress: 100,
        seq: 1,
        upstreamTaskId: "",
        payerKind: "user",
        payerTeamId: "",
        payerLogId: "",
        storageTeamId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: now(),
    });
    await archiveJobOutputs(job);
    await repo(AgentSession).save({
        userId: victim.id,
        sessionId: "agent-victim",
        projectId: "victim-project",
        projectOwnerId: victim.id,
        shareId: "",
        payerUserId: victim.id,
        title: "待清理会话",
        status: "idle",
        model: "",
        error: "",
        lastSeq: 1,
        pendingAction: null,
        rounds: 0,
        autoRenamed: false,
        deleted: false,
        payerKind: "user",
        payerTeamId: "",
        payerLogId: "",
        payerCredits: 0,
        createdAt: now(),
        updatedAt: now(),
    });
    await repo(AgentMessage).save({
        userId: victim.id,
        sessionId: "agent-victim",
        seq: 1,
        role: "user",
        content: "待清理",
        toolName: "",
        toolArgs: "",
        toolResult: "",
        attachments: [victimFile.id],
        references: [],
        clientMessageId: "message-victim",
        createdAt: now(),
    });
    await repo(TeamMember).save({
        teamId: inviteTeam.id,
        userId: survivor.id,
        role: "member",
        creditLimit: 0,
        limitWindow: "month",
        status: "active",
        invitedBy: victim.id,
        joinedAt: now(),
        updatedAt: now(),
    });

    await requestAccountDeletion(victim.id);
    await repo(User).update({ id: victim.id }, { deleteRequestedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    check("到期任务处理一条注销", await processDueAccountDeletions(new Date()), 1);
    const deleted = await repo(User).findOneByOrFail({ id: victim.id });
    check("注销完成后用户行仍保留", deleted.status, "deleted");
    check("原用户名保留在审计字段", deleted.deletedUsername, "victim");
    check("真实用户名替换成唯一墓碑值", deleted.username.startsWith("deleted:"), true);
    check("密码被清空", deleted.password, "");
    check("三方登录绑定被清空", deleted.linuxDoId, "");
    check("Passkey 已删除", await repo(Passkey).countBy({ userId: victim.id }), 0);
    check("画布已删除", await repo(Project).countBy({ userId: victim.id }), 0);
    check("素材已删除", await repo(UserAsset).countBy({ userId: victim.id }), 0);
    check("插件已删除", await repo(UserPlugin).countBy({ userId: victim.id }), 0);
    check("分享已删除", await repo(ProjectShare).countBy({ ownerId: victim.id }), 0);
    check("Agent 会话已删除", await repo(AgentSession).countBy({ userId: victim.id }), 0);
    check("Agent 消息已删除", await repo(AgentMessage).countBy({ userId: victim.id }), 0);
    check("生成任务已删除", await repo(Job).countBy({ userId: victim.id }), 0);
    check("生成历史媒体引用已删除", await repo(GenerationOutput).countBy({ jobId: job.id }), 0);
    check("个人云空间文件行已删除", await repo(StoredFile).countBy({ userId: victim.id }), 0);
    check("另一个账号的相同图片仍存在", await repo(StoredFile).countBy({ id: survivorFile.id }), 1);
    check("共享物理对象仍然活跃", (await repo(PhysicalBlob).findOneByOrFail({ checksum: survivorFile.checksum })).state, "active");
    check("共享物理对象引用数没有多减", (await repo(PhysicalBlob).findOneByOrFail({ checksum: survivorFile.checksum })).refCount, 1);
    check("注销后其他成员记录不再引用注销账号为邀请人", (await repo(TeamMember).findOneByOrFail({ teamId: inviteTeam.id, userId: survivor.id })).invitedBy, "");

    const replacement = await register("victim", "replacement-password");
    check("注销后原用户名可重新注册", replacement.user.username, "victim");
    await rejects("原用户名已被新账号占用时不能直接恢复旧墓碑", () => reactivateDeletedAccount(deleted.id, "victim", "restored-password"));
    await saveSettings({ public: { storage: { defaultQuota: 234_567 } } } as never);
    const reactivated = await reactivateDeletedAccount(deleted.id, "victim-restored", "restored-password");
    check("管理员可用新用户名重新启用墓碑账号", reactivated.status, "active");
    check("重新启用账号采用当前系统默认云空间配额", reactivated.storageQuota, 234_567);
    check("重新启用必须设置新的密码", await bcrypt.compare("restored-password", reactivated.password), true);
    check("重新启用账号可以再次登录", (await login("victim-restored", "restored-password")).user.id, deleted.id);

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
