# WebSocket 单连接实时链路实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将画布、团队、Job、Agent 四条 SSE 与 presence HTTP 上行渐进迁移到单条 WebSocket 多路复用连接，同时保留原有一致性保证和故障降级。

**架构：** Node HTTP server 通过 `ws` 的 `noServer` 模式承载 `/api/v1/realtime`，一次性 ticket 负责握手身份，传输无关的频道控制器负责权限、replay 和事件订阅。前端共享一条连接并按逻辑频道订阅；连续失败后回落到现有 SSE/HTTP 轮询，画布持久写入继续使用 HTTP revision CAS 与 409 三方合并。

**技术栈：** Node.js 20、Express 5、TypeScript、`ws` 8、React 19、Zustand 5、原生浏览器 WebSocket、TypeORM、多方言数据库、Bash/tsx 契约验证。

**设计依据：** `docs/superpowers/specs/2026-08-04-websocket-realtime-design.md`

---

## 文件结构

### 新建

- `server/src/lib/realtime-protocol.ts`：协议类型、解析和资源限制。
- `server/src/services/realtime-tickets.ts`：一次性 ticket 签发、哈希保存、消费和过期清理。
- `server/src/services/realtime-channels.ts`：传输无关的四频道鉴权、replay、缓冲和关闭。
- `server/src/services/realtime-hub.ts`：HTTP upgrade、WebSocket 生命周期、订阅表、ping/pong 和背压。
- `server/src/routes/realtime.ts`：账号/访客取 ticket 的 HTTP 端点。
- `server/verify-realtime.ts`：服务端实时协议与真实 WebSocket 专项验证。
- `server/ws-probe.mjs`：smoke test 使用的真实 WebSocket 收发探针。
- `web/src/services/realtime/protocol.ts`：浏览器侧协议类型。
- `web/src/services/realtime/connection.ts`：全应用共享连接、ticket、重连、重放和降级信号。
- `web/realtime-contract-check.mjs`：共享连接和四业务迁移契约检查。

### 修改

- `server/package.json`、`server/package-lock.json`：`ws` 与 `@types/ws`。
- `server/src/index.ts`：显式创建 HTTP server 并挂载 hub。
- `server/src/app.ts`：挂载 ticket 路由。
- `server/src/services/project-realtime.ts`、`server/src/services/team-realtime.ts`：频道级撤销回调。
- `server/smoke-test.sh`：真实 WebSocket upgrade 与收发，并保留 SSE 验证。
- `web/src/services/api/server.ts`：取票和 WS URL；现有 SSE API 保留。
- `web/src/services/project-realtime.ts`：project 频道、presence 上行、SSE 降级。
- `web/src/services/team-realtime.ts`：team 频道、SSE/30 秒轮询和低频纠偏。
- `web/src/services/api/job-stream.ts`：jobs 频道、SSE/5 秒轮询降级。
- `web/src/stores/use-cloud-agent-store.ts`：agent 频道与 SSE 降级。
- `nginx.conf`：Upgrade/Connection 转发。
- `CHANGELOG.md`、`docs/content/docs/progress/pending-test.mdx`：版本与待验证项。

---

### 任务 1：建立 WebSocket server 骨架

**文件：**
- 修改：`server/package.json`
- 修改：`server/package-lock.json`
- 修改：`server/src/index.ts`
- 创建：`server/src/services/realtime-hub.ts`
- 测试：`server/verify-realtime.ts`

- [ ] **步骤 1：编写失败的 server 附着测试**

在 `server/verify-realtime.ts` 使用 `prepareEnv("verify-realtime")` 后动态导入 hub，创建 `http.createServer((_req, res) => res.end())`，监听随机端口并用 `ws` 客户端连接 `/api/v1/realtime`；断言无 ticket 被 401 拒绝、错误路径被 404 拒绝。

```ts
const rejected: number[] = [];
await connectWs(`${base}/api/v1/realtime-nope`).catch((error) => rejected.push(error.status));
check("错误 WS 路径返回 404", rejected.at(-1), 404);
await connectWs(`${base}/api/v1/realtime`).catch((error) => rejected.push(error.status));
check("无票据返回 401", rejected.at(-1), 401);
```

- [ ] **步骤 2：确认测试先失败**

运行：`cd server && npx tsx verify-realtime.ts`

预期：`Cannot find module './src/services/realtime-hub'`，退出码非 0。

- [ ] **步骤 3：安装依赖**

运行：`cd server && npm install ws && npm install --save-dev @types/ws`

预期：lockfile 更新，`ws` 位于 dependencies，`@types/ws` 位于 devDependencies。

- [ ] **步骤 4：实现最小 upgrade 骨架**

`realtime-hub.ts` 导出 `attachRealtime(server)`，使用 `new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })`。upgrade 时精确匹配 `/api/v1/realtime`；当前先对无 ticket 返回 401，错误路径返回 404。

`server/src/index.ts` 改为：

```ts
const server = createServer(createApp());
attachRealtime(server);
server.listen(config.port, () => console.log(`infinite-canvas server listening on :${config.port}`));
```

- [ ] **步骤 5：验证并提交**

运行：`cd server && npx tsx verify-realtime.ts && npm run typecheck && npm run build`

预期：新增断言失败 0，typecheck/build 退出码 0。

提交：`feat(realtime): attach a no-server WebSocket endpoint`

---

### 任务 2：实现一次性 ticket 与 Origin 校验

**文件：**
- 创建：`server/src/services/realtime-tickets.ts`
- 创建：`server/src/routes/realtime.ts`
- 修改：`server/src/app.ts`
- 修改：`server/src/services/realtime-hub.ts`
- 测试：`server/verify-realtime.ts`

- [ ] **步骤 1：编写失败的 ticket 测试**

```ts
const identity = { userId: "u1", displayName: "用户", avatarUrl: "", guest: null };
const ticket = issueTicket(identity, nowMs);
check("ticket 首次消费成功", consumeTicket(ticket, nowMs)?.userId, "u1");
check("ticket 不可重放", consumeTicket(ticket, nowMs), null);
check("伪造 ticket 被拒", consumeTicket("forged", nowMs), null);
const expired = issueTicket(identity, nowMs - 30_001);
check("过期 ticket 被拒", consumeTicket(expired, nowMs), null);
```

再用真实 HTTP/WS 断言不允许的 Origin 为 403，正确 Origin + ticket 可完成 upgrade，已消费 ticket 第二次为 401。

- [ ] **步骤 2：确认测试先失败**

运行：`cd server && npx tsx verify-realtime.ts`

预期：找不到 `realtime-tickets`。

- [ ] **步骤 3：实现 ticket 服务与路由**

ticket 使用 32 字节 `randomBytes`，Map 只保存 SHA-256 hash、identity、expiresAt。`consumeTicket` 必须先删除再返回，确保单次消费。TTL 为 30 秒。

`POST /v1/realtime/tickets` 使用允许账号或 guest 的现有 principal 解析；响应 `{ ticket, expiresInMs: 30000 }`，不记录 token/ticket。hub 校验 path、Origin，再消费 ticket。

- [ ] **步骤 4：验证账号/访客边界**

运行：`cd server && npx tsx verify-realtime.ts`

预期：首次消费、重放、过期、Origin、账号和 guest 取票断言全部通过。

- [ ] **步骤 5：提交**

提交：`feat(realtime): authenticate upgrades with one-time tickets`

---

### 任务 3：定义协议和硬限制

**文件：**
- 创建：`server/src/lib/realtime-protocol.ts`
- 创建：`web/src/services/realtime/protocol.ts`
- 测试：`server/verify-realtime.ts`

- [ ] **步骤 1：编写失败的帧解析测试**

覆盖非法 JSON、`v !== 1`、未知 type、缺 id、非法 channel、超过 64 KiB、合法 subscribe/unsubscribe/presence.update。稳定错误码分别为 `INVALID_FRAME`、`UNSUPPORTED_VERSION`、`UNKNOWN_TYPE`、`INVALID_SUBSCRIPTION`、`FRAME_TOO_LARGE`。

- [ ] **步骤 2：运行并确认失败**

运行：`cd server && npx tsx verify-realtime.ts`

预期：协议模块不存在。

- [ ] **步骤 3：实现协议**

定义 `ClientFrame`、`ServerFrame` 和：

```ts
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_SUBSCRIPTIONS = 32;
export const MAX_SEND_BUFFER_BYTES = 4 * 1024 * 1024;
export const PRESENCE_MIN_INTERVAL_MS = 200;
```

只允许 `subscribe`、`unsubscribe`、`presence.update`，id/channel 使用 `/^[A-Za-z0-9_:-]{1,128}$/`。浏览器侧协议类型保持字段完全一致。

- [ ] **步骤 4：验证并提交**

运行：`cd server && npx tsx verify-realtime.ts && npm run typecheck`

预期：协议断言失败 0。

提交：`feat(realtime): define the multiplexed realtime protocol`

---

### 任务 4：实现传输无关的四频道控制器

**文件：**
- 创建：`server/src/services/realtime-channels.ts`
- 修改：`server/src/services/project-realtime.ts`
- 修改：`server/src/services/team-realtime.ts`
- 测试：`server/verify-realtime.ts`

- [ ] **步骤 1：编写 project/team 失败测试**

创建用户、项目、团队数据，直接调用 `openRealtimeChannel`：

```ts
check("project 首帧为 ready", projectFrames[0].type, "ready");
check("project ready 带 revision", projectFrames[0].payload.revision, 1);
publishProjectSaved(ownerId, projectId, 2, "remote-client");
check("project 事件按 revision 到达", projectFrames[1].payload.revision, 2);
check("team ready 返回绝对余额", teamFrames[0].payload.credits, 100);
check("team ready 返回空间用量", teamFrames[0].payload.storage.used, 0);
```

构造“监听已挂但快照尚未读完”的钩子，验证期间发布的事件在 `ready` 后按序 flush。

- [ ] **步骤 2：编写 jobs/agent 与 guest 隔离失败测试**

验证 jobs 按每个 job 的 seq replay，不能用全局最大 seq；Agent 从 `sinceSeq` 后补消息并发送带 title/pendingAction 的 status。验证 guest 可订阅自己的 project，但订阅 team/jobs/agent 均返回 `FORBIDDEN`。

- [ ] **步骤 3：确认测试先失败**

运行：`cd server && npx tsx verify-realtime.ts`

预期：找不到频道控制器。

- [ ] **步骤 4：实现最少控制器**

`openRealtimeChannel` 只依赖 `send(frame)`，不依赖 WebSocket。每个频道按固定顺序执行：资源鉴权 → 先挂 listener 并缓冲 → 读取 replay/快照 → 发送 `ready` → 按到达顺序 flush。失败路径立即 unsubscribe。

project 使用 revision 与 presence；team 返回绝对 credits/role/storage；jobs 保留 per-job replay map 与文本 offset；agent 补消息后发送 status。

- [ ] **步骤 5：实现频道级撤销**

project/team 的 connection registration 保存逻辑频道 `close` 回调。`disconnectShare` 和 `closeTeamConnectionsOf` 只触发对应 subscription 的 `unsubscribed` 与清理，不关闭物理 WebSocket。

- [ ] **步骤 6：验证并提交**

运行：`cd server && npx tsx verify-realtime.ts && npx tsx verify-share.ts && npx tsx verify-teams.ts`

预期：全部失败 0，listener/presence 无泄漏。

提交：`feat(realtime): add replayable project team job and agent channels`

---

### 任务 5：将频道接入 WebSocket hub

**文件：**
- 修改：`server/src/services/realtime-hub.ts`
- 创建：`server/ws-probe.mjs`
- 修改：`server/smoke-test.sh`
- 测试：`server/verify-realtime.ts`

- [ ] **步骤 1：编写真实连接失败测试**

真实连接中订阅四个频道，断言只建立一个 socket、四个 ready 都到达；第 33 个订阅返回 `TOO_MANY_SUBSCRIPTIONS` 但 socket 保持 OPEN；unsubscribe 后 listener 数为 0；关闭 socket 后全部订阅和 presence 清空。

- [ ] **步骤 2：编写心跳、背压和 presence 失败测试**

注入短 heartbeat 周期验证不回 pong 的客户端被 terminate；模拟 `bufferedAmount` 超限；200ms 内重复 presence.update 返回 `RATE_LIMITED`，合法 presence 立即反映到 project presence。

- [ ] **步骤 3：确认测试先失败**

运行：`cd server && npx tsx verify-realtime.ts`

预期：连接建立但 subscribe 无 ready，新增断言失败。

- [ ] **步骤 4：实现 hub 生命周期**

每连接维护 `Map<subscriptionId, close>`、最近 presence 时间和 protocol violation 计数。发送前检查 readyState 与 bufferedAmount。每 25 秒 ping，一周期未 pong 就 terminate。close 时幂等执行全部 unsubscribe。

- [ ] **步骤 5：扩展真实 smoke test**

`ws-probe.mjs` 使用 `ws` 客户端连接、发送 project subscribe、等待 ready、发送 presence.update，并输出一行一个 JSON frame。`smoke-test.sh` 登录取 ticket，运行探针并断言 ready/presence；同时保留现有四条 SSE 检查。

- [ ] **步骤 6：验证并提交**

运行：`cd server && npx tsx verify-realtime.ts && npm run typecheck && npm run build && bash smoke-test.sh`

预期：全部失败 0。

提交：`feat(realtime): multiplex subscriptions over one WebSocket`

---

### 任务 6：实现浏览器共享连接管理器

**文件：**
- 创建：`web/src/services/realtime/connection.ts`
- 修改：`web/src/services/api/server.ts`
- 创建：`web/realtime-contract-check.mjs`

- [ ] **步骤 1：编写失败的纯客户端契约测试**

使用 fake WebSocket/fake timer 验证：四频道只创建一个 socket；每次重连重新取 ticket；重放最新游标；连续三次失败触发每频道 `onDegrade`；对应 ready 后触发 `onRecover`；FORBIDDEN 只停止单频道。

- [ ] **步骤 2：确认测试先失败**

运行：`node web/realtime-contract-check.mjs`

预期：共享连接模块不存在。

- [ ] **步骤 3：实现 ticket API 与 URL 推导**

`serverRealtimeTicket()` POST `/v1/realtime/tickets`。`serverRealtimeUrl(ticket)` 从现有 server base URL 推导 `ws:`/`wss:` 并只把短期 ticket 放 query。

- [ ] **步骤 4：实现连接管理器**

管理器保存逻辑订阅、最新 cursor、handlers 和失败次数。重连固定执行：新 ticket → 新 socket → open 后重放全部订阅。退避为 `[1500,3000,6000,12000,24000,30000]` 并乘 0.8–1.2 抖动。只有收到 ready 才重置失败数。

- [ ] **步骤 5：验证并提交**

运行：`node web/realtime-contract-check.mjs && npm --prefix web run typecheck`

预期：契约失败 0，typecheck 通过。

提交：`feat(realtime): share one reconnecting WebSocket in the browser`

---

### 任务 7：迁移 project 与 presence

**文件：**
- 修改：`web/src/services/project-realtime.ts`
- 修改：`web/realtime-contract-check.mjs`

- [ ] **步骤 1：编写失败测试**

断言 project 首选 WS、远端新 revision 触发拉取、自身 clientId 与旧 revision 被忽略、连续事件合并拉取；三次失败后启用现有 `serverProjectStream`；ready 后 abort SSE；presence 首选 WS，WS 不可用时回落现有 HTTP。

- [ ] **步骤 2：确认失败**

运行：`node web/realtime-contract-check.mjs`

预期：project 仍只走 SSE，新增断言失败。

- [ ] **步骤 3：实现最少迁移**

只替换事件传输入口，保留现有 canvas store/presence store 更新和 revision 去重。`createPresenceReporter` 保留节流与 15 秒心跳，但优先发送 `presence.update`。

明确不修改 `remote-sync.ts` 的 HTTP 保存队列、revision CAS、baseSnapshot 与 409 三方合并。

- [ ] **步骤 4：验证并提交**

运行：`node web/realtime-contract-check.mjs && node web/share-contract-check.mjs && npm --prefix web run typecheck`

预期：失败 0。

提交：`feat(realtime): move project presence to the shared socket`

---

### 任务 8：迁移 team、jobs 与 agent

**文件：**
- 修改：`web/src/services/team-realtime.ts`
- 修改：`web/src/services/api/job-stream.ts`
- 修改：`web/src/stores/use-cloud-agent-store.ts`
- 修改：`web/realtime-contract-check.mjs`

- [ ] **步骤 1：编写 team 失败测试**

断言 team 首选 WS；ready 更新 credits/role/storage；三次失败后启用原 SSE 与 30 秒轮询；WS 健康时仍低频拉绝对状态纠偏；ready 后停止降级 SSE，但保留低频纠偏。

- [ ] **步骤 2：编写 jobs/agent 失败测试**

断言 jobs 只订阅一个逻辑频道、按各 job seq 恢复、文本 offset 正确、无 waiter 时只退订频道而不关 socket、失败后保留 5 秒轮询。Agent 使用 session sinceSeq，失败后回落 `serverAgentStream`。

- [ ] **步骤 3：确认失败**

运行：`node web/realtime-contract-check.mjs`

预期：三业务仍直接调用 SSE，新增断言失败。

- [ ] **步骤 4：实现 team、jobs、agent 适配器**

复用原有事件处理函数与 store 写入，不复制业务逻辑。SSE 函数和调用点必须保留在降级分支。EOF 计为失败；收到频道 ready 才视为恢复。终态权限错误停止频道而不是反复重连。

- [ ] **步骤 5：验证并提交**

运行：`node web/realtime-contract-check.mjs && node web/team-contract-check.mjs && node web/share-contract-check.mjs && npm --prefix web run typecheck && npm --prefix web run build`

预期：全部失败 0；build 仅允许现有 chunk warning。

提交：`feat(realtime): move team jobs and agent streams onto one socket`

---

### 任务 9：配置 nginx WebSocket 转发

**文件：**
- 修改：`nginx.conf`

- [ ] **步骤 1：验证当前配置缺失**

运行：`grep -n "proxy_set_header Upgrade" nginx.conf`

预期：无输出。

- [ ] **步骤 2：添加条件 Connection map**

在 http 作用域已有 map 附近添加：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
}
```

在 `/api/` location 添加：

```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

- [ ] **步骤 3：验证配置**

运行：`docker run --rm -v "$PWD/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine nginx -t`

预期：`syntax is ok` 和 `test is successful`。若本机无 Docker，记录该项未执行，不能声称通过，并依靠 smoke test 的直连验证补充但不替代 nginx 验证。

- [ ] **步骤 4：提交**

提交：`fix(deploy): proxy WebSocket upgrades through nginx`

---

### 任务 10：文档、v0.13.0 归档与全量验证

**文件：**
- 修改：`CHANGELOG.md`
- 修改：`docs/content/docs/progress/pending-test.mdx`

- [ ] **步骤 1：更新文档**

把 WebSocket 单连接、一次性 ticket、四频道降级、HTTP CAS 保留和单实例限制写入 `v0.13.0 - 2026-08-03`。将当前 Unreleased 的本分支条目全部移动到该版本，清空 Unreleased 内容但保留标题。`VERSION` 保持 `v0.13.0`。

pending-test 增加真实反向代理 Upgrade、断线重连、跨账号/guest 隔离、长期稳定性和多实例 Redis adapter 尚未提供等人工验证项。

- [ ] **步骤 2：运行服务端全部契约验证**

运行：

```bash
cd server
npm run typecheck
npm run build
for file in verify-*.ts; do npx tsx "$file"; done
bash smoke-test.sh
```

预期：所有命令退出码 0，每个 verify 脚本报告失败 0，smoke test 报告失败 0。

- [ ] **步骤 3：运行前端全部契约验证**

运行：

```bash
node web/realtime-contract-check.mjs
node web/team-contract-check.mjs
node web/share-contract-check.mjs
node web/ui-check.mjs
npm --prefix web run typecheck
npm --prefix web run build
```

预期：契约/UI 检查失败 0；typecheck/build 退出码 0，仅允许既有动态导入与 chunk size warning。

- [ ] **步骤 4：检查占位符、空白和凭据残留**

运行：

```bash
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- '*.ts' '*.tsx' '*.mjs' '*.sh' | grep -nE 'TODO|FIXME|test\.(skip|only)|describe\.(skip|only)' || true
grep -rn --exclude-dir=.git --exclude-dir=node_modules -E 'f8a25351-|tvly-dev-SRcK9|sk-NIIuV2Bb|XRJK5N6rK2916W0rzqrPBduP31GQ' .
```

预期：无空白错误、无新增占位符或跳过测试、凭据扫描无输出。

- [ ] **步骤 5：独立审查并修复全部 Critical/Important**

使用独立 code-reviewer 审查 `origin/main...HEAD`，重点检查鉴权泄漏、频道隔离、listener/presence 清理、replay 时序、慢客户端内存、SSE 降级与多实例表述。每个确认问题先补失败测试，再最小修复并重跑相关验证。

- [ ] **步骤 6：提交文档和修复**

提交：`docs(realtime): document the multiplexed realtime transport`

- [ ] **步骤 7：最终同步和推送**

获取并合并最新 `upstream/main`；冲突时保留双方真实内容。重跑步骤 2–4。确认工作树 clean 后执行：

```bash
git push origin HEAD:main
```

预期：远端 `main` 更新到当前已验证 HEAD。

---

## 自检结果

- 规格覆盖：四频道、ticket、Origin、replay、presence、心跳、背压、重连、SSE/轮询降级、nginx、HTTP CAS、多实例边界、验证和 v0.13.0 均有明确任务。
- 占位符扫描：计划不含待定实现；所有关键接口、命令、预期和提交边界已明确。
- 类型一致性：统一使用 `subscribe`/`unsubscribe`/`presence.update` 与 `ready`/`event`/`error`/`unsubscribed`；频道游标保持 project revision、jobs per-job seq、agent seq、team 绝对快照。
- 范围控制：不实现 Redis adapter，不删除 SSE，不迁移画布持久保存，不承诺多实例实时一致性。
