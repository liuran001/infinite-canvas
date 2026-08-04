import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 账号相关专项验证：管理员自定义邀请码、用户自助改昵称与第三方昵称同步的冲突。
 * 这两件事都改的是「用户身份」这条线，且都没有端到端以外的覆盖，所以在服务层直接验证。
 * 用法：cd server && npx tsx verify-account.ts
 */
const env = prepareEnv("verify-account");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { InviteCode, User } = await import("./src/db/entities");
    const { createInviteCodes } = await import("./src/services/invites");
    const { normalizeCustomInviteCode } = await import("./src/lib/invite-code");
    const { syncedDisplayName, updateDisplayName } = await import("./src/services/auth");
    const { fail, now } = await import("./src/lib/errors");

    await initDatabase();
    const codes = repo(InviteCode);
    const users = repo(User);

    console.log("邀请码码值规则");
    const bad = (value: unknown) => normalizeCustomInviteCode(value, (reason) => fail(reason));
    // 形近字只对随机码有意义——那种码没人挑得动，混进 0/O 就是在制造「码是对的却输不进去」的客服工单。
    // 管理员自己写的码不一样：他知道自己要 WELCOME2026 还是 VIP001，易混淆的代价也由他自己承担，
    // 拿随机码的字母表去卡他，只会让人对着一个完全合理的码被打回来而不知所措。
    for (const value of ["ABC0DEF", "OOOOOO", "111111", "IIIIII", "LLLLLL", "ABC-DEF", "ABC_DEF", "WELCOME2026", "VIP001"]) {
        check(`放行管理员指定的 ${String(value)}`, bad(value), String(value).toUpperCase());
    }
    // 但仍然挡住会把注册链接搞坏的东西：邀请码要能原样放进 URL。
    for (const value of ["ABC DEF", "ABC中文", "ABC/DEF", "ABC?DEF", "ABC#DEF", "ABC&DEF"]) {
        await rejects(`拒绝会破坏链接的 ${String(value)}`, async () => bad(value));
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
    await rejects("指定码值时仍然挡住会破坏链接的字符", () => createInviteCodes({ code: "team 99" }));

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

    console.log("用户自助改昵称");
    await users.insert({
        id: "user-name",
        username: "name-user",
        password: "",
        email: "",
        displayName: "第三方昵称",
        displayNameCustomized: false,
        avatarUrl: "",
        role: "user",
        credits: 0,
        storageQuota: 1 << 20,
        affCode: "name-user",
        affCount: 0,
        inviterId: "",
        linuxDoId: "12345",
        status: "active",
        lastLoginAt: "",
        preferences: "",
        extra: "",
        createdAt: now(),
        updatedAt: now(),
    });
    check("改前没有被标记为自定义", (await users.findOneByOrFail({ id: "user-name" })).displayNameCustomized, false);
    check("改昵称返回新值", (await updateDisplayName("user-name", "  我的昵称  ")).displayName, "我的昵称");
    check("首尾空白被裁掉后落库", (await users.findOneByOrFail({ id: "user-name" })).displayName, "我的昵称");
    check("改过之后被标记为自定义", (await users.findOneByOrFail({ id: "user-name" })).displayNameCustomized, true);
    check("用户名不受影响", (await users.findOneByOrFail({ id: "user-name" })).username, "name-user");
    await rejects("超长昵称被拒", () => updateDisplayName("user-name", "长".repeat(65)));
    check("被拒后昵称没有被改", (await users.findOneByOrFail({ id: "user-name" })).displayName, "我的昵称");
    await rejects("不存在的用户改不了", () => updateDisplayName("user-nobody", "x"));
    // 空昵称是允许的：各处展示本来就是 displayName || username，清空等于回落到用户名。
    check("允许清空昵称", (await updateDisplayName("user-name", "")).displayName, "");
    check("清空之后仍然算自定义", (await users.findOneByOrFail({ id: "user-name" })).displayNameCustomized, true);

    // 这是最容易漏的一点：Linux.do 每次登录都会同步第三方昵称，
    // 用户自己改过之后再登录一次就被打回去，而且没有任何提示。
    console.log("第三方昵称同步不覆盖用户自定义");
    // 断言直接盯 loginWithLinuxDo 用的那个函数，不在这里照抄一份规则——抄出来的那份怎么改都不会红。
    check("没自定义过的账号仍然跟随第三方", syncedDisplayName({ displayName: "旧名", displayNameCustomized: false }, "第三方新名"), "第三方新名");
    check("自定义过的账号不被覆盖", syncedDisplayName({ displayName: "我改的", displayNameCustomized: true }, "第三方新名"), "我改的");
    check("自定义成空之后也不被第三方填回来", syncedDisplayName({ displayName: "", displayNameCustomized: true }, "第三方新名"), "");
    check("第三方昵称为空时保留本地值", syncedDisplayName({ displayName: "旧名", displayNameCustomized: false }, ""), "旧名");
    check("第三方昵称是纯空白时同样保留本地值", syncedDisplayName({ displayName: "旧名", displayNameCustomized: false }, "   "), "旧名");

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
