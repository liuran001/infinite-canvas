import { dataSource } from "../db/data-source";
import { CreditLog, User, type CreditLogType } from "../db/entities";
import { fail, newId, now } from "../lib/errors";

/**
 * 付费方。团队池是后续批次的事，这一批只有个人一种，所以联合类型现在只有一个成员；
 * 加团队时在这里补一个 `{ kind: "team"; ... }`，charge / refund 各多一个分支，调用点不用改。
 */
export type Payer = { kind: "user"; userId: string };

/** 扣费回执。退款只认它，不重新解析付费方，保证「谁付的退给谁」。 */
export type ChargeReceipt = { payer: Payer; credits: number; logId: string };

export type ChargeMeta = { model: string; path: string };

/**
 * 付费方由服务端解析，签名里刻意不接受任何来自客户端的付费方字段：
 * 客户端只能说「我在哪个画布/任务/会话里干活」，由谁买单是服务端的判断。
 */
export type BillingContext = { projectId?: string; jobId?: string; sessionId?: string };

export async function resolvePayer(userId: string, _context: BillingContext = {}): Promise<Payer> {
    return { kind: "user", userId };
}

/**
 * 进程内串行队列。SQLite 驱动全程只有一条连接，两个并发的 `BEGIN` 会直接报
 * 「cannot start a transaction within a transaction」，所以余额事务必须排队进出。
 * MySQL/Postgres 走连接池不需要它，但排队本身无害：计费的吞吐远低于一次上游模型调用的耗时。
 * 跨进程的正确性不依赖这把锁——那由事务内的条件更新与行锁保证。
 */
let creditQueue: Promise<unknown> = Promise.resolve();

function queueCreditWork<T>(work: () => Promise<T>): Promise<T> {
    const next = creditQueue.then(work, work);
    creditQueue = next.catch(() => undefined);
    return next;
}

/**
 * 余额变动与流水写入的唯一通道：条件更新 + 读回余额 + 插入流水在同一个事务里完成。
 * 三步分开做的话，进程在中间挂掉就是「钱扣了没流水」；并发下各自单独读一次余额，
 * 两条流水还会记到同一个 balance 上，对账时流水累加永远回不到 users.credits。
 * 事务只负责「三件事要么全成要么全不成」，不扣成负数仍然由 `WHERE credits >= :amount` 这个条件更新本身保证。
 */
async function moveUserCredits(userId: string, delta: number, type: CreditLogType, remark: string, extra: unknown) {
    return queueCreditWork(() =>
        dataSource.transaction(async (manager) => {
            const users = manager.getRepository(User);
            const result = await users
                .createQueryBuilder()
                .update(User)
                .set({ credits: () => (delta < 0 ? "credits - :amount" : "credits + :amount"), updatedAt: now() })
                .where(delta < 0 ? "id = :userId AND credits >= :amount" : "id = :userId", { userId })
                .setParameter("amount", Math.abs(delta))
                .execute();
            if (!result.affected) throw fail("算力点不足");
            const user = await users.findOneBy({ id: userId });
            const logId = newId("credit");
            await manager.getRepository(CreditLog).insert({
                id: logId,
                userId,
                type,
                amount: delta,
                balance: user?.credits || 0,
                relatedId: "",
                remark,
                extra: extra ? JSON.stringify(extra) : "",
                createdAt: now(),
            });
            return logId;
        }),
    );
}

/** 扣费。余额不足时不扣款也不写流水，错误语义与文案保持「算力点不足」。 */
export async function charge(payer: Payer, credits: number, meta: ChargeMeta): Promise<ChargeReceipt> {
    if (credits <= 0) return { payer, credits: 0, logId: "" };
    const logId = await moveUserCredits(payer.userId, -credits, "ai_consume", `调用模型 ${meta.model}`, { model: meta.model, path: meta.path });
    return { payer, credits, logId };
}

/** 原路退款。只读回执，回执金额为 0 时什么都不做。 */
export async function refund(receipt: ChargeReceipt, meta: ChargeMeta) {
    if (receipt.credits <= 0) return;
    await moveUserCredits(receipt.payer.userId, receipt.credits, "ai_refund", `模型调用失败返还 ${meta.model}`, { model: meta.model, path: meta.path });
}
