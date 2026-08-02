# 团队与团队计费设计

**日期：** 2026-08-02

## 目标

在现有单用户账号体系之上引入团队，让一群人共用一份算力预算：

1. 支持**多团队**：一个用户可以同时属于多个团队，团队之间互不可见；
2. 四级角色 `owner` / `admin` / `member` / `viewer`，权限矩阵完整且唯一定义在服务端；
3. 两种入团入口：**邀请链接**（高熵随机 token）与**可手输邀请码**，都支持过期、停用、使用次数上限，并发领取原子安全；
4. **团队管理前台**面向 team owner/admin，与平台管理员后台（`/admin` + `adminAuth`）彻底分离；
5. 团队有独立**积分池**与独立**积分流水表**，余额变化实时同步到在线成员；
6. 团队余额不足时**默认拒绝**调用；用户可以自行开启「回落到个人余额」开关；
7. 退款严格原路：团队扣的退回团队，个人扣的退回个人；
8. 扣费与流水写入必须在**同一事务**内完成；
9. 计费主体（payer）**只能由服务端解析**，客户端传来的任何 `teamId` 一律忽略；
10. 存量个人账号完全兼容：不给任何人自动建团队，无团队时行为与现在逐字节一致。

本批不实现团队级存储配额池、团队画布共享库、跨团队转账与发票。

## 已确认的架构取舍

### 一个用户多个团队，不做「当前团队」全局态

用户可以属于任意多个团队，但**服务端不维护「当前团队」这种会话级状态**。计费主体永远由被访问资源的归属推导（见「payer 解析」），因为：

- 全局「当前团队」是典型的隐式状态源：用户在 A 团队页面开着，另一个标签页切到 B 团队，回来一点生成就扣错了池子，而且事后无法解释；
- 资源归属是持久事实，任何时刻从数据库读出来都一样，扣费行为可复现、可审计；
- 前端仍可以有「当前团队」的视觉概念，但它只影响展示与筛选，不参与任何扣费判定。

### payer 由服务端解析，绝不接受客户端传入 `teamId`

新增 `resolvePayer(user, context)`，返回本次调用应该扣谁的余额：

```ts
type Payer =
    | { kind: "user"; userId: string }
    | { kind: "team"; teamId: string; memberId: string };

type BillingContext = { projectId?: string; jobId?: string; sessionId?: string };

resolvePayer(user: AuthUser, context: BillingContext): Promise<Payer>;
```

解析顺序：

1. 上下文里有资源标识（画布、任务、Agent 会话）→ 读取该资源的归属：归属团队则 payer 为该团队，且要求 `user` 是该团队中权限足够的成员，否则 403；
2. 资源无团队归属（存量数据、个人画布）→ payer 为 `{ kind: "user" }`；
3. 完全没有资源上下文（例如裸的 `/v1/ai/chat/completions`）→ payer 为 `{ kind: "user" }`。

请求体、查询串、请求头中出现的 `teamId` 一律**不读取**。这是本设计里最硬的一条约束：一旦允许客户端指定付款方，「越权花别人团队的钱」就退化成一个纯前端参数问题。

### 团队积分池与个人余额是两套账，不互相透支

`Team.credits` 与 `User.credits` 是两个独立余额，各自有独立流水。默认情况下：

- 团队资源的消耗只扣团队池；
- 个人资源的消耗只扣个人余额；
- 团队池不足时**直接拒绝**，返回 `TEAM_CREDITS_EXHAUSTED`。

**为什么默认拒绝而不是默认回落到个人余额：** 默认回落意味着成员在完全无感的情况下被扣走自己的钱，而他执行的是团队的工作。团队池耗尽是一个需要管理员知道并处理的事件，静默由成员垫付会把这个信号吞掉。因此回落是**用户自己**在个人设置里显式打开的开关（`preferences.billingFallbackToPersonal`，默认 `false`），语义是「我愿意在团队没钱时用自己的点数继续干活」。这个开关：

- 存在用户偏好里，不是团队设置，团队管理员**不能**替成员打开；
- 只在 payer 解析为团队且团队扣费失败时生效；
- 回落成功后写两条流水：团队流水记一条 `insufficient` 拒绝事件（金额 0，仅留痕），个人流水记一条正常消费，`extra` 里标注 `fallbackFromTeamId`，让双方账本都能解释这次调用去哪了。

### 退款严格原路

退款不重新解析 payer，而是**读取消费时落下的流水**：每次扣费返回一个 `ChargeReceipt`，退款接口只接受回执。

```ts
type ChargeReceipt = { payer: Payer; credits: number; logId: string };

charge(payer: Payer, amount: number, meta: ChargeMeta): Promise<ChargeReceipt>;
refund(receipt: ChargeReceipt, meta: RefundMeta): Promise<void>;
```

这样即便退款发生在几分钟后、用户已被移出团队、团队已被解散，钱也一定退回当初扣走的那个账户。凭回执退款还顺带杜绝了「扣个人退团队」这类通过重放实现的套利。

### 扣费与流水同一事务

**现状是缺陷**：`server/src/services/auth.ts` 的 `consumeUserCredits` 先做一条带条件的原子 `UPDATE`，再单独 `findOneBy` 读余额、再单独写 `CreditLog`。这是三次独立写读：

- 进程在两步之间崩溃 → 钱扣了，流水没了，用户投诉时查无对证；
- 并发调用之间 `findOneBy` 读到的 `balance` 不是本次扣费后的余额，流水里的余额快照本来就可能是错的。

本批把扣费统一改为在 `dataSource.transaction` 内完成：条件更新 + 读回余额 + 插入流水三件事在同一个事务里，`affected === 0` 时抛错并回滚。`refundUserCredits` 同理。团队扣费从第一天起就走同一个实现。

事务隔离级别用各方言默认即可：正确性由 `UPDATE ... WHERE credits >= :amount` 的条件更新保证，事务只负责「要么三件事都成、要么都不成」。

## 数据模型

新增四张表，全部加进 `server/src/db/entities.ts`，字段风格沿用现有实体（`varchar(64)` 主键、ISO 字符串时间、`@Index` 显式声明）。

### `Team`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `varchar(64)` 主键 | `newId("team")` |
| `name` | `varchar(255)` | 团队名 |
| `description` | `text` | 简介 |
| `avatarUrl` | `text` | 团队头像 |
| `ownerId` | `varchar(255)`，索引 | 当前 owner 的用户 id，冗余便于列表查询 |
| `credits` | `int`，默认 0 | 团队积分池余额 |
| `memberLimit` | `int`，默认 0 | 成员数上限，0 表示不限 |
| `status` | `varchar(32)`，默认 `active` | `active` / `disabled`（平台管理员可停用） |
| `createdAt` / `updatedAt` | `varchar(255)` | ISO 时间 |

### `TeamMember`

复合主键 `(teamId, userId)`，与 `Project` 的 `(userId, projectId)` 同一风格：一个用户在一个团队里只可能有一条记录，复合主键比「加唯一索引」更能直接表达这件事。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `teamId` | 主键片段，索引 | |
| `userId` | 主键片段，索引 | |
| `role` | `varchar(32)` | `owner` / `admin` / `member` / `viewer` |
| `creditLimit` | `int`，默认 0 | 成员周期额度上限，0 表示不限 |
| `limitWindow` | `varchar(32)`，默认 `month` | `day` / `month` / `total` |
| `status` | `varchar(32)`，默认 `active` | `active` / `suspended` |
| `invitedBy` | `varchar(255)` | 邀请人用户 id |
| `joinedAt` / `updatedAt` | `varchar(255)` | |

**成员额度不冗余计数。** 已用额度按 `TeamCreditLog` 实时聚合，风格与 `server/src/services/quota.ts` 的 `usedBytesOf` 完全一致：

```ts
// 与 quota.ts 的 usedBytesOf 同构：SUM + GROUP BY，不落任何冗余计数列
teamUsedCreditsOf(teamId, userIds, since): Promise<Map<string, number>>
```

理由与存储配额一样：冗余计数列必须在每条扣费、每次退款、每次窗口翻转时同步维护，任何一条路径漏改就会永久漂移，而漂移的额度只能靠人工对账修。实时聚合的代价是一条带索引的 `SUM`，`TeamCreditLog` 上 `(teamId, userId, createdAt)` 联合索引足以支撑。

### `TeamInvite`

链接与手输码**共用一张表**，靠 `kind` 区分。两者的生命周期字段（过期、停用、次数上限、领取记录）完全相同，拆两张表只会让「查这个人是怎么进来的」变成两次查询。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 主键 | |
| `teamId` | 索引 | |
| `kind` | `varchar(16)` | `link` / `code` |
| `tokenHash` | `varchar(128)`，唯一索引 | 链接 token 的 SHA-256，**不存明文** |
| `tokenPrefix` | `varchar(32)` | token 前 8 位，仅供管理界面辨认 |
| `code` | `varchar(64)`，唯一索引 | 手输码明文，`kind = "code"` 时有值 |
| `role` | `varchar(32)` | 加入后被授予的角色，禁止为 `owner` |
| `maxUses` | `int`，默认 0 | 0 表示不限次，语义与 `InviteCode.maxUses` 一致 |
| `usedCount` | `int`，默认 0 | 已领取次数 |
| `enabled` | `boolean`，默认 true | 停用开关 |
| `expiresAt` | `varchar(255)` | 空串表示不过期 |
| `createdBy` | `varchar(255)` | |
| `note` | `varchar(255)` | |
| `createdAt` | 索引 | |

**为什么链接存哈希而手输码存明文：** 链接 token 是 128 bit 以上的高熵随机值，服务端不需要把它显示回给任何人（创建时返回一次即可），存哈希可以让库被拖走也无法直接用于加入团队。手输码是 10 位受限字母表、给人抄写的，管理员必须能在后台反复看到它才能口头/截图分发，存哈希就等于让这个功能不可用。两者的风险等级本来就不同：手输码熵低，所以必须靠 `maxUses`、过期和登录态限流兜底，而不是靠保密。

链接 token 生成：`crypto.randomBytes(24).toString("base64url")`，192 bit，满足 ">= 128 bit" 要求。手输码沿用 `server/src/services/invites.ts` 已有的 `CODE_ALPHABET`（去掉 0/O/1/I/L 形近字）与 `CODE_LENGTH = 10`，复用同一个 `newInviteCode` 实现，不再另写一套。

### `TeamInviteUse`

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `inviteId` | 索引 |
| `teamId` | 索引 |
| `userId` | 索引，领取人 |
| `role` | 领取时授予的角色（invite 后续改角色不影响历史记录） |
| `createdAt` | 索引 |

### `TeamCreditLog`

**独立表，不复用 `CreditLog`。** 原因：

- `CreditLog` 的语义是「某个用户的余额变动」，主键之外的核心索引是 `userId`；团队流水的核心维度是 `(teamId, userId)`，团队维度的聚合（成员额度、团队报表）在 `CreditLog` 上要么全表扫要么加一堆可空列；
- 平台管理后台的算力流水页直接查 `CreditLog` 并按 `userId` 展示，往里塞团队记录会让现有页面的数字含义突变（个人余额流水里混进不影响个人余额的行）；
- 团队流水需要 `balance` 表示**团队池**余额，与 `CreditLog.balance` 表示个人余额冲突，共表必然出现「这一行的 balance 到底是谁的」这种只能靠 `type` 猜的字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 主键 | |
| `teamId` | 索引 | |
| `userId` | 索引 | 触发本次变动的成员；充值/管理员调整时为操作者 |
| `type` | `varchar(32)` | `topup` / `admin_adjust` / `ai_consume` / `ai_refund` / `insufficient` |
| `amount` | `int` | 正为入账，负为出账；`insufficient` 恒为 0 |
| `balance` | `int` | 本次变动后的**团队池**余额 |
| `model` | `varchar(255)` | 模型名，便于按模型统计 |
| `relatedId` | `varchar(255)` | 任务 id / 会话 id |
| `remark` | `varchar(255)` | |
| `extra` | `text` | JSON，含 `path`、`fallbackToUserId` 等 |
| `createdAt` | 索引 | |

联合索引 `(teamId, userId, createdAt)` 供成员额度聚合使用。

## 权限矩阵

角色能力由服务端唯一定义在 `server/src/services/team-access.ts`，前端只做展示裁剪，不作为判定依据。

| 能力 | owner | admin | member | viewer |
| --- | :---: | :---: | :---: | :---: |
| 查看团队信息与成员列表 | 是 | 是 | 是 | 是 |
| 查看团队积分余额 | 是 | 是 | 是 | 是 |
| 查看团队积分流水（全员） | 是 | 是 | 否 | 否 |
| 查看自己的团队消费记录 | 是 | 是 | 是 | 是 |
| 使用团队积分调用模型 | 是 | 是 | 是 | 否 |
| 读取团队画布 | 是 | 是 | 是 | 是 |
| 编辑团队画布 | 是 | 是 | 是 | 否 |
| 创建/停用邀请链接与邀请码 | 是 | 是 | 否 | 否 |
| 邀请成员为 `admin` | 是 | 否 | 否 | 否 |
| 邀请成员为 `member` / `viewer` | 是 | 是 | 否 | 否 |
| 修改成员角色（不含 owner） | 是 | 是（不能改 admin） | 否 | 否 |
| 设置成员额度 `creditLimit` | 是 | 是 | 否 | 否 |
| 移除成员 | 是 | 是（不能移除 owner/admin） | 否 | 否 |
| 主动退出团队 | 否（需先转让） | 是 | 是 | 是 |
| 修改团队名称/简介/头像 | 是 | 是 | 否 | 否 |
| 转让 owner | 是 | 否 | 否 | 否 |
| 解散团队 | 是 | 否 | 否 | 否 |
| 平台层停用团队、调整团队积分 | 否 | 否 | 否 | 否（仅平台管理员） |

不变量：

- **每个团队恒有且仅有一个 `owner`。** 转让是单事务内的两条更新（旧 owner 降为 `admin`，新 owner 升级），不存在中间态；
- **owner 不能退出、不能被移除、不能被降级**，只能转让后再退出，或直接解散团队；
- **admin 不能操作 admin**：admin 之间的互相移除/降级会形成权限争夺循环，这类操作一律留给 owner；
- `viewer` 是纯只读角色，**不能消耗团队积分**，用于外部评审、客户旁观等场景；
- 角色变更立即生效，长连接推送见「实时同步」。

## 服务端设计

### 目录与职责

| 文件 | 职责 |
| --- | --- |
| `server/src/services/teams.ts` | 团队 CRUD、成员管理、转让、解散 |
| `server/src/services/team-access.ts` | 权限矩阵的唯一实现：`requireTeamRole`、`canTeamAction` |
| `server/src/services/team-invites.ts` | 邀请链接/码的生成、校验、原子领取 |
| `server/src/services/billing.ts` | `resolvePayer` / `charge` / `refund`，事务化扣费 |
| `server/src/services/team-realtime.ts` | 团队维度 SSE：余额、成员、角色变更 |
| `server/src/routes/teams.ts` | `/v1/teams/*`，挂 `userAuth` |
| `server/src/routes/admin-teams.ts` | `/admin/teams/*`，挂 `adminAuth` |

### 唯一权限入口 `requireTeamRole`

```ts
type TeamContext = { team: Team; member: TeamMember; role: TeamRole };

requireTeamRole(userId: string, teamId: string, allow: TeamRole[]): Promise<TeamContext>;
```

规则：

- 团队不存在、已解散、用户不是成员 → 一律 **404**，不区分「没有」与「没权限」，避免用团队 id 探测别人的团队是否存在；
- 是成员但角色不足 → **403**，错误码 `TEAM_FORBIDDEN`。已经证明自己是成员之后，403 不泄露任何新信息；
- 成员 `status = "suspended"` → 403，错误码 `TEAM_MEMBER_SUSPENDED`；
- 团队 `status = "disabled"`（平台管理员停用）→ 只读接口正常，任何写入与任何扣费返回 403，错误码 `TEAM_DISABLED`。

任何路由都不允许自行比较 `member.role === "owner"`，一律经 `requireTeamRole` 或 `canTeamAction`。

### 邀请领取的并发安全

沿用 `server/src/services/invites.ts` 已验证的做法：名额判断与自增写在**同一条 UPDATE** 里。

```sql
UPDATE team_invites
   SET usedCount = usedCount + 1
 WHERE id = :id
   AND enabled = 1
   AND (maxUses = 0 OR usedCount < maxUses)
   AND (expiresAt = '' OR expiresAt > :now)
```

`affected === 0` 即为「已停用 / 已用完 / 已过期」，直接拒绝。领取前的那次 `findOneBy` 只用于给出具体文案，不是门禁。

领取全流程在一个事务内：

1. 原子占用名额（上面的 UPDATE）；
2. 检查用户是否已在团队中——已在则**回滚名额**并返回成功（幂等：重复点邀请链接不应该报错，也不应该白吃名额）；
3. 检查 `memberLimit`：当前成员数 `>= memberLimit` 且 `memberLimit > 0` 时回滚并返回 `TEAM_MEMBER_LIMIT`；
4. 插入 `TeamMember`（角色取 invite 的 `role`，永远不可能是 `owner`）；
5. 插入 `TeamInviteUse`；
6. 提交后向团队实时总线广播 `member.joined`。

失败路径复用 `releaseInviteCode` 同款的「归还名额」写法：`usedCount = usedCount - 1 WHERE usedCount > 0`。

### 计费流程

`charge` 的完整语义：

```ts
async function charge(payer: Payer, amount: number, meta: ChargeMeta): Promise<ChargeReceipt>;
```

1. `amount <= 0` 直接返回零额回执，不写库；
2. payer 为 `user`：在事务内条件更新 `users.credits >= amount`，读回余额，插入 `CreditLog`；`affected === 0` 抛 `INSUFFICIENT_CREDITS`；
3. payer 为 `team`：
   1. 先按成员额度做判定——`creditLimit > 0` 时聚合本窗口内该成员的 `ai_consume` 绝对值，加上本次金额超过上限则抛 `TEAM_MEMBER_LIMIT_EXCEEDED`（不扣费、不写消费流水，写一条 `insufficient` 留痕）；
   2. 事务内条件更新 `teams.credits >= amount`，读回团队余额，插入 `TeamCreditLog`；
   3. `affected === 0` → 写一条 `insufficient` 流水（金额 0），然后：用户开关关闭 → 抛 `TEAM_CREDITS_EXHAUSTED`；开关开启 → 递归调用 `charge({ kind: "user", userId: memberId }, ...)`，成功后在个人流水的 `extra` 中写 `fallbackFromTeamId`，回执的 `payer` 为**个人**（保证退款原路回到个人）。

`refund(receipt)` 只看回执里的 `payer` 与 `credits`，在事务内加回并写对应表的 `ai_refund` 流水。回执金额为 0 时直接返回。

### 调用点改造

| 调用点 | 现状 | 改为 |
| --- | --- | --- |
| `server/src/routes/ai.ts` | `consumeUserCredits(user.id, ...)` | `charge(await resolvePayer(user, {}), ...)`，失败路径用 `refund(receipt)` |
| `server/src/services/jobs.ts:316` | `consumeUserCredits(job.userId, ...)` | 任务持久化时就存下 `payerKind` / `payerTeamId`，运行时按存下的 payer 扣费 |
| `server/src/services/jobs.ts:329` | `refundUserCredits(job.userId, ...)` | 按任务上存下的回执退款 |
| `server/src/services/agent.ts` 三处 | `consume/refundUserCredits` | 会话创建时解析 payer 并存在 `AgentSession` 上，之后所有轮次沿用 |

任务与 Agent 会话必须**在创建时**固化 payer：一个任务可能跑几分钟，期间用户可能被移出团队或团队被停用，退款必须仍然回到当初扣钱的池子。`Job` 与 `AgentSession` 各加两列 `payerKind`（默认 `"user"`）与 `payerTeamId`（默认空串），存量行读出来就是个人计费，与现在行为一致。

### 实时同步

复用 `server/src/services/project-realtime.ts` 的进程内 `EventEmitter` 模式，新增 `team-realtime.ts`，频道键为 `team:<teamId>`。

事件：

- `team.credits`：`{ credits, teamId }`，团队池余额变化后广播，扣费/充值/管理员调整都触发；
- `team.member`：成员加入、退出、被移除、角色变更；
- `team.updated`：团队名称/头像/状态变化；
- `team.disbanded`：解散，客户端收到后立即离开团队页面。

新增 `GET /v1/teams/:id/realtime` SSE 路由，进入前经 `requireTeamRole`。角色被降级或成员被移除时，服务端**主动关闭**该用户在该团队上的 SSE 连接，理由与画布分享的撤销断流一致：长连接不重连就不会重新鉴权。

**进程内 EventEmitter 的单实例限制（必须明确记录）：**

`project-realtime.ts` 与新增的 `team-realtime.ts` 都把 `EventEmitter` 与 Presence 表放在**进程内存**里。这意味着：

- 只有在**单实例部署**下，所有订阅者才能收到全部事件；
- 一旦水平扩容到多个进程/多个容器，事件只在产生它的那个进程内广播，连到别的实例的成员**收不到**余额与成员变更，会一直看到过期数据直到自己刷新；
- 团队余额尤其敏感：成员 A 在实例 1 扣光了池子，连在实例 2 的成员 B 界面上余额仍然是旧值，直到他自己发起一次调用被拒；
- 但**正确性不受影响**：所有扣费判定都走数据库上的条件更新，不依赖广播。广播只是「让界面早点知道」，不是任何判定的依据。跨实例最坏结果是界面数字滞后，不会出现超扣。

因此本批的部署约束是：**实时推送仅在单实例下完整可用**。要水平扩容必须先把总线换成 Redis Pub/Sub 或数据库轮询，这属于后续批次，本设计不做前置抽象——过早抽象一个只有一种实现的总线接口，只会得到一个形状被单机实现绑死的接口。前端必须实现「SSE 不可用时按 30 秒轮询余额」的降级路径，让多实例部署下功能仍然可用、只是不实时。

### API 一览

团队前台（全部 `userAuth`，权限经 `requireTeamRole`）：

| 方法与路径 | 说明 | 最低角色 |
| --- | --- | --- |
| `GET /v1/teams` | 我加入的团队列表（含我的角色与团队余额） | 成员 |
| `POST /v1/teams` | 创建团队，创建者为 owner | 登录用户 |
| `GET /v1/teams/:id` | 团队详情 | viewer |
| `PATCH /v1/teams/:id` | 改名称/简介/头像 | admin |
| `DELETE /v1/teams/:id` | 解散 | owner |
| `POST /v1/teams/:id/transfer` | 转让 owner | owner |
| `GET /v1/teams/:id/members` | 成员列表（含本窗口已用额度） | viewer |
| `PATCH /v1/teams/:id/members/:userId` | 改角色、额度、挂起状态 | admin |
| `DELETE /v1/teams/:id/members/:userId` | 移除成员 | admin |
| `POST /v1/teams/:id/leave` | 主动退出 | 非 owner |
| `GET /v1/teams/:id/invites` | 邀请列表（链接只返回 `tokenPrefix`） | admin |
| `POST /v1/teams/:id/invites` | 创建链接或手输码 | admin |
| `PATCH /v1/teams/:id/invites/:inviteId` | 停用/改次数/改过期 | admin |
| `GET /v1/team-invites/:token` | 按链接 token 预览团队信息 | 登录用户 |
| `POST /v1/team-invites/:token/accept` | 用链接加入 | 登录用户 |
| `POST /v1/teams/join` | 用手输码加入，body 为 `{ code }` | 登录用户 |
| `GET /v1/teams/:id/credit-logs` | 团队流水（全员） | admin |
| `GET /v1/teams/:id/credit-logs/mine` | 我在该团队的消费记录 | viewer |
| `GET /v1/teams/:id/realtime` | 团队 SSE | viewer |

平台后台（全部 `adminAuth`，独立文件 `routes/admin-teams.ts`）：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /admin/teams` | 全平台团队列表，支持关键词与状态筛选 |
| `PATCH /admin/teams/:id` | 停用/启用团队、调整 `memberLimit` |
| `POST /admin/teams/:id/credits` | 调整团队积分池，写 `admin_adjust` 流水 |
| `GET /admin/teams/:id/members` | 查看任意团队的成员 |
| `GET /admin/team-credit-logs` | 全平台团队流水 |

**为什么不把团队管理塞进现有 `/admin`：** `/admin` 全部走 `adminAuth`，判定是「你是不是平台管理员」，是一个**全局单点**权限。团队管理的判定是「你在这个团队里是不是 admin」，是**按资源实例**的权限。把两者放进同一个中间件分区，等于要求 `adminAuth` 承担两种完全不同的判定语义，随后必然出现「某个路由忘了加 teamId 校验，于是任意团队 admin 能操作别人的团队」这类漏洞。物理分离路由文件与中间件，让这类错误在写代码时就写不出来。

### 错误码约定

| 场景 | HTTP | code |
| --- | --- | --- |
| 团队不存在 / 非成员 / 已解散 | 404 | `TEAM_NOT_FOUND` |
| 角色不足 | 403 | `TEAM_FORBIDDEN` |
| 成员被挂起 | 403 | `TEAM_MEMBER_SUSPENDED` |
| 团队被平台停用 | 403 | `TEAM_DISABLED` |
| 邀请无效 / 已停用 / 已过期 / 已用完 | 400 | `TEAM_INVITE_INVALID` |
| 成员数达到上限 | 400 | `TEAM_MEMBER_LIMIT` |
| 团队积分不足且未开启回落 | 402 | `TEAM_CREDITS_EXHAUSTED` |
| 成员本窗口额度用尽 | 402 | `TEAM_MEMBER_LIMIT_EXCEEDED` |
| 个人积分不足 | 402 | `INSUFFICIENT_CREDITS` |
| owner 试图退出团队 | 400 | `TEAM_OWNER_MUST_TRANSFER` |

`402` 用于「余额类」拒绝，与 `403`（权限类）区分开，前端可以对前者弹充值引导、对后者弹权限说明。

## 客户端设计

### 团队前台 `/teams`

新增独立路由分区，挂在现有 `UserLayout` 下（与 `/admin` 的 `AdminLayout` 完全分离）：

- `/teams`：我的团队列表 + 创建团队 + 用邀请码加入的输入框；
- `/teams/:id`：团队概览（余额、成员数、本月消耗）；
- `/teams/:id/members`：成员表格，角色下拉、额度设置、移除；
- `/teams/:id/invites`：邀请管理，创建链接后**仅此一次**展示完整链接可复制，手输码常驻可见；
- `/teams/:id/logs`：团队流水，admin 看全员、member/viewer 看自己；
- `/join/:token`：邀请链接落地页，未登录先引导登录再带回 token 继续。

界面上的每个按钮都按 `myRole` 裁剪，但这只是体验优化——服务端一定会再判一次。

### 余额展示与实时同步

新增 `web/src/services/team-realtime.ts`，模式对齐已有的 `web/src/services/project-realtime.ts`：

- 进入团队页面时建立 SSE，收到 `team.credits` 立即更新 store；
- SSE 断开且重连三次失败后降级为 30 秒轮询 `GET /v1/teams/:id`；
- 收到 `team.member` 中涉及自己的角色变更时刷新权限并重渲染；
- 收到 `team.disbanded` 时跳回 `/teams` 并提示。

### 回落开关

在个人设置页（`/config`）的算力区块新增一个开关：「团队积分用尽时，允许使用我的个人积分继续」，默认**关闭**。开关说明文案必须写清楚后果：关闭时团队没钱就直接失败；开启时会扣自己的点数。存储走现有的 `PUT /v1/preferences`，键名 `billingFallbackToPersonal`。

调用被 `TEAM_CREDITS_EXHAUSTED` 拒绝时，前端弹窗给两个出口：联系团队管理员充值，或打开回落开关重试。不做「本次临时使用个人积分」的一次性选项——一次性授权会让用户在连续失败时反复点确认，最终等价于默认开启，只是多了一堆点击。

## 存量兼容

这是本批的硬性验收项，逐条落到测试：

- **不给任何现有用户自动创建团队**，也没有「默认团队」概念；
- 用户不属于任何团队时，`resolvePayer` 恒返回 `{ kind: "user" }`，扣费路径与改造前完全一致（同一张 `CreditLog`、同样的 `type` 值、同样的 `balance` 语义）；
- `Job` 与 `AgentSession` 的新增列有默认值，存量行读出来即 `payerKind = "user"`；
- 平台后台的算力流水页面（查 `CreditLog`）内容不变，因为团队消耗写的是 `TeamCreditLog`；
- 唯一对存量用户可见的变化：`consumeUserCredits` 变成事务化，崩溃时不再出现「扣了钱没流水」。这是修 bug，不是行为变更；
- 前端在用户没有任何团队时不显示团队入口，`/teams` 页面直接展示创建引导。

## 安全检查清单

- 客户端传入的 `teamId` 在任何计费路径上都不被读取，payer 只由服务端解析；
- 邀请链接 token >= 128 bit 随机、只存哈希、明文仅创建时返回一次、不写日志；
- 手输码熵低，必须靠 `maxUses` + 过期 + 登录态才能领取来兜底，且默认 `maxUses = 1`；
- 团队不存在与非成员统一 404，防止用 id 枚举团队；
- 角色变更与移除成员后主动断开对应 SSE 连接；
- 每个团队恒有一个 owner，转让在单事务内完成；
- admin 不能操作 admin，不能提升任何人为 owner；
- 扣费、余额读回、流水写入在同一事务内，`affected === 0` 全部回滚；
- 退款只认扣费回执，绝不重新解析 payer；
- 平台管理员接口与团队管理员接口在路由文件与中间件层面物理分离。
