# 画布分享实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。每个任务都先写失败测试再写实现。

**目标：** 在实时协作层之上实现画布分享链接：只读/可编辑、匿名可选、可撤销可过期、访客写入复用现有 CAS/SSE/Presence、可克隆为独立副本，并保证授权判定只有一个入口。

**架构：** `ProjectShare` 存 token 哈希作为能力凭证；`POST /v1/shares/:token/session` 换取短期 guest JWT；`resolveProjectAccess` 是所有画布资源的唯一授权函数；editor 访客直接写所有者的项目行并复用既有广播；撤销经实时总线主动断流；克隆在单事务内复用 blob 并重写 fileId。

**技术栈：** Node.js 20、Express 5、TypeORM、React 19、Zustand 5、TypeScript、SSE、Bash smoke、Playwright。

**前置依赖：** `docs/superpowers/plans/2026-08-02-realtime-collaboration.md`（CAS、`project-realtime`、`project-access`）与 `docs/superpowers/plans/2026-08-02-storage-reference-counting.md`（`StoredFile` 引用计数）均已实现并合入。

**设计文档：** `docs/superpowers/specs/2026-08-02-canvas-sharing-design.md`

---

## 文件结构

### 新建

- `server/src/entities/project-share.ts`：分享实体。
- `server/src/entities/project-access-log.ts`：访问日志实体。
- `server/src/services/project-share.ts`：token 生成校验、分享 CRUD、guest JWT 签发、访问日志节流。
- `server/src/services/project-clone.ts`：单事务克隆，含 fileId 重写与 blob 复用。
- `server/src/routes/share.ts`：`/v1/projects/:id/shares/*` 与 `/v1/shares/:token/*` 路由。
- `web/src/pages/share/share-canvas.tsx`：独立 `/s/:token` 分享页。
- `web/src/services/share-session.ts`：token 换 guest JWT、会话持久化、失效处理。
- `web/src/components/canvas/share-panel.tsx`：所有者侧分享管理面板。
- `web/verify-share.mjs`：Playwright 端到端验证（只读、可编辑、撤销断流、克隆）。

### 修改

- `server/src/lib/jwt.ts`：guest 载荷 `kind`、`shareId`、`projectId`、`role` 与短 TTL 签发/校验。
- `server/src/middleware/auth.ts`：区分 `kind: "user"` 与 `kind: "guest"`，账号级路由拒绝 guest。
- `server/src/services/project-access.ts`：扩展为分享感知的唯一授权函数。
- `server/src/services/project-realtime.ts`：连接记录 `shareId`，新增 `revokeShare` 主动断流。
- `server/src/routes/sync.ts`：项目读写、SSE、Presence 路由改用新的 `resolveProjectAccess`。
- `server/src/services/sync.ts`：CAS 成功后写 `edit` 访问日志（节流）。
- `server/src/routes/files.ts`：上传归属所有者、所有者配额校验、访客限流、只读拒绝。
- `server/src/lib/errors.ts`：新增 `SHARE_READ_ONLY`、`CLONE_DISABLED`、`RATE_LIMITED`、`QUOTA_EXCEEDED`。
- `server/src/data-source.ts`：注册两个新实体。
- `server/src/app.ts`：挂载 share 路由、`/s/` 的 `X-Robots-Tag` 响应头。
- `server/smoke-test.sh`：分享全链路 smoke 断言。
- `web/src/services/api/server.ts`：分享 API、guest 令牌注入。
- `web/src/router.tsx`：注册 `/s/:token`。
- `web/index.html`：robots meta 注入位。
- `web/public/robots.txt`：`Disallow: /s/`。
- `web/ui-check.mjs`：分享面板渲染无报错检查。
- `CHANGELOG.md`：记录画布分享。

---

### 任务 1：分享实体与 token 服务

**文件：**
- 新建：`server/src/entities/project-share.ts`
- 新建：`server/src/entities/project-access-log.ts`
- 新建：`server/src/services/project-share.ts`
- 修改：`server/src/data-source.ts`
- 修改：`server/src/lib/errors.ts`
- 测试：`server/src/services/project-share.test.ts`

- [ ] **步骤 1：先写失败测试**

在 `server/src/services/project-share.test.ts` 断言：

- `createShare` 返回的明文 token 解码后至少 16 字节（128 bit）；
- 连续生成 1000 个 token 无重复；
- 数据库中只存 `tokenHash`，且 `tokenHash !== 明文`；
- `tokenPrefix` 长度 <= 8 且是明文前缀；
- `findShareByToken` 对错误 token 返回 null；
- 对 `enabled: false`、`expiresAt` 已过去的分享返回 null；
- 访问日志节流：同 `(shareId, actorId, "open")` 连续调用 3 次只落库 1 条；间隔超过 5 分钟（注入可控时钟）后再落 1 条；
- `event: "clone"` 不节流，3 次落 3 条。

```bash
cd server && npm test -- project-share
```

预期：模块不存在，测试失败。

- [ ] **步骤 2：实现实体与服务**

按设计文档的字段表创建两个实体；`tokenHash` 唯一索引，`projectId`、`shareId`、`createdAt` 建索引。token 用 `crypto.randomBytes(24).toString("base64url")`，哈希用 `crypto.createHash("sha256")`，比较用 `crypto.timingSafeEqual`。节流表用 `Map<string, number>`，键为 `${shareId}:${actorId}:${event}`，注入 `now()` 便于测试。在 `errors.ts` 增加新错误码。在 `data-source.ts` 注册实体。

- [ ] **步骤 3：验证**

```bash
cd server && npm test -- project-share && npx tsc --noEmit
```

预期：全部通过，无类型错误。

---

### 任务 2：guest JWT 与身份区分

**文件：**
- 修改：`server/src/lib/jwt.ts`
- 修改：`server/src/middleware/auth.ts`
- 测试：`server/src/lib/jwt.test.ts`

- [ ] **步骤 1：先写失败测试**

断言：

- `signGuestToken({ shareId, projectId, role, actorId })` 产出的载荷含 `kind: "guest"`；
- 该 token 过期时间不超过 30 分钟；
- 普通用户 token 载荷为 `kind: "user"`；
- 缺 `kind` 的历史 token 被当作 `user`（向后兼容）或被拒绝——二选一，测试固定其中一种并在实现中一致；
- 鉴权中间件对 guest token 设置 `req.auth = { kind: "guest", ... }`，且 `requireUser` 中间件对 guest 返回 403。

```bash
cd server && npm test -- jwt auth
```

- [ ] **步骤 2：实现并验证**

```bash
cd server && npm test -- jwt auth && npx tsc --noEmit
```

---

### 任务 3：`resolveProjectAccess` 成为唯一授权入口

**文件：**
- 修改：`server/src/services/project-access.ts`
- 修改：`server/src/routes/sync.ts`
- 测试：`server/src/services/project-access.test.ts`

- [ ] **步骤 1：先写失败测试**

断言矩阵（每条独立用例）：

| 身份 | need | 期望 |
| --- | --- | --- |
| owner | read/write | 通过，`role: "owner"` |
| 其他账号，无分享 | read | 404 |
| viewer 分享 | read | 通过，`role: "viewer"` |
| viewer 分享 | write | 403 / `SHARE_READ_ONLY` |
| editor 分享 | write | 通过，返回的 `ownerId` 是项目所有者而非访客 |
| 已撤销分享 | read | 404 |
| 已过期分享 | read | 404 |
| `allowAnonymous: false` + 匿名 | read | 404 |
| guest token 的 `projectId` 与请求路径不一致 | read | 404 |
| 项目已软删除 | read | 404 |

再加一条**结构性测试**：用 `grep` 断言 `server/src/routes/` 下没有除 `project-access.ts` 之外的 `ownerId ===` 比较。

```bash
cd server && npm test -- project-access
grep -rn "ownerId ===" src/routes src/services --include=*.ts | grep -v project-access.ts
```

预期：测试失败；grep 当前有输出（说明存在待迁移点）。

- [ ] **步骤 2：实现**

按设计文档实现 `ProjectAccess` 返回结构。先按 guest JWT 载荷做快速判定，再回查 `ProjectShare` 确认仍然有效（防止撤销后 JWT 未过期）。把 `routes/sync.ts` 中所有项目、SSE、Presence 处理器改为经它取项目。

- [ ] **步骤 3：验证**

```bash
cd server && npm test -- project-access && npx tsc --noEmit
grep -rn "ownerId ===" src/routes --include=*.ts
```

预期：测试通过；grep 无输出。

---

### 任务 4：分享管理与 token 交换路由

**文件：**
- 新建：`server/src/routes/share.ts`
- 修改：`server/src/app.ts`
- 测试：`server/smoke-test.sh`

- [ ] **步骤 1：先写失败 smoke 断言**

在 `server/smoke-test.sh` 新增「画布分享」段：

```bash
SHARE=$(curl -s -X POST "$BASE/v1/projects/p1/shares" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"viewer","allowAnonymous":true,"allowClone":true}')
TOKEN=$(echo "$SHARE" | jq -r .data.token)
check "创建分享返回明文 token" "$(printf '%s' "$TOKEN" | wc -c | tr -d ' ')" "32"

LIST=$(curl -s "$BASE/v1/projects/p1/shares" -H "Authorization: Bearer $USER_TOKEN")
check "列表不返回明文 token" "$(echo "$LIST" | jq -r '.data[0].token // "absent"')" "absent"

SESSION=$(curl -s -X POST "$BASE/v1/shares/$TOKEN/session")
check "匿名换取 guest 令牌" "$(echo "$SESSION" | jq -r .data.role)" "viewer"
GUEST=$(echo "$SESSION" | jq -r .data.token)

check "非所有者无法管理分享" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/p1/shares" -H "Authorization: Bearer $GUEST")" "403"
check "错误 token 返回 404" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/shares/deadbeefdeadbeefdeadbeef/session")" "404"
```

```bash
cd server && ./smoke-test.sh
```

预期：新断言失败。

- [ ] **步骤 2：实现路由并挂载**

实现设计文档「分享管理接口」与「token 交换」两节的全部端点。所有 `/v1/projects/:id/shares*` 走 `requireUser` + owner 校验；`/v1/shares/:token/session` 不要求登录但读取可选用户 JWT。

- [ ] **步骤 3：验证**

```bash
cd server && ./smoke-test.sh && npx tsc --noEmit
```

---

### 任务 5：访客写入复用现有 CAS 与广播

**文件：**
- 修改：`server/src/services/sync.ts`
- 测试：`server/smoke-test.sh`

- [ ] **步骤 1：先写失败 smoke 断言**

```bash
ESHARE=$(curl -s -X POST "$BASE/v1/projects/p1/shares" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"role":"editor","allowAnonymous":true,"allowClone":false}')
ETOKEN=$(echo "$ESHARE" | jq -r .data.token)
EGUEST=$(curl -s -X POST "$BASE/v1/shares/$ETOKEN/session" | jq -r .data.token)
REV=$(curl -s "$BASE/v1/projects/p1" -H "Authorization: Bearer $EGUEST" | jq -r .data.revision)

WROTE=$(curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $EGUEST" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"访客改标题\",\"data\":{\"nodes\":[9]},\"revision\":$REV,\"clientId\":\"guest-a\"}")
check "editor 访客写入成功" "$(echo "$WROTE" | jq -r .data.revision)" "$((REV + 1))"
check "项目仍属于原所有者" \
  "$(curl -s "$BASE/v1/projects" -H "Authorization: Bearer $USER_TOKEN" | jq -r '.data[] | select(.id=="p1") | .title')" "访客改标题"

check "viewer 访客写入被拒" \
  "$(curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $GUEST" -H 'Content-Type: application/json' \
     -d '{"title":"x","data":{},"revision":99,"clientId":"g"}' -o /dev/null -w '%{http_code}')" "403"
check "editor 访客不能用 Agent" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/agent/chat" -H "Authorization: Bearer $EGUEST" \
     -H 'Content-Type: application/json' -d '{"message":"hi"}')" "403"
```

- [ ] **步骤 2：实现**

`sync.ts` 的保存路径改用 `resolveProjectAccess(ctx, id, "write")` 返回的 `ownerId` 与 `actorId`；CAS、409 结构、广播逻辑一律不改。成功后调用节流版 `logAccess(shareId, actorId, "edit")`（owner 直写时 `share` 为空则跳过）。Agent 与账号级路由加 `requireUser`。

- [ ] **步骤 3：验证**

```bash
cd server && ./smoke-test.sh && npx tsc --noEmit
```

---

### 任务 6：撤销立即断流

**文件：**
- 修改：`server/src/services/project-realtime.ts`
- 修改：`server/src/routes/share.ts`
- 测试：`server/src/services/project-realtime.test.ts`、`server/smoke-test.sh`

- [ ] **步骤 1：先写失败测试**

单测断言：

- `subscribe(projectId, { shareId })` 后调用 `revokeShare(projectId, shareId)`，该连接的 close 回调被调用，其 Presence 条目被移除；
- owner 连接（`shareId: null`）与其他 `shareId` 的连接不受影响。

smoke 断言：撤销后再用旧 guest token 读项目返回 404。

```bash
DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/v1/projects/p1/shares/$SHARE_ID" -H "Authorization: Bearer $USER_TOKEN")
check "撤销成功" "$DEL" "200"
check "撤销后旧 guest 令牌失效" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects/p1" -H "Authorization: Bearer $GUEST")" "404"
```

- [ ] **步骤 2：实现并验证**

```bash
cd server && npm test -- project-realtime && ./smoke-test.sh
```

---

### 任务 7：访客上传归属、配额与限流

**文件：**
- 修改：`server/src/routes/files.ts`
- 测试：`server/smoke-test.sh`

- [ ] **步骤 1：先写失败 smoke 断言**

```bash
UP=$(curl -s -X POST "$BASE/v1/files" -H "Authorization: Bearer $EGUEST" -F "file=@$WORK/tiny.png")
FID=$(echo "$UP" | jq -r .data.id)
check "editor 访客可上传" "$(echo "$UP" | jq -r .code)" "0"
check "文件归属所有者" \
  "$(curl -s "$BASE/v1/files/$FID/meta" -H "Authorization: Bearer $USER_TOKEN" | jq -r .data.ownerId)" "$USER_ID"
check "只读访客不可上传" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/files" -H "Authorization: Bearer $GUEST" -F "file=@$WORK/tiny.png")" "403"
```

限流断言：循环上传 21 次，最后一次期望 429。

- [ ] **步骤 2：实现**

上传处理器改为需要 `projectId` 参数并经 `resolveProjectAccess(ctx, projectId, "write")`；`StoredFile.ownerId` 写 `access.ownerId`；配额按 `access.ownerId` 校验；`access.share` 存在时按 `(shareId, actorId)` 做 10 分钟 20 文件 / 100 MB 限流。

- [ ] **步骤 3：验证**

```bash
cd server && ./smoke-test.sh && npx tsc --noEmit
```

---

### 任务 8：克隆

**文件：**
- 新建：`server/src/services/project-clone.ts`
- 修改：`server/src/routes/share.ts`
- 测试：`server/src/services/project-clone.test.ts`

- [ ] **步骤 1：先写失败测试**

断言：

- 克隆后新项目 `ownerId` 为克隆者，`revision` 为 1，标题以「的副本」结尾；
- 源 JSON 中每个 `fileId` 在新 JSON 中都被替换为新 id，且新旧 id 无交集；
- 每个新 `StoredFile` 的 `blobKey` 与源记录相同，`ownerId` 为克隆者；
- 底层 blob 字节数未增加（统计存储目录大小或 mock 存储层写次数为 0）；
- 中途在插入项目前抛错时，事务回滚，新 `StoredFile` 一条不留；
- `allowClone: false` 抛 `CLONE_DISABLED`；
- 匿名（无账号身份）克隆被拒；
- 克隆者配额不足时整体回滚并返回配额错误；
- 克隆后修改源项目，副本内容不变。

```bash
cd server && npm test -- project-clone
```

- [ ] **步骤 2：实现**

在 `dataSource.transaction` 内按设计文档的 5 步流程实现；JSON 遍历使用递归扫描所有 `fileId` 字段，重写用同一份映射表；全部完成后写 `clone` 日志。

- [ ] **步骤 3：验证**

```bash
cd server && npm test -- project-clone && npx tsc --noEmit
```

---

### 任务 9：分享页面与 noindex

**文件：**
- 新建：`web/src/pages/share/share-canvas.tsx`
- 新建：`web/src/services/share-session.ts`
- 修改：`web/src/router.tsx`
- 修改：`web/src/services/api/server.ts`
- 修改：`web/public/robots.txt`
- 修改：`web/index.html`
- 修改：`server/src/app.ts`
- 测试：`web/ui-check.mjs`

- [ ] **步骤 1：先写失败检查**

在 `web/ui-check.mjs` 增加：访问 `/s/invalid-token` 渲染「链接不存在或已失效」且控制台无 error；`robots.txt` 含 `Disallow: /s/`；`/s/` 响应头含 `X-Robots-Tag: noindex`。

```bash
cd web && node ui-check.mjs
```

- [ ] **步骤 2：实现**

`share-session.ts` 负责换取 guest JWT、存 sessionStorage（含匿名 actorId）、失效时清理并通知页面。`share-canvas.tsx` 复用现有 canvas store 与 remote-sync，`viewer` 时禁用一切编辑入口。`app.ts` 对 `/s/` 前缀加 `X-Robots-Tag` 响应头；`index.html` 在分享路由下注入 robots meta。

- [ ] **步骤 3：验证**

```bash
cd web && npx tsc --noEmit && npm run lint && node ui-check.mjs
```

---

### 任务 10：所有者分享面板

**文件：**
- 新建：`web/src/components/canvas/share-panel.tsx`
- 修改：`web/src/pages/canvas/project.tsx`
- 测试：`web/ui-check.mjs`

- [ ] **步骤 1：先写失败检查**

`ui-check.mjs` 断言：项目页存在「分享」按钮；点击后面板出现且含角色切换、匿名开关、克隆开关、过期设置、撤销按钮与访问日志列表；创建后展示可复制的完整链接；控制台无 error。

- [ ] **步骤 2：实现并验证**

```bash
cd web && npx tsc --noEmit && npm run lint && node ui-check.mjs
```

---

### 任务 11：端到端验证与收尾

**文件：**
- 新建：`web/verify-share.mjs`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：写端到端脚本**

`verify-share.mjs` 用两个 Playwright browser context：

1. context A 以所有者登录，创建 editor 分享并取得链接；
2. context B 匿名打开 `/s/:token`，拖动节点，A 的画布在 3 秒内出现同一变更；
3. A 侧看到访客的 Presence 高亮与「访客-XXXX」标签；
4. A 撤销分享，B 在 3 秒内显示「链接已失效」且不再重连；
5. A 另建 viewer + allowClone 分享，B 登录后克隆，B 的项目列表出现副本，副本图片可正常显示；
6. B 修改副本后，A 的原画布内容不变。

- [ ] **步骤 2：全量验证**

```bash
cd server && npx tsc --noEmit && npm test && ./smoke-test.sh
cd web && npx tsc --noEmit && npm run lint && npm run build && node ui-check.mjs && node verify-share.mjs
```

预期：全部通过。

- [ ] **步骤 3：更新 CHANGELOG**

在 `CHANGELOG.md` 的 Unreleased 段记录：画布分享链接（只读/可编辑）、匿名访问、撤销与过期、访客 Presence、克隆到我的画布。

---

## 完成标准

- [ ] `resolveProjectAccess` 是唯一授权入口，`src/routes` 下无裸 `ownerId ===` 比较；
- [ ] 不存在/撤销/过期/匿名不允许统一返回 404，只读写入返回 403；
- [ ] token 明文不入库、不入日志；
- [ ] 撤销后长连接被主动关闭；
- [ ] 访客上传计所有者配额且有独立限流；
- [ ] guest 身份无法访问 Agent、生成与账号级接口；
- [ ] 克隆在单事务内完成 fileId 重写并复用 blob，无字节复制；
- [ ] 分享页三重 noindex 齐备；
- [ ] 服务端单测、smoke、web 类型检查、lint、build、ui-check、verify-share 全绿。
