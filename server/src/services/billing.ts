import { serialTransaction } from "../db/data-source";
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
 * 余额变动与流水写入的唯一通道：条件更新 + 读回余额 + 插入流水在同一个事务里完成。
 * 三步分开做的话，进程在中间挂掉就是「钱扣了没流水」；并发下各自单独读一次余额，
 * 两条流水还会记到同一个 balance 上，对账时流水累加永远回不到 users.credits。
 * 事务只负责「三件事要么全成要么全不成」，不扣成负数仍然由 `WHERE credits >= :amount` 这个条件更新本身保证。
 */
async function moveUserCredits(userId: string, delta: number, type: CreditLogType, remark: string, extra: unknown) {
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
            relatedId: "",
            remark,
            extra: extra ? JSON.stringify(extra) : "",
            createdAt: now(),
        });
        return logId;
    });
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
