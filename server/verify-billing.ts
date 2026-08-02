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
    const { adjustUserCredits } = await import("./src/services/auth");
    const { newId, now } = await import("./src/lib/errors");

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

    console.log("退款必须凭真实扣费回执");
    await makeUser("strict", 100);
    const strict = await charge({ kind: "user", userId: "strict" }, 10, { model: "m", path: "/x" });
    await rejects("非零退款没有流水 ID 时拒绝", () => refund({ payer: { kind: "user", userId: "strict" }, credits: 10, logId: "" }, { model: "m", path: "/x" }));
    await rejects("流水 ID 不存在时拒绝", () => refund({ payer: { kind: "user", userId: "strict" }, credits: 10, logId: "credit-nope" }, { model: "m", path: "/x" }));
    await rejects("付款方与原始扣费不符时拒绝", () => refund({ payer: { kind: "user", userId: "solo" }, credits: 10, logId: strict.logId }, { model: "m", path: "/x" }));
    await rejects("退款金额与原始扣费不符时拒绝", () => refund({ payer: { kind: "user", userId: "strict" }, credits: 99, logId: strict.logId }, { model: "m", path: "/x" }));
    check("被拒的退款一分钱都没退出去", await creditsOf("strict"), 90);
    check("被拒的退款没有写任何退款流水", await logs.countBy({ userId: "strict", type: "ai_refund" }), 0);
    check("首次退款成功", await refund(strict, { model: "m", path: "/x" }), true);
    check("首次退款后余额还原", await creditsOf("strict"), 100);
    // 幂等：崩溃重启后的重放会再退一次，这一次必须是空操作而不是又加一笔钱。
    check("重复退款返回 false", await refund(strict, { model: "m", path: "/x" }), false);
    check("重复退款不改余额", await creditsOf("strict"), 100);
    check("重复退款不写第二条退款流水", await logs.countBy({ userId: "strict", type: "ai_refund" }), 1);
    check("退款流水记住了原始扣费", (await logs.findOneByOrFail({ userId: "strict", type: "ai_refund" })).refundOf, strict.logId);
    // 并发重放：只有一笔能落地，靠 refundOf 唯一索引，而不是靠调用方自觉。
    await makeUser("replayer", 50);
    const replayed = await charge({ kind: "user", userId: "replayer" }, 20, { model: "m", path: "/x" });
    const replays = await Promise.all(Array.from({ length: 8 }, () => refund(replayed, { model: "m", path: "/x" }).catch(() => false)));
    check("并发重放只有一次真正退款", replays.filter(Boolean).length, 1);
    check("并发重放后余额只加回一次", await creditsOf("replayer"), 50);
    check("并发重放只写一条退款流水", await logs.countBy({ userId: "replayer", type: "ai_refund" }), 1);

    console.log("并发退款");
    await makeUser("refunder", 12);
    const refundReceipts = await Promise.all(Array.from({ length: 12 }, () => charge({ kind: "user", userId: "refunder" }, 1, { model: "m", path: "/x" })));
    check("并发退款前余额已被扣光", await creditsOf("refunder"), 0);
    await Promise.all(refundReceipts.map((item) => refund(item, { model: "m", path: "/x" })));
    check("并发退款余额正确", await creditsOf("refunder"), 12);
    check(
        "并发退款每条 balance 互不重复",
        (await logsOf("refunder")).filter((row) => row.type === "ai_refund").map((row) => row.balance).sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );

    console.log("扣费与退款的公共入口行为");
    await makeUser("legacy", 5);
    const legacyReceipt = await charge({ kind: "user", userId: "legacy" }, 3, { model: "gpt-x", path: "/legacy" });
    check("扣费后余额正确", await creditsOf("legacy"), 2);
    await rejects("余额不足仍抛错", () => charge({ kind: "user", userId: "legacy" }, 99, { model: "gpt-x", path: "/legacy" }));
    check("被拒后不写流水", (await logsOf("legacy")).length, 1);
    await refund(legacyReceipt, { model: "gpt-x", path: "/legacy" });
    check("退款后余额还原", await creditsOf("legacy"), 5);
    const legacyLogs = await logsOf("legacy");
    check("扣费流水备注沿用原文案", legacyLogs.find((row) => row.type === "ai_consume")?.remark, "调用模型 gpt-x");
    check("退款流水备注沿用原文案", legacyLogs.find((row) => row.type === "ai_refund")?.remark, "模型调用失败返还 gpt-x");
    check("零额扣费不写流水", (await charge({ kind: "user", userId: "legacy" }, 0, { model: "gpt-x", path: "/legacy" })).logId, "");
    check("零额流水条数不变", (await logsOf("legacy")).length, 2);

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
    // 退款只能针对真实存在、尚未退过的那笔扣费，所以随机流程里要自己攒着扣费回执。
    const pending: Awaited<ReturnType<typeof charge>>[] = [];
    for (let index = 0; index < 60; index += 1) {
        const dice = Math.random();
        if (dice < 0.5 || !pending.length) {
            const amount = 1 + Math.floor(Math.random() * 9);
            const done = await charge({ kind: "user", userId: "audit" }, amount, { model: "m", path: "/x" }).catch(() => null);
            if (done) {
                expected -= amount;
                pending.push(done);
            }
        } else if (dice < 0.8) {
            const target = pending.shift();
            if (target) {
                await refund(target, { model: "m", path: "/x" });
                expected += target.credits;
            }
        } else {
            const value = Math.floor(Math.random() * 40);
            await adjustUserCredits("audit", value);
            expected = value;
            // 覆盖式改写之后，之前那些扣费的余额语义已经断了，但退款仍然合法，回执照留。
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
    // 两条流水常落在同一毫秒里，createdAt 排不出先后，id 又是随机的，所以按「谁的 balance 等于最终余额」定序：
    // 那一条必然是后写入的。不这么定序的话这两条断言会随机翻车，而它们要验的是丢更新，不是排序。
    const ordered2 = [...raceLogs].sort((a, b) => Number(a.balance === raceBalance) - Number(b.balance === raceBalance));
    check("并发调整后流水最后一条的 balance 等于真实余额", ordered2[ordered2.length - 1].balance, raceBalance);
    check("并发调整逐条回放能还原余额", ordered2.every((row, index) => (index ? row.balance === ordered2[index - 1].balance + row.amount : true) || row.type === "admin_adjust"), true);
    // 两种交错都合法：先扣后调停在 150，先调后扣停在 130。落在这两个值之外说明有一次写入被覆盖了。
    check("并发调整的结果是两种合法交错之一", [130, 150].includes(raceBalance), true);

    check("随机操作后余额与预期一致", await creditsOf("audit"), expected);
    check("每一步操作后流水 balance 都等于真实余额", mismatched, 0);
    check("最后一条流水的 balance 等于当前余额", ordered[ordered.length - 1].balance, await creditsOf("audit"));
    // 逐条回放：扣费/退款的 balance 必须等于「上一条 balance + 本条 amount」，管理员调整是覆盖式改写，只校验它自己自洽。
    check("逐条回放流水能还原出每一步余额", ordered.every((row, index) => row.balance === (index ? ordered[index - 1].balance : 0) + row.amount), true);
    check("随机操作中余额从未为负", ordered.every((row) => row.balance >= 0), true);

    await teamBilling({ check, rejects });
    await legacyCompatibility({ check, rejects });
    await crashWindows({ check });
    await refundConflictShapes({ check });
    await insufficientThroughCallers({ check, rejects });

    finish(env.root);
}

/**
 * 「已经退过了」这个判断必须精确到 refundOf 那条约束。
 * 放宽成「任何唯一冲突」的话，主键冲突（ID 生成撞车）会被当成一次成功的空操作：
 * 那笔钱从此没人退，现场还干干净净什么都查不到。三种驱动报冲突的形状各不相同，逐个盯住。
 */
async function refundConflictShapes({ check }: { check: (name: string, actual: unknown, expected: unknown) => void }) {
    const { repo } = await import("./src/db/data-source");
    const { CreditLog } = await import("./src/db/entities");
    const { isRefundOfUniqueViolation, isUniqueViolation } = await import("./src/lib/db-errors");
    const { newId, now } = await import("./src/lib/errors");

    console.log("退款唯一冲突的识别范围");
    // 三种驱动的真实错误形状，逐个断言，避免只在 SQLite 上碰巧成立。
    const sqlite = { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: credit_logs.refundOf" };
    const sqliteTeam = { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint failed: team_credit_logs.refundOf" };
    const mysql = { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: "Duplicate entry 'credit-1' for key 'uq_credit_logs_refund_of'" };
    const postgres = { code: "23505", table: "credit_logs", constraint: "uq_credit_logs_refund_of", detail: 'Key ("refundOf")=(credit-1) already exists.' };
    check("SQLite 的 refundOf 冲突被认出", isRefundOfUniqueViolation(sqlite), true);
    check("SQLite 的团队流水 refundOf 冲突被认出", isRefundOfUniqueViolation(sqliteTeam), true);
    check("MySQL 的 refundOf 冲突被认出", isRefundOfUniqueViolation(mysql), true);
    check("Postgres 的 refundOf 冲突被认出", isRefundOfUniqueViolation(postgres), true);
    // 包一层 QueryFailedError 的形状（TypeORM 把驱动错误挂在 driverError 上）同样要认得出。
    check("包在 driverError 里的冲突被认出", isRefundOfUniqueViolation({ message: "QueryFailedError", driverError: mysql }), true);

    // 主键冲突：三种驱动都必须判否，否则一次 ID 撞车会被当成「这笔已经退过」。
    const sqlitePk = { code: "SQLITE_CONSTRAINT_PRIMARYKEY", message: "UNIQUE constraint failed: credit_logs.id" };
    const mysqlPk = { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: "Duplicate entry 'credit-1' for key 'PRIMARY'" };
    const postgresPk = { code: "23505", table: "credit_logs", constraint: "PK_9a1c2f3", detail: "Key (id)=(credit-1) already exists." };
    check("SQLite 主键冲突不算已退款", isRefundOfUniqueViolation(sqlitePk), false);
    check("MySQL 主键冲突不算已退款", isRefundOfUniqueViolation(mysqlPk), false);
    check("Postgres 主键冲突不算已退款", isRefundOfUniqueViolation(postgresPk), false);
    check("主键冲突本身仍是唯一冲突", isUniqueViolation(sqlitePk), true);
    // 别的表的唯一冲突也不能被误认。
    check("别的表的唯一冲突不算已退款", isRefundOfUniqueViolation({ code: "23505", table: "team_invites", constraint: "uq_team_invites_code", detail: "Key (code)=(ABC) already exists." }), false);

    // 真实 SQLite：同一个 refundOf 插第二次必须被认成「已退款」，同一个 id 插第二次必须不是。
    const logs = repo(CreditLog);
    const target = newId("credit");
    const row = { userId: "shape", type: "ai_refund" as const, amount: 1, balance: 1, relatedId: target, remark: "", extra: "", createdAt: now() };
    const firstId = newId("credit");
    await logs.insert({ id: firstId, refundOf: target, ...row });
    let duplicateRefund: unknown = null;
    try {
        await logs.insert({ id: newId("credit"), refundOf: target, ...row });
    } catch (error) {
        duplicateRefund = error;
    }
    check("真实 SQLite 的重复 refundOf 被认成已退款", isRefundOfUniqueViolation(duplicateRefund), true);
    let duplicateId: unknown = null;
    try {
        await logs.insert({ id: firstId, refundOf: newId("credit"), ...row });
    } catch (error) {
        duplicateId = error;
    }
    check("真实 SQLite 的重复主键不算已退款", isRefundOfUniqueViolation(duplicateId), false);
    check("真实 SQLite 的重复主键仍是唯一冲突", isUniqueViolation(duplicateId), true);
    // 多行 refundOf 为 null 不受唯一索引影响，否则所有非退款流水都插不进去。
    await logs.insert({ id: newId("credit"), refundOf: null, ...row, type: "ai_consume", amount: -1 });
    await logs.insert({ id: newId("credit"), refundOf: null, ...row, type: "ai_consume", amount: -1 });
    check("多行 refundOf 为空互不冲突", await logs.countBy({ userId: "shape", type: "ai_consume" }), 2);
}

/**
 * insufficient 留痕必须活过调用方的真实封装。
 * 这条最容易在重构里悄悄失效：调用方为了「扣费与回执落库同生共死」在外面套一层事务，
 * 而 serialTransaction 嵌套时复用外层 manager，于是 charge 抛出的「团队算力点不足」
 * 会把同一个事务里刚写下的留痕一起回滚——单测 charge 时一切正常，走到真实入口就什么都不剩。
 * 所以这里不直接调 charge，而是走 jobs 与 agent 的实际入口。
 */
async function insufficientThroughCallers({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { AgentMessage, AgentSession, CreditLog, Job, Project, Team, TeamCreditLog, TeamMember, User } = await import("./src/db/entities");
    const { charge } = await import("./src/services/billing");
    const { createJob } = await import("./src/services/jobs");
    const { resolveAgentSession } = await import("./src/services/agent");
    const { saveSettings } = await import("./src/services/settings");
    const { newId, now } = await import("./src/lib/errors");

    console.log("团队池不足的留痕活过真实调用入口");
    // 真实入口要能跑起来就得有一个「存在且有单价」的模型；上游永远不会被调用，因为扣费先抛错。
    await saveSettings({
        private: { channels: [{ apiFormat: "openai", name: "verify", baseUrl: "http://127.0.0.1:9", apiKey: "k", models: [{ name: "verify-model", capability: "image" }, { name: "verify-text", capability: "text" }], weight: 1, enabled: true, remark: "" }] },
        public: { modelChannel: { modelCosts: [{ model: "verify-model", credits: 5 }, { model: "verify-text", credits: 5 }] } },
    } as never);

    await repo(User).insert({ id: "poor", username: "poor", password: "", email: "", displayName: "poor", avatarUrl: "", role: "user", credits: 100, storageQuota: 1 << 20, affCode: "poor", affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const poorTeam = newId("team");
    await repo(Team).insert({ id: poorTeam, name: "穷团队", description: "", avatarUrl: "", ownerId: "poor", credits: 0, memberLimit: 0, status: "active", createdAt: now(), updatedAt: now() });
    await repo(TeamMember).insert({ teamId: poorTeam, userId: "poor", role: "owner", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });
    await repo(Project).insert({ userId: "poor", projectId: "p-poor", title: "团队画布", data: "{}", revision: 1, deleted: false, teamId: poorTeam, createdAt: now(), updatedAt: now() });

    const marksBefore = await repo(TeamCreditLog).countBy({ teamId: poorTeam, type: "insufficient" });
    const job = await createJob("poor", { clientJobId: "poor-1", kind: "image", model: "verify-model", prompt: "", params: {}, inputFileIds: [], billingProjectId: "p-poor" });
    check("任务挂在团队名下", job.payerKind, "team");
    // 调度器是后台跑的，等它把这个任务走完扣费那一步。
    const deadline = Date.now() + 15000;
    let settled = await repo(Job).findOneByOrFail({ id: job.id });
    while (settled.status !== "failed" && settled.status !== "succeeded" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        settled = await repo(Job).findOneByOrFail({ id: job.id });
    }
    check("团队池不足时任务失败", settled.status, "failed");
    check("失败任务没有扣到钱", settled.credits, 0);
    check("失败任务没有留下回执", settled.payerLogId, "");
    check("走 jobs 真实入口后留痕还在", await repo(TeamCreditLog).countBy({ teamId: poorTeam, type: "insufficient" }), marksBefore + 1);
    check("个人余额没有被偷偷动用", (await repo(User).findOneByOrFail({ id: "poor" })).credits, 100);

    // Agent 的真实入口：续跑要重新扣一次点，团队池空的时候同样必须留痕。
    const sessionId = newId("agent");
    await repo(AgentSession).insert({ userId: "poor", sessionId, projectId: "p-poor", title: "会话", status: "awaiting", model: "verify-model", error: "", lastSeq: 0, pendingAction: { type: "continue", roundsUsed: 3, credits: 5 }, rounds: 3, autoRenamed: false, deleted: false, payerKind: "team", payerTeamId: poorTeam, payerLogId: "", payerCredits: 0, createdAt: now(), updatedAt: now() } as never);
    const beforeAgent = await repo(TeamCreditLog).countBy({ teamId: poorTeam, type: "insufficient" });
    await rejects("团队池不足时续跑被拒", () => resolveAgentSession("poor", sessionId, true));
    check("走 agent 真实入口后留痕还在", await repo(TeamCreditLog).countBy({ teamId: poorTeam, type: "insufficient" }), beforeAgent + 1);
    const stalled = await repo(AgentSession).findOneByOrFail({ userId: "poor", sessionId });
    check("被拒后会话没有留下回执", stalled.payerLogId, "");
    check("被拒后会话金额仍为零", stalled.payerCredits, 0);
    check("被拒后会话仍停在等确认", stalled.status, "awaiting");

    console.log("行上还挂着退不掉的回执时，新消息不能覆盖它");
    // 一行只放得下一笔回执。上一笔退款失败时会话已经是 failed / idle，用户随时能再发一条消息，
    // 这时候直接扣新的一笔并覆写回执，上一笔就再也没人退得了——必须先结清，结不掉就拒绝这次扣费。
    const { sendAgentMessage } = await import("./src/services/agent");
    const users = repo(User);
    const balanceOf = async (id: string) => (await users.findOneByOrFail({ id })).credits;
    await users.insert({ id: "stuck", username: "stuck", password: "", email: "", displayName: "stuck", avatarUrl: "", role: "user", credits: 100, storageQuota: 1 << 20, affCode: "stuck", affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    await repo(Project).insert({ userId: "stuck", projectId: "p-stuck", title: "画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    const messages = repo(AgentMessage);
    for (const status of ["failed", "idle"] as const) {
        const stuckSession = newId("agent");
        // payerLogId 指向一条不存在的流水：退款一定抛错，也就一定不能放行新的扣费。
        await repo(AgentSession).insert({ userId: "stuck", sessionId: stuckSession, projectId: "p-stuck", title: "会话", status, model: "verify-text", error: "", lastSeq: 0, pendingAction: null, rounds: 0, autoRenamed: false, deleted: false, payerKind: "user", payerTeamId: "", payerLogId: "credit-missing", payerCredits: 30, createdAt: now(), updatedAt: now() } as never);
        const before = await balanceOf("stuck");
        await rejects(`${status} 会话上一笔退不掉时拒绝新消息`, () => sendAgentMessage("stuck", stuckSession, { clientMessageId: `stuck-${status}`, content: "接着做", model: "verify-text", attachmentIds: [], references: [] }));
        const after = await repo(AgentSession).findOneByOrFail({ userId: "stuck", sessionId: stuckSession });
        check(`${status} 会话的旧回执没有被覆盖`, after.payerLogId, "credit-missing");
        check(`${status} 会话的旧金额没有被覆盖`, after.payerCredits, 30);
        check(`${status} 会话被拒后没有扣新的钱`, await balanceOf("stuck"), before);
        check(`${status} 会话被拒后没有落下消息`, await messages.countBy({ userId: "stuck", sessionId: stuckSession }), 0);
    }

    // 上一笔退得掉时才放行：先把旧的退回去，再扣新的一笔，两笔各自记账。
    const freshSession = newId("agent");
    const oldReceipt = await charge({ kind: "user", userId: "stuck" }, 30, { model: "verify-text", path: "/agent" });
    await repo(AgentSession).insert({ userId: "stuck", sessionId: freshSession, projectId: "p-stuck", title: "会话", status: "idle", model: "verify-text", error: "", lastSeq: 0, pendingAction: null, rounds: 0, autoRenamed: false, deleted: false, payerKind: "user", payerTeamId: "", payerLogId: oldReceipt.logId, payerCredits: 30, createdAt: now(), updatedAt: now() } as never);
    await sendAgentMessage("stuck", freshSession, { clientMessageId: "stuck-ok", content: "接着做", model: "verify-text", attachmentIds: [], references: [] });
    // 断言只看旧回执：新的一笔由后台执行负责，跑失败后会异步退回，余额此刻还在变。
    check("上一笔退得掉时被原路退回", await repo(CreditLog).countBy({ userId: "stuck", type: "ai_refund", refundOf: oldReceipt.logId }), 1);
    check("旧回执已经不在会话行上", (await repo(AgentSession).findOneByOrFail({ userId: "stuck", sessionId: freshSession })).payerLogId === oldReceipt.logId, false);
}

/**
 * 崩溃窗口。这一段验的都是「进程在扣费之后、收尾之前被杀」这一类交错：
 * 单跑一遍永远看不出问题，只有把重启入口再执行一次，才能暴露「重复退款」与「免费重跑」。
 */
async function crashWindows({ check }: { check: (name: string, actual: unknown, expected: unknown) => void }) {
    const { repo } = await import("./src/db/data-source");
    const { AgentSession, CreditLog, Job, User } = await import("./src/db/entities");
    const { charge, refund } = await import("./src/services/billing");
    const { resetRunningJobs } = await import("./src/services/jobs");
    const { resetRunningAgentSessions } = await import("./src/services/agent");
    const { newId, now } = await import("./src/lib/errors");

    const users = repo(User);
    const jobs = repo(Job);
    const creditsOf = async (id: string) => (await users.findOneByOrFail({ id })).credits;
    const makeUser = async (id: string, credits: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits, storageQuota: 1 << 20, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });

    console.log("任务的崩溃窗口");
    await makeUser("crasher", 100);
    const receipt = await charge({ kind: "user", userId: "crasher" }, 30, { model: "m", path: "/jobs/image" });
    check("扣费后余额", await creditsOf("crasher"), 70);
    const jobId = newId("job");
    // 模拟「扣费已提交、回执已落到任务行，进程随即被杀」：任务停在 running。
    await jobs.insert({ id: jobId, userId: "crasher", clientJobId: "crash-1", kind: "image", status: "running", model: "m", prompt: "", params: "{}", progress: 0, credits: 30, seq: 1, text: "", error: "", outputFileIds: [], inputFileIds: [], upstreamTaskId: "", payerKind: "user", payerTeamId: "", payerLogId: receipt.logId, createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    await resetRunningJobs();
    check("重启后已扣未结的那笔被退回", await creditsOf("crasher"), 100);
    const revived = await jobs.findOneByOrFail({ id: jobId });
    check("重启后任务回到队列", revived.status === "pending" || revived.status === "failed", true);
    // 清零才不会让重跑白嫖：credits 还留着的话，runJob 里的 `!job.credits` 判定为假，这次重跑一分钱不收。
    check("重启后任务上的金额已清零", revived.credits, 0);
    check("重启后任务上的回执已清空", revived.payerLogId, "");
    // 再重启一次：退款幂等，不能退第二遍。
    await resetRunningJobs();
    check("再次重启不会重复退款", await creditsOf("crasher"), 100);
    check("重复退款没有写第二条退款流水", await repo(CreditLog).countBy({ userId: "crasher", type: "ai_refund" }), 1);
    // 手里那张回执再退一次同样是空操作。
    check("旧回执重放是空操作", await refund(receipt, { model: "m", path: "/jobs/image" }), false);
    check("旧回执重放不改余额", await creditsOf("crasher"), 100);

    console.log("Agent 会话的崩溃窗口");
    await makeUser("chatter", 100);
    const chatReceipt = await charge({ kind: "user", userId: "chatter" }, 15, { model: "m", path: "/agent" });
    const sessionId = newId("agent");
    await repo(AgentSession).insert({ userId: "chatter", sessionId, projectId: "p-crash", title: "会话", status: "running", model: "m", error: "", lastSeq: 0, pendingAction: null, rounds: 1, autoRenamed: false, deleted: false, payerKind: "user", payerTeamId: "", payerLogId: chatReceipt.logId, payerCredits: 15, createdAt: now(), updatedAt: now() } as never);
    check("扣费后余额", await creditsOf("chatter"), 85);
    await resetRunningAgentSessions();
    check("重启后会话的已扣未结被退回", await creditsOf("chatter"), 100);
    const revivedSession = await repo(AgentSession).findOneByOrFail({ userId: "chatter", sessionId });
    check("重启后会话置为失败", revivedSession.status, "failed");
    check("重启后会话回执已清空", revivedSession.payerLogId, "");
    check("重启后会话金额已清零", revivedSession.payerCredits, 0);
    await repo(AgentSession).update({ userId: "chatter", sessionId }, { status: "running" });
    await resetRunningAgentSessions();
    check("再次重启不会重复退款", await creditsOf("chatter"), 100);
    check("会话重复退款没有写第二条退款流水", await repo(CreditLog).countBy({ userId: "chatter", type: "ai_refund" }), 1);

    console.log("退款失败时保留回执并在下次启动重试");
    // 退款抛错（这里用一个查不到原始流水的回执制造失败）时绝不能清回执：
    // 清了就再没有任何地方记得这笔钱。回执留着，下一次启动照着它重试一次，且只退一次。
    await makeUser("retrier", 100);
    const retryReceipt = await charge({ kind: "user", userId: "retrier" }, 40, { model: "m", path: "/jobs/image" });
    check("扣费后余额", await creditsOf("retrier"), 60);
    const retryJobId = newId("job");
    // payerLogId 指向一条不存在的流水：refund 会抛「找不到原始扣费流水」。
    await jobs.insert({ id: retryJobId, userId: "retrier", clientJobId: "retry-1", kind: "image", status: "running", model: "m", prompt: "", params: "{}", progress: 0, credits: 40, seq: 1, text: "", error: "", outputFileIds: [], inputFileIds: [], upstreamTaskId: "", payerKind: "user", payerTeamId: "", payerLogId: "credit-missing", createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    await resetRunningJobs();
    const failedOnce = await jobs.findOneByOrFail({ id: retryJobId });
    check("退款失败后余额没有变化", await creditsOf("retrier"), 60);
    check("退款失败后回执原样保留", failedOnce.payerLogId, "credit-missing");
    check("退款失败后金额原样保留", failedOnce.credits, 40);
    check("退款失败的任务不会回到队列", failedOnce.status, "failed");
    check("退款失败时没有写退款流水", await repo(CreditLog).countBy({ userId: "retrier", type: "ai_refund" }), 0);
    // 修好回执（等价于「那次退款失败的偶发原因消失了」），下一次启动必须重试并退成。
    await jobs.update({ id: retryJobId }, { payerLogId: retryReceipt.logId });
    await resetRunningJobs();
    check("下次启动重试退款成功", await creditsOf("retrier"), 100);
    const retried = await jobs.findOneByOrFail({ id: retryJobId });
    check("重试成功后回执被清空", retried.payerLogId, "");
    check("重试成功后金额清零", retried.credits, 0);
    // 第三次启动：这笔已经结清，既不会再退也不会再写流水。
    await resetRunningJobs();
    check("重试成功后不会再退第二次", await creditsOf("retrier"), 100);
    check("整个重试过程只退了一次", await repo(CreditLog).countBy({ userId: "retrier", type: "ai_refund" }), 1);

    console.log("非 running 状态的会话也要结清");
    // 退款失败过的会话早被标成 failed / idle，只扫 running 与 awaiting 等于放着那笔钱永不重试。
    await makeUser("idler", 100);
    const idleReceipt = await charge({ kind: "user", userId: "idler" }, 10, { model: "m", path: "/agent" });
    const failedReceipt = await charge({ kind: "user", userId: "idler" }, 20, { model: "m", path: "/agent" });
    const idleSession = newId("agent");
    const failedSession = newId("agent");
    await repo(AgentSession).insert({ userId: "idler", sessionId: idleSession, projectId: "p-idle", title: "会话", status: "idle", model: "m", error: "", lastSeq: 0, pendingAction: null, rounds: 0, autoRenamed: false, deleted: false, payerKind: "user", payerTeamId: "", payerLogId: idleReceipt.logId, payerCredits: 10, createdAt: now(), updatedAt: now() } as never);
    await repo(AgentSession).insert({ userId: "idler", sessionId: failedSession, projectId: "p-failed", title: "会话", status: "failed", model: "m", error: "上次退款失败", lastSeq: 0, pendingAction: null, rounds: 0, autoRenamed: false, deleted: false, payerKind: "user", payerTeamId: "", payerLogId: failedReceipt.logId, payerCredits: 20, createdAt: now(), updatedAt: now() } as never);
    check("两笔已扣未结的钱都还没退", await creditsOf("idler"), 70);
    await resetRunningAgentSessions();
    check("idle 与 failed 会话的已扣未结都被退回", await creditsOf("idler"), 100);
    check("idle 会话回执已清空", (await repo(AgentSession).findOneByOrFail({ userId: "idler", sessionId: idleSession })).payerLogId, "");
    check("failed 会话回执已清空", (await repo(AgentSession).findOneByOrFail({ userId: "idler", sessionId: failedSession })).payerCredits, 0);
    // 状态各自维持原样：idle 会话不该因为一笔待退的钱莫名其妙变成失败。
    check("idle 会话状态没有被改动", (await repo(AgentSession).findOneByOrFail({ userId: "idler", sessionId: idleSession })).status, "idle");
    await resetRunningAgentSessions();
    check("再次启动不会重复退款", await creditsOf("idler"), 100);
    check("两笔各只退了一次", await repo(CreditLog).countBy({ userId: "idler", type: "ai_refund" }), 2);

    console.log("存量 running 行没有回执也不能免费重跑");
    // 这一列上线前留下的行：credits 记着钱，payerLogId 是空的。
    // 那笔钱已经没有线索能原路退回，但绝不能放着 credits 不清——重跑时 `!job.credits` 判定为假，
    // 整次生成就成了免费的。清零让它照常重新扣一次。
    await makeUser("legacy-run", 100);
    const legacyJobId = newId("job");
    await jobs.insert({ id: legacyJobId, userId: "legacy-run", clientJobId: "legacy-1", kind: "image", status: "running", model: "m", prompt: "", params: "{}", progress: 0, credits: 25, seq: 1, text: "", error: "", outputFileIds: [], inputFileIds: [], upstreamTaskId: "", payerKind: "user", payerTeamId: "", payerLogId: "", createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    await resetRunningJobs();
    const legacyRevived = await jobs.findOneByOrFail({ id: legacyJobId });
    check("无回执的存量行回到队列", legacyRevived.status, "pending");
    check("无回执的存量行金额被清零", legacyRevived.credits, 0);
    check("无回执的存量行没有凭空退钱", await creditsOf("legacy-run"), 100);
    check("无回执的存量行没有写退款流水", await repo(CreditLog).countBy({ userId: "legacy-run", type: "ai_refund" }), 0);
}

/**
 * 团队计费。这一段的每条断言都对应架构文档里「必须测试」的一项：
 * 两个团队互不串账、非成员既不能绑定也不能消费、普通保存夹带 teamId 无效、
 * 伪造 Job.context.projectId 不改付费方、存量画布默认走个人、移出成员后新调用被拒但在途退款仍回原团队。
 */
async function teamBilling({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { AgentSession, CreditLog, Job, Project, Team, TeamCreditLog, TeamMember, User } = await import("./src/db/entities");
    const { charge, payerOfJob, payerOfProject, payerOfSession, receiptOfJob, refund, resolvePayer } = await import("./src/services/billing");
    const { setProjectTeam } = await import("./src/services/project-team");
    const { saveProject } = await import("./src/services/sync");
    const { createJob } = await import("./src/services/jobs");
    const { savePreferences } = await import("./src/services/preferences");
    const { newId, now } = await import("./src/lib/errors");

    const users = repo(User);
    const teams = repo(Team);
    const makeUser = async (id: string, credits: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits, storageQuota: 1 << 20, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const creditsOfTeam = async (id: string) => (await teams.findOneByOrFail({ id })).credits;
    const creditsOfUser = async (id: string) => (await users.findOneByOrFail({ id })).credits;
    const makeTeam = async (name: string, ownerId: string, credits: number) => {
        const id = newId("team");
        await teams.insert({ id, name, description: "", avatarUrl: "", ownerId, credits, memberLimit: 0, status: "active", createdAt: now(), updatedAt: now() });
        return id;
    };
    const join = async (teamId: string, userId: string, role: "owner" | "admin" | "member" | "viewer") =>
        repo(TeamMember).insert({ teamId, userId, role, creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });

    console.log("团队扣费与成员额度");
    await makeUser("boss", 100);
    await makeUser("worker", 50);
    await makeUser("outsider", 100);
    const teamA = await makeTeam("A 团队", "boss", 40);
    await join(teamA, "boss", "owner");
    await join(teamA, "worker", "member");

    const teamReceipt = await charge({ kind: "team", teamId: teamA, memberId: "worker" }, 25, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("团队池被扣", await creditsOfTeam(teamA), 15);
    check("个人余额未被动用", await creditsOfUser("worker"), 50);
    check("写入团队流水", await repo(TeamCreditLog).countBy({ teamId: teamA, type: "ai_consume" }), 1);
    check("个人流水没有新增", await repo(CreditLog).countBy({ userId: "worker" }), 0);
    check("团队流水 balance 是团队池余额", (await repo(TeamCreditLog).findOneByOrFail({ teamId: teamA, type: "ai_consume" })).balance, 15);

    await rejects("团队池不足且未开回落时拒绝", () => charge({ kind: "team", teamId: teamA, memberId: "worker" }, 999, { model: "gpt-x", path: "/x" }));
    check("被拒后团队池不变", await creditsOfTeam(teamA), 15);
    check("被拒后个人余额不变", await creditsOfUser("worker"), 50);
    check("被拒留下 insufficient 留痕", await repo(TeamCreditLog).countBy({ teamId: teamA, type: "insufficient" }), 1);
    check("insufficient 金额为 0", (await repo(TeamCreditLog).findOneByOrFail({ teamId: teamA, type: "insufficient" })).amount, 0);

    console.log("用户开启回落后使用个人余额");
    await savePreferences("worker", { billingFallbackToPersonal: true });
    const fallback = await charge({ kind: "team", teamId: teamA, memberId: "worker" }, 20, { model: "gpt-x", path: "/x" });
    check("回落后扣的是个人余额", await creditsOfUser("worker"), 30);
    check("回落后团队池不变", await creditsOfTeam(teamA), 15);
    check("回执 payer 变为个人", fallback.payer.kind, "user");
    check("个人流水标注来源团队", JSON.parse((await repo(CreditLog).findOneByOrFail({ userId: "worker", type: "ai_consume" })).extra || "{}").fallbackFromTeamId, teamA);
    await savePreferences("worker", {});

    console.log("退款严格原路");
    await refund(teamReceipt, { model: "gpt-x", path: "/x" });
    check("团队扣的退回团队", await creditsOfTeam(teamA), 40);
    check("团队退款不加个人余额", await creditsOfUser("worker"), 30);
    check("退款流水指回原始扣费流水", (await repo(TeamCreditLog).findOneByOrFail({ teamId: teamA, type: "ai_refund" })).relatedId, teamReceipt.logId);
    await refund(fallback, { model: "gpt-x", path: "/x" });
    check("回落扣的退回个人", await creditsOfUser("worker"), 50);
    check("回落退款不加团队池", await creditsOfTeam(teamA), 40);

    console.log("成员额度按实时聚合");
    await repo(TeamMember).update({ teamId: teamA, userId: "worker" }, { creditLimit: 10, limitWindow: "total" });
    await charge({ kind: "team", teamId: teamA, memberId: "worker" }, 8, { model: "gpt-x", path: "/x" });
    await rejects("超出成员额度时拒绝", () => charge({ kind: "team", teamId: teamA, memberId: "worker" }, 5, { model: "gpt-x", path: "/x" }));
    check("超额被拒后团队池只少了 8", await creditsOfTeam(teamA), 32);
    await repo(TeamMember).update({ teamId: teamA, userId: "worker" }, { creditLimit: 0 });

    console.log("成员额度在并发下也不被突破");
    // 额度聚合与扣费分处两个事务时，5 笔并发会各自读到同一份「已用量 0」，双双判定没超额。
    // 额度 10、每笔 4，正确结果只能是 2 笔成功。
    await makeUser("burst", 0);
    await join(teamA, "burst", "member");
    await teams.update({ id: teamA }, { credits: 1000 });
    await repo(TeamMember).update({ teamId: teamA, userId: "burst" }, { creditLimit: 10, limitWindow: "total" });
    const burstBefore = await creditsOfTeam(teamA);
    const burst = await Promise.allSettled(Array.from({ length: 5 }, () => charge({ kind: "team", teamId: teamA, memberId: "burst" }, 4, { model: "gpt-x", path: "/x" })));
    const burstOk = burst.filter((item) => item.status === "fulfilled").length;
    check("并发下额度只放行 2 笔", burstOk, 2);
    check("并发额度下团队池只少了 8", await creditsOfTeam(teamA), burstBefore - 8);
    await teams.update({ id: teamA }, { credits: 32 });

    console.log("团队退款的严格性");
    const teamStrict = await charge({ kind: "team", teamId: teamA, memberId: "boss" }, 6, { model: "gpt-x", path: "/x" });
    await rejects("团队退款没有流水 ID 时拒绝", () => refund({ payer: { kind: "team", teamId: teamA, memberId: "boss" }, credits: 6, logId: "" }, { model: "gpt-x", path: "/x" }));
    await rejects("退给不存在的团队时抛错", () => refund({ payer: { kind: "team", teamId: "team-nope", memberId: "boss" }, credits: 6, logId: teamStrict.logId }, { model: "gpt-x", path: "/x" }));
    const otherTeam = await makeTeam("对照团队", "boss", 10);
    await join(otherTeam, "boss", "owner");
    await rejects("团队与原始扣费不符时拒绝", () => refund({ payer: { kind: "team", teamId: otherTeam, memberId: "boss" }, credits: 6, logId: teamStrict.logId }, { model: "gpt-x", path: "/x" }));
    check("对照团队没有被退进钱", await creditsOfTeam(otherTeam), 10);
    check("被拒的团队退款没有加钱", await creditsOfTeam(teamA), 26);
    check("首次团队退款成功", await refund(teamStrict, { model: "gpt-x", path: "/x" }), true);
    check("重复团队退款是空操作", await refund(teamStrict, { model: "gpt-x", path: "/x" }), false);
    check("重复团队退款不加第二次钱", await creditsOfTeam(teamA), 32);

    console.log("团队池不足时的留痕");
    const marks = await repo(TeamCreditLog).findBy({ teamId: teamA, type: "insufficient" });
    check("留痕的余额是当时事务里读到的团队池", marks.every((row) => row.balance >= 0), true);
    check("默认留痕不标记回落", JSON.parse(marks[0].extra || "{}").fallback, false);
    await savePreferences("worker", { billingFallbackToPersonal: true });
    await charge({ kind: "team", teamId: teamA, memberId: "worker" }, 9999, { model: "gpt-x", path: "/x" }).catch(() => undefined);
    const fallbackMark = (await repo(TeamCreditLog).find({ where: { teamId: teamA, type: "insufficient" }, order: { createdAt: "DESC" } }))[0];
    check("开启回落后的留痕带 fallback 标记", JSON.parse(fallbackMark.extra || "{}").fallback, true);
    await savePreferences("worker", {});

    console.log("并发不超扣");
    const before = await creditsOfTeam(teamA);
    const rush = await Promise.allSettled(Array.from({ length: 20 }, () => charge({ kind: "team", teamId: teamA, memberId: "boss" }, 4, { model: "gpt-x", path: "/x" })));
    const okCount = rush.filter((item) => item.status === "fulfilled").length;
    check("并发扣费不超扣", await creditsOfTeam(teamA), before - okCount * 4);
    check("团队池不为负", (await creditsOfTeam(teamA)) >= 0, true);

    console.log("A/B 两团队不串账");
    await teams.update({ id: teamA }, { credits: 100 });
    const teamB = await makeTeam("B 团队", "boss", 100);
    await join(teamB, "boss", "owner");
    const projects = repo(Project);
    await projects.insert({ userId: "boss", projectId: "p-a", title: "A 画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await projects.insert({ userId: "boss", projectId: "p-b", title: "B 画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await setProjectTeam("boss", "p-a", teamA);
    await setProjectTeam("boss", "p-b", teamB);
    await charge(await resolvePayer("boss", { projectId: "p-a" }), 10, { model: "gpt-x", path: "/x" });
    check("A 画布扣的是 A 团队", await creditsOfTeam(teamA), 90);
    check("A 画布的消费没有落到 B 团队", await creditsOfTeam(teamB), 100);
    await charge(await resolvePayer("boss", { projectId: "p-b" }), 30, { model: "gpt-x", path: "/x" });
    check("B 画布扣的是 B 团队", await creditsOfTeam(teamB), 70);
    check("B 画布的消费没有落到 A 团队", await creditsOfTeam(teamA), 90);
    check("两次消费都没动用个人余额", await creditsOfUser("boss"), 100);

    console.log("非成员不能绑定也不能消费");
    await projects.insert({ userId: "outsider", projectId: "p-out", title: "外人画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await rejects("非成员不能把画布绑到团队", () => setProjectTeam("outsider", "p-out", teamA));
    check("被拒后画布归属仍为空", (await projects.findOneByOrFail({ userId: "outsider", projectId: "p-out" })).teamId, "");
    await rejects("非成员不能直接消费团队池", () => charge({ kind: "team", teamId: teamA, memberId: "outsider" }, 5, { model: "gpt-x", path: "/x" }));
    check("非成员被拒后团队池不变", await creditsOfTeam(teamA), 90);
    // viewer 在权限矩阵里没有 credits.spend：有成员身份不等于能花钱。
    await join(teamA, "watcher", "viewer");
    await rejects("viewer 不能消费团队池", () => charge({ kind: "team", teamId: teamA, memberId: "watcher" }, 5, { model: "gpt-x", path: "/x" }));
    check("viewer 被拒后团队池不变", await creditsOfTeam(teamA), 90);

    console.log("普通保存夹带 teamId 改不了归属");
    await saveProject("boss", { id: "p-a", title: "A 画布", data: { teamId: teamB }, revision: 1, clientId: "client-aaaaaaaa", teamId: teamB } as never);
    check("保存后归属仍是原团队", (await projects.findOneByOrFail({ userId: "boss", projectId: "p-a" })).teamId, teamA);
    await saveProject("boss", { id: "p-new", title: "新画布", data: {}, revision: 0, clientId: "client-aaaaaaaa", teamId: teamB } as never);
    check("新建画布默认归个人", (await projects.findOneByOrFail({ userId: "boss", projectId: "p-new" })).teamId, "");

    console.log("存量画布默认走个人账本");
    // 存量行不带 teamId，读出来就是空串（或 null），付费方必须仍是个人。
    await projects.insert({ userId: "solo", projectId: "p-legacy", title: "存量画布", data: "{}", revision: 1, deleted: false, createdAt: now(), updatedAt: now() } as never);
    check("存量画布 teamId 为空", (await projects.findOneByOrFail({ userId: "solo", projectId: "p-legacy" })).teamId || "", "");
    check("存量画布 payer 为个人", (await resolvePayer("solo", { projectId: "p-legacy" })).kind, "user");
    check("客户端传 teamId 被忽略", (await resolvePayer("solo", { projectId: "p-legacy", teamId: teamA } as never)).kind, "user");

    console.log("任务与会话固化 payer");
    const jobs = repo(Job);
    const teamJobId = newId("job");
    await jobs.insert({ id: teamJobId, userId: "boss", clientJobId: "c1", kind: "image", status: "pending", model: "gpt-x", prompt: "", params: "{}", progress: 0, credits: 0, seq: 1, text: "", error: "", outputFileIds: [], inputFileIds: [], upstreamTaskId: "", payerKind: "team", payerTeamId: teamA, payerLogId: "", createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    check("任务上固化了 payer 类型", (await jobs.findOneByOrFail({ id: teamJobId })).payerKind, "team");
    check("按任务解析出团队 payer", payerOfJob(await jobs.findOneByOrFail({ id: teamJobId })).kind, "team");

    const legacyJobId = newId("job");
    await jobs.insert({ id: legacyJobId, userId: "solo", clientJobId: "c2", kind: "image", status: "pending", model: "gpt-x", prompt: "", params: "{}", progress: 0, credits: 0, seq: 2, text: "", error: "", outputFileIds: [], inputFileIds: [], upstreamTaskId: "", createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    check("存量任务默认按个人计费", (await jobs.findOneByOrFail({ id: legacyJobId })).payerKind, "user");
    check("存量任务 payerTeamId 为空", (await jobs.findOneByOrFail({ id: legacyJobId })).payerTeamId || "", "");
    check("按存量任务解析出个人 payer", payerOfJob(await jobs.findOneByOrFail({ id: legacyJobId })).kind, "user");

    const teamSession = newId("agent");
    await repo(AgentSession).insert({ userId: "boss", sessionId: teamSession, projectId: "p-a", title: "会话", status: "idle", model: "gpt-x", error: "", lastSeq: 0, pendingAction: null, rounds: 0, autoRenamed: false, deleted: false, payerKind: "team", payerTeamId: teamA, createdAt: now(), updatedAt: now() } as never);
    check("按会话解析出团队 payer", payerOfSession(await repo(AgentSession).findOneByOrFail({ userId: "boss", sessionId: teamSession })).kind, "team");
    check("会话上下文解析出团队 payer", (await resolvePayer("boss", { sessionId: teamSession })).kind, "team");

    console.log("伪造 Job.context.projectId 不改 payer");
    // context 是客户端自定义的展示信息，付费方一眼都不看它。
    const forged = await createJob("outsider", { clientJobId: "forge-1", kind: "image", model: "any", prompt: "", params: {}, inputFileIds: [], context: { projectId: "p-a", teamId: teamA } }).catch(() => null);
    check("伪造 context 的任务不会挂到团队", forged ? forged.payerKind : "user", "user");
    // 显式的 billingProjectId 同样是不可信输入：服务端按当前 userId 回库查画布，别人的画布查不到，落回个人。
    check("指定别人的画布解析出的仍是个人", (await payerOfProject("outsider", "p-a")).kind, "user");
    check("指定不存在的画布解析出的仍是个人", (await payerOfProject("outsider", "p-nope")).kind, "user");
    const stolen = await createJob("outsider", { clientJobId: "forge-2", kind: "image", model: "any", prompt: "", params: {}, inputFileIds: [], billingProjectId: "p-a" }).catch(() => null);
    check("指定别人的画布也挂不上团队", stolen ? stolen.payerKind : "user", "user");
    check("伪造后 A 团队池未被动过", await creditsOfTeam(teamA), 90);

    console.log("移出成员后新调用拒绝，在途退款仍回原团队");
    // 成员在册时把自己的画布绑到团队，之后被移出：归属不会静默改变，但他已经不能再用它花团队的钱。
    await projects.insert({ userId: "worker", projectId: "p-w", title: "成员画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await setProjectTeam("worker", "p-w", teamA);
    const inflight = await charge(await resolvePayer("worker", { projectId: "p-w" }), 12, { model: "gpt-x", path: "/x" });
    check("在途任务已从团队池扣走", await creditsOfTeam(teamA), 78);
    const workerBefore = await creditsOfUser("worker");
    await repo(TeamMember).delete({ teamId: teamA, userId: "worker" });
    await rejects("被移出后新的团队消费被拒", () => charge({ kind: "team", teamId: teamA, memberId: "worker" }, 5, { model: "gpt-x", path: "/x" }));
    await rejects("被移出后按画布解析付费方也拒绝", () => resolvePayer("worker", { projectId: "p-w" }));
    check("被移出后画布归属没有被静默改掉", (await projects.findOneByOrFail({ userId: "worker", projectId: "p-w" })).teamId, teamA);
    check("被拒后团队池不变", await creditsOfTeam(teamA), 78);
    await teams.update({ id: teamA }, { status: "disabled" });
    await refund(inflight, { model: "gpt-x", path: "/x" });
    check("团队停用且成员已移出，退款仍回团队池", await creditsOfTeam(teamA), 90);
    check("在途退款没有落到个人余额", await creditsOfUser("worker"), workerBefore);
    await teams.update({ id: teamA }, { status: "active" });

    console.log("任务行能还原出回执");
    await jobs.update({ id: teamJobId }, { credits: 7, payerLogId: "team-credit-x" });
    const restored = receiptOfJob(await jobs.findOneByOrFail({ id: teamJobId }));
    check("还原出的付费方是团队", restored.payer.kind, "team");
    check("还原出的金额是任务上的金额", restored.credits, 7);
    check("还原出的流水 ID 不是空串", restored.logId, "team-credit-x");
    // 这条是纯还原断言，用的是一个假流水 ID；留着它会让之后每次启动扫描都去退一笔退不掉的钱，
    // 在验证输出里刷出一堆与被测性质无关的噪声，所以用完就把这行任务的回执收掉。
    await jobs.update({ id: teamJobId }, { credits: 0, payerLogId: "" });
}

/**
 * 存量个人账户的兼容回归。这一段是本批的硬性验收：
 * 团队功能上线后，一个不属于任何团队的用户，扣费路径必须与改造前一字不差——
 * 同一张 CreditLog、同样的 type、balance 仍是个人余额，且一行团队流水都不该被写出来。
 *
 * 简报里写的是 `consumeUserCredits` / `refundUserCredits`，那两个函数在本批之前就已经被
 * `charge` / `refund` 取代（付费方由服务端解析一次并固化）。这里断言的是同一件事，
 * 只是走的是现在真实存在的那个入口；对着一个不存在的函数写测试只会得到一个永远跑不起来的回归。
 */
async function legacyCompatibility({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { CreditLog, Team, TeamCreditLog, TeamMember, User } = await import("./src/db/entities");
    const { charge, refund, resolvePayer } = await import("./src/services/billing");
    const { now } = await import("./src/lib/errors");

    console.log("存量个人账户完全兼容");
    const users = repo(User);
    await users.insert({ id: "legacy-solo", username: "legacy-solo", password: "", email: "", displayName: "legacy", avatarUrl: "", role: "user", credits: 200, storageQuota: 1 << 20, affCode: "legacy-solo", affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    check("新用户不属于任何团队", await repo(TeamMember).countBy({ userId: "legacy-solo" }), 0);
    check("不会被自动建团队", await repo(Team).countBy({ ownerId: "legacy-solo" }), 0);
    check("无团队用户 payer 恒为个人", (await resolvePayer("legacy-solo", {})).kind, "user");
    // 连「我在哪张画布里」都给上，只要那张画布没挂团队，付费方依旧是个人。
    check("无归属画布也解析为个人", (await resolvePayer("legacy-solo", { projectId: "no-such-project" })).kind, "user");

    const receipt = await charge({ kind: "user", userId: "legacy-solo" }, 40, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("旧路径扣费余额正确", (await users.findOneByOrFail({ id: "legacy-solo" })).credits, 160);
    const consumeLog = await repo(CreditLog).findOneOrFail({ where: { userId: "legacy-solo" }, order: { createdAt: "DESC" } });
    check("旧路径流水 type 不变", consumeLog.type, "ai_consume");
    check("旧路径流水金额为负", consumeLog.amount, -40);
    check("旧路径流水 balance 是个人余额", consumeLog.balance, 160);
    check("旧路径不写团队流水", await repo(TeamCreditLog).countBy({ userId: "legacy-solo" }), 0);

    await refund(receipt, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("旧路径退款余额还原", (await users.findOneByOrFail({ id: "legacy-solo" })).credits, 200);
    check("旧路径退款流水 type 不变", (await repo(CreditLog).findOneOrFail({ where: { userId: "legacy-solo" }, order: { createdAt: "DESC" } })).type, "ai_refund");
    check("旧路径退款也不写团队流水", await repo(TeamCreditLog).countBy({ userId: "legacy-solo" }), 0);

    await rejects("旧路径余额不足仍然抛错", () => charge({ kind: "user", userId: "legacy-solo" }, 9999, { model: "gpt-x", path: "/x" }));
    check("失败后余额未变", (await users.findOneByOrFail({ id: "legacy-solo" })).credits, 200);
    check("失败后不写任何流水", await repo(CreditLog).countBy({ userId: "legacy-solo", type: "ai_consume" }), 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
