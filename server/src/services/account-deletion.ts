import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { In, LessThanOrEqual, Not, type EntityManager } from "typeorm";

import { config } from "../config";
import { repo, serialTransaction } from "../db/data-source";
import {
    AgentMessage,
    AgentSession,
    CreditLog,
    GenerationOutput,
    InviteUse,
    Passkey,
    PhysicalBlob,
    Project,
    ProjectAccessLog,
    ProjectShare,
    StoredFile,
    Team,
    TeamCreditLog,
    TeamInvite,
    TeamInviteUse,
    TeamMember,
    User,
    UserAsset,
    UserPlugin,
} from "../db/entities";
import { fail, newAffCode, now } from "../lib/errors";
import { disconnectAgentShareSubscribers, disconnectAgentSubscribers, stopAgentSessionsForAccount } from "./agent";
import { blobReferenceCount, collectPendingBlobs } from "./blob-gc";
import { deleteFile } from "./files";
import { deleteGenerationHistoryJob } from "./generation-history";
import { disconnectJobSubscribers, stopJobsForAccount } from "./jobs";
import { disconnectProjectActor, disconnectShare } from "./project-realtime";
import { disconnectRealtimeUser } from "./realtime-hub";
import { getSettings } from "./settings";
import { requireActiveAccount } from "./account-fence";

export const ACCOUNT_DELETION_DELAY_MS = 24 * 60 * 60 * 1000;
const FINALIZATION_LEASE_MS = 15 * 60 * 1000;
const RESUME_TOKEN_KIND = "account-deletion-resume";
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function deletionTimes(requestedAt: string) {
    const requested = Date.parse(requestedAt);
    return { requestedAt, deletesAt: new Date(requested + ACCOUNT_DELETION_DELAY_MS).toISOString() };
}

function signResumeToken(user: User) {
    return jwt.sign({ kind: RESUME_TOKEN_KIND, userId: user.id, sessionVersion: user.sessionVersion }, config.jwtSecret, { expiresIn: "10m", subject: user.id });
}

async function assertNoTeams(manager: EntityManager, userId: string) {
    const memberships = await manager.getRepository(TeamMember).countBy({ userId });
    const owned = await manager.getRepository(Team).countBy({ ownerId: userId, status: Not("disbanded") });
    if (memberships || owned) throw fail("请先退出或解散所有团队后再注销账号", 400, "ACCOUNT_HAS_TEAMS");
}

/**
 * 账号加入/创建团队前先用一条自赋值 UPDATE 锁住用户行。注销申请也先更新同一行：
 * 两条路径无论谁先拿到锁，后拿到的一方都会看到提交后的真实状态，不会在“检查 active”与“插成员”之间穿过去。
 * SQLite 的事务默认是 deferred，这条 UPDATE 同时负责尽早取得写锁；不能只做一次普通 SELECT。
 */
export const requireActiveAccountForMembership = requireActiveAccount;

/** 登录凭据验证后的状态门禁；真正完成登录还必须走 auth.ts 的 sessionVersion 条件更新。 */
export async function assertAccountLoginAllowed(user: User) {
    if (user.status === "active") return;
    if (user.status === "ban") throw fail("账号已被禁用");
    if (user.status === "deleted" || user.status === "finalizing") throw fail("用户名或密码错误");
    const times = deletionTimes(user.deleteRequestedAt || user.updatedAt);
    if (Date.parse(times.deletesAt) <= Date.now()) {
        await finalizeAccountDeletion(user.id).catch((error) => console.error(`account deletion ${user.id} failed during login:`, error));
        throw fail("用户名或密码错误");
    }
    throw fail("此账号正在自助注销，确认登录将取消注销", 409, "ACCOUNT_DELETION_PENDING", {
        ...times,
        resumeToken: signResumeToken(user),
    });
}

export async function requestAccountDeletion(userId: string) {
    const result = await serialTransaction(async (manager) => {
        const users = manager.getRepository(User);
        const user = await users.findOneBy({ id: userId });
        if (!user) throw fail("用户不存在", 404);
        if (user.status === "deleted") throw fail("账号已注销");
        if (user.status === "deleting" && user.deleteRequestedAt) return { requestedAt: user.deleteRequestedAt, changed: false };
        if (user.status !== "active") throw fail("当前账号状态不允许自助注销");

        const requestedAt = now();
        const changed = await users.update(
            { id: userId, status: "active", sessionVersion: user.sessionVersion },
            {
                status: "deleting",
                sessionVersion: user.sessionVersion + 1,
                deleteRequestedAt: requestedAt,
                deleteFinalizingAt: "",
                deletedAt: "",
                updatedAt: requestedAt,
            },
        );
        if (!changed.affected) throw fail("账号状态已变化，请重试", 409, "ACCOUNT_DELETION_CHANGED");
        // 状态更新和团队检查同事务：检查失败会连上面的 deleting 一并回滚。
        await assertNoTeams(manager, userId);
        return { requestedAt, changed: true };
    });

    // deleting 状态本身已经让后续请求失效；这里再立即掐断已经建立的长连接与后台写入。
    // 重复申请也要重跑这一段：上一次可能在状态提交后、任务真正退出前进程中断。
    const shares = await repo(ProjectShare).findBy({ ownerId: userId });
    for (const share of shares) {
        disconnectShare(userId, share.projectId, share.id);
        disconnectAgentShareSubscribers(share.id);
    }
    disconnectRealtimeUser(userId);
    disconnectProjectActor(userId);
    disconnectAgentSubscribers(userId);
    disconnectJobSubscribers(userId);
    await stopAgentSessionsForAccount(userId);
    await stopJobsForAccount(userId);
    return deletionTimes(result.requestedAt);
}

export async function cancelAccountDeletion(token: string) {
    let payload: { kind?: string; userId?: string; sessionVersion?: number };
    try {
        payload = jwt.verify(token, config.jwtSecret) as typeof payload;
    } catch {
        throw fail("恢复登录确认已过期，请重新登录", 400, "ACCOUNT_RESUME_TOKEN_INVALID");
    }
    if (payload.kind !== RESUME_TOKEN_KIND || !payload.userId) throw fail("恢复登录确认无效，请重新登录", 400, "ACCOUNT_RESUME_TOKEN_INVALID");

    const users = repo(User);
    const user = await users.findOneBy({ id: payload.userId });
    if (!user || user.status !== "deleting" || user.sessionVersion !== Number(payload.sessionVersion || 0)) throw fail("账号注销状态已变化，请重新登录", 409, "ACCOUNT_DELETION_CHANGED");
    const { deletesAt } = deletionTimes(user.deleteRequestedAt || user.updatedAt);
    if (Date.parse(deletesAt) <= Date.now()) {
        await finalizeAccountDeletion(user.id).catch((error) => console.error(`account deletion ${user.id} failed during resume:`, error));
        throw fail("账号已完成注销");
    }

    const updatedAt = now();
    const canceled = await users.update(
        { id: user.id, status: "deleting", sessionVersion: user.sessionVersion },
        {
            status: "active",
            sessionVersion: user.sessionVersion + 1,
            deleteRequestedAt: "",
            deleteFinalizingAt: "",
            updatedAt,
        },
    );
    if (!canceled.affected) throw fail("账号注销状态已变化，请重新登录", 409, "ACCOUNT_DELETION_CHANGED");
    return users.findOneByOrFail({ id: user.id, status: "active", sessionVersion: user.sessionVersion + 1 });
}

type FinalizationClaim = { user: User; sessionVersion: number };

/** deleting -> finalizing，或在租约过期后接管崩溃的 finalizing。 */
async function claimFinalization(userId: string): Promise<FinalizationClaim | { done: User }> {
    return serialTransaction(async (manager) => {
        const users = manager.getRepository(User);
        const user = await users.findOneBy({ id: userId });
        if (!user) throw fail("用户不存在", 404);
        if (user.status === "deleted") return { done: user };
        if (user.status !== "deleting" && user.status !== "finalizing") throw fail("账号未处于注销流程");
        if (user.status === "finalizing") {
            const lease = Date.parse(user.deleteFinalizingAt || user.updatedAt);
            if (Number.isFinite(lease) && lease > Date.now() - FINALIZATION_LEASE_MS) throw fail("账号注销正在处理中", 409, "ACCOUNT_DELETION_IN_PROGRESS");
        }
        await assertNoTeams(manager, userId);
        const leaseAt = now();
        const nextVersion = user.sessionVersion + 1;
        const claimed = await users.update(
            {
                id: userId,
                status: user.status,
                sessionVersion: user.sessionVersion,
                ...(user.status === "finalizing" ? { deleteFinalizingAt: user.deleteFinalizingAt } : {}),
            },
            { status: "finalizing", sessionVersion: nextVersion, deleteFinalizingAt: leaseAt, updatedAt: leaseAt },
        );
        if (!claimed.affected) throw fail("账号注销状态已变化", 409, "ACCOUNT_DELETION_CHANGED");
        return { user: { ...user, status: "finalizing", sessionVersion: nextVersion, deleteFinalizingAt: leaseAt, updatedAt: leaseAt }, sessionVersion: nextVersion };
    });
}

async function renewFinalization(userId: string, sessionVersion: number, patch: Partial<User> = {}) {
    const leaseAt = now();
    const renewed = await repo(User).update(
        { id: userId, status: "finalizing", sessionVersion },
        { ...patch, deleteFinalizingAt: leaseAt, updatedAt: leaseAt },
    );
    if (!renewed.affected) {
        // MySQL 对“同一毫秒内写回相同租约时间”可能报 affected=0；状态与 owner 版本仍一致就算续租成功。
        const current = await repo(User).findOneBy({ id: userId });
        if (!current || current.status !== "finalizing" || current.sessionVersion !== sessionVersion) throw fail("账号注销状态已变化", 409, "ACCOUNT_DELETION_CHANGED");
    }
}

function cleanupChecksums(extra: string | null | undefined) {
    try {
        const parsed = JSON.parse(extra || "{}") as { accountDeletionChecksums?: unknown };
        return Array.isArray(parsed.accountDeletionChecksums) ? parsed.accountDeletionChecksums.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
    } catch {
        return [];
    }
}

/**
 * 真正的清理由 finalizing 租约独占。待清理 checksum 在第一次删除逻辑行前写进 User.extra：
 * 如果对象存储删除失败或进程崩溃，下一任租约持有者仍知道哪些零引用对象必须确认消失，不能误写“已注销”。
 */
export async function finalizeAccountDeletion(userId: string) {
    const claim = await claimFinalization(userId);
    if ("done" in claim) return claim.done;
    const { user, sessionVersion } = claim;

    await renewFinalization(userId, sessionVersion);
    const jobs = await stopJobsForAccount(userId);
    const files = await repo(StoredFile).findBy({ userId });
    const outputs = jobs.length ? await repo(GenerationOutput).findBy({ jobId: In(jobs.map((job) => job.id)) }) : [];
    const checksums = new Set([...cleanupChecksums(user.extra), ...files.map((file) => file.checksum), ...outputs.map((output) => output.checksum)].filter(Boolean));
    await renewFinalization(userId, sessionVersion, { extra: JSON.stringify({ accountDeletionChecksums: [...checksums] }) });

    for (const job of jobs) {
        await renewFinalization(userId, sessionVersion);
        await deleteGenerationHistoryJob(job.id);
    }

    const sessions = await stopAgentSessionsForAccount(userId);
    for (const session of sessions) {
        await renewFinalization(userId, sessionVersion);
        await repo(AgentMessage).delete({ userId: session.userId, sessionId: session.sessionId });
        await repo(AgentSession).delete({ userId: session.userId, sessionId: session.sessionId });
    }

    const shares = await repo(ProjectShare).findBy({ ownerId: userId });
    for (const share of shares) disconnectShare(userId, share.projectId, share.id);
    if (shares.length) await repo(ProjectAccessLog).delete({ shareId: In(shares.map((share) => share.id)) });
    await repo(ProjectAccessLog).delete({ actorId: userId });
    await repo(ProjectShare).delete({ ownerId: userId });

    await renewFinalization(userId, sessionVersion);
    await repo(Project).delete({ userId });
    await repo(UserAsset).delete({ userId });
    await repo(UserPlugin).delete({ userId });
    await repo(Passkey).delete({ userId });
    await repo(CreditLog).delete({ userId });
    await repo(InviteUse).delete({ userId });

    await repo(TeamInvite).delete({ createdBy: userId });
    await repo(TeamInviteUse).delete({ userId });
    await repo(TeamCreditLog).delete({ userId });
    await repo(TeamMember).update({ invitedBy: userId }, { invitedBy: "" });
    const disbandedTeams = await repo(Team).findBy({ ownerId: userId, status: "disbanded" });
    if (disbandedTeams.length) {
        const ids = disbandedTeams.map((team) => team.id);
        await repo(TeamInvite).delete({ teamId: In(ids) });
        await repo(TeamInviteUse).delete({ teamId: In(ids) });
        await repo(TeamCreditLog).delete({ teamId: In(ids) });
        await repo(Team).delete({ id: In(ids) });
    }

    for (const file of files) {
        await renewFinalization(userId, sessionVersion);
        await deleteFile(file.id, userId);
    }

    await repo(User).update({ inviterId: userId }, { inviterId: "" });
    await renewFinalization(userId, sessionVersion);
    await collectPendingBlobs({ graceMs: 0 });
    for (const checksum of checksums) {
        if ((await blobReferenceCount(checksum)) === 0 && (await repo(PhysicalBlob).exist({ where: { checksum } }))) {
            throw fail("账号文件清理失败，请稍后重试", 503, "ACCOUNT_FILE_CLEANUP_PENDING");
        }
    }

    const deletedAt = now();
    const deleted = await repo(User).update(
        { id: userId, status: "finalizing", sessionVersion },
        {
            username: `deleted:${userId}`,
            password: "",
            email: "",
            displayName: "",
            displayNameCustomized: false,
            avatarUrl: "",
            credits: 0,
            storageQuota: 0,
            affCode: "",
            affCount: 0,
            inviterId: "",
            linuxDoId: "",
            status: "deleted",
            sessionVersion: sessionVersion + 1,
            deleteRequestedAt: "",
            deleteFinalizingAt: "",
            deletedAt,
            deletedUsername: user.deletedUsername || user.username,
            lastLoginAt: "",
            preferences: "",
            extra: "",
            updatedAt: deletedAt,
        },
    );
    if (!deleted.affected) throw fail("账号注销状态已变化", 409, "ACCOUNT_DELETION_CHANGED");
    return repo(User).findOneByOrFail({ id: userId, status: "deleted", sessionVersion: sessionVersion + 1 });
}

export async function processDueAccountDeletions(at = new Date()) {
    const cutoff = new Date(at.getTime() - ACCOUNT_DELETION_DELAY_MS).toISOString();
    const staleLease = new Date(at.getTime() - FINALIZATION_LEASE_MS).toISOString();
    const rows = await repo(User).find({
        where: [
            { status: "deleting", deleteRequestedAt: LessThanOrEqual(cutoff) },
            { status: "finalizing", deleteFinalizingAt: LessThanOrEqual(staleLease) },
        ],
    });
    let completed = 0;
    for (const user of rows) {
        try {
            const result = await finalizeAccountDeletion(user.id);
            if (result.status === "deleted") completed += 1;
        } catch (error) {
            console.error(`account deletion ${user.id} failed:`, error);
        }
    }
    return completed;
}

export function startAccountDeletionCleanup() {
    void processDueAccountDeletions();
    const timer = setInterval(() => void processDueAccountDeletions(), CLEANUP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

/** 管理员重新启用只复活墓碑行，旧认证材料不会回来；必须设置全新的用户名和密码。 */
export async function reactivateDeletedAccount(userId: string, username: string, password: string) {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user || user.status !== "deleted") throw fail("该账号不是已注销状态");
    const name = username.trim();
    if (!name || /\s/.test(name)) throw fail("用户名不能为空且不能包含空格");
    if (password.length < 6) throw fail("新密码至少 6 位");
    const duplicate = await users.findOneBy({ username: name });
    if (duplicate && duplicate.id !== userId) throw fail("用户名已存在");
    const settings = await getSettings();
    const updatedAt = now();
    const reactivated = await users.update(
        { id: userId, status: "deleted", sessionVersion: user.sessionVersion },
        {
            username: name,
            password: await bcrypt.hash(password, 10),
            status: "active",
            sessionVersion: user.sessionVersion + 1,
            deleteRequestedAt: "",
            deleteFinalizingAt: "",
            deletedAt: "",
            deletedUsername: "",
            affCode: newAffCode(),
            storageQuota: settings.public.storage.defaultQuota,
            updatedAt,
        },
    );
    if (!reactivated.affected) throw fail("账号状态已变化，请刷新后重试");
    return users.findOneByOrFail({ id: userId, status: "active", sessionVersion: user.sessionVersion + 1 });
}
