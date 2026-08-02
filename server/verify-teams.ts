import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 团队与权限专项验证：实体建表、权限矩阵、团队生命周期与 owner 不变量、邀请领取并发。
 * 用法：cd server && npx tsx verify-teams.ts
 */
const env = prepareEnv("verify-teams");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { AgentSession, Job, Team, TeamCreditLog, TeamInvite, TeamInviteUse, TeamMember } = await import("./src/db/entities");
    const { newId, now } = await import("./src/lib/errors");

    await initDatabase();

    console.log("实体建表");
    const teamId = newId("team");
    await repo(Team).insert({
        id: teamId,
        name: "验证团队",
        description: "",
        avatarUrl: "",
        ownerId: "user-owner",
        credits: 100,
        memberLimit: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
    });
    check("团队写入成功", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 100);

    await repo(TeamMember).insert({
        teamId,
        userId: "user-owner",
        role: "owner",
        creditLimit: 0,
        limitWindow: "month",
        status: "active",
        invitedBy: "",
        joinedAt: now(),
        updatedAt: now(),
    });
    await repo(TeamMember).insert({
        teamId,
        userId: "user-a",
        role: "member",
        creditLimit: 0,
        limitWindow: "month",
        status: "active",
        invitedBy: "user-owner",
        joinedAt: now(),
        updatedAt: now(),
    });
    check("复合主键允许同团队多成员", await repo(TeamMember).countBy({ teamId }), 2);

    const inviteId = newId("team-invite");
    await repo(TeamInvite).insert({
        id: inviteId,
        teamId,
        kind: "code",
        tokenHash: "",
        tokenPrefix: "",
        code: "ABCDEFGHJK",
        role: "member",
        maxUses: 1,
        usedCount: 0,
        enabled: true,
        expiresAt: "",
        createdBy: "user-owner",
        note: "",
        createdAt: now(),
    });
    check("邀请写入成功", (await repo(TeamInvite).findOneByOrFail({ id: inviteId })).code, "ABCDEFGHJK");

    await repo(TeamInviteUse).insert({
        id: newId("team-invite-use"),
        inviteId,
        teamId,
        userId: "user-a",
        role: "member",
        createdAt: now(),
    });
    check("领取记录写入成功", await repo(TeamInviteUse).countBy({ inviteId }), 1);

    await repo(TeamCreditLog).insert({
        id: newId("team-credit"),
        teamId,
        userId: "user-a",
        type: "ai_consume",
        amount: -10,
        balance: 90,
        model: "gpt-x",
        relatedId: "",
        remark: "验证",
        extra: "",
        createdAt: now(),
    });
    check("团队流水写入成功", (await repo(TeamCreditLog).findOneByOrFail({ teamId })).balance, 90);

    console.log("存量记录默认按个人计费");
    // 写入一条不带 payer 字段的记录，模拟加列之前就存在的行：读回来必须落到「个人付费」。
    const legacyJobId = newId("job");
    await repo(Job).insert({
        id: legacyJobId,
        userId: "user-a",
        clientJobId: "legacy-1",
        kind: "image",
        status: "pending",
        model: "gpt-x",
        prompt: "",
        params: "{}",
        inputFileIds: [],
        outputFileIds: [],
        text: "",
        context: {},
        error: "",
        credits: 0,
        progress: 0,
        seq: 0,
        upstreamTaskId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: "",
    });
    const legacyJob = await repo(Job).findOneByOrFail({ id: legacyJobId });
    check("存量任务默认按个人计费", legacyJob.payerKind, "user");
    check("存量任务没有付费团队", legacyJob.payerTeamId, "");

    await repo(AgentSession).insert({
        userId: "user-a",
        sessionId: "legacy-session",
        projectId: "p-1",
        title: "",
        status: "idle",
        model: "gpt-x",
        error: "",
        lastSeq: 0,
        pendingAction: null,
        rounds: 0,
        autoRenamed: false,
        deleted: false,
        createdAt: now(),
        updatedAt: now(),
    });
    const legacySession = await repo(AgentSession).findOneByOrFail({
        userId: "user-a",
        sessionId: "legacy-session",
    });
    check("存量会话默认按个人计费", legacySession.payerKind, "user");
    check("存量会话没有付费团队", legacySession.payerTeamId, "");

    console.log("权限矩阵");
    const { canTeamAction, requireTeamRole } = await import("./src/services/team-access");

    const matrix: Array<[string, "owner" | "admin" | "member" | "viewer", boolean]> = [
        ["team.read", "viewer", true],
        ["team.update", "member", false],
        ["team.update", "admin", true],
        ["team.disband", "admin", false],
        ["team.disband", "owner", true],
        ["team.transfer", "admin", false],
        ["team.transfer", "owner", true],
        ["invite.manage", "member", false],
        ["invite.manage", "admin", true],
        ["member.manage", "admin", true],
        ["member.manage", "member", false],
        ["credits.spend", "viewer", false],
        ["credits.spend", "member", true],
        ["logs.readAll", "member", false],
        ["logs.readAll", "admin", true],
        ["logs.readMine", "viewer", true],
    ];
    for (const [action, role, expected] of matrix) check(`${role} 可以 ${action} 为 ${expected}`, canTeamAction(role, action as never), expected);

    check("admin 不能把人提升为 admin", canTeamAction("admin", "member.promoteAdmin"), false);
    check("owner 可以把人提升为 admin", canTeamAction("owner", "member.promoteAdmin"), true);

    await rejects("非成员访问团队抛错", () => requireTeamRole("user-outsider", teamId, "team.read"));
    await rejects("团队不存在抛错", () => requireTeamRole("user-owner", "team-missing", "team.read"));
    check("owner 通过 team.read 门槛", (await requireTeamRole("user-owner", teamId, "team.read")).role, "owner");
    await rejects("member 不满足 team.update 门槛", () => requireTeamRole("user-a", teamId, "team.update"));

    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "suspended" });
    await rejects("挂起成员被拒", () => requireTeamRole("user-a", teamId, "team.read"));
    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "active" });

    await repo(Team).update({ id: teamId }, { status: "disabled" });
    check("团队被停用仍可只读", (await requireTeamRole("user-a", teamId, "team.read")).team.status, "disabled");
    await rejects("团队被停用禁止写入", () => requireTeamRole("user-a", teamId, "credits.spend", { write: true }));
    await repo(Team).update({ id: teamId }, { status: "active" });

    // 权限判定只有 MATRIX 一个来源：调用处拿不到「角色数组」这个口子，
    // 传一个不在矩阵里的动作只能是硬拒，而不是意外放行。
    await rejects("未知动作一律拒绝", () => requireTeamRole("user-owner", teamId, "team.nope" as never));

    // 同级 admin 保护是一条具名断言，不是散在各服务里的 role 比较。
    const { assertCanManageMember } = await import("./src/services/team-access");
    await rejects("admin 不能操作同级 admin", async () => assertCanManageMember("admin", "admin"));
    check(
        "owner 可以操作 admin",
        (() => {
            assertCanManageMember("owner", "admin");
            return "放行";
        })(),
        "放行",
    );
    check(
        "admin 可以操作 member",
        (() => {
            assertCanManageMember("admin", "member");
            return "放行";
        })(),
        "放行",
    );

    console.log("嵌套事务");
    const { serialTransaction } = await import("./src/db/data-source");
    // 嵌套调用必须复用外层 manager，否则内层会永远排在自己后面，整个进程的写入全挂住。
    const nested = await Promise.race([
        serialTransaction(async (outer) => {
            await outer.getRepository(Team).update({ id: teamId }, { name: "嵌套改名" });
            return serialTransaction(async (inner) => {
                // 内层看得到外层还没提交的写入，才说明真的是同一个事务。
                check("嵌套事务复用同一个 manager", inner === outer, true);
                return (await inner.getRepository(Team).findOneByOrFail({ id: teamId })).name;
            });
        }),
        new Promise((resolve) => setTimeout(() => resolve("死锁超时"), 2000)),
    ]);
    check("嵌套事务不自死锁", nested, "嵌套改名");
    check("嵌套事务提交后写入生效", (await repo(Team).findOneByOrFail({ id: teamId })).name, "嵌套改名");
    await rejects("嵌套事务内抛错整体回滚", () =>
        serialTransaction(async (outer) => {
            await outer.getRepository(Team).update({ id: teamId }, { name: "不该留下" });
            await serialTransaction(async () => {
                throw new Error("boom");
            });
        }),
    );
    check("回滚后外层写入也没留下", (await repo(Team).findOneByOrFail({ id: teamId })).name, "嵌套改名");

    console.log("团队生命周期与 owner 不变量");
    const { createTeam, disbandTeam, leaveTeam, listMyTeams, removeMember, transferOwner, updateMemberRole, updateTeam } = await import("./src/services/teams");

    const fresh = await createTeam("user-boss", { name: "新团队" });
    check(
        "创建者即 owner",
        (
            await repo(TeamMember).findOneByOrFail({
                teamId: fresh.id,
                userId: "user-boss",
            })
        ).role,
        "owner",
    );
    check("新团队积分池为 0", fresh.credits, 0);
    check(
        "我的团队列表含新团队",
        (await listMyTeams("user-boss")).some((item) => item.id === fresh.id),
        true,
    );
    check("列表带上我的角色", (await listMyTeams("user-boss")).find((item) => item.id === fresh.id)?.myRole, "owner");
    check("不在团队的人列表为空", (await listMyTeams("user-outsider")).length, 0);
    await rejects("团队名不能为空", () => createTeam("user-boss", { name: "   " }));

    await repo(TeamMember).insert({
        teamId: fresh.id,
        userId: "user-b",
        role: "member",
        creditLimit: 0,
        limitWindow: "month",
        status: "active",
        invitedBy: "user-boss",
        joinedAt: now(),
        updatedAt: now(),
    });
    await repo(TeamMember).insert({
        teamId: fresh.id,
        userId: "user-c",
        role: "admin",
        creditLimit: 0,
        limitWindow: "month",
        status: "active",
        invitedBy: "user-boss",
        joinedAt: now(),
        updatedAt: now(),
    });

    check("admin 可以改团队信息", (await updateTeam(fresh.id, "user-c", { name: "改过的团队" })).name, "改过的团队");
    await rejects("member 不能改团队信息", () => updateTeam(fresh.id, "user-b", { name: "不该生效" }));
    check("被拒后团队名未变", (await repo(Team).findOneByOrFail({ id: fresh.id })).name, "改过的团队");

    await rejects("owner 不能主动退出", () => leaveTeam(fresh.id, "user-boss"));
    await rejects("owner 不能被移除", () => removeMember(fresh.id, "user-c", "user-boss"));
    await rejects("admin 不能移除 admin", () => removeMember(fresh.id, "user-c", "user-c"));
    await rejects("admin 不能把人提为 owner", () => updateMemberRole(fresh.id, "user-c", "user-b", "owner"));
    await rejects("admin 不能把人提为 admin", () => updateMemberRole(fresh.id, "user-c", "user-b", "admin"));
    await rejects("owner 也不能被降级", () => updateMemberRole(fresh.id, "user-boss", "user-boss", "member"));
    check(
        "被拒后 user-b 仍是 member",
        (
            await repo(TeamMember).findOneByOrFail({
                teamId: fresh.id,
                userId: "user-b",
            })
        ).role,
        "member",
    );
    check("admin 可以把 member 降为 viewer", (await updateMemberRole(fresh.id, "user-c", "user-b", "viewer")).role, "viewer");
    check("owner 可以任命 admin", (await updateMemberRole(fresh.id, "user-boss", "user-b", "admin")).role, "admin");
    await updateMemberRole(fresh.id, "user-boss", "user-b", "member");

    await transferOwner(fresh.id, "user-boss", "user-c");
    check(
        "转让后新 owner 就位",
        (
            await repo(TeamMember).findOneByOrFail({
                teamId: fresh.id,
                userId: "user-c",
            })
        ).role,
        "owner",
    );
    check(
        "转让后旧 owner 降为 admin",
        (
            await repo(TeamMember).findOneByOrFail({
                teamId: fresh.id,
                userId: "user-boss",
            })
        ).role,
        "admin",
    );
    check("团队恒有且仅有一个 owner", await repo(TeamMember).countBy({ teamId: fresh.id, role: "owner" }), 1);
    check("Team.ownerId 同步更新", (await repo(Team).findOneByOrFail({ id: fresh.id })).ownerId, "user-c");
    await rejects("不能转让给非成员", () => transferOwner(fresh.id, "user-c", "user-outsider"));
    await rejects("转让后旧 owner 无权再转让", () => transferOwner(fresh.id, "user-boss", "user-b"));

    await leaveTeam(fresh.id, "user-boss");
    check("退出后成员记录被删除", await repo(TeamMember).countBy({ teamId: fresh.id, userId: "user-boss" }), 0);

    // 平台停用团队后成员仍必须能退出：退出是「保护自己」的动作，
    // 把它一起掐掉等于把人永久锁在一个已经停用的团队里，连断开关系都做不到。
    const frozen = await createTeam("user-frozen-owner", { name: "被停用的团队" });
    await repo(TeamMember).insert({ teamId: frozen.id, userId: "user-frozen-member", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-frozen-owner", joinedAt: now(), updatedAt: now() });
    await repo(Team).update({ id: frozen.id }, { status: "disabled" });
    await leaveTeam(frozen.id, "user-frozen-member");
    check("停用团队后普通成员仍可退出", await repo(TeamMember).countBy({ teamId: frozen.id, userId: "user-frozen-member" }), 0);
    await rejects("停用团队后 owner 仍不能直接退出", () => leaveTeam(frozen.id, "user-frozen-owner"));
    await rejects("停用团队后仍不能改成员角色", () => updateMemberRole(frozen.id, "user-frozen-owner", "user-frozen-owner", "member"));

    const { createTeamInvite: makeInvite } = await import("./src/services/team-invites");
    const leftover = await makeInvite(fresh.id, "user-c", { kind: "link", role: "member", maxUses: 0 });
    const leftoverInviteId = leftover.id;
    const leftoverInviteToken = leftover.token;

    await disbandTeam(fresh.id, "user-c");
    check("解散后团队标记为 disbanded", (await repo(Team).findOneByOrFail({ id: fresh.id })).status, "disbanded");
    check("解散后成员全部清空", await repo(TeamMember).countBy({ teamId: fresh.id }), 0);
    check(
        "解散后不出现在任何人的团队列表",
        (await listMyTeams("user-c")).some((item) => item.id === fresh.id),
        false,
    );
    await rejects("解散后无法再访问", () => requireTeamRole("user-c", fresh.id, "team.read"));

    // 解散会删光成员，所以这里手工塞回一条：验证列表过滤的是团队状态本身，
    // 而不是「碰巧没有成员记录了」——否则残留一条成员行就能让死团队重新出现在列表里。
    await repo(TeamMember).insert({ teamId: fresh.id, userId: "user-ghost", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });
    check("残留成员也看不到已解散的团队", (await listMyTeams("user-ghost")).length, 0);
    await repo(TeamMember).delete({ teamId: fresh.id, userId: "user-ghost" });

    console.log("邀请链接与手输码");
    const { acceptTeamInvite, createTeamInvite, listTeamInvites, previewTeamInvite, updateTeamInvite } = await import("./src/services/team-invites");

    // 解散前留下的邀请必须一起失效，否则一条还在群里流传的链接能把人拉进一个已经没有 owner 的空壳团队。
    check("解散前的邀请已被停用", (await repo(TeamInvite).findOneByOrFail({ id: leftoverInviteId })).enabled, false);
    await rejects("解散后旧邀请无法领取", () => acceptTeamInvite(leftoverInviteToken, "user-late-join"));

    const host = await createTeam("user-host", { name: "邀请团队" });
    const link = await createTeamInvite(host.id, "user-host", {
        kind: "link",
        role: "member",
        maxUses: 0,
    });
    check("链接 token 至少 128 bit", Buffer.from(link.token, "base64url").length >= 16, true);
    check("库中不存 token 明文", (await repo(TeamInvite).findOneByOrFail({ id: link.id })).tokenHash !== link.token, true);
    check("tokenPrefix 是明文前缀", link.token.startsWith((await repo(TeamInvite).findOneByOrFail({ id: link.id })).tokenPrefix), true);
    check("tokenPrefix 不超过 8 位", (await repo(TeamInvite).findOneByOrFail({ id: link.id })).tokenPrefix.length <= 8, true);
    check("列表接口不返回明文 token", Object.prototype.hasOwnProperty.call((await listTeamInvites(host.id, "user-host"))[0], "token"), false);
    await rejects("member 不能管理邀请", () =>
        createTeamInvite(host.id, "user-outsider", {
            kind: "link",
            role: "member",
        }),
    );

    const tokens = new Set<string>();
    for (let index = 0; index < 1000; index += 1)
        tokens.add(
            (
                await createTeamInvite(host.id, "user-host", {
                    kind: "link",
                    role: "member",
                    maxUses: 0,
                })
            ).token,
        );
    check("1000 个 token 无重复", tokens.size, 1000);

    const codeInvite = await createTeamInvite(host.id, "user-host", {
        kind: "code",
        role: "viewer",
        maxUses: 2,
    });
    check("手输码长度为 10", codeInvite.code.length, 10);
    check("手输码不含形近字", /[01OIL]/.test(codeInvite.code), false);
    check("手输码明文可回查", (await repo(TeamInvite).findOneByOrFail({ id: codeInvite.id })).code, codeInvite.code);
    check(
        "手输码默认一次性",
        (
            await createTeamInvite(host.id, "user-host", {
                kind: "code",
                role: "member",
            })
        ).maxUses,
        1,
    );
    await rejects("不允许邀请为 owner", () =>
        createTeamInvite(host.id, "user-host", {
            kind: "code",
            role: "owner",
            maxUses: 1,
        }),
    );

    check("预览返回团队名", (await previewTeamInvite(link.token)).teamName, "邀请团队");
    await rejects("无效 token 预览失败", () => previewTeamInvite("not-a-real-token"));
    await acceptTeamInvite(link.token, "user-x");
    check(
        "领取后成为 member",
        (
            await repo(TeamMember).findOneByOrFail({
                teamId: host.id,
                userId: "user-x",
            })
        ).role,
        "member",
    );
    check("领取写入使用记录", await repo(TeamInviteUse).countBy({ inviteId: link.id }), 1);

    await acceptTeamInvite(link.token, "user-x");
    check("重复领取幂等，不新增成员", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-x" }), 1);
    check("重复领取不消耗名额", (await repo(TeamInvite).findOneByOrFail({ id: link.id })).usedCount, 1);

    check("手输码大小写不敏感", (await acceptTeamInvite(codeInvite.code.toLowerCase(), "user-lower")).role, "viewer");

    console.log("并发领取原子性");
    const limited = await createTeamInvite(host.id, "user-host", {
        kind: "link",
        role: "member",
        maxUses: 3,
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_unused, index) => acceptTeamInvite(limited.token, `rush-${index}`)));
    check("成功数恰好等于名额上限", results.filter((item) => item.status === "fulfilled").length, 3);
    check("usedCount 不超过 maxUses", (await repo(TeamInvite).findOneByOrFail({ id: limited.id })).usedCount, 3);
    // 只数本轮 rush-* 用户：按 invitedBy 数会把更早通过同一个人加入的成员算进来，
    // 断言名与期望值对不上，日后调整前序用例会先在这里翻车。
    check("本轮实际入队人数等于名额上限", (await repo(TeamMember).findBy({ teamId: host.id })).filter((member) => member.userId.startsWith("rush-")).length, 3);

    const single = await createTeamInvite(host.id, "user-host", {
        kind: "code",
        role: "member",
        maxUses: 1,
    });
    const duel = await Promise.allSettled([acceptTeamInvite(single.code, "duel-a"), acceptTeamInvite(single.code, "duel-b")]);
    check("同时抢一个名额只有一人成功", duel.filter((item) => item.status === "fulfilled").length, 1);
    check("单名额邀请 usedCount 为 1", (await repo(TeamInvite).findOneByOrFail({ id: single.id })).usedCount, 1);

    // 同一个人手抖点两次链接：两次都该成功且指向同一条成员记录，只吃一个名额。
    // 「其中一次拿到 409」不是可接受的语义——用户看到的是一次莫名其妙的失败。
    const twice = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    const sameUser = await Promise.allSettled([acceptTeamInvite(twice.token, "user-double"), acceptTeamInvite(twice.token, "user-double")]);
    check("同一用户并发领取两次都成功", sameUser.filter((item) => item.status === "fulfilled").length, 2);
    check("同一用户并发领取只产生一条成员记录", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-double" }), 1);
    check("同一用户并发领取只消耗一个名额", (await repo(TeamInvite).findOneByOrFail({ id: twice.id })).usedCount, 1);
    check("同一用户并发领取只写一条使用记录", await repo(TeamInviteUse).countBy({ inviteId: twice.id }), 1);

    // 挂起的成员再点链接，必须给一个明确的错误，而不是「返回成功但进去什么都做不了」。
    await repo(TeamMember).update({ teamId: host.id, userId: "user-double" }, { status: "suspended" });
    await rejects("挂起成员领取邀请被明确拒绝", () => acceptTeamInvite(twice.token, "user-double"));
    check("挂起成员领取后状态不变", (await repo(TeamMember).findOneByOrFail({ teamId: host.id, userId: "user-double" })).status, "suspended");
    check("挂起成员领取不消耗名额", (await repo(TeamInvite).findOneByOrFail({ id: twice.id })).usedCount, 1);
    await repo(TeamMember).update({ teamId: host.id, userId: "user-double" }, { status: "active" });

    console.log("邀请码唯一性与过期归一化");
    // code 列必须有唯一约束：没有它，两次生成撞上同一个码时后来的那张会把前一张的领取路径整个劫走。
    const dup = await createTeamInvite(host.id, "user-host", { kind: "code", role: "member", maxUses: 1 });
    await rejects("重复的手输码写不进库", () =>
        repo(TeamInvite).insert({
            id: newId("team-invite"),
            teamId: host.id,
            kind: "code",
            tokenHash: "",
            tokenPrefix: "",
            code: dup.code,
            role: "member",
            maxUses: 1,
            usedCount: 0,
            enabled: true,
            expiresAt: "",
            createdBy: "user-host",
            note: "",
            createdAt: now(),
        }),
    );
    // 生成器撞码时要靠唯一约束本身兜住，而不是先查再写——两次查询之间的窗口期正是真实冲突发生的地方。
    const { insertWithUniqueCode, isUniqueViolation } = await import("./src/services/team-invites");
    const scripted = ["AAAAAAAAAA", "AAAAAAAAAA", "BBBBBBBBBB"];
    let picked = 0;
    const conflict = () => Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    check(
        "写入撞唯一约束后换一个新码重试",
        await insertWithUniqueCode(
            () => scripted[picked++],
            async (code: string) => {
                if (code === "AAAAAAAAAA") throw conflict();
            },
        ),
        "BBBBBBBBBB",
    );
    check("撞码重试确实换过码", picked, 3);
    await rejects("一直撞码则明确报错而不是死循环", () =>
        insertWithUniqueCode(
            () => "AAAAAAAAAA",
            async () => {
                throw conflict();
            },
        ),
    );
    // 不是唯一冲突的错误必须原样抛出：换几次码结果一样，吞掉只会把真故障伪装成「邀请码生成失败」。
    let attempts = 0;
    await rejects("非唯一冲突的错误不重试直接抛出", () =>
        insertWithUniqueCode(
            () => "CCCCCCCCCC",
            async () => {
                attempts += 1;
                throw new Error("connection lost");
            },
        ),
    );
    check("非唯一冲突只尝试一次", attempts, 1);
    check("识别 SQLite 唯一冲突", isUniqueViolation(conflict()), true);
    check("识别 MySQL 唯一冲突", isUniqueViolation({ code: "ER_DUP_ENTRY" }), true);
    check("识别 Postgres 唯一冲突", isUniqueViolation({ driverError: { code: "23505" } }), true);
    check("普通错误不算唯一冲突", isUniqueViolation(new Error("boom")), false);

    // 真实数据库上的冲突恢复：把生成器钉死在一个已被占用的码上一次，第二次给新码，必须成功落库。
    const occupied = (await repo(TeamInvite).findOneByOrFail({ id: dup.id })).code as string;
    const replacement = "ZZZZZZZZZZ";
    const retryId = newId("team-invite");
    const sequence = [occupied, replacement];
    let cursor = 0;
    const settled = await insertWithUniqueCode(
        () => sequence[cursor++],
        async (code: string) => {
            await repo(TeamInvite).insert({ id: retryId, teamId: host.id, kind: "code", tokenHash: "", tokenPrefix: "", code, role: "member", maxUses: 1, usedCount: 0, enabled: true, expiresAt: "", createdBy: "user-host", note: "", createdAt: now() });
        },
    );
    check("真实唯一冲突后重试写入成功", settled, replacement);
    check("重试后落库的是新码", (await repo(TeamInvite).findOneByOrFail({ id: retryId })).code, replacement);

    // 带时区偏移的过期时间必须归一化成 UTC ISO：直接原样入库的话，
    // claimSlot 的字符串比较与 Date.parse 判定会分家，已过期的邀请在并发路径上还能被领走。
    const tz = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0, expiresAt: "2020-01-01T00:00:00+08:00" });
    check("过期时间归一化为 UTC ISO", (await repo(TeamInvite).findOneByOrFail({ id: tz.id })).expiresAt, new Date("2020-01-01T00:00:00+08:00").toISOString());
    await rejects("带时区的过期邀请无法领取", () => acceptTeamInvite(tz.token, "user-tz"));
    check("带时区的过期邀请没有消耗名额", (await repo(TeamInvite).findOneByOrFail({ id: tz.id })).usedCount, 0);
    await rejects("非法过期时间被拒绝", () => createTeamInvite(host.id, "user-host", { kind: "link", role: "member", expiresAt: "明天" }));
    const tzPatch = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    check("更新过期时间同样归一化", (await updateTeamInvite(host.id, "user-host", tzPatch.id, { expiresAt: "2030-01-01T00:00:00+08:00" })).expiresAt, new Date("2030-01-01T00:00:00+08:00").toISOString());
    await rejects("更新时非法过期时间被拒绝", () => updateTeamInvite(host.id, "user-host", tzPatch.id, { expiresAt: "后天" }));

    console.log("成员变更广播");
    const { closeTeamConnectionsOf, publishTeamMember, subscribeTeam } = await import("./src/services/team-realtime");
    const events: Array<{ type: string; userId: string }> = [];
    const stopWatching = subscribeTeam(host.id, "user-host", (event) => events.push(event));
    const otherEvents: unknown[] = [];
    const stopOther = subscribeTeam(fresh.id, "user-host", (event) => otherEvents.push(event));

    const joinLink = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    await repo(Team).update({ id: host.id }, { memberLimit: 0 });
    await acceptTeamInvite(joinLink.token, "user-broadcast");
    check("加入后广播 member.joined", events.filter((event) => event.type === "member.joined" && event.userId === "user-broadcast").length, 1);
    check("其他团队的订阅者收不到", otherEvents.length, 0);

    let kicked = false;
    subscribeTeam(host.id, "user-broadcast", () => undefined, () => {
        kicked = true;
    });
    await removeMember(host.id, "user-host", "user-broadcast");
    check("移除后广播 member.removed", events.filter((event) => event.type === "member.removed" && event.userId === "user-broadcast").length, 1);
    check("移除后断开该成员的团队连接", kicked, true);

    const before = events.length;
    stopWatching();
    stopOther();
    publishTeamMember(host.id, { type: "member.joined", userId: "user-none", role: "member" });
    check("退订后不再收到事件", events.length, before);
    check("没有连接时断连返回 0", closeTeamConnectionsOf(host.id, "user-nobody"), 0);

    // 断连必须连同总线 listener 一起退订。只关连接不退订的话，被移除的人页面早就没了，
    // 进程里还留着他的回调，团队每变更一次就白跑一遍，重新入队时还会收到两份事件。
    const { teamListenerCount } = await import("./src/services/team-realtime");
    check("退订后总线上不留 listener", teamListenerCount(host.id), 0);
    const leaked: unknown[] = [];
    subscribeTeam(host.id, "user-leak", (event) => leaked.push(event), () => undefined);
    check("订阅后总线上有一个 listener", teamListenerCount(host.id), 1);
    check("断连返回被关闭的连接数", closeTeamConnectionsOf(host.id, "user-leak"), 1);
    check("断连后总线 listener 已退订", teamListenerCount(host.id), 0);
    publishTeamMember(host.id, { type: "member.joined", userId: "user-none", role: "member" });
    check("断连后不再收到事件", leaked.length, 0);
    // 断连之后调用方再退订一次不能把别人的 listener 误伤掉，也不能报错。
    const stopLeak = subscribeTeam(host.id, "user-leak2", () => undefined);
    const stopKeeper = subscribeTeam(host.id, "user-keeper", () => undefined);
    closeTeamConnectionsOf(host.id, "user-leak2");
    stopLeak();
    check("重复退订不影响其他订阅者", teamListenerCount(host.id), 1);
    stopKeeper();
    check("全部退订后归零", teamListenerCount(host.id), 0);

    console.log("转让广播");
    const relay = await createTeam("user-relay-a", { name: "转让广播团队" });
    await repo(TeamMember).insert({ teamId: relay.id, userId: "user-relay-b", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-relay-a", joinedAt: now(), updatedAt: now() });
    const relayEvents: Array<{ type: string; userId: string; role: string }> = [];
    const stopRelay = subscribeTeam(relay.id, "user-relay-a", (event) => relayEvents.push(event));
    await transferOwner(relay.id, "user-relay-a", "user-relay-b");
    // 只广播新 owner 的话，其他人页面上会同时挂着两个 owner，旧 owner 那边还留着他已经点不动的入口。
    check("转让广播新 owner 的 roleChanged", relayEvents.filter((event) => event.type === "member.roleChanged" && event.userId === "user-relay-b" && event.role === "owner").length, 1);
    check("转让广播旧 owner 降为 admin", relayEvents.filter((event) => event.type === "member.roleChanged" && event.userId === "user-relay-a" && event.role === "admin").length, 1);
    stopRelay();

    console.log("邀请状态校验");
    // 停用与过期各用一条独立的、名额充足的邀请：共用一条的话后一个用例会被前一个吃掉的名额掩盖，
    // 变成「因为用完了所以被拒」，那条断言就再也咬不住停用/过期的判定本身。
    const toDisable = await createTeamInvite(host.id, "user-host", { kind: "code", role: "member", maxUses: 0 });
    await updateTeamInvite(host.id, "user-host", toDisable.id, { enabled: false });
    await rejects("停用后无法领取", () => acceptTeamInvite(toDisable.code, "user-y"));

    const toExpire = await createTeamInvite(host.id, "user-host", { kind: "code", role: "member", maxUses: 0 });
    await updateTeamInvite(host.id, "user-host", toExpire.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await rejects("过期后无法领取", () => acceptTeamInvite(toExpire.code, "user-y2"));
    await rejects("错误 token 无法领取", () => acceptTeamInvite("not-a-real-token", "user-y"));
    check("停用后没有加入团队", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-y" }), 0);
    check("过期后没有加入团队", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-y2" }), 0);

    const usedUp = await createTeamInvite(host.id, "user-host", {
        kind: "link",
        role: "member",
        maxUses: 1,
    });
    await acceptTeamInvite(usedUp.token, "user-fill");
    await rejects("名额用完后无法领取", () => acceptTeamInvite(usedUp.token, "user-late"));

    console.log("成员数上限");
    // 名额只剩一个人的位置，两个人同时抢：一个进去，另一个必须被拒且不留下任何痕迹。
    // 占位若发生在事务外，SQLite 单连接下它会落进别人已经打开的 BEGIN 里，
    // 被拒那一方回滚时会把成功那一方占掉的名额一起抹掉，usedCount 从此对不上真实入队人数。
    await repo(Team).update({ id: host.id }, { memberLimit: (await repo(TeamMember).countBy({ teamId: host.id })) + 1 });
    const race = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    const raced = await Promise.allSettled([acceptTeamInvite(race.token, "user-race-a"), acceptTeamInvite(race.token, "user-race-b")]);
    check("只剩一个位置时只有一人挤进来", raced.filter((item) => item.status === "fulfilled").length, 1);
    check("被上限拒绝的一方不留成员记录", (await repo(TeamMember).findBy({ teamId: host.id })).filter((member) => member.userId.startsWith("user-race-")).length, 1);
    check("并发触上限后 usedCount 等于真实入队人数", (await repo(TeamInvite).findOneByOrFail({ id: race.id })).usedCount, 1);

    await repo(Team).update({ id: host.id }, { memberLimit: await repo(TeamMember).countBy({ teamId: host.id }) });
    const overflow = await createTeamInvite(host.id, "user-host", {
        kind: "link",
        role: "member",
        maxUses: 0,
    });
    await rejects("达到成员上限后拒绝加入", () => acceptTeamInvite(overflow.token, "user-z"));
    check("被拒后名额已归还", (await repo(TeamInvite).findOneByOrFail({ id: overflow.id })).usedCount, 0);
    check("被拒后没有写入成员", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-z" }), 0);

    finish(env.root);
}

void main();
