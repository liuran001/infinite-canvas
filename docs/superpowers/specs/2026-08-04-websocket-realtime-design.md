# WebSocket 单连接实时链路设计

## 背景与目标

当前系统实际存在四条独立的 SSE 长连接：画布协作、团队状态、Job 进度和 Agent 会话。客户端还通过 HTTP 上报 presence，并分别实现重连、游标补齐与轮询降级。目标是在不削弱现有一致性和兼容性的前提下，把这四类实时数据合并到一条 WebSocket 双向连接。

本次采用渐进双栈迁移：WebSocket 成为首选实时传输，原 SSE 与 HTTP 轮询保留为兼容和故障降级路径。画布内容持久化仍使用 HTTP revision CAS；发生 409 时继续执行现有三方合并，不把持久写入迁移到 WebSocket。

## 架构边界

服务端使用 `http.createServer(app)` 同时承载 Express 与 `ws` 的 `WebSocketServer({ noServer: true })`。唯一 WebSocket 端点为 `/api/v1/realtime`，upgrade 处理独立于 Express 路由。

新增传输无关的实时频道控制器，复用现有项目、团队、Job 和 Agent 服务层的权限检查、EventEmitter 订阅以及数据库 replay 查询。每条浏览器连接可持有多个逻辑订阅，并由客户端生成的 `subscriptionId` 区分。分享撤销或团队权限变化只终止受影响的逻辑频道，不关闭同一连接上的其他频道。

频道包括：

- `project:<projectId>`：画布 revision 通知、presence 快照和 presence 上行。
- `team:<teamId>`：团队余额、角色、成员变化及云空间用量。
- `jobs`：当前账号正在跟踪的 Job 状态和文本增量。
- `agent:<sessionId>`：Agent 消息、状态、标题和待确认动作。

## 鉴权

浏览器 WebSocket API 不能设置 `Authorization` 请求头，长期 JWT 或 guest token 也不能放入 URL，以免进入 nginx、CDN、APM 或浏览器诊断日志。

客户端先调用 `POST /api/v1/realtime/tickets`。该请求沿用现有账号或分享访客鉴权，服务端签发随机、约 30 秒有效、仅可消费一次且仅用于 WebSocket upgrade 的票据。票据在内存中只保存哈希和身份快照；消费、过期或服务重启后均不可再用。

upgrade 阶段验证：

1. 请求路径必须精确匹配 `/api/v1/realtime`。
2. `Origin` 必须符合当前服务的同源或允许来源规则。
3. 票据必须存在、未过期且未消费；验证成功时原子删除。
4. 失败时返回 401 或 403 并销毁 socket，不进入 WebSocket 状态。

票据只证明连接身份。每次 `subscribe` 仍必须调用资源级权限检查。分享访客只能订阅其 guest session 对应的项目，不能订阅团队、Job 或 Agent。

## 消息协议

所有消息都是有版本的 JSON 对象：

```ts
type RealtimeEnvelope = {
    v: 1;
    type: string;
    id?: string;
    channel?: string;
    payload?: unknown;
};
```

客户端消息：

- `subscribe`：包含 `id`、频道和频道游标。
- `unsubscribe`：包含订阅 `id`。
- `presence.update`：包含项目订阅 `id`、`clientId`、节点列表和活动状态。

服务端消息：

- `ready`：某逻辑订阅已完成权限检查和初始 replay，可开始消费实时事件。
- `event`：频道事件。
- `error`：请求级或频道级错误，包含稳定错误码和可重试标志。
- `unsubscribed`：订阅已由客户端、权限撤销或服务端关闭。

各频道保留各自游标，不能合并为全局 sequence：

- project 使用 `sinceRevision`。
- jobs 按 Job 保存 `sinceSeq`。
- agent 使用会话消息 `sinceSeq`。
- team 没有增量游标，`ready` 返回绝对状态。

建立订阅时先挂 EventEmitter 监听并缓冲事件，再查询数据库或构造快照。发送 `ready` 后按序 flush 缓冲，沿用现有 SSE 的“订阅与读库之间不丢事件”契约。

## 连接生命周期

服务端每 25 秒发送 WebSocket ping。每个周期开始前把连接标记为未响应；收到 pong 后恢复。连续一个周期未收到 pong 就 `terminate()`。连接关闭时集中执行其全部 unsubscribe，清理 listener、计时器和 presence。

客户端共享连接管理器维护当前逻辑订阅和游标。断线时使用带抖动的指数退避；重连后重新获取一次性 ticket，重放全部逻辑订阅及最新游标。终态权限错误只停止对应频道，不让整个连接反复重连。

单帧大小、每连接订阅数量、待发送缓冲和 presence 上报频率都有硬限制。非法 JSON、未知协议版本或单个频道参数错误返回请求级错误；只有超限或持续协议滥用才关闭物理连接。

## 降级与兼容

原 SSE 端点在 `v0.13.0` 保留，不立即删除：

- WebSocket 连续失败三次后，project 与 agent 回落到现有 SSE。
- team 启用现有 30 秒 HTTP 绝对状态轮询。
- jobs 启用现有 5 秒 HTTP 轮询。
- WebSocket 恢复并收到对应 `ready` 后停止该频道的降级传输。

即使 WebSocket 健康，团队和 Job 仍进行低频绝对状态纠偏，以减轻多实例事件丢失导致的长期陈旧。nginx 配置必须转发 `Upgrade` 与 `Connection` 头；前端从现有 server base URL 推导 `ws:` 或 `wss:` 地址。

## 多实例边界

WebSocket 不会自动解决现有进程内 EventEmitter 的跨实例问题。当前项目和团队事件、Job 与 Agent 总线仍只在单进程内传播；Job sequence 分配也不是多实例安全的。因此，本版本只承诺单实例下的完整实时语义。

实现时把事件发布/订阅包装在明确接口之后，为 Redis pub/sub adapter 留替换点，但本次不强制增加 Redis 运维依赖。多实例部署若需要实时一致性，后续必须启用 Redis adapter，并把 Job sequence 改成数据库原子分配或 Redis 原子计数。轮询纠偏是兼容保护，不被描述成多实例强一致保证。

## 错误和安全处理

- ticket、JWT、guest token 不写入应用日志。
- ticket 过期、重放和不允许的 Origin 均拒绝。
- 所有 subscribe 重新鉴权，不能信任客户端频道名或 ticket 中的资源声明。
- 分享或团队权限撤销只关闭相关频道，并清除相应 presence。
- 慢客户端超过发送缓冲上限时关闭连接，避免无界内存增长。
- 连接关闭、订阅替换和重复 unsubscribe 都保持幂等，不遗留 EventEmitter listener。

## 验证策略

新增 `server/verify-realtime.ts`，至少覆盖：

- ticket 过期、单次消费、重放、账号和 guest 隔离。
- 四类频道的权限与订阅。
- `ready` 之前缓冲、之后按序 flush。
- project revision、Job per-job sequence、Agent message sequence 的 replay。
- 分享撤销和团队权限变化的频道级关闭。
- presence 上行、断线清理与频率限制。
- ping/pong 失活连接清理。
- 单帧、订阅数和发送缓冲限制。

扩展 `server/smoke-test.sh`，真正完成 WebSocket upgrade、订阅和双向收发，而不只断言 HTTP 状态。原 SSE 契约检查继续运行，证明降级路径未损坏。

前端契约检查覆盖：

- 四类频道复用同一物理连接。
- 断线后重新取 ticket、重放订阅与游标。
- 终态权限错误只停止单个频道。
- 达到失败阈值后启用 SSE 或轮询，恢复后停止降级。
- presence 立即通过 WebSocket 上报。

最终验证包括 server/web typecheck 与 build、全部 `verify-*.ts`、`smoke-test.sh`、前端契约检查、UI 检查、凭据扫描和独立代码审查。
