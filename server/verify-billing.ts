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

    await teamBilling({ check, rejects });

    finish(env.root);
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
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
