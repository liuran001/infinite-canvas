import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 计费专项验证：扣费与流水同事务、并发下 balance 快照正确、余额不足零副作用、原路退款、对账不变式。
 * 这些性质靠 smoke 的串行断言看不出来——非事务实现在单线程串行下同样能对上，
 * 只有并发交错才会暴露「两条流水记到同一个 balance」和「流水累加对不上余额」。
 * 团队池相关断言留给引入 Team 实体的批次，这里只覆盖 payer 为个人的分支。
 * 用法：cd server && npx tsx verify-billing.ts
 */
const env = prepareEnv("verify-billing");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { CreditLog, User } = await import("./src/db/entities");
    const { charge, refund, resolvePayer } = await import("./src/services/billing");
    const { adjustUserCredits, consumeUserCredits, refundUserCredits } = await import("./src/services/auth");
    const { now } = await import("./src/lib/errors");

    await initDatabase();
    const users = repo(User);
    const logs = repo(CreditLog);
    const makeUser = async (id: string, credits: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits, storageQuota: 1 << 20, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const creditsOf = async (id: string) => (await users.findOneByOrFail({ id })).credits;
    const logsOf = async (id: string) => logs.find({ where: { userId: id }, order: { createdAt: "ASC", id: "ASC" } });

    console.log("个人扣费与流水同事务");
    await makeUser("solo", 100);
    const receipt = await charge({ kind: "user", userId: "solo" }, 30, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("扣费后余额正确", await creditsOf("solo"), 70);
    check("流水条数为 1", await logs.countBy({ userId: "solo" }), 1);
    check("流水金额为负", (await logs.findOneByOrFail({ userId: "solo" })).amount, -30);
    check("流水 balance 是扣后余额", (await logs.findOneByOrFail({ userId: "solo" })).balance, 70);
    check("回执记录 payer 为个人", receipt.payer.kind, "user");
    check("回执带上流水 ID", Boolean(receipt.logId), true);

    await rejects("余额不足时拒绝", () => charge({ kind: "user", userId: "solo" }, 1000, { model: "gpt-x", path: "/x" }));
    check("被拒后余额不变", await creditsOf("solo"), 70);
    check("被拒后不写任何流水", await logs.countBy({ userId: "solo" }), 1);
    try {
        await charge({ kind: "user", userId: "solo" }, 1000, { model: "gpt-x", path: "/x" });
    } catch (error) {
        check("余额不足的错误文案不变", (error as Error).message, "算力点不足");
    }

    await refund(receipt, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("退款回到个人余额", await creditsOf("solo"), 100);
    check("退款写入 ai_refund 流水", await logs.countBy({ userId: "solo", type: "ai_refund" }), 1);
    check("退款流水 balance 是退款后余额", (await logs.findOneByOrFail({ userId: "solo", type: "ai_refund" })).balance, 100);

    console.log("零额与 payer 解析");
    const zero = await charge({ kind: "user", userId: "solo" }, 0, { model: "gpt-x", path: "/x" });
    check("零额不写流水", zero.logId, "");
    check("零额流水条数不变", await logs.countBy({ userId: "solo" }), 2);
    await refund(zero, { model: "gpt-x", path: "/x" });
    check("零额回执退款不动余额", await creditsOf("solo"), 100);
    check("无上下文时 payer 为个人", (await resolvePayer("solo", {})).kind, "user");
    check("画布上下文 payer 仍为个人", (await resolvePayer("solo", { projectId: "p-solo" })).kind, "user");

    console.log("并发扣费");
    await makeUser("racer", 10);
    // 20 笔并发、每笔 1 点，余额只够 10 笔：成功次数必须正好是 10，余额落到 0，一条流水都不能多。
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => charge({ kind: "user", userId: "racer" }, 1, { model: "m", path: "/x" }).then(() => true).catch(() => false)));
    const succeeded = outcomes.filter(Boolean).length;
    check("并发扣费成功次数等于余额上限", succeeded, 10);
    check("并发扣费余额不为负", await creditsOf("racer"), 0);
    const racerLogs = await logsOf("racer");
    check("流水条数等于成功次数", racerLogs.length, succeeded);
    // 关键断言：每次扣 1 点，10 条流水的 balance 必须是 9..0 各一次，不重复不倒挂。
    // 非事务实现下多个协程会各自读一次余额，这里会出现重复值。
    check(
        "每条流水的 balance 互不重复且逐级递减",
        racerLogs.map((row) => row.balance).sort((a, b) => b - a),
        [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    );

    console.log("并发退款");
    await makeUser("refunder", 0);
    await Promise.all(Array.from({ length: 12 }, () => refund({ payer: { kind: "user", userId: "refunder" }, credits: 1, logId: "" }, { model: "m", path: "/x" })));
    check("并发退款余额正确", await creditsOf("refunder"), 12);
    check(
        "并发退款每条 balance 互不重复",
        (await logsOf("refunder")).map((row) => row.balance).sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );

    console.log("旧入口薄封装行为不变");
    await makeUser("legacy", 5);
    await consumeUserCredits("legacy", "gpt-x", 3, "/legacy");
    check("旧扣费入口余额正确", await creditsOf("legacy"), 2);
    await rejects("旧扣费入口余额不足仍抛错", () => consumeUserCredits("legacy", "gpt-x", 99, "/legacy"));
    check("旧扣费入口被拒后不写流水", (await logsOf("legacy")).length, 1);
    await refundUserCredits("legacy", "gpt-x", 3, "/legacy");
    check("旧退款入口余额还原", await creditsOf("legacy"), 5);
    const legacyLogs = await logsOf("legacy");
    check("旧入口流水备注沿用原文案", legacyLogs.find((row) => row.type === "ai_consume")?.remark, "调用模型 gpt-x");
    check("旧退款流水备注沿用原文案", legacyLogs.find((row) => row.type === "ai_refund")?.remark, "模型调用失败返还 gpt-x");
    check("旧入口零额不写流水", await consumeUserCredits("legacy", "gpt-x", 0, "/legacy"), undefined);
    check("旧入口零额流水条数不变", (await logsOf("legacy")).length, 2);

    console.log("随机操作后的对账不变式");
    await makeUser("audit", 0);
    // createdAt 只到毫秒，同一毫秒内的多条流水没法靠时间排序，所以按操作顺序把新增的那条捡出来自己记账。
    const seen = new Set<string>();
    const ordered: { amount: number; balance: number }[] = [];
    const takeNewLogs = async () => {
        for (const row of await logsOf("audit")) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            ordered.push({ amount: row.amount, balance: row.balance });
        }
    };
    await adjustUserCredits("audit", 50);
    await takeNewLogs();
    let expected = 50;
    let mismatched = 0;
    for (let index = 0; index < 60; index += 1) {
        const dice = Math.random();
        if (dice < 0.5) {
            const amount = 1 + Math.floor(Math.random() * 9);
            const ok = await charge({ kind: "user", userId: "audit" }, amount, { model: "m", path: "/x" }).then(() => true).catch(() => false);
            if (ok) expected -= amount;
        } else if (dice < 0.8) {
            const amount = 1 + Math.floor(Math.random() * 5);
            await refund({ payer: { kind: "user", userId: "audit" }, credits: amount, logId: "" }, { model: "m", path: "/x" });
            expected += amount;
        } else {
            const target = Math.floor(Math.random() * 40);
            await adjustUserCredits("audit", target);
            expected = target;
        }
        await takeNewLogs();
        // 每一步都对账：流水最后一条的 balance 必须就是此刻库里的真实余额。
        if (ordered[ordered.length - 1].balance !== (await creditsOf("audit"))) mismatched += 1;
    }
    console.log("管理员调整与扣费并发");
    // 「设置成某个值」必须先读旧值才能算出流水里的 amount，而读了再写天然会丢更新：
    // 读到 100 的同时用户花掉 20，写回 150 就把那 20 点凭空还了回去。串行断言看不出这一点。
    await makeUser("race", 100);
    await Promise.all([adjustUserCredits("race", 150), charge({ kind: "user", userId: "race" }, 20, { model: "m", path: "/x" })]);
    const raceLogs = await logsOf("race");
    const raceBalance = await creditsOf("race");
    check("并发调整后流水最后一条的 balance 等于真实余额", raceLogs[raceLogs.length - 1].balance, raceBalance);
    check("并发调整逐条回放能还原余额", raceLogs.every((row, index) => (index ? row.balance === raceLogs[index - 1].balance + row.amount : true)), true);
    // 两种交错都合法：先扣后调停在 150，先调后扣停在 130。落在这两个值之外说明有一次写入被覆盖了。
    check("并发调整的结果是两种合法交错之一", [130, 150].includes(raceBalance), true);

    check("随机操作后余额与预期一致", await creditsOf("audit"), expected);
    check("每一步操作后流水 balance 都等于真实余额", mismatched, 0);
    check("最后一条流水的 balance 等于当前余额", ordered[ordered.length - 1].balance, await creditsOf("audit"));
    // 逐条回放：扣费/退款的 balance 必须等于「上一条 balance + 本条 amount」，管理员调整是覆盖式改写，只校验它自己自洽。
    check("逐条回放流水能还原出每一步余额", ordered.every((row, index) => row.balance === (index ? ordered[index - 1].balance : 0) + row.amount), true);
    check("随机操作中余额从未为负", ordered.every((row) => row.balance >= 0), true);

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
