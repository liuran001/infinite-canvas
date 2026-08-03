import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 账号相关专项验证。眼下覆盖管理员自定义邀请码：码值规则散在 lib 与 service 两处，
 * 而它决定了一张码能不能被人正确抄下来再输进去，端到端只能验到「能建出来」这一层。
 * 用法：cd server && npx tsx verify-account.ts
 */
const env = prepareEnv("verify-account");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { InviteCode } = await import("./src/db/entities");
    const { createInviteCodes } = await import("./src/services/invites");
    const { normalizeCustomInviteCode } = await import("./src/lib/invite-code");
    const { fail } = await import("./src/lib/errors");

    await initDatabase();
    const codes = repo(InviteCode);

    console.log("邀请码码值规则");
    const bad = (value: unknown) => normalizeCustomInviteCode(value, (reason) => fail(reason));
    // 字母表刻意去掉了 0/O/1/I/L：放行它们，用户照着纸条输错一个字符就只会看到「邀请码无效」，
    // 而管理员手里那张码确实存在，两边都无从判断问题出在哪。
    for (const value of ["ABC0DEF", "OOOOOO", "111111", "IIIIII", "LLLLLL", "ABC-DEF", "ABC DEF", "ABC_DEF", "ABC中文"]) {
        await rejects(`拒绝含非法字符的 ${String(value)}`, async () => bad(value));
    }
    await rejects("拒绝过短的码", async () => bad("AB"));
    await rejects("拒绝超过列长度的码", async () => bad("A".repeat(65)));
    check("接受长度下界", bad("ABCD"), "ABCD");
    check("接受长度上界", bad("A".repeat(64)).length, 64);
    check("小写归一成大写", bad("abcdef"), "ABCDEF");
    check("首尾空白被裁掉", bad("  abcdef  "), "ABCDEF");

    console.log("指定邀请码内容");
    const [custom] = await createInviteCodes({ code: "team99", maxUses: 3, credits: 50, note: "指定码" });
    check("指定的码按归一化后的值落库", custom.code, "TEAM99");
    check("指定码的其余字段照常生效", [custom.maxUses, custom.credits], [3, 50]);
    check("库里确实只有这一条", await codes.countBy({ code: "TEAM99" }), 1);

    // 撞码必须报错而不是覆盖：insert 而非 save 正是为了这个，覆盖等于悄悄改掉别人已经发出去的码。
    await rejects("指定的码与已有码重复时报错", () => createInviteCodes({ code: "team99" }));
    check("撞码后原码的字段一个都没被改", (await codes.findOneByOrFail({ code: "TEAM99" })).credits, 50);
    await rejects("大小写不同的重复码同样被拒", () => createInviteCodes({ code: "TEAM99" }));
    await rejects("指定码值时不接受非法字符", () => createInviteCodes({ code: "team-99" }));

    // 「指定这串字符，来 5 个」是自相矛盾的。静默按 1 处理的话，管理员以为发出去 5 个码，
    // 实际只有一个能用，后面 4 个人拿到的是「邀请码已用完」。
    await rejects("指定码值时 count 只能是 1", () => createInviteCodes({ code: "MEGA88", count: 5 }));
    check("被拒的批量没有写入任何码", await codes.countBy({ code: "MEGA88" }), 0);

    console.log("留空仍然随机生成");
    const batch = await createInviteCodes({ count: 3 });
    check("留空时按 count 批量生成", batch.length, 3);
    check("随机码各不相同", new Set(batch.map((row) => row.code)).size, 3);
    check("随机码长度是 10", batch[0].code.length, 10);
    // 空串、纯空白与 undefined 都是「没填」，必须走随机；当成指定值的话会直接撞长度校验报错。
    for (const blank of ["", "   ", undefined]) {
        const [row] = await createInviteCodes({ code: blank });
        check(`code=${JSON.stringify(blank)} 时仍然随机生成`, row.code.length, 10);
    }

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
