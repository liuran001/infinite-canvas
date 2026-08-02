import { repo, serialTransaction } from "../db/data-source";
import { AgentSession, CreditLog, Job, Project, Team, TeamCreditLog, TeamMember, User, type CreditLogType, type TeamLimitWindow } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
import { getPreferences } from "./preferences";
import { canTeamAction } from "./team-access";

/**
 * 付费方。个人与团队是两本完全独立的账，各自有余额与流水，
 * 由谁买单只在调用发起时解析一次并固化，之后（尤其是退款时）不再重算。
 */
export type Payer = { kind: "user"; userId: string } | { kind: "team"; teamId: string; memberId: string };

/** 扣费回执。退款只认它，不重新解析付费方，保证「谁付的退给谁」。 */
export type ChargeReceipt = { payer: Payer; credits: number; logId: string };

export type ChargeMeta = { model: string; path: string };

/**
 * 付费方由服务端解析，签名里刻意不接受任何来自客户端的付费方字段：
 * 客户端只能说「我在哪个画布/任务/会话里干活」，由谁买单是服务端按库里的持久归属做的判断。
 * 这个类型里永远不会出现 teamId——多一个字段，前端就能直接点名让别人的团队付钱。
 */
export type BillingContext = { projectId?: string; jobId?: string; sessionId?: string };

export const TEAM_CREDITS_EXHAUSTED = "TEAM_CREDITS_EXHAUSTED";
export const TEAM_MEMBER_LIMIT_EXCEEDED = "TEAM_MEMBER_LIMIT_EXCEEDED";
export const TEAM_SPEND_FORBIDDEN = "TEAM_SPEND_FORBIDDEN";

/** 成员周期额度的窗口起点。total 没有起点，用空串表示「从开天辟地算起」，字符串比较天然成立。 */
function windowStart(window: TeamLimitWindow) {
    const date = new Date();
    if (window === "day") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
    if (window === "month") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
    return "";
}

/**
 * 成员在本窗口已经花掉多少，按团队流水实时聚合，不落任何冗余计数列：
 * 冗余列只要漏改一条路径（退款、管理员调整、并发回滚）就会永久漂移，而漂移的额度是查不出来的。
 * 退款一并计入（amount 为正），否则失败重试几次就能把额度白白耗光。
 */
async function usedByMember(teamId: string, userId: string, window: TeamLimitWindow) {
    const start = windowStart(window);
    const query = repo(TeamCreditLog)
        .createQueryBuilder("log")
        .select("SUM(log.amount)", "total")
        .where("log.teamId = :teamId AND log.userId = :userId", { teamId, userId })
        .andWhere("log.type IN (:...types)", { types: ["ai_consume", "ai_refund"] });
    if (start) query.andWhere("log.createdAt >= :start", { start });
    const row = await query.getRawOne<{ total: string | number | null }>();
    return -Number(row?.total || 0);
}

/** 团队消费的资格：团队在用、成员在册且状态正常、角色允许花钱。三者缺一都不能动团队池。 */
async function assertCanSpend(teamId: string, memberId: string) {
    const team = await repo(Team).findOneBy({ id: teamId });
    if (!team || team.status !== "active") throw fail("团队不可用", 403, TEAM_SPEND_FORBIDDEN);
    const member = await repo(TeamMember).findOneBy({ teamId, userId: memberId });
    if (!member || member.status !== "active") throw fail("你不是该团队的正常成员", 403, TEAM_SPEND_FORBIDDEN);
    if (!canTeamAction(member.role, "credits.spend")) throw fail("你在该团队中没有消费权限", 403, TEAM_SPEND_FORBIDDEN);
    return member;
}

/**
 * 余额变动与流水写入的唯一通道：条件更新 + 读回余额 + 插入流水在同一个事务里完成。
 * 三步分开做的话，进程在中间挂掉就是「钱扣了没流水」；并发下各自单独读一次余额，
 * 两条流水还会记到同一个 balance 上，对账时流水累加永远回不到 users.credits。
 * 事务只负责「三件事要么全成要么全不成」，不扣成负数仍然由 `WHERE credits >= :amount` 这个条件更新本身保证。
 */
async function moveUserCredits(userId: string, delta: number, type: CreditLogType, remark: string, extra: unknown, relatedId = "") {
    return serialTransaction(async (manager) => {
        const users = manager.getRepository(User);
        const result = await users
            .createQueryBuilder()
            .update(User)
            .set({ credits: () => (delta < 0 ? "credits - :amount" : "credits + :amount"), updatedAt: now() })
            .where(delta < 0 ? "id = :userId AND credits >= :amount" : "id = :userId", { userId })
            .setParameter("amount", Math.abs(delta))
            .execute();
        if (!result.affected) throw fail(delta < 0 ? "算力点不足" : "用户不存在");
        const user = await users.findOneBy({ id: userId });
        const logId = newId("credit");
        await manager.getRepository(CreditLog).insert({
            id: logId,
            userId,
            type,
            amount: delta,
            balance: user?.credits || 0,
            relatedId,
            remark,
            extra: extra ? JSON.stringify(extra) : "",
            createdAt: now(),
        });
        return logId;
    });
}

/** 团队池的同一套动作。条件更新挡住并发超扣，流水与余额同事务，balance 记的是团队池而不是谁的个人余额。 */
async function moveTeamCredits(teamId: string, memberId: string, delta: number, type: "ai_consume" | "ai_refund", meta: ChargeMeta, remark: string, relatedId = "") {
    return serialTransaction(async (manager) => {
        const teams = manager.getRepository(Team);
        const result = await teams
            .createQueryBuilder()
            .update(Team)
            .set({ credits: () => (delta < 0 ? "credits - :amount" : "credits + :amount"), updatedAt: now() })
            .where(delta < 0 ? "id = :teamId AND credits >= :amount" : "id = :teamId", { teamId })
            .setParameter("amount", Math.abs(delta))
            .execute();
        if (!result.affected) return "";
        const team = await teams.findOneBy({ id: teamId });
        const logId = newId("team-credit");
        await manager.getRepository(TeamCreditLog).insert({
            id: logId,
            teamId,
            userId: memberId,
            type,
            amount: delta,
            balance: team?.credits || 0,
            model: meta.model,
            relatedId,
            remark,
            extra: JSON.stringify({ model: meta.model, path: meta.path }),
            createdAt: now(),
        });
        return logId;
    });
}

/** 团队池不足的留痕。金额 0，只为让成员和管理员事后查得出「这里被拒过一次」。 */
async function logInsufficient(teamId: string, memberId: string, credits: number, meta: ChargeMeta) {
    const team = await repo(Team).findOneBy({ id: teamId });
    await repo(TeamCreditLog).insert({
        id: newId("team-credit"),
        teamId,
        userId: memberId,
        type: "insufficient",
        amount: 0,
        balance: team?.credits || 0,
        model: meta.model,
        relatedId: "",
        remark: `团队算力点不足，本次需要 ${credits}`,
        extra: JSON.stringify({ model: meta.model, path: meta.path, needed: credits }),
        createdAt: now(),
    });
}

/**
 * 扣费。余额不足时不扣款也不写消费流水，错误语义与文案保持「算力点不足」。
 * 团队池不足默认直接拒绝：悄悄改扣个人余额等于替用户做了一次付款决定，
 * 只有用户本人在偏好里显式打开 billingFallbackToPersonal 才回落，而且回落后的回执 payer 就是个人，
 * 退款照样退回个人——两本账从头到尾没有互相担保过。
 */
export async function charge(payer: Payer, credits: number, meta: ChargeMeta): Promise<ChargeReceipt> {
    if (credits <= 0) return { payer, credits: 0, logId: "" };
    if (payer.kind === "user") {
        const logId = await moveUserCredits(payer.userId, -credits, "ai_consume", `调用模型 ${meta.model}`, { model: meta.model, path: meta.path });
        return { payer, credits, logId };
    }

    const member = await assertCanSpend(payer.teamId, payer.memberId);
    if (member.creditLimit > 0) {
        const used = await usedByMember(payer.teamId, payer.memberId, member.limitWindow);
        if (used + credits > member.creditLimit) throw fail(`已超出你在该团队的额度：${used}/${member.creditLimit}`, 403, TEAM_MEMBER_LIMIT_EXCEEDED);
    }

    const logId = await moveTeamCredits(payer.teamId, payer.memberId, -credits, "ai_consume", meta, `调用模型 ${meta.model}`);
    if (logId) return { payer, credits, logId };

    await logInsufficient(payer.teamId, payer.memberId, credits, meta);
    const preferences = await getPreferences(payer.memberId);
    if (preferences.billingFallbackToPersonal !== true) throw fail("团队算力点不足", 403, TEAM_CREDITS_EXHAUSTED);
    // 回落是另一笔账：付费方从此就是个人，回执里再也看不到团队，退款自然也回不到团队池。
    const personal: Payer = { kind: "user", userId: payer.memberId };
    const fallbackLogId = await moveUserCredits(payer.memberId, -credits, "ai_consume", `调用模型 ${meta.model}`, { model: meta.model, path: meta.path, fallbackFromTeamId: payer.teamId });
    return { payer: personal, credits, logId: fallbackLogId };
}

/**
 * 原路退款。只读回执，回执金额为 0 时什么都不做。
 * 团队停用、成员已被移出都照退不误：钱是当初从那个池子里扣走的，
 * 退款是把它放回原处，不是一次需要重新鉴权的新消费。
 */
export async function refund(receipt: ChargeReceipt, meta: ChargeMeta) {
    if (receipt.credits <= 0) return;
    if (receipt.payer.kind === "user") {
        await moveUserCredits(receipt.payer.userId, receipt.credits, "ai_refund", `模型调用失败返还 ${meta.model}`, { model: meta.model, path: meta.path }, receipt.logId);
        return;
    }
    await moveTeamCredits(receipt.payer.teamId, receipt.payer.memberId, receipt.credits, "ai_refund", meta, `模型调用失败返还 ${meta.model}`, receipt.logId);
}

/** 任务上固化的付费方。存量任务读出来的 payerKind 就是 user，因此老任务的行为一字不变。 */
export function payerOfJob(job: Pick<Job, "userId" | "payerKind" | "payerTeamId">): Payer {
    return job.payerKind === "team" && job.payerTeamId ? { kind: "team", teamId: job.payerTeamId, memberId: job.userId } : { kind: "user", userId: job.userId };
}

export function payerOfSession(session: Pick<AgentSession, "userId" | "payerKind" | "payerTeamId">): Payer {
    return session.payerKind === "team" && session.payerTeamId ? { kind: "team", teamId: session.payerTeamId, memberId: session.userId } : { kind: "user", userId: session.userId };
}

/**
 * 从任务行还原扣费回执。任务可能跨进程重启后才走到退款，那时内存里的回执早没了，
 * 而退款必须原路：付费方与原始流水 ID 都只能从行上读回来。
 */
export function receiptOfJob(job: Pick<Job, "userId" | "payerKind" | "payerTeamId" | "payerLogId" | "credits">): ChargeReceipt {
    return { payer: payerOfJob(job), credits: job.credits, logId: job.payerLogId || "" };
}

/**
 * 画布的付费方。画布归属是库里的持久事实，不按「这个人在哪些团队里」猜：
 * 多团队用户立刻就会歧义，而歧义的默认值意味着钱会从一个用户没预期的池子里出去。
 * 画布挂在团队上、调用者却已经不是能消费的成员时直接拒绝，不静默改扣个人：
 * 那既瞒着用户花了他自己的钱，也把「他还能用这张团队画布」这件已经不成立的事伪装成成立。
 */
export async function payerOfProject(userId: string, projectId: string): Promise<Payer> {
    const project = await repo(Project).findOneBy({ userId, projectId });
    if (!project || project.deleted || !project.teamId) return { kind: "user", userId };
    await assertCanSpend(project.teamId, userId);
    return { kind: "team", teamId: project.teamId, memberId: userId };
}

/**
 * 服务端解析付费方。只读库里的持久归属：画布的 teamId、任务与会话上固化的 payer 两列，
 * 客户端能影响的只有「我在哪个资源里」，而那个资源必须是按 userId 查得到的自己的资源。
 */
export async function resolvePayer(userId: string, context: BillingContext = {}): Promise<Payer> {
    if (context.jobId) {
        const job = await repo(Job).findOneBy({ id: context.jobId, userId });
        if (job) return payerOfJob(job);
    }
    if (context.sessionId) {
        const session = await repo(AgentSession).findOneBy({ userId, sessionId: context.sessionId });
        if (session) return payerOfSession(session);
    }
    if (context.projectId) return payerOfProject(userId, context.projectId);
    return { kind: "user", userId };
}

const SET_RETRIES = 5;

/**
 * 管理员把余额直接改成某个值。语义是覆盖而非增减，所以必须先读旧值才算得出流水里的 amount，
 * 而「读了再写」天然会丢更新：读到 100 的同时用户花掉 20，写回 150 就把那 20 点凭空还了回去，
 * 流水累加从此对不上余额。用读到的旧值当更新条件，被别人抢先就重读重算
 * ——与画布保存的 revision 冲突是同一套思路，只是这里能直接重试，不必让调用方参与合并。
 */
export async function setUserCredits(userId: string, credits: number) {
    const next = Math.max(0, Math.floor(credits));
    for (let attempt = 0; attempt < SET_RETRIES; attempt += 1) {
        const settled = await serialTransaction(async (manager) => {
            const users = manager.getRepository(User);
            const user = await users.findOneBy({ id: userId });
            if (!user) throw fail("用户不存在");
            if (user.credits === next) return user;
            const result = await users.update({ id: userId, credits: user.credits }, { credits: next, updatedAt: now() });
            if (!result.affected) return null;
            await manager.getRepository(CreditLog).insert({
                id: newId("credit"),
                userId,
                type: "admin_adjust",
                amount: next - user.credits,
                balance: next,
                relatedId: "",
                remark: "后台手动调整",
                extra: "",
                createdAt: now(),
            });
            return { ...user, credits: next };
        });
        if (settled) return settled;
    }
    throw fail("余额正在变动，请稍后重试");
}
