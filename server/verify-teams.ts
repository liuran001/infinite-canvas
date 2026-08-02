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

    await rejects("非成员访问团队抛错", () => requireTeamRole("user-outsider", teamId, ["viewer"]));
    await rejects("团队不存在抛错", () => requireTeamRole("user-owner", "team-missing", ["viewer"]));
    check("owner 通过 viewer 门槛", (await requireTeamRole("user-owner", teamId, ["owner", "viewer"])).role, "owner");
    await rejects("member 不满足 admin 门槛", () => requireTeamRole("user-a", teamId, ["owner", "admin"]));

    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "suspended" });
    await rejects("挂起成员被拒", () => requireTeamRole("user-a", teamId, ["member"]));
    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "active" });

    await repo(Team).update({ id: teamId }, { status: "disabled" });
    check("团队被停用仍可只读", (await requireTeamRole("user-a", teamId, ["member"])).team.status, "disabled");
    await rejects("团队被停用禁止写入", () => requireTeamRole("user-a", teamId, ["member"], { write: true }));
    await repo(Team).update({ id: teamId }, { status: "active" });

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
    await rejects("解散后无法再访问", () => requireTeamRole("user-c", fresh.id, ["viewer"]));

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
    check(
        "实际入队人数等于名额上限",
        await repo(TeamMember).countBy({
            invitedBy: "user-host",
            teamId: host.id,
            role: "member",
        }),
        4,
    );

    const single = await createTeamInvite(host.id, "user-host", {
        kind: "code",
        role: "member",
        maxUses: 1,
    });
    const duel = await Promise.allSettled([acceptTeamInvite(single.code, "duel-a"), acceptTeamInvite(single.code, "duel-b")]);
    check("同时抢一个名额只有一人成功", duel.filter((item) => item.status === "fulfilled").length, 1);
    check("单名额邀请 usedCount 为 1", (await repo(TeamInvite).findOneByOrFail({ id: single.id })).usedCount, 1);

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
