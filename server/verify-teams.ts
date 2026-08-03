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
    const { AgentSession, Job, Project, Team, TeamCreditLog, TeamInvite, TeamInviteUse, TeamMember } = await import("./src/db/entities");
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
    const { createTeam, disbandTeam, getTeam, leaveTeam, listMyTeams, removeMember, transferOwner, updateMemberRole, updateTeam } = await import("./src/services/teams");

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

    // 解散前先挂两张画布上去：解散若不把 teamId 收回来，画布的付费方解析会永远卡在「团队不可用」，
    // 而画布的主人既不能在上面花钱，也没有任何入口把它解绑，等于被永久锁死。
    await repo(Project).insert({ userId: "user-c", projectId: "pd-1", title: "解散前画布", data: "{}", revision: 1, deleted: false, teamId: fresh.id, createdAt: now(), updatedAt: now() });
    await repo(Project).insert({ userId: "user-b", projectId: "pd-2", title: "别人的画布", data: "{}", revision: 1, deleted: false, teamId: fresh.id, createdAt: now(), updatedAt: now() });

    await disbandTeam(fresh.id, "user-c");
    check("解散后团队标记为 disbanded", (await repo(Team).findOneByOrFail({ id: fresh.id })).status, "disbanded");
    check("解散后画布收回个人名下", await repo(Project).countBy({ teamId: fresh.id }), 0);
    check("解散后画布本身还在", (await repo(Project).findOneByOrFail({ userId: "user-c", projectId: "pd-1" })).teamId, "");
    check("解散后画布仍能解析出个人付费方", (await (await import("./src/services/billing")).payerOfProject("user-c", "pd-1")).kind, "user");
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
    // 错误文案照抄驱动真实输出：重试判定要认出「撞的是 code 这条约束」，认不出主键冲突就会被当成码耗尽。
    const conflict = () => Object.assign(new Error("UNIQUE constraint failed: team_invites.code"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
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
    const { isInviteCodeUniqueViolation } = await import("./src/services/team-invites");
    check("识别到撞的是 code 约束", isInviteCodeUniqueViolation(conflict()), true);
    // 主键冲突也是唯一冲突，但换码重试解决不了，必须落到「原样抛出」那条分支。
    check("主键冲突不算码冲突", isInviteCodeUniqueViolation(Object.assign(new Error("UNIQUE constraint failed: team_invites.id"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" })), false);
    check("识别 MySQL 的 code 约束名", isInviteCodeUniqueViolation({ code: "ER_DUP_ENTRY", message: "Duplicate entry 'ABC' for key 'uq_team_invites_code'" }), true);
    // Postgres：码约束是显式命名的，constraint 字段就是它；主键则是 TypeORM 生成的 PK_<hash>，
    // 名字里没有表名也没有列名，必须匹配不上而原样抛出，否则会被换码重试八次再伪装成「码耗尽」。
    check("识别 Postgres 的 code 约束名", isInviteCodeUniqueViolation({ driverError: { code: "23505", constraint: "uq_team_invites_code", table: "team_invites", detail: "Key (code)=(ABC) already exists." } }), true);
    check("Postgres 主键冲突不算码冲突", isInviteCodeUniqueViolation({ driverError: { code: "23505", constraint: "PK_9a1f2c7b3e", table: "team_invites", detail: "Key (id)=(x) already exists.", message: 'duplicate key value violates unique constraint "PK_9a1f2c7b3e"' } }), false);
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
    // 转让改的是双方的角色，而 SSE 建好之后不再鉴权：不断连的话，旧 owner 的界面会一直留着
    // 「解散团队」这种他已经点不动的入口，新 owner 反而拿不到任何 owner 入口，两边都要等自己刷新。
    let relayOldClosed = false;
    let relayNewClosed = false;
    subscribeTeam(
        relay.id,
        "user-relay-a",
        () => undefined,
        () => {
            relayOldClosed = true;
        },
    );
    subscribeTeam(
        relay.id,
        "user-relay-b",
        () => undefined,
        () => {
            relayNewClosed = true;
        },
    );
    await transferOwner(relay.id, "user-relay-a", "user-relay-b");
    // 只广播新 owner 的话，其他人页面上会同时挂着两个 owner，旧 owner 那边还留着他已经点不动的入口。
    check("转让广播新 owner 的 roleChanged", relayEvents.filter((event) => event.type === "member.roleChanged" && event.userId === "user-relay-b" && event.role === "owner").length, 1);
    check("转让广播旧 owner 降为 admin", relayEvents.filter((event) => event.type === "member.roleChanged" && event.userId === "user-relay-a" && event.role === "admin").length, 1);
    check("转让后断开旧 owner 的连接", relayOldClosed, true);
    check("转让后断开新 owner 的连接", relayNewClosed, true);
    check("转让后两边的 listener 都已退订", teamListenerCount(relay.id), 0);
    stopRelay();

    console.log("团队实时总线");
    const { publishTeamCredits } = await import("./src/services/team-realtime");
    const creditEvents: Array<{ type: string; credits?: number }> = [];
    const creditOther: unknown[] = [];
    const stopCredits = subscribeTeam(host.id, "user-credits", (event) => creditEvents.push(event));
    const stopCreditsOther = subscribeTeam(fresh.id, "user-credits", (event) => creditOther.push(event));

    publishTeamCredits(host.id, 123);
    check("订阅者收到余额事件", creditEvents.length, 1);
    check("余额事件带最新余额", creditEvents[0].credits, 123);
    check("余额事件类型是 team.credits", creditEvents[0].type, "team.credits");
    check("其他团队的订阅者不受余额事件影响", creditOther.length, 0);

    publishTeamMember(host.id, { type: "member.joined", userId: "user-x", role: "member" });
    check("同一条订阅也收成员事件", creditEvents.length, 2);

    let creditClosed = false;
    subscribeTeam(host.id, "user-kick", () => undefined, () => {
        creditClosed = true;
    });
    check("被移除成员的连接被主动关闭", (closeTeamConnectionsOf(host.id, "user-kick"), creditClosed), true);

    stopCredits();
    stopCreditsOther();
    publishTeamCredits(host.id, 456);
    check("退订后不再收到余额事件", creditEvents.length, 2);
    check("余额订阅退订后总线归零", teamListenerCount(host.id), 0);

    // 扣费与管理员调整都必须把最新余额广播出去，否则界面上的团队余额要等用户自己刷新。
    const { charge, setTeamCredits } = await import("./src/services/billing");
    const busTeam = await createTeam("user-bus-owner", { name: "余额广播团队" });
    await repo(Team).update({ id: busTeam.id }, { credits: 100 });
    const busEvents: Array<{ type: string; credits?: number }> = [];
    const stopBus = subscribeTeam(busTeam.id, "user-bus-owner", (event) => busEvents.push(event));
    await charge({ kind: "team", teamId: busTeam.id, memberId: "user-bus-owner" }, 30, { model: "gpt-x", path: "/x" });
    check("团队扣费后广播最新余额", busEvents.filter((event) => event.type === "team.credits" && event.credits === 70).length, 1);
    await setTeamCredits(busTeam.id, 500, "验证充值");
    check("管理员调整后广播最新余额", busEvents.filter((event) => event.type === "team.credits" && event.credits === 500).length, 1);
    check("调整写入团队 admin_adjust 流水", await repo(TeamCreditLog).countBy({ teamId: busTeam.id, type: "admin_adjust" }), 1);
    // 平台管理员不是团队成员，这条流水的 userId 必须留空，否则成员额度聚合会把充值算到某个人头上。
    check("平台调整的流水不挂在任何成员名下", (await repo(TeamCreditLog).findOneByOrFail({ teamId: busTeam.id, type: "admin_adjust" })).userId, "");
    check("调整后团队池就是目标值", (await repo(Team).findOneByOrFail({ id: busTeam.id })).credits, 500);
    stopBus();

    console.log("降级与挂起后断流");
    const { updateMember } = await import("./src/services/teams");
    const guard = await createTeam("user-guard-owner", { name: "断流团队" });
    await repo(TeamMember).insert({ teamId: guard.id, userId: "user-guard-m", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-guard-owner", joinedAt: now(), updatedAt: now() });
    let demoted = false;
    subscribeTeam(guard.id, "user-guard-m", () => undefined, () => {
        demoted = true;
    });
    await updateMember(guard.id, "user-guard-owner", "user-guard-m", { role: "viewer" });
    check("降级后主动断开该成员的连接", demoted, true);
    check("降级确实落库", (await repo(TeamMember).findOneByOrFail({ teamId: guard.id, userId: "user-guard-m" })).role, "viewer");

    let suspended = false;
    subscribeTeam(guard.id, "user-guard-m", () => undefined, () => {
        suspended = true;
    });
    await updateMember(guard.id, "user-guard-owner", "user-guard-m", { status: "suspended" });
    check("挂起后主动断开该成员的连接", suspended, true);
    // 挂起的人连读都过不了 requireTeamRole，SSE 自然也进不来。
    await rejects("挂起后无法再订阅团队", () => getTeam("user-guard-m", guard.id));
    await updateMember(guard.id, "user-guard-owner", "user-guard-m", { status: "active" });
    check("恢复后又能读团队", (await getTeam("user-guard-m", guard.id)).myRole, "viewer");
    check("额度与周期能一起改", JSON.stringify(await updateMember(guard.id, "user-guard-owner", "user-guard-m", { creditLimit: 20, limitWindow: "day" })).includes('"creditLimit":20'), true);
    await rejects("非法额度周期被拒", () => updateMember(guard.id, "user-guard-owner", "user-guard-m", { limitWindow: "week" }));
    await rejects("不能挂起 owner", () => updateMember(guard.id, "user-guard-owner", "user-guard-owner", { status: "suspended" }));

    let disbandClosed = false;
    subscribeTeam(guard.id, "user-guard-m", () => undefined, () => {
        disbandClosed = true;
    });
    await disbandTeam(guard.id, "user-guard-owner");
    check("解散后断开全部成员连接", disbandClosed, true);
    check("解散后总线上不留 listener", teamListenerCount(guard.id), 0);

    console.log("团队流水的可见范围");
    const ledger = await createTeam("user-ledger-owner", { name: "流水团队" });
    await repo(TeamMember).insert({ teamId: ledger.id, userId: "user-ledger-m", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-ledger-owner", joinedAt: now(), updatedAt: now() });
    await repo(Team).update({ id: ledger.id }, { credits: 100 });
    const { listMyTeamCreditLogs, listTeamCreditLogs } = await import("./src/services/teams");
    await charge({ kind: "team", teamId: ledger.id, memberId: "user-ledger-m" }, 10, { model: "gpt-x", path: "/x" });
    await charge({ kind: "team", teamId: ledger.id, memberId: "user-ledger-owner" }, 5, { model: "gpt-x", path: "/x" });
    const page = { keyword: "", tags: [], category: "", type: "", page: 1, pageSize: 20, offset: 0 };
    check("owner 能看全员流水", (await listTeamCreditLogs("user-ledger-owner", ledger.id, page)).total, 2);
    await rejects("member 看不了全员流水", () => listTeamCreditLogs("user-ledger-m", ledger.id, page));
    check("member 只能看自己的流水", (await listMyTeamCreditLogs("user-ledger-m", ledger.id, page)).total, 1);
    await rejects("非成员看流水按不存在处理", () => listMyTeamCreditLogs("user-ledger-outsider", ledger.id, page));

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

    await projectOwnership({ check, rejects });
    await memberSettings({ check, rejects });
    await backstage({ check, rejects });
    await readySequencing({ check });
    await numericInput({ check, rejects });

    finish(env.root);
}

/**
 * 非负整数入参的边界。这个函数是「畸形请求会不会被解释成一次清零」的唯一裁判，
 * 而 JS 的隐式转换在这里全是陷阱：Number("")、Number("   ")、Number([]) 统统是 0，
 * Number(false) 是 0，Number("0x10") 是 16，Number("1e2") 是 100。
 * 任何一条漏网，一次拼错字段名或前端传空的请求就会被照单执行成「把积分/额度/上限改成某个数」。
 */
async function numericInput({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { nonNegativeInteger } = await import("./src/lib/validate");

    console.log("非负整数入参校验");
    const parse = (value: unknown) => nonNegativeInteger(value, 7, 1000, "非法", "BAD");
    const refuses = (value: unknown) => rejects(`拒绝 ${typeof value} ${JSON.stringify(value) ?? String(value)}`, async () => parse(value));

    // 空值系列：全都会被 Number() 折成 0，也就是「清零」，而它们的真实含义是「这个字段没填」。
    for (const value of ["", "   ", "\t\n", [], {}, null, true, false, [5]]) await refuses(value);
    // 进制与科学计数：用户以为自己写的是十进制，落库的却是另一个数量级。
    for (const value of ["0x10", "0b11", "0o17", "1e2", "1E2", " 0x10 "]) await refuses(value);
    // 形似数字但不是纯十进制的写法，一律不猜用户的意思。
    for (const value of ["1_000", "12.0", "+12", "1,000", "12px", "Infinity", "NaN", "1n"]) await refuses(value);
    // number 类型自身的非法取值。
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, -0.5, 1001, Number.MAX_SAFE_INTEGER]) await refuses(value);

    check("接受 number 型非负整数", parse(0), 0);
    check("接受上界本身", parse(1000), 1000);
    check("接受纯十进制字符串", parse("42"), 42);
    check("接受带空白的纯十进制字符串", parse("  42  "), 42);
    check("接受前导零", parse("007"), 7);
    check("undefined 表示这次不改", parse(undefined), 7);
    // -0 与 0 在库里没有区别，但 Object.is 分得清；归一成 0 免得它顺着写进流水里。
    check("负零归一为零", Object.is(parse(-0), 0), true);
}

/**
 * 成员设置的入参与原子性。这条路径同时改角色、额度、状态，是团队里唯一能一次动三样东西的写入，
 * 任何一项校验漏掉都会在库里留下一条谁也解释不了的成员记录。
 */
async function memberSettings({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { Team, TeamMember } = await import("./src/db/entities");
    const { createTeam, updateMember } = await import("./src/services/teams");
    const { now } = await import("./src/lib/errors");

    console.log("成员设置的入参与原子性");
    const team = await createTeam("user-set-owner", { name: "设置团队" });
    const member = () => repo(TeamMember).findOneByOrFail({ teamId: team.id, userId: "user-set-m" });
    await repo(TeamMember).insert({ teamId: team.id, userId: "user-set-m", role: "member", creditLimit: 7, limitWindow: "month", status: "active", invitedBy: "user-set-owner", joinedAt: now(), updatedAt: now() });

    // 角色白名单。只挡 owner 的话，随手传一个 "boss" 就能在库里种下一个权限矩阵查不到的角色：
    // 这个人处处被拒，却没有任何一条规则能说明为什么，管理员也没有入口把他改回来。
    for (const bogus of ["boss", "OWNER", "", "administrator"]) await rejects(`角色 ${JSON.stringify(bogus)} 被拒`, () => updateMember(team.id, "user-set-owner", "user-set-m", { role: bogus }));
    check("被拒后角色没有变脏", (await member()).role, "member");
    check("白名单内的角色仍能改", (await updateMember(team.id, "user-set-owner", "user-set-m", { role: "viewer" })).role, "viewer");

    // 额度上限：畸形输入必须是 400，而不是被 `Number(x) || 0` 悄悄折成「把额度改成 0」。
    for (const bogus of ["abc", Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, null, {}, 1_000_000_001])
        await rejects(`额度 ${JSON.stringify(bogus) ?? String(bogus)} 被拒`, () => updateMember(team.id, "user-set-owner", "user-set-m", { creditLimit: bogus }));
    check("被拒后额度原样保留", (await member()).creditLimit, 7);
    check("合法额度能改", (await updateMember(team.id, "user-set-owner", "user-set-m", { creditLimit: 0 })).creditLimit, 0);
    check("字符串数字也认", (await updateMember(team.id, "user-set-owner", "user-set-m", { creditLimit: "42" })).creditLimit, 42);

    // 原子性：角色与额度必须同生共死。分两段写的话，前一段的角色已经落库，
    // 后一段被非法周期拦下，成员就停在一个「角色改了、额度没改」的中间态上，而调用方收到的是一次失败。
    await rejects("角色合法但周期非法时整体失败", () => updateMember(team.id, "user-set-owner", "user-set-m", { role: "member", limitWindow: "week" }));
    check("整体失败后角色没有被改掉", (await member()).role, "viewer");
    await rejects("角色合法但额度非法时整体失败", () => updateMember(team.id, "user-set-owner", "user-set-m", { role: "member", creditLimit: -5 }));
    check("整体失败后角色仍未变", (await member()).role, "viewer");
    check("整体失败后额度仍未变", (await member()).creditLimit, 42);

    // 并发：两个 admin 同时改同一个人，后手不能拿着过期快照把先手的写入盖回去。
    const settled = await Promise.all([updateMember(team.id, "user-set-owner", "user-set-m", { role: "member" }), updateMember(team.id, "user-set-owner", "user-set-m", { creditLimit: 99 })]);
    const final = await member();
    check("并发修改后角色是 member", final.role, "member");
    check("并发修改后额度是 99", final.creditLimit, 99);
    check("两次调用都成功返回", settled.length, 2);

    // 成员列表的已用额度：按窗口批量聚合，结果必须与逐人聚合的判定口径一模一样，
    // 否则界面上的数字和真正会拦住人的那个数字会分家。
    const { charge, usedCreditsOfMember } = await import("./src/services/billing");
    const { listMemberViews } = await import("./src/services/teams");
    await repo(Team).update({ id: team.id }, { credits: 500 });
    await repo(TeamMember).update({ teamId: team.id, userId: "user-set-m" }, { limitWindow: "day", creditLimit: 0 });
    await charge({ kind: "team", teamId: team.id, memberId: "user-set-m" }, 12, { model: "gpt-x", path: "/x" });
    await charge({ kind: "team", teamId: team.id, memberId: "user-set-owner" }, 30, { model: "gpt-x", path: "/x" });
    const views = await listMemberViews("user-set-owner", team.id);
    check("成员列表算出本人已用额度", views.find((view) => view.userId === "user-set-m")?.usedCredits, 12);
    check("不同窗口的成员各算各的", views.find((view) => view.userId === "user-set-owner")?.usedCredits, 30);
    check("批量聚合与判定口径一致", views.find((view) => view.userId === "user-set-m")?.usedCredits, await usedCreditsOfMember(team.id, "user-set-m", "day"));
    const zero = await createTeam("user-zero", { name: "零消费团队" });
    check("没花过钱的成员是 0 而不是缺字段", (await listMemberViews("user-zero", zero.id))[0].usedCredits, 0);
}

/**
 * 平台后台。这里的每个入口都绕过团队内的权限判定，所以它自己的入参校验就是最后一道门。
 */
async function backstage({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { Project, Team, TeamMember } = await import("./src/db/entities");
    const { adminSetTeamCredits, adminUpdateTeam } = await import("./src/services/admin-teams");
    const { createTeam, disbandTeam } = await import("./src/services/teams");
    const { now } = await import("./src/lib/errors");

    console.log("平台团队后台");
    const team = await createTeam("user-back-owner", { name: "后台团队" });
    await repo(TeamMember).insert({ teamId: team.id, userId: "user-back-m", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-back-owner", joinedAt: now(), updatedAt: now() });
    await repo(Project).insert({ userId: "user-back-owner", projectId: "pb-1", title: "后台画布", data: "{}", revision: 1, deleted: false, teamId: team.id, createdAt: now(), updatedAt: now() });

    // 后台只有「启用/停用」两档。放行 disbanded 的话，这里只改一列状态：成员、邀请、画布归属原封不动，
    // 画布的付费方解析从此永远卡在「团队不可用」，主人既不能花钱也没有入口解绑，等于被永久锁死。
    await rejects("后台不能把团队置为 disbanded", () => adminUpdateTeam(team.id, { status: "disbanded" }));
    await rejects("后台不认无效状态", () => adminUpdateTeam(team.id, { status: "frozen" }));
    check("被拒后团队仍是 active", (await repo(Team).findOneByOrFail({ id: team.id })).status, "active");
    check("被拒后成员一个没少", await repo(TeamMember).countBy({ teamId: team.id }), 2);
    check("被拒后画布归属仍在", (await repo(Project).findOneByOrFail({ userId: "user-back-owner", projectId: "pb-1" })).teamId, team.id);

    check("后台可以停用", (await adminUpdateTeam(team.id, { status: "disabled" })).status, "disabled");
    check("后台可以恢复", (await adminUpdateTeam(team.id, { status: "active" })).status, "active");

    // 成员上限同样不能被 `Number(x) || 0` 折成 0——0 在这里的语义是「不限」，等于悄悄拆掉了上限。
    await repo(Team).update({ id: team.id }, { memberLimit: 5 });
    for (const bogus of ["abc", -1, 2.5, Number.POSITIVE_INFINITY, 100_001]) await rejects(`成员上限 ${String(bogus)} 被拒`, () => adminUpdateTeam(team.id, { memberLimit: bogus }));
    check("被拒后成员上限没有被清零", (await repo(Team).findOneByOrFail({ id: team.id })).memberLimit, 5);
    check("合法成员上限能改", (await adminUpdateTeam(team.id, { memberLimit: 20 })).memberLimit, 20);

    // 后台改名走的必须是前台那套 normalize：绕过它的话超长名字会在数据库层被静默截断。
    check("后台改名同样截断到 64 字", (await adminUpdateTeam(team.id, { name: "长".repeat(80) })).name.length, 64);
    check("空名字保持原样而不是清空", (await adminUpdateTeam(team.id, { name: "   " })).name.length, 64);

    // 积分：畸形请求必须 400。折成 0 的话，一次拼错字段名就把整个团队池清空了，事后从流水里也看不出本意。
    await repo(Team).update({ id: team.id }, { credits: 300 });
    for (const bogus of ["abc", -1, 1.5, Number.NaN, null, 1_000_000_001, undefined]) await rejects(`积分 ${String(bogus)} 被拒`, () => adminSetTeamCredits(team.id, bogus, "畸形"));
    check("被拒后团队池没有被清零", (await repo(Team).findOneByOrFail({ id: team.id })).credits, 300);
    check("合法积分能设", (await adminSetTeamCredits(team.id, 800, "验证")).credits, 800);
    check("显式设成 0 仍然允许", (await adminSetTeamCredits(team.id, 0, "清零")).credits, 0);

    // 解散过的团队没有成员也没有入口，后台再改它只会在列表上留下误导性的活跃感。
    await disbandTeam(team.id, "user-back-owner");
    await rejects("已解散的团队后台改不动", () => adminUpdateTeam(team.id, { status: "active" }));
}

/**
 * SSE 的 ready 与事件的先后。订阅在鉴权之前完成，所以这段 await 窗口里发生的余额变化
 * 必须排在 ready 之后再放行：直接写出去的话顺序变成「新余额、旧快照」，
 * 客户端最后停在旧值上，而且它没有任何理由怀疑这个数。
 */
async function readySequencing({ check }: { check: (name: string, actual: unknown, expected: unknown) => void }) {
    const { createBufferedWriter, sseWriter } = await import("./src/lib/sse");

    console.log("SSE ready 竞态");
    const written: unknown[] = [];
    const stream = createBufferedWriter((event) => written.push(event));
    stream.push({ type: "team.credits", credits: 200 });
    check("ready 之前的事件先进缓冲", written.length, 0);
    check("缓冲里确实攒着一条", stream.pending, 1);
    stream.flush({ type: "ready", credits: 100 });
    check("ready 排在最前", (written[0] as { type: string }).type, "ready");
    check("窗口期事件随后补发", (written[1] as { credits: number }).credits, 200);
    check("客户端最终看到的是新余额", (written[written.length - 1] as { credits: number }).credits, 200);

    stream.push({ type: "team.credits", credits: 300 });
    check("flush 之后转为直写", written.length, 3);
    stream.flush({ type: "ready", credits: 999 });
    check("重复 flush 不会再发一次 ready", written.filter((event) => (event as { type: string }).type === "ready").length, 1);

    // 多条事件必须按到达顺序补发：乱序的话，客户端会把中间某个旧值当成最终余额。
    const ordered: number[] = [];
    const many = createBufferedWriter((event) => ordered.push((event as { credits: number }).credits));
    for (const credits of [1, 2, 3]) many.push({ credits });
    many.flush({ credits: 0 });
    check("缓冲按到达顺序 flush", ordered, [0, 1, 2, 3]);

    // 连接结束后一律不再写。被挂起或移除的成员由 closeTeamConnectionsOf 直接 res.end()，
    // 而它可能正好落在 flush 补发的中途：结束后再写会抛 ERR_STREAM_WRITE_AFTER_END，
    // 那一抛在 flush 的循环里，剩下的事件全被截断。
    const chunks: string[] = [];
    const fake = { writableEnded: false, write: (chunk: string) => chunks.push(chunk) };
    const writeTo = sseWriter(fake);
    writeTo({ type: "ready" });
    check("连接活着时正常写出", chunks.length, 1);
    check("写出的是 SSE 数据帧", chunks[0], 'data: {"type":"ready"}\n\n');
    fake.writableEnded = true;
    writeTo({ type: "team.credits" });
    check("连接结束后静默丢弃", chunks.length, 1);

    // 中途被关掉：ready 写得出去，补发的部分整段丢弃，而且不能抛错——抛在这里就是一条截断的流。
    const midway: unknown[] = [];
    const closing = { writableEnded: false, write: (chunk: string) => midway.push(chunk) };
    const guarded = createBufferedWriter((event) => {
        sseWriter(closing)(event);
        closing.writableEnded = true;
    });
    guarded.push({ credits: 1 });
    guarded.push({ credits: 2 });
    guarded.flush({ type: "ready" });
    check("中途关闭后只写出了 ready", midway.length, 1);
}

/**
 * 画布的团队归属。这是唯一能写 Project.teamId 的路径，所以它的两道门必须咬得住：
 * 调用者得是画布所有者，并且是目标团队里有消费权限的活跃成员。
 */
async function projectOwnership({ check, rejects }: { check: (name: string, actual: unknown, expected: unknown) => void; rejects: (name: string, work: () => Promise<unknown>) => Promise<void> }) {
    const { repo } = await import("./src/db/data-source");
    const { Project, TeamMember } = await import("./src/db/entities");
    const { createTeam } = await import("./src/services/teams");
    const { getProjectTeam, setProjectTeam } = await import("./src/services/project-team");
    const { now } = await import("./src/lib/errors");

    console.log("画布团队归属");
    const projects = repo(Project);
    const owned = await createTeam("user-canvas-owner", { name: "画布团队" });
    await repo(TeamMember).insert({ teamId: owned.id, userId: "user-canvas-viewer", role: "viewer", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-canvas-owner", joinedAt: now(), updatedAt: now() });
    await projects.insert({ userId: "user-canvas-owner", projectId: "pt-1", title: "画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    check("新画布默认没有团队归属", (await getProjectTeam("user-canvas-owner", "pt-1")).teamId, "");

    await setProjectTeam("user-canvas-owner", "pt-1", owned.id);
    check("owner 能把自己的画布绑到团队", (await getProjectTeam("user-canvas-owner", "pt-1")).teamId, owned.id);

    await rejects("非成员不能绑定", () => setProjectTeam("user-canvas-stranger", "pt-1", owned.id));
    await rejects("画布不存在时拒绝", () => setProjectTeam("user-canvas-owner", "pt-nope", owned.id));
    // viewer 在团队里，但权限矩阵没给它 credits.spend：能看不等于能把画布挂到团队账上花钱。
    await projects.insert({ userId: "user-canvas-viewer", projectId: "pt-2", title: "看客画布", data: "{}", revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await rejects("viewer 不能把画布绑到团队", () => setProjectTeam("user-canvas-viewer", "pt-2", owned.id));
    check("被拒后归属仍为空", (await getProjectTeam("user-canvas-viewer", "pt-2")).teamId, "");

    await setProjectTeam("user-canvas-owner", "pt-1", "");
    check("解绑回个人不需要团队权限", (await getProjectTeam("user-canvas-owner", "pt-1")).teamId, "");
}

void main();
