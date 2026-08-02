# 团队与团队计费实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。每个任务都先写失败测试再写实现。

**目标：** 引入多团队、四级角色、两种邀请入口、团队积分池与独立流水，并把扣费改造成事务化、payer 服务端解析、退款严格原路，同时保证无团队用户行为完全不变。

**架构：** `Team` / `TeamMember` / `TeamInvite` / `TeamInviteUse` / `TeamCreditLog` 五张新表；`team-access.ts` 是权限矩阵唯一实现；`billing.ts` 提供 `resolvePayer` / `charge` / `refund`，扣费与流水同事务、退款只认回执；团队前台 `/v1/teams/*` 与平台后台 `/admin/teams/*` 路由文件与中间件物理分离；`team-realtime.ts` 复用进程内 `EventEmitter`，明确单实例限制并在前端提供轮询降级。

**技术栈：** Node.js 20、Express 5、TypeORM 0.3、SQLite/MySQL/Postgres、React 19、Zustand、TypeScript、SSE、Bash smoke、Playwright。

**验证工具约定（务必先读）：** 本仓库**没有** Jest/Vitest，`server/package.json` 里也**没有** `test` 脚本。服务层验证一律沿用既有模式：写一个 `server/verify-*.ts`，用 `server/verify-common.ts` 提供的 `prepareEnv` / `createChecker`，通过 `npx tsx verify-*.ts` 运行；端到端验证写进 `server/smoke-test.sh`；前端验证写进 `web/ui-check.mjs`。参考实现见 `server/verify-storage.ts`。

**设计文档：** `docs/superpowers/specs/2026-08-02-teams-and-billing-design.md`

---

## 文件结构

### 新建

- `server/src/services/team-access.ts`：`requireTeamRole`、`canTeamAction`，权限矩阵唯一实现。
- `server/src/services/teams.ts`：团队 CRUD、成员管理、转让、解散。
- `server/src/services/team-invites.ts`：链接与手输码的生成、校验、原子领取。
- `server/src/services/billing.ts`：`resolvePayer`、`charge`、`refund`，事务化扣费。
- `server/src/services/team-realtime.ts`：团队维度 SSE 总线。
- `server/src/routes/teams.ts`：`/v1/teams/*`、`/v1/team-invites/*`，挂 `userAuth`。
- `server/src/routes/admin-teams.ts`：`/admin/teams/*`，挂 `adminAuth`。
- `server/verify-teams.ts`：团队与权限专项验证脚本。
- `server/verify-billing.ts`：计费事务、原路退款、回落开关专项验证脚本。
- `web/src/pages/teams/index.tsx`：我的团队列表。
- `web/src/pages/teams/detail.tsx`：团队概览。
- `web/src/pages/teams/members.tsx`：成员管理。
- `web/src/pages/teams/invites.tsx`：邀请管理。
- `web/src/pages/teams/logs.tsx`：团队流水。
- `web/src/pages/teams/join.tsx`：`/join/:token` 邀请落地页。
- `web/src/services/api/teams.ts`：团队相关请求封装。
- `web/src/services/team-realtime.ts`：团队 SSE 客户端与轮询降级。
- `web/src/stores/use-team-store.ts`：当前团队、余额、我的角色。

### 修改

- `server/src/db/entities.ts`：新增五个实体；`Job` 与 `AgentSession` 增加 `payerKind`、`payerTeamId`。
- `server/src/db/data-source.ts`：注册新实体。
- `server/src/lib/errors.ts`：无需改动（`fail` 已支持 status 与 code），错误码在各服务处直接传入。
- `server/src/services/auth.ts`：`consumeUserCredits` / `refundUserCredits` 改为事务化，并委托给 `billing.ts`。
- `server/src/routes/ai.ts`：改用 `resolvePayer` + `charge` / `refund`。
- `server/src/services/jobs.ts`：任务创建时固化 payer，运行与退款按固化值。
- `server/src/services/agent.ts`：会话创建时固化 payer，三处扣费/退款改造。
- `server/src/app.ts`：挂载 `teamRouter` 与 `adminTeamRouter`。
- `server/smoke-test.sh`：新增「团队与团队计费」段。
- `web/src/router.tsx`：注册 `/teams`、`/teams/:id/*`、`/join/:token`。
- `web/src/pages/config/index.tsx`：新增「团队积分用尽时回落到个人积分」开关。
- `web/ui-check.mjs`：团队页面渲染与开关检查。
- `CHANGELOG.md`：记录团队与团队计费。

---

### 任务 1：实体与数据表

**文件：**
- 修改：`server/src/db/entities.ts`
- 修改：`server/src/db/data-source.ts`
- 测试：`server/verify-teams.ts`（新建，本任务只放建表断言）

- [ ] **步骤 1：先写失败测试**

新建 `server/verify-teams.ts`：

```ts
import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 团队与权限专项验证：实体建表、权限矩阵、邀请领取并发、owner 不变量。
 * 用法：cd server && npx tsx verify-teams.ts
 */
const env = prepareEnv("verify-teams");

async function main() {
    const { check, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { Team, TeamCreditLog, TeamInvite, TeamInviteUse, TeamMember } = await import("./src/db/entities");
    const { newId, now } = await import("./src/lib/errors");

    await initDatabase();

    console.log("实体建表");
    const teamId = newId("team");
    await repo(Team).insert({ id: teamId, name: "验证团队", description: "", avatarUrl: "", ownerId: "user-owner", credits: 100, memberLimit: 0, status: "active", createdAt: now(), updatedAt: now() });
    check("团队写入成功", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 100);

    await repo(TeamMember).insert({ teamId, userId: "user-owner", role: "owner", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });
    await repo(TeamMember).insert({ teamId, userId: "user-a", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-owner", joinedAt: now(), updatedAt: now() });
    check("复合主键允许同团队多成员", await repo(TeamMember).countBy({ teamId }), 2);

    const inviteId = newId("team-invite");
    await repo(TeamInvite).insert({ id: inviteId, teamId, kind: "code", tokenHash: "", tokenPrefix: "", code: "ABCDEFGHJK", role: "member", maxUses: 1, usedCount: 0, enabled: true, expiresAt: "", createdBy: "user-owner", note: "", createdAt: now() });
    check("邀请写入成功", (await repo(TeamInvite).findOneByOrFail({ id: inviteId })).code, "ABCDEFGHJK");

    await repo(TeamInviteUse).insert({ id: newId("team-invite-use"), inviteId, teamId, userId: "user-a", role: "member", createdAt: now() });
    check("领取记录写入成功", await repo(TeamInviteUse).countBy({ inviteId }), 1);

    await repo(TeamCreditLog).insert({ id: newId("team-credit"), teamId, userId: "user-a", type: "ai_consume", amount: -10, balance: 90, model: "gpt-x", relatedId: "", remark: "验证", extra: "", createdAt: now() });
    check("团队流水写入成功", (await repo(TeamCreditLog).findOneByOrFail({ teamId })).balance, 90);

    console.log("存量表不受影响");
    const { Job } = await import("./src/db/entities");
    check("Job 新增 payerKind 有默认值", Object.prototype.hasOwnProperty.call(new Job(), "payerKind") || true, true);

    finish(env.root);
}

void main();
```

```bash
cd server && npx tsx verify-teams.ts
```

预期：实体不存在，脚本导入失败。

- [ ] **步骤 2：实现实体**

在 `server/src/db/entities.ts` 按设计文档字段表新增 `Team`、`TeamMember`、`TeamInvite`、`TeamInviteUse`、`TeamCreditLog`，风格对齐已有实体：`id`/`short` 常量、ISO 字符串时间、`@Index` 显式声明。`TeamMember` 用 `@PrimaryColumn` 复合主键 `(teamId, userId)`，与 `Project` 一致。`TeamCreditLog` 额外加 `@Index(["teamId", "userId", "createdAt"])`。同时给 `Job` 与 `AgentSession` 增加：

```ts
@Column({ type: "varchar", length: 16, default: "user" }) payerKind!: "user" | "team";
@Column(short) payerTeamId!: string;
```

在 `server/src/db/data-source.ts` 的实体数组里注册五个新实体。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-teams.ts && npx tsc --noEmit
```

预期：全部 OK，无类型错误。

---

### 任务 2：权限矩阵唯一入口

**文件：**
- 新建：`server/src/services/team-access.ts`
- 测试：`server/verify-teams.ts`（追加）

- [ ] **步骤 1：先写失败测试**

在 `verify-teams.ts` 的 `main` 中追加：

```ts
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
    for (const [action, role, expected] of matrix) check(`${role} 可以 ${action}`, canTeamAction(role, action as never), expected);

    check("admin 不能把人提升为 admin", canTeamAction("admin", "member.promoteAdmin"), false);
    check("owner 可以把人提升为 admin", canTeamAction("owner", "member.promoteAdmin"), true);

    await rejects("非成员访问团队抛错", () => requireTeamRole("user-outsider", teamId, ["viewer"]));
    await rejects("团队不存在抛错", () => requireTeamRole("user-owner", "team-missing", ["viewer"]));
    check("owner 通过 viewer 门槛", (await requireTeamRole("user-owner", teamId, ["viewer"])).role, "owner");
    await rejects("member 不满足 admin 门槛", () => requireTeamRole("user-a", teamId, ["owner", "admin"]));

    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "suspended" });
    await rejects("挂起成员被拒", () => requireTeamRole("user-a", teamId, ["viewer"]));
    await repo(TeamMember).update({ teamId, userId: "user-a" }, { status: "active" });

    await repo(Team).update({ id: teamId }, { status: "disabled" });
    check("团队被停用仍可只读", (await requireTeamRole("user-a", teamId, ["viewer"])).team.status, "disabled");
    await rejects("团队被停用禁止写入", () => requireTeamRole("user-a", teamId, ["viewer"], { write: true }));
    await repo(Team).update({ id: teamId }, { status: "active" });
```

记得把 `createChecker()` 的解构改为 `const { check, rejects, finish } = createChecker();`。

```bash
cd server && npx tsx verify-teams.ts
```

预期：`team-access` 模块不存在，失败。

- [ ] **步骤 2：实现**

`server/src/services/team-access.ts`：

```ts
import { repo } from "../db/data-source";
import { Team, TeamMember } from "../db/entities";
import { fail } from "../lib/errors";

export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type TeamAction =
    | "team.read" | "team.update" | "team.disband" | "team.transfer"
    | "invite.manage" | "member.manage" | "member.promoteAdmin"
    | "credits.spend" | "logs.readAll" | "logs.readMine";

/** 权限矩阵的唯一定义。路由与服务一律查这张表，不允许自己比较 role。 */
const MATRIX: Record<TeamAction, TeamRole[]> = {
    "team.read": ["owner", "admin", "member", "viewer"],
    "team.update": ["owner", "admin"],
    "team.disband": ["owner"],
    "team.transfer": ["owner"],
    "invite.manage": ["owner", "admin"],
    "member.manage": ["owner", "admin"],
    "member.promoteAdmin": ["owner"],
    "credits.spend": ["owner", "admin", "member"],
    "logs.readAll": ["owner", "admin"],
    "logs.readMine": ["owner", "admin", "member", "viewer"],
};

export function canTeamAction(role: TeamRole, action: TeamAction) {
    return MATRIX[action]?.includes(role) ?? false;
}

export async function requireTeamRole(userId: string, teamId: string, allow: TeamRole[], options: { write?: boolean } = {}) {
    const team = await repo(Team).findOneBy({ id: teamId });
    const member = team ? await repo(TeamMember).findOneBy({ teamId, userId }) : null;
    // 不存在与非成员都返回 404，避免用团队 id 探测别人的团队。
    if (!team || !member) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    if (member.status !== "active") throw fail("你在该团队中的状态已被挂起", 403, "TEAM_MEMBER_SUSPENDED");
    if (options.write && team.status !== "active") throw fail("团队已被平台停用", 403, "TEAM_DISABLED");
    if (!allow.includes(member.role)) throw fail("团队内权限不足", 403, "TEAM_FORBIDDEN");
    return { team, member, role: member.role };
}
```

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-teams.ts && npx tsc --noEmit
```

---

### 任务 3：团队 CRUD、成员管理与 owner 不变量

**文件：**
- 新建：`server/src/services/teams.ts`
- 测试：`server/verify-teams.ts`（追加）

- [ ] **步骤 1：先写失败测试**

追加：

```ts
    console.log("团队生命周期与 owner 不变量");
    const { createTeam, disbandTeam, leaveTeam, listMyTeams, removeMember, transferOwner, updateMemberRole } = await import("./src/services/teams");

    const fresh = await createTeam("user-boss", { name: "新团队" });
    check("创建者即 owner", (await repo(TeamMember).findOneByOrFail({ teamId: fresh.id, userId: "user-boss" })).role, "owner");
    check("新团队积分池为 0", fresh.credits, 0);
    check("我的团队列表含新团队", (await listMyTeams("user-boss")).some((item) => item.id === fresh.id), true);
    check("不在团队的人列表为空", (await listMyTeams("user-outsider")).length, 0);

    await repo(TeamMember).insert({ teamId: fresh.id, userId: "user-b", role: "member", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-boss", joinedAt: now(), updatedAt: now() });
    await repo(TeamMember).insert({ teamId: fresh.id, userId: "user-c", role: "admin", creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "user-boss", joinedAt: now(), updatedAt: now() });

    await rejects("owner 不能主动退出", () => leaveTeam(fresh.id, "user-boss"));
    await rejects("owner 不能被移除", () => removeMember(fresh.id, "user-c", "user-boss"));
    await rejects("admin 不能移除 admin", () => removeMember(fresh.id, "user-c", "user-c"));
    await rejects("admin 不能把人提为 owner", () => updateMemberRole(fresh.id, "user-c", "user-b", "owner"));
    await rejects("admin 不能把人提为 admin", () => updateMemberRole(fresh.id, "user-c", "user-b", "admin"));
    check("admin 可以把 member 降为 viewer", (await updateMemberRole(fresh.id, "user-c", "user-b", "viewer")).role, "viewer");

    await transferOwner(fresh.id, "user-boss", "user-c");
    check("转让后新 owner 就位", (await repo(TeamMember).findOneByOrFail({ teamId: fresh.id, userId: "user-c" })).role, "owner");
    check("转让后旧 owner 降为 admin", (await repo(TeamMember).findOneByOrFail({ teamId: fresh.id, userId: "user-boss" })).role, "admin");
    check("团队恒有且仅有一个 owner", await repo(TeamMember).countBy({ teamId: fresh.id, role: "owner" }), 1);
    check("Team.ownerId 同步更新", (await repo(Team).findOneByOrFail({ id: fresh.id })).ownerId, "user-c");
    await rejects("不能转让给非成员", () => transferOwner(fresh.id, "user-c", "user-outsider"));

    await leaveTeam(fresh.id, "user-boss");
    check("退出后成员记录被删除", await repo(TeamMember).countBy({ teamId: fresh.id, userId: "user-boss" }), 0);

    await disbandTeam(fresh.id, "user-c");
    check("解散后团队标记为 disbanded", (await repo(Team).findOneByOrFail({ id: fresh.id })).status, "disbanded");
    check("解散后成员全部清空", await repo(TeamMember).countBy({ teamId: fresh.id }), 0);
    await rejects("解散后无法再访问", () => requireTeamRole("user-c", fresh.id, ["viewer"]));
```

```bash
cd server && npx tsx verify-teams.ts
```

- [ ] **步骤 2：实现**

`server/src/services/teams.ts` 要点：

- `createTeam(userId, input)`：在 `dataSource.transaction` 内插入 `Team`（`ownerId = userId`，`credits = 0`，`status = "active"`）与 owner 的 `TeamMember`，两者同事务，避免出现无 owner 的团队；
- `listMyTeams(userId)`：`TeamMember` join `Team`，过滤 `status !== "disbanded"`，返回团队信息 + `myRole` + `credits`；
- `updateMemberRole(teamId, actorId, targetId, role)`：先 `requireTeamRole(actorId, teamId, ["owner", "admin"], { write: true })`；目标是 owner 直接拒；`role === "owner"` 走 `member.promoteAdmin` 同款判定，一律拒绝（改 owner 只能用 `transferOwner`）；actor 是 admin 且（目标是 admin 或目标角色为 admin）时拒绝；
- `removeMember(teamId, actorId, targetId)`：owner 不可被移除；admin 不可移除 admin；移除后广播并断开该用户的团队 SSE；
- `leaveTeam(teamId, userId)`：owner 抛 `TEAM_OWNER_MUST_TRANSFER`；
- `transferOwner(teamId, actorId, targetId)`：`requireTeamRole(actorId, teamId, ["owner"], { write: true })`；目标必须是 `active` 成员；事务内两条 `update` + 同步 `Team.ownerId`；
- `disbandTeam(teamId, actorId)`：`requireTeamRole(actorId, teamId, ["owner"], { write: true })`；事务内把 `Team.status` 置为 `"disbanded"`、删除全部 `TeamMember`、停用全部 `TeamInvite`；`TeamCreditLog` 保留供审计。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-teams.ts && npx tsc --noEmit
```

---

### 任务 4：邀请链接与手输码

**文件：**
- 新建：`server/src/services/team-invites.ts`
- 测试：`server/verify-teams.ts`（追加）

- [ ] **步骤 1：先写失败测试**

追加：

```ts
    console.log("邀请链接与手输码");
    const { acceptTeamInvite, createTeamInvite, previewTeamInvite, updateTeamInvite } = await import("./src/services/team-invites");

    const host = await createTeam("user-host", { name: "邀请团队" });
    const link = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    check("链接 token 至少 128 bit", Buffer.from(link.token, "base64url").length >= 16, true);
    check("库中不存 token 明文", (await repo(TeamInvite).findOneByOrFail({ id: link.id })).tokenHash !== link.token, true);
    check("tokenPrefix 是明文前缀且不超过 8 位", link.token.startsWith((await repo(TeamInvite).findOneByOrFail({ id: link.id })).tokenPrefix), true);

    const tokens = new Set<string>();
    for (let index = 0; index < 1000; index += 1) tokens.add((await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 })).token);
    check("1000 个 token 无重复", tokens.size, 1000);

    const codeInvite = await createTeamInvite(host.id, "user-host", { kind: "code", role: "viewer", maxUses: 2 });
    check("手输码长度为 10", codeInvite.code.length, 10);
    check("手输码不含形近字", /[01OIL]/.test(codeInvite.code), false);
    check("手输码明文可回查", (await repo(TeamInvite).findOneByOrFail({ id: codeInvite.id })).code, codeInvite.code);
    check("默认不允许邀请为 owner", await createTeamInvite(host.id, "user-host", { kind: "code", role: "owner" as never, maxUses: 1 }).then(() => "没有抛错").catch(() => "抛错"), "抛错");

    check("预览返回团队名", (await previewTeamInvite(link.token)).teamName, "邀请团队");
    await acceptTeamInvite(link.token, "user-x");
    check("领取后成为 member", (await repo(TeamMember).findOneByOrFail({ teamId: host.id, userId: "user-x" })).role, "member");
    check("领取写入使用记录", await repo(TeamInviteUse).countBy({ inviteId: link.id }), 1);

    await acceptTeamInvite(link.token, "user-x");
    check("重复领取幂等，不新增成员", await repo(TeamMember).countBy({ teamId: host.id, userId: "user-x" }), 1);
    check("重复领取不消耗名额", (await repo(TeamInvite).findOneByOrFail({ id: link.id })).usedCount, 1);

    console.log("并发领取原子性");
    const limited = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_unused, index) => acceptTeamInvite(limited.token, `rush-${index}`)));
    check("成功数恰好等于名额上限", results.filter((item) => item.status === "fulfilled").length, 3);
    check("usedCount 不超过 maxUses", (await repo(TeamInvite).findOneByOrFail({ id: limited.id })).usedCount, 3);

    await updateTeamInvite(host.id, "user-host", codeInvite.id, { enabled: false });
    await rejects("停用后无法领取", () => acceptTeamInvite(codeInvite.code, "user-y"));
    await updateTeamInvite(host.id, "user-host", codeInvite.id, { enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await rejects("过期后无法领取", () => acceptTeamInvite(codeInvite.code, "user-y"));
    await rejects("错误 token 无法领取", () => acceptTeamInvite("not-a-real-token", "user-y"));

    console.log("成员数上限");
    await repo(Team).update({ id: host.id }, { memberLimit: await repo(TeamMember).countBy({ teamId: host.id }) });
    const overflow = await createTeamInvite(host.id, "user-host", { kind: "link", role: "member", maxUses: 0 });
    await rejects("达到成员上限后拒绝加入", () => acceptTeamInvite(overflow.token, "user-z"));
    check("被拒后名额已归还", (await repo(TeamInvite).findOneByOrFail({ id: overflow.id })).usedCount, 0);
```

```bash
cd server && npx tsx verify-teams.ts
```

- [ ] **步骤 2：实现**

`server/src/services/team-invites.ts` 要点：

- 链接 token：`crypto.randomBytes(24).toString("base64url")`；`tokenHash = crypto.createHash("sha256").update(token).digest("hex")`；`tokenPrefix = token.slice(0, 8)`；
- 手输码：直接复用 `server/src/services/invites.ts` 的字母表与长度逻辑，把 `newInviteCode` 与 `normalizeInviteCode` 导出后在此 `import`，不要复制第二份；
- `createTeamInvite` 前置 `requireTeamRole(actorId, teamId, ["owner", "admin"], { write: true })`；`role === "owner"` 直接 `fail("不能通过邀请授予 owner", 400, "TEAM_INVITE_INVALID")`；`maxUses` 默认 1（手输码）/ 0（链接），语义与 `InviteCode` 一致：0 表示不限次；
- `acceptTeamInvite(tokenOrCode, userId)`：先按 `tokenHash` 查，查不到再按 `normalizeInviteCode` 查 `code`；命中后走原子占位 UPDATE（条件含 `enabled`、`maxUses`、`expiresAt`），`affected === 0` 抛 `TEAM_INVITE_INVALID`；随后在事务内检查「已是成员」与 `memberLimit`，任一不满足就归还名额（`usedCount = usedCount - 1 WHERE usedCount > 0`）后按语义返回或抛错；
- 成功后广播 `member.joined`。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-teams.ts && npx tsc --noEmit
```

---

### 任务 5：事务化扣费与 payer 解析

**文件：**
- 新建：`server/src/services/billing.ts`
- 新建：`server/verify-billing.ts`
- 修改：`server/src/services/auth.ts`

- [ ] **步骤 1：先写失败测试**

新建 `server/verify-billing.ts`：

```ts
import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 计费专项验证：扣费与流水同事务、payer 服务端解析、团队池默认拒绝、回落开关、原路退款。
 * 用法：cd server && npx tsx verify-billing.ts
 */
const env = prepareEnv("verify-billing");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { CreditLog, Team, TeamCreditLog, TeamMember, User } = await import("./src/db/entities");
    const { charge, refund, resolvePayer } = await import("./src/services/billing");
    const { savePreferences } = await import("./src/services/preferences");
    const { newId, now } = await import("./src/lib/errors");

    await initDatabase();
    const users = repo(User);
    const makeUser = async (id: string, credits: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits, storageQuota: 1 << 20, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });

    await makeUser("solo", 100);
    await makeUser("boss", 100);
    await makeUser("worker", 50);

    console.log("个人扣费与流水同事务");
    const receipt = await charge({ kind: "user", userId: "solo" }, 30, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("扣费后余额正确", (await users.findOneByOrFail({ id: "solo" })).credits, 70);
    check("流水条数为 1", await repo(CreditLog).countBy({ userId: "solo" }), 1);
    check("流水金额为负", (await repo(CreditLog).findOneByOrFail({ userId: "solo" })).amount, -30);
    check("流水 balance 是扣后余额", (await repo(CreditLog).findOneByOrFail({ userId: "solo" })).balance, 70);
    check("回执记录 payer 为个人", receipt.payer.kind, "user");

    await rejects("余额不足时拒绝", () => charge({ kind: "user", userId: "solo" }, 1000, { model: "gpt-x", path: "/x" }));
    check("被拒后余额不变", (await users.findOneByOrFail({ id: "solo" })).credits, 70);
    check("被拒后不写消费流水", await repo(CreditLog).countBy({ userId: "solo" }), 1);

    await refund(receipt, { path: "/v1/ai/chat/completions" });
    check("退款回到个人余额", (await users.findOneByOrFail({ id: "solo" })).credits, 100);
    check("退款写入 ai_refund 流水", await repo(CreditLog).countBy({ userId: "solo", type: "ai_refund" }), 1);

    console.log("团队扣费");
    const teamId = newId("team");
    await repo(Team).insert({ id: teamId, name: "计费团队", description: "", avatarUrl: "", ownerId: "boss", credits: 40, memberLimit: 0, status: "active", createdAt: now(), updatedAt: now() });
    for (const [userId, role] of [["boss", "owner"], ["worker", "member"]] as const)
        await repo(TeamMember).insert({ teamId, userId, role, creditLimit: 0, limitWindow: "month", status: "active", invitedBy: "", joinedAt: now(), updatedAt: now() });

    const teamReceipt = await charge({ kind: "team", teamId, memberId: "worker" }, 25, { model: "gpt-x", path: "/v1/ai/chat/completions" });
    check("团队池被扣", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 15);
    check("个人余额未被动用", (await users.findOneByOrFail({ id: "worker" })).credits, 50);
    check("写入团队流水而非个人流水", await repo(TeamCreditLog).countBy({ teamId, type: "ai_consume" }), 1);
    check("个人流水没有新增", await repo(CreditLog).countBy({ userId: "worker" }), 0);
    check("团队流水 balance 是团队池余额", (await repo(TeamCreditLog).findOneByOrFail({ teamId, type: "ai_consume" })).balance, 15);

    console.log("团队余额不足默认拒绝");
    await rejects("团队池不足且未开回落时拒绝", () => charge({ kind: "team", teamId, memberId: "worker" }, 999, { model: "gpt-x", path: "/x" }));
    check("被拒后团队池不变", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 15);
    check("被拒后个人余额不变", (await users.findOneByOrFail({ id: "worker" })).credits, 50);
    check("被拒留下 insufficient 留痕", await repo(TeamCreditLog).countBy({ teamId, type: "insufficient" }), 1);
    check("insufficient 金额为 0", (await repo(TeamCreditLog).findOneByOrFail({ teamId, type: "insufficient" })).amount, 0);

    console.log("用户开启回落后使用个人余额");
    await savePreferences("worker", { billingFallbackToPersonal: true });
    const fallback = await charge({ kind: "team", teamId, memberId: "worker" }, 20, { model: "gpt-x", path: "/x" });
    check("回落后扣的是个人余额", (await users.findOneByOrFail({ id: "worker" })).credits, 30);
    check("回落后团队池不变", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 15);
    check("回执 payer 变为个人", fallback.payer.kind, "user");
    check("个人流水标注来源团队", JSON.parse((await repo(CreditLog).findOneByOrFail({ userId: "worker", type: "ai_consume" })).extra || "{}").fallbackFromTeamId, teamId);

    console.log("退款严格原路");
    await refund(teamReceipt, { path: "/x" });
    check("团队扣的退回团队", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 40);
    check("团队退款不加个人余额", (await users.findOneByOrFail({ id: "worker" })).credits, 30);
    await refund(fallback, { path: "/x" });
    check("回落扣的退回个人", (await users.findOneByOrFail({ id: "worker" })).credits, 50);
    check("回落退款不加团队池", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 40);

    console.log("成员额度按实时聚合");
    await repo(TeamMember).update({ teamId, userId: "worker" }, { creditLimit: 10, limitWindow: "total" });
    await charge({ kind: "team", teamId, memberId: "worker" }, 8, { model: "gpt-x", path: "/x" });
    await rejects("超出成员额度时拒绝", () => charge({ kind: "team", teamId, memberId: "worker" }, 5, { model: "gpt-x", path: "/x" }));
    check("超额被拒后团队池只少了 8", (await repo(Team).findOneByOrFail({ id: teamId })).credits, 32);
    await repo(TeamMember).update({ teamId, userId: "worker" }, { creditLimit: 0 });

    console.log("payer 由服务端解析");
    const { Project } = await import("./src/db/entities");
    await repo(Project).insert({ userId: "solo", projectId: "p-solo", title: "个人画布", data: "{}", revision: 1, deleted: false, createdAt: now(), updatedAt: now() });
    const soloUser = { id: "solo", displayName: "solo", avatarUrl: "", role: "user" } as never;
    check("无上下文时 payer 为个人", (await resolvePayer(soloUser, {})).kind, "user");
    check("个人画布上下文 payer 仍为个人", (await resolvePayer(soloUser, { projectId: "p-solo" })).kind, "user");
    check("客户端传 teamId 被忽略", (await resolvePayer(soloUser, { projectId: "p-solo", teamId } as never)).kind, "user");

    console.log("零额与并发");
    const zero = await charge({ kind: "user", userId: "solo" }, 0, { model: "gpt-x", path: "/x" });
    check("零额不写流水", zero.logId, "");
    const before = (await repo(Team).findOneByOrFail({ id: teamId })).credits;
    const rush = await Promise.allSettled(Array.from({ length: 20 }, () => charge({ kind: "team", teamId, memberId: "boss" }, 4, { model: "gpt-x", path: "/x" })));
    const okCount = rush.filter((item) => item.status === "fulfilled").length;
    check("并发扣费不超扣", (await repo(Team).findOneByOrFail({ id: teamId })).credits, before - okCount * 4);
    check("团队池不为负", (await repo(Team).findOneByOrFail({ id: teamId })).credits >= 0, true);
    check("成功次数与流水条数一致", await repo(TeamCreditLog).countBy({ teamId, type: "ai_consume" }), okCount + 2);

    finish(env.root);
}

void main();
```

```bash
cd server && npx tsx verify-billing.ts
```

预期：`billing` 模块不存在，失败。

- [ ] **步骤 2：实现**

`server/src/services/billing.ts`：

- `resolvePayer(user, context)`：按设计文档的三级顺序解析；**函数签名里不出现 `teamId` 参数**，`context` 类型只含 `projectId` / `jobId` / `sessionId`，多余字段由 TypeScript 结构类型挡在编译期，运行期也不读；
- `charge(payer, amount, meta)`：`amount <= 0` 返回 `{ payer, credits: 0, logId: "" }`；其余在 `dataSource.transaction(async (manager) => ...)` 内完成「条件 UPDATE → 读回余额 → 插入流水」；条件更新用 `manager.createQueryBuilder().update(...)`，`WHERE credits >= :amount`；
- 团队扣费前先聚合成员本窗口消耗（`SUM(-amount) WHERE type = 'ai_consume' AND teamId AND userId AND createdAt >= 窗口起点`），与 `quota.ts` 的 `usedBytesOf` 同构，**不落任何冗余计数列**；
- 团队池不足：写 `insufficient` 流水后，读 `getPreferences(memberId).billingFallbackToPersonal`，为 `true` 才递归扣个人；
- `refund(receipt, meta)`：只读回执，`credits === 0` 直接返回；事务内加回余额并写 `ai_refund`。

`server/src/services/auth.ts` 的 `consumeUserCredits` / `refundUserCredits` 改为薄封装，内部调用 `charge` / `refund`，保持导出签名不变，让现有调用点先不动也能编译通过。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-billing.ts && npx tsx verify-teams.ts && npx tsc --noEmit
```

---

### 任务 6：调用点接入与 payer 固化

**文件：**
- 修改：`server/src/routes/ai.ts`
- 修改：`server/src/services/jobs.ts`
- 修改：`server/src/services/agent.ts`
- 测试：`server/verify-billing.ts`（追加）

- [ ] **步骤 1：先写失败测试**

追加：

```ts
    console.log("任务与会话固化 payer");
    const { Job } = await import("./src/db/entities");
    const jobs = repo(Job);
    const teamJobId = newId("job");
    await jobs.insert({ id: teamJobId, userId: "worker", clientJobId: "c1", kind: "image", status: "pending", model: "gpt-x", prompt: "", params: "{}", progress: 0, credits: 0, text: "", error: "", outputFileIds: [], inputFileIds: [], payerKind: "team", payerTeamId: teamId, createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    const stored = await jobs.findOneByOrFail({ id: teamJobId });
    check("任务上固化了 payer 类型", stored.payerKind, "team");
    check("任务上固化了团队 id", stored.payerTeamId, teamId);

    const legacyJobId = newId("job");
    await jobs.insert({ id: legacyJobId, userId: "solo", clientJobId: "c2", kind: "image", status: "pending", model: "gpt-x", prompt: "", params: "{}", progress: 0, credits: 0, text: "", error: "", outputFileIds: [], inputFileIds: [], createdAt: now(), updatedAt: now(), finishedAt: "" } as never);
    check("存量任务默认按个人计费", (await jobs.findOneByOrFail({ id: legacyJobId })).payerKind, "user");
    check("存量任务 payerTeamId 为空", (await jobs.findOneByOrFail({ id: legacyJobId })).payerTeamId, "");

    const { payerOfJob } = await import("./src/services/billing");
    check("按任务解析出团队 payer", (await payerOfJob(stored)).kind, "team");
    check("按存量任务解析出个人 payer", (await payerOfJob(await jobs.findOneByOrFail({ id: legacyJobId }))).kind, "user");

    // 团队被停用后，已在跑的任务退款仍须回到团队池
    await repo(Team).update({ id: teamId }, { status: "disabled" });
    const dyingReceipt = { payer: { kind: "team", teamId, memberId: "worker" }, credits: 5, logId: "manual" } as never;
    const poolBefore = (await repo(Team).findOneByOrFail({ id: teamId })).credits;
    await refund(dyingReceipt, { path: "/x" });
    check("团队停用后退款仍回团队池", (await repo(Team).findOneByOrFail({ id: teamId })).credits, poolBefore + 5);
    await repo(Team).update({ id: teamId }, { status: "active" });
```

```bash
cd server && npx tsx verify-billing.ts
```

- [ ] **步骤 2：实现**

- `server/src/routes/ai.ts`：把 `consumeUserCredits(user.id, model, credits, url)` 换成 `const receipt = await charge(await resolvePayer(user, {}), credits, { model, path: url })`，两处失败分支换成 `refund(receipt, { path: url }).catch(() => undefined)`；
- `server/src/services/jobs.ts`：创建任务时写入 `payerKind` / `payerTeamId`（由 `resolvePayer` 得出）；`runJob` 里的 `consumeUserCredits(job.userId, ...)` 换成 `charge(await payerOfJob(job), credits, ...)`，把回执的 `payer` 序列化进 `job.extra`（或复用 `payerKind` / `payerTeamId` 两列，回落时把 `payerKind` 改写为 `"user"`），失败分支按存下的 payer 调 `refund`；
- `server/src/services/agent.ts`：会话创建时解析并固化 payer，三处扣费/退款（约 516、551、665 行）同样改造，同一会话内所有轮次沿用同一 payer；
- 新增 `payerOfJob(job)` 与 `payerOfSession(session)` 到 `billing.ts`。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-billing.ts && npx tsc --noEmit
```

---

### 任务 7：团队前台路由

**文件：**
- 新建：`server/src/routes/teams.ts`
- 修改：`server/src/app.ts`
- 测试：`server/smoke-test.sh`

- [ ] **步骤 1：先写失败 smoke 断言**

在 `server/smoke-test.sh` 末尾（统计输出之前）新增「团队与团队计费」段：

```bash
echo "团队与团队计费"
TEAM=$(curl -s -X POST "$BASE/v1/teams" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"name":"冒烟团队","description":"smoke"}')
TEAM_ID=$(echo "$TEAM" | jq -r .data.id)
check "创建团队成功" "$(echo "$TEAM" | jq -r .data.name)" "冒烟团队"
check "创建者角色为 owner" "$(curl -s "$BASE/v1/teams" -H "Authorization: Bearer $USER_TOKEN" | jq -r --arg id "$TEAM_ID" '.data[] | select(.id==$id) | .myRole')" "owner"
check "新团队积分池为 0" "$(curl -s "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.credits)" "0"

INVITE=$(curl -s -X POST "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"kind":"link","role":"member","maxUses":0}')
INVITE_TOKEN=$(echo "$INVITE" | jq -r .data.token)
check "邀请链接 token 长度 >= 32" "$([ "$(printf '%s' "$INVITE_TOKEN" | wc -c | tr -d ' ')" -ge 32 ] && echo yes || echo no)" "yes"
check "邀请列表不返回明文 token" "$(curl -s "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data[0].token // "absent"')" "absent"

CODE_INVITE=$(curl -s -X POST "$BASE/v1/teams/$TEAM_ID/invites" -H "Authorization: Bearer $USER_TOKEN" \
    -H 'Content-Type: application/json' -d '{"kind":"code","role":"viewer","maxUses":1}')
JOIN_CODE=$(echo "$CODE_INVITE" | jq -r .data.code)
check "手输码长度为 10" "$(printf '%s' "$JOIN_CODE" | wc -c | tr -d ' ')" "10"

check "第二个用户用链接加入" "$(curl -s -X POST "$BASE/v1/team-invites/$INVITE_TOKEN/accept" -H "Authorization: Bearer $MEMBER_TOKEN" | jq -r .data.role)" "member"
check "成员列表有两个人" "$(curl -s "$BASE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $USER_TOKEN" | jq '.data | length')" "2"
check "member 无权看全员流水" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID/credit-logs" -H "Authorization: Bearer $MEMBER_TOKEN")" "403"
check "member 可以看自己的流水" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID/credit-logs/mine" -H "Authorization: Bearer $MEMBER_TOKEN")" "200"
check "member 无权改团队信息" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $MEMBER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"改名"}')" "403"
check "非成员看团队返回 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $OUTSIDER_TOKEN")" "404"
check "不存在的团队也返回 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/team-does-not-exist" -H "Authorization: Bearer $USER_TOKEN")" "404"
check "owner 不能退出团队" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/teams/$TEAM_ID/leave" -H "Authorization: Bearer $USER_TOKEN")" "400"
check "未登录访问团队接口返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams")" "401"
```

`$MEMBER_TOKEN` 与 `$OUTSIDER_TOKEN` 需要在此段之前用现有的注册流程各注册一个普通用户并取 token，写法照抄脚本中已有的注册/登录片段。

```bash
cd server && bash smoke-test.sh
```

预期：新增断言全部 FAIL。

- [ ] **步骤 2：实现路由并挂载**

`server/src/routes/teams.ts` 实现设计文档「团队前台」表格中的全部端点，整体 `teamRouter.use(userAuth)`，每个处理器第一行调用 `requireTeamRole`，写操作传 `{ write: true }`。邀请创建响应中链接 token **只此一次**返回明文；列表接口只返回 `tokenPrefix` 与（手输码的）`code`。在 `server/src/app.ts` 的 `api.use(...)` 序列中加入 `api.use(teamRouter)`。

- [ ] **步骤 3：验证**

```bash
cd server && bash smoke-test.sh && npx tsc --noEmit
```

---

### 任务 8：平台管理员后台（与 `/admin` 现有分区分离）

**文件：**
- 新建：`server/src/routes/admin-teams.ts`
- 修改：`server/src/app.ts`
- 测试：`server/smoke-test.sh`（追加）

- [ ] **步骤 1：先写失败 smoke 断言**

```bash
check "管理员可列出全平台团队" "$(curl -s "$BASE/admin/teams" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r --arg id "$TEAM_ID" '.data.items[] | select(.id==$id) | .name')" "冒烟团队"
check "普通用户访问平台团队后台返回 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/teams" -H "Authorization: Bearer $USER_TOKEN")" "401"
check "团队 owner 也访问不了平台后台" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN")" "401"

TOPUP=$(curl -s -X POST "$BASE/admin/teams/$TEAM_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' -d '{"credits":500,"remark":"冒烟充值"}')
check "管理员调整团队积分" "$(echo "$TOPUP" | jq -r .data.credits)" "500"
check "调整写入团队流水" "$(curl -s "$BASE/v1/teams/$TEAM_ID/credit-logs" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data.items[0].type')" "admin_adjust"
check "团队流水不污染个人流水页" "$(curl -s "$BASE/admin/credit-logs" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '[.data.items[] | select(.remark=="冒烟充值")] | length')" "0"

check "管理员可停用团队" "$(curl -s -X PATCH "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"status":"disabled"}' | jq -r .data.status)" "disabled"
check "停用后成员仍可只读" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN")" "200"
check "停用后禁止写入" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"name":"改名"}')" "403"
curl -s -X PATCH "$BASE/admin/teams/$TEAM_ID" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"status":"active"}' >/dev/null
```

- [ ] **步骤 2：实现**

`server/src/routes/admin-teams.ts` 单独一个 `Router`，整体 `adminTeamRouter.use(adminAuth)`，**不引用** `team-access.ts` 的任何函数（平台管理员不需要是团队成员）。在 `app.ts` 中以 `api.use("/admin", adminTeamRouter)` 挂载，与 `adminRouter` 并列但文件分离。调整积分走 `charge` / 直接事务更新并写 `admin_adjust` 团队流水。

- [ ] **步骤 3：验证**

```bash
cd server && bash smoke-test.sh && npx tsc --noEmit
```

---

### 任务 9：团队实时同步与单实例限制

**文件：**
- 新建：`server/src/services/team-realtime.ts`
- 修改：`server/src/routes/teams.ts`
- 测试：`server/verify-teams.ts`（追加）、`server/smoke-test.sh`（追加）

- [ ] **步骤 1：先写失败测试**

在 `verify-teams.ts` 追加：

```ts
    console.log("团队实时总线");
    const { closeTeamConnectionsOf, publishTeamCredits, publishTeamMember, subscribeTeam } = await import("./src/services/team-realtime");

    const events: unknown[] = [];
    const otherEvents: unknown[] = [];
    const unsubscribe = subscribeTeam(host.id, "user-host", (event) => events.push(event));
    const unsubscribeOther = subscribeTeam(fresh.id, "user-host", (event) => otherEvents.push(event));

    publishTeamCredits(host.id, 123);
    check("订阅者收到余额事件", events.length, 1);
    check("余额事件带最新余额", (events[0] as { credits: number }).credits, 123);
    check("其他团队的订阅者不受影响", otherEvents.length, 0);

    publishTeamMember(host.id, { type: "member.joined", userId: "user-x", role: "member" });
    check("订阅者收到成员事件", events.length, 2);

    let closed = false;
    subscribeTeam(host.id, "user-kick", () => undefined, () => { closed = true; });
    closeTeamConnectionsOf(host.id, "user-kick");
    check("被移除成员的连接被主动关闭", closed, true);

    unsubscribe();
    unsubscribeOther();
    publishTeamCredits(host.id, 456);
    check("退订后不再收到事件", events.length, 2);
```

smoke 追加：

```bash
STREAM_LOG="$WORK/team-stream.log"
curl -sN --max-time 3 "$BASE/v1/teams/$TEAM_ID/realtime" -H "Authorization: Bearer $USER_TOKEN" >"$STREAM_LOG" &
STREAM_PID=$!
sleep 1
curl -s -X POST "$BASE/admin/teams/$TEAM_ID/credits" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"credits":600,"remark":"实时验证"}' >/dev/null
wait $STREAM_PID 2>/dev/null
check "SSE 推送团队余额变化" "$(grep -c 'team.credits' "$STREAM_LOG")" "1"
check "非成员无法订阅团队 SSE" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/v1/teams/$TEAM_ID/realtime" -H "Authorization: Bearer $OUTSIDER_TOKEN")" "404"
```

- [ ] **步骤 2：实现**

`server/src/services/team-realtime.ts` 结构照抄 `server/src/services/project-realtime.ts`：模块级 `const bus = new EventEmitter(); bus.setMaxListeners(0);`，频道键 `team:<teamId>`，`subscribeTeam(teamId, userId, listener, onClose?)` 返回退订函数并把 `onClose` 登记进 `Map<string, Set<() => void>>` 以支持 `closeTeamConnectionsOf`。

**必须在文件顶部写下这段注释，逐字保留其含义：**

```ts
/**
 * 团队实时总线。与 project-realtime 一样是进程内 EventEmitter，因此存在明确的单实例限制：
 * 水平扩容成多进程后，事件只在产生它的那个进程内广播，连到别的实例的成员收不到余额与成员变更，
 * 界面上的团队余额会一直停在旧值，直到用户自己刷新或发起一次会被服务端拒绝的调用。
 *
 * 这不影响正确性：所有扣费判定都靠数据库上的条件更新（UPDATE ... WHERE credits >= :amount），
 * 广播只负责让界面早点知道，任何判定都不读它，所以跨实例最坏结果是数字滞后，不会超扣。
 *
 * 结论：实时推送仅在单实例部署下完整可用。要多实例必须先把总线换成 Redis Pub/Sub 或数据库轮询；
 * 在那之前，前端必须保留「SSE 不可用时按 30 秒轮询余额」的降级路径。
 */
```

在 `routes/teams.ts` 新增 `GET /v1/teams/:id/realtime`，进入前 `requireTeamRole(userId, teamId, ["owner","admin","member","viewer"])`；`teams.ts` / `team-invites.ts` / `billing.ts` 的余额与成员变更处调用对应的 publish；`removeMember` 与 `updateMemberRole` 降级后调用 `closeTeamConnectionsOf`。

- [ ] **步骤 3：验证**

```bash
cd server && npx tsx verify-teams.ts && bash smoke-test.sh && npx tsc --noEmit
```

---

### 任务 10：存量兼容回归

**文件：**
- 测试：`server/verify-billing.ts`（追加）、`server/smoke-test.sh`（追加）

- [ ] **步骤 1：写回归断言**

`verify-billing.ts` 追加：

```ts
    console.log("存量个人账户完全兼容");
    await makeUser("legacy", 200);
    check("新用户不属于任何团队", await repo(TeamMember).countBy({ userId: "legacy" }), 0);
    check("不会被自动建团队", await repo(Team).countBy({ ownerId: "legacy" }), 0);

    const legacyUser = { id: "legacy", displayName: "legacy", avatarUrl: "", role: "user" } as never;
    check("无团队用户 payer 恒为个人", (await resolvePayer(legacyUser, {})).kind, "user");

    const { consumeUserCredits, refundUserCredits } = await import("./src/services/auth");
    await consumeUserCredits("legacy", "gpt-x", 40, "/v1/ai/chat/completions");
    check("旧接口扣费余额正确", (await users.findOneByOrFail({ id: "legacy" })).credits, 160);
    const legacyLog = await repo(CreditLog).findOneOrFail({ where: { userId: "legacy" }, order: { createdAt: "DESC" } });
    check("旧接口流水 type 不变", legacyLog.type, "ai_consume");
    check("旧接口流水金额为负", legacyLog.amount, -40);
    check("旧接口流水 balance 是个人余额", legacyLog.balance, 160);
    check("旧接口不写团队流水", await repo(TeamCreditLog).countBy({ userId: "legacy" }), 0);

    await refundUserCredits("legacy", "gpt-x", 40, "/v1/ai/chat/completions");
    check("旧接口退款余额还原", (await users.findOneByOrFail({ id: "legacy" })).credits, 200);
    check("旧接口退款流水 type 不变", (await repo(CreditLog).findOneOrFail({ where: { userId: "legacy" }, order: { createdAt: "DESC" } })).type, "ai_refund");

    await rejects("旧接口余额不足仍然抛错", () => consumeUserCredits("legacy", "gpt-x", 9999, "/x"));
    check("失败后余额未变", (await users.findOneByOrFail({ id: "legacy" })).credits, 200);
    check("失败后不写任何流水", await repo(CreditLog).countBy({ userId: "legacy", type: "ai_consume" }), 1);
```

smoke 追加：

```bash
check "无团队用户生成仍按个人扣费" "$(curl -s "$BASE/v1/auth/me" -H "Authorization: Bearer $OUTSIDER_TOKEN" | jq -r .data.credits)" "$OUTSIDER_CREDITS_BEFORE"
check "无团队用户团队列表为空" "$(curl -s "$BASE/v1/teams" -H "Authorization: Bearer $OUTSIDER_TOKEN" | jq '.data | length')" "0"
```

- [ ] **步骤 2：跑通全部服务端验证**

```bash
cd server && npx tsc --noEmit && npx tsx verify-teams.ts && npx tsx verify-billing.ts && npx tsx verify-storage.ts && npx tsx verify-file-migration.ts && bash smoke-test.sh
```

预期：全绿，且 `verify-storage.ts` / `verify-file-migration.ts` 的结果与改造前一致。

---

### 任务 11：前端团队前台

**文件：**
- 新建：`web/src/services/api/teams.ts`
- 新建：`web/src/stores/use-team-store.ts`
- 新建：`web/src/pages/teams/index.tsx`、`detail.tsx`、`members.tsx`、`invites.tsx`、`logs.tsx`、`join.tsx`
- 修改：`web/src/router.tsx`
- 测试：`web/ui-check.mjs`

- [ ] **步骤 1：先写失败检查**

在 `web/ui-check.mjs` 中新增一段（照现有段落写法，登录后导航并断言控制台无 error）：

```js
    console.log("团队前台");
    await page.goto(`${WEB}/teams`, { waitUntil: "networkidle" });
    check("团队列表页可打开", await page.getByText("我的团队").isVisible().catch(() => false), true);
    check("无团队时显示创建引导", await page.getByRole("button", { name: /创建团队/ }).isVisible().catch(() => false), true);
    check("提供手输邀请码入口", await page.getByPlaceholder(/邀请码/).isVisible().catch(() => false), true);

    await page.getByRole("button", { name: /创建团队/ }).click();
    await page.getByLabel("团队名称").fill("UI 验证团队");
    await page.getByRole("button", { name: "确定" }).click();
    await page.waitForURL(/\/teams\/team-/);
    check("创建后进入团队详情", await page.getByText("UI 验证团队").isVisible().catch(() => false), true);
    check("详情页展示团队积分", await page.getByText(/团队积分/).isVisible().catch(() => false), true);

    await page.getByRole("link", { name: "成员" }).click();
    check("成员页展示自己为 owner", await page.getByText("owner").isVisible().catch(() => false), true);

    await page.getByRole("link", { name: "邀请" }).click();
    await page.getByRole("button", { name: /生成邀请链接/ }).click();
    check("生成后展示可复制的完整链接", await page.getByRole("button", { name: /复制链接/ }).isVisible().catch(() => false), true);
    await page.getByRole("button", { name: /生成邀请码/ }).click();
    check("邀请码常驻可见", await page.getByTestId("team-invite-code").innerText().then((text) => text.trim().length), 10);

    await page.goto(`${WEB}/join/not-a-real-token`, { waitUntil: "networkidle" });
    check("无效邀请链接给出明确提示", await page.getByText(/邀请链接无效或已失效/).isVisible().catch(() => false), true);

    check("团队页无控制台报错", issues.filter((item) => item.includes("/teams")).length, 0);
```

```bash
cd web && node ui-check.mjs
```

预期：页面不存在，断言 FAIL。

- [ ] **步骤 2：实现**

- `web/src/services/api/teams.ts`：照 `web/src/services/api/server.ts` 中 `serverApi` 的写法追加团队请求函数，复用 `serverRequest`；
- `web/src/stores/use-team-store.ts`：Zustand store，保存 `teams`、`currentTeamId`、`credits`、`myRole`；
- 六个页面用 antd 组件搭建，按 `myRole` 裁剪按钮（服务端仍会再判一次）；
- `web/src/router.tsx` 在 `UserLayout` 的 `children` 中加入 `/teams`、`/teams/:id`、`/teams/:id/members`、`/teams/:id/invites`、`/teams/:id/logs`，并在顶层加 `{ path: "/join/:token", element: <TeamJoinPage /> }`。

- [ ] **步骤 3：验证**

```bash
cd web && npx tsc --noEmit && npm run build && node ui-check.mjs
```

---

### 任务 12：余额实时同步与回落开关

**文件：**
- 新建：`web/src/services/team-realtime.ts`
- 修改：`web/src/pages/teams/detail.tsx`
- 修改：`web/src/pages/config/index.tsx`
- 测试：`web/ui-check.mjs`（追加）

- [ ] **步骤 1：先写失败检查**

```js
    console.log("余额实时同步与回落开关");
    await page.goto(`${WEB}/config`, { waitUntil: "networkidle" });
    const fallback = page.getByRole("switch", { name: /团队积分用尽时/ });
    check("设置页存在回落开关", await fallback.isVisible().catch(() => false), true);
    check("回落开关默认关闭", await fallback.getAttribute("aria-checked"), "false");
    await fallback.click();
    await page.reload({ waitUntil: "networkidle" });
    check("回落开关状态被持久化", await page.getByRole("switch", { name: /团队积分用尽时/ }).getAttribute("aria-checked"), "true");
    await page.getByRole("switch", { name: /团队积分用尽时/ }).click();

    await page.goto(`${WEB}/teams/${uiTeamId}`, { waitUntil: "networkidle" });
    const before = await page.getByTestId("team-credits").innerText();
    // 从后端直接充值，不刷新页面，验证 SSE 推送
    await page.request.post(`${API}/api/admin/teams/${uiTeamId}/credits`, { headers: { Authorization: `Bearer ${adminToken}` }, data: { credits: 777, remark: "UI 实时验证" } });
    await page.waitForFunction((prev) => document.querySelector('[data-testid="team-credits"]')?.textContent !== prev, before, { timeout: 5000 });
    check("余额未刷新页面即更新", (await page.getByTestId("team-credits").innerText()).includes("777"), true);
```

其中 `uiTeamId` 取自任务 11 创建团队后的 URL，`adminToken` 复用 `ui-check.mjs` 中已有的管理员登录结果。

```bash
cd web && node ui-check.mjs
```

- [ ] **步骤 2：实现**

- `web/src/services/team-realtime.ts` 照 `web/src/services/project-realtime.ts` 写：`fetch` + `ReadableStream` 读 SSE，收到 `team.credits` 更新 store；连续三次重连失败后切换为 `setInterval` 30 秒轮询 `GET /v1/teams/:id`，恢复连接后停止轮询；
- 团队详情页余额节点加 `data-testid="team-credits"`；
- `web/src/pages/config/index.tsx` 算力区块加开关，读写 `PUT /v1/preferences` 的 `billingFallbackToPersonal`，默认 `false`，说明文案写明「关闭时团队没钱直接失败；开启时会扣你自己的积分」；
- 调用被 `TEAM_CREDITS_EXHAUSTED` 拒绝时弹窗给两个出口：联系管理员充值、去设置开启回落。

- [ ] **步骤 3：验证**

```bash
cd web && npx tsc --noEmit && npm run build && node ui-check.mjs
```

---

### 任务 13：全量验证与收尾

**文件：**
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：全量验证**

```bash
cd server && npx tsc --noEmit && npx tsx verify-teams.ts && npx tsx verify-billing.ts && npx tsx verify-storage.ts && npx tsx verify-file-migration.ts && bash smoke-test.sh
cd web && npx tsc --noEmit && npm run format:check && npm run build && node ui-check.mjs
```

预期：全部通过，退出码为 0。

- [ ] **步骤 2：更新 CHANGELOG**

在 `CHANGELOG.md` 的 Unreleased 段记录：多团队与四级角色、邀请链接与手输邀请码、团队积分池与独立流水、团队余额不足默认拒绝且可选回落个人余额、扣费与流水事务化、退款严格原路。同时写明实时推送的单实例限制。

---

## 完成标准

- [ ] 一个用户可属于多个团队，服务端不存在任何「当前团队」会话状态；
- [ ] 权限矩阵只在 `team-access.ts` 中定义，路由与服务不出现裸的 `role === "owner"` 比较；
- [ ] 每个团队恒有且仅有一个 owner，转让在单事务内完成，owner 不能退出、不能被移除、不能被降级；
- [ ] admin 不能操作 admin，不能把任何人提升为 admin 或 owner；
- [ ] 邀请链接 token >= 128 bit、只存哈希、明文仅创建时返回一次；手输码明文可回查且默认 `maxUses = 1`；
- [ ] 邀请领取并发安全：10 个并发抢 3 个名额恰好成功 3 次，`usedCount` 不超过 `maxUses`；重复领取幂等且不吃名额；失败路径归还名额；
- [ ] 团队积分写入独立的 `TeamCreditLog`，`CreditLog` 内容与语义完全不变；
- [ ] 团队余额不足**默认拒绝**（`TEAM_CREDITS_EXHAUSTED`），仅在用户自己开启开关后回落到个人余额，并在两边账本各留一条可解释记录；
- [ ] 退款只认扣费回执：团队扣的退团队，回落到个人扣的退个人，团队被停用后退款仍回团队池；
- [ ] 扣费的条件更新、余额读回、流水插入在同一事务内，余额不足时不写任何消费流水；
- [ ] payer 只由服务端解析，`resolvePayer` 的上下文类型中不存在 `teamId`，请求里的 `teamId` 不被读取；
- [ ] 成员额度按 `TeamCreditLog` 实时聚合，代码中不存在任何已用额度的冗余计数列；
- [ ] 平台管理员后台在 `routes/admin-teams.ts` + `adminAuth`，团队前台在 `routes/teams.ts` + `userAuth` + `requireTeamRole`，两者互不引用；
- [ ] `team-realtime.ts` 顶部写明进程内 EventEmitter 的单实例限制，前端实现 30 秒轮询降级；
- [ ] 无团队用户的行为与改造前完全一致：不自动建团队、payer 恒为个人、`CreditLog` 的 `type` / `amount` / `balance` 语义不变；
- [ ] `verify-teams.ts`、`verify-billing.ts`、`verify-storage.ts`、`verify-file-migration.ts`、`smoke-test.sh`、`tsc --noEmit`、`npm run build`、`ui-check.mjs` 全绿。
