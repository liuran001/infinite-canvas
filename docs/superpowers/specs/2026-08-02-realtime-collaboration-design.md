# 实时协作层设计

**日期：** 2026-08-02

## 目标

在不引入 CRDT、继续以整份画布 JSON 为持久化单位的前提下，提供：

1. 同一账号在多个设备或标签页打开同一画布时，保存后自动同步；
2. 为后续分享权限接入预留不同账号共同编辑的授权边界；
3. 显示当前正在操作节点的在线端，节点高亮并标注操作者；
4. 断网、刷新、SSE 重连后自动收敛到服务端最新版本；
5. 并发保存不能静默互相覆盖。

本批不实现画布分享、团队或成员表；不同账号获得画布访问权的入口归后续分享批次。本批实时协议从第一天就使用 `actor`/`clientId`，分享功能只需替换资源授权函数，不需要重写实时层。

## 已确认的架构取舍

### 采用 SSE + HTTP 上行，不采用 WebSocket

项目已有 `fetch + SSE` 的鉴权、解析、断线重连和 nginx 防缓冲模式。画布变更通知与 Presence 下行复用一条画布级 SSE；保存继续走现有 `PUT`，Presence 上行走节流后的 `POST`。这避免增加 WebSocket 依赖、代理配置和第二套鉴权协议。

### 继续保存整份 JSON，不采用 CRDT

服务端仍以 `Project.data` 的完整 JSON 为权威状态。`revision` 同时承担画布内容版本与当前画布事件补齐游标：流只订阅一张画布，因此不需要新增用户级 `seq`。断线期间发生多次保存时只补最新快照，因为中间状态不再有独立价值。

### Presence 是提示，不是锁

节点高亮只表示某个在线端正在选择或拖动节点，不禁止其他人操作。这样不会因断线留下死锁，也符合“整份 JSON + 乐观并发”的模型。

## 服务端设计

### 1. 原子 revision CAS

`PUT /v1/projects/:id` 请求改为：

```json
{
  "title": "画布标题",
  "data": {},
  "revision": 7,
  "clientId": "tab_xxx"
}
```

规则：

- 新画布必须带 `revision: 0`，通过 `INSERT` 创建为 revision 1；
- 已有画布必须执行 `UPDATE ... WHERE revision = :revision AND deleted = false`；
- `affected !== 1` 返回 HTTP 409、稳定错误码 `REVISION_CONFLICT`，并返回当前服务端快照；
- 缺少 revision 或伪造未来 revision 都不能绕过检查；
- 已删除项目不能被迟到的 PUT 复活；
- 成功后才广播事件。

Agent 的 `updateProjectCanvas` 与 `renameProjectCanvas` 也必须使用相同 CAS：读取 revision、计算新 JSON、条件更新，冲突最多重试三次。这样用户保存与 Agent 写画布之间不会静默覆盖。

### 2. 画布实时总线

创建专用 `project-realtime` 服务，职责仅包括：

- 按 `ownerId + projectId` 发布/订阅事件；
- 管理 Presence 内存 Map；
- Presence TTL 清理；
- 不负责数据库读写或路由鉴权。

事件：

```ts
type ProjectRealtimeEvent =
  | { type: "project.saved"; projectId: string; revision: number; writerClientId: string }
  | { type: "project.deleted"; projectId: string; revision: number; writerClientId: string }
  | { type: "presence.sync"; projectId: string; members: ProjectPresence[] };

type ProjectPresence = {
  clientId: string;
  principalId: string;
  displayName: string;
  avatarUrl: string;
  color: string;
  nodeIds: string[];
  activity: "idle" | "selecting" | "editing";
  updatedAt: string;
};
```

总线先使用 `EventEmitter`，与现有 job/agent 一致。部署约束明确为单服务进程；将来横向扩容时统一替换为 Redis pub/sub，而不是在业务代码散落 Redis 调用。

### 3. SSE 与 Presence API

```text
GET    /v1/projects/:id/realtime?clientId=...&sinceRevision=...
POST   /v1/projects/:id/presence
DELETE /v1/projects/:id/presence/:clientId
```

SSE 行为：

1. 先订阅总线，再读取数据库，避免“读取后、订阅前”丢事件；
2. 若服务端 revision 大于 `sinceRevision`，发送一次 `project.saved`；
3. 发送 `ready`，包含当前 revision 与完整 Presence；
4. 每 25 秒发送 keep-alive；
5. 连接关闭时注销 listener，并移除该 `clientId` 的 Presence；
6. 响应设置 `Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。

`project.saved` 不携带整份 JSON。远端客户端收到后按 revision 去重，再 `GET /v1/projects/:id` 拉取权威快照；即使保存事件连续到达，客户端也合并为一次拉取，并接受 GET 返回的更新 revision，避免大画布被广播复制到每个连接。

Presence：

- 客户端拖动/选中变化最多每 200ms 上报一次；
- 无变化时每 15 秒心跳；
- 服务端 45 秒未更新自动清除；
- `nodeIds` 去重并限制数量，`clientId`、activity 和字符串长度严格校验；
- principal 身份、昵称、头像全部来自已认证用户，不能相信客户端自报；
- 颜色由 `principalId + clientId` 稳定散列到固定可读色板。

### 4. 授权边界

新增统一的项目访问解析函数，当前实现只允许 owner：

```ts
resolveProjectAccess(actor, projectId, "read" | "write")
  -> { ownerId, project, permission }
```

项目读取、保存、删除、SSE 与 Presence 全部先经过它。不存在或无权限统一按“不存在”处理，避免泄漏项目 ID 是否存在。后续分享功能加入成员、匿名 token 后只扩展这个函数。

## 前端设计

### 1. 标签页身份与单连接生命周期

每个画布页面生成一个 `clientId`，同一标签页生命周期内稳定，不写入长期 localStorage。登录态与画布加载完成后建立一条实时流；切换画布、退出登录或卸载页面时 abort，并主动清 Presence。

实时客户端负责：

- `fetch` + 现有 SSE 解析器；
- `sinceRevision` 重连；
- 1.5 秒到 30 秒指数退避；
- 收到远端保存事件后合并重复 pull；
- 更新 Presence store；
- 流失败不阻断本地编辑，UI 同步状态显示失败/重连。

### 2. 防回声

收到 `project.saved`：

- `writerClientId === clientId`：只确认 revision，不覆盖本地状态；
- `event.revision <= local.revision`：丢弃旧帧；
- 否则取消该项目尚未发送的防抖保存，拉取远端快照，并通过“应用远端”闸门写 store；
- 闸门期间 `updateProject` 不触发 `pushRemote`，防止 React state 被远端覆盖后又原样写回服务端。

### 3. 保存队列与冲突合并

每个 project 只允许一个 PUT 在途。在途期间的新变更只置 `dirty`，响应返回后立即用新 revision 再保存最新快照。

客户端维护该项目最近一次确认的 `baseSnapshot`。409 时使用三方合并：

- base：最近确认的服务端快照；
- local：当前本地快照；
- remote：409 返回的服务端快照。

合并按节点 ID、连接 ID 和项目顶层字段进行：

- 本地相对 base 未改的部分采用 remote；
- remote 相对 base 未改的部分采用 local；
- 双方修改不同节点时两边都保留；
- 双方修改同一节点时，本地仍在进行的编辑字段优先，随后以 remote revision 重试；
- 节点删除优先于对同一节点的普通修改，并清理悬空连接；
- viewport 继续是设备本地状态，不参与远端保存或合并。

最多自动重试三次；仍冲突时保留本地状态、标记同步失败并给出明确提示，不进行无限覆盖循环。

### 4. Presence 展示

画布渲染层把 `nodeId -> ProjectPresence[]` 映射传入节点容器：

- 远端正在操作的节点增加彩色外描边；
- 节点上沿显示紧凑的昵称标签；
- 多人同时操作同一节点时最多展示两个昵称，其余显示 `+N`；
- 自己当前标签页不重复高亮；同账号另一设备仍作为独立在线端展示；
- Presence 消失后描边立即移除，不写入撤销历史与项目 JSON。

## 故障处理

- SSE 断线：指数退避无限重连，编辑与本地持久化继续；
- 重连：服务端根据 revision 补最新状态，不回放中间快照；
- 保存 409：三方合并后重试，不靠中文错误文案识别；
- 远端删除：停止保存与 Presence，提示画布已删除并返回列表；
- 无权限/权限撤销：流返回 404 或关闭，后续 pull 同样失败，不再展示缓存中的共享内容；
- Presence 上报失败：不影响内容保存；下一次心跳自愈；
- 服务重启：内容由数据库恢复，Presence 暂时清空并在 15 秒内由心跳恢复。

## 测试策略

### 服务端 smoke

- 缺 revision 拒绝；未来/旧 revision 均 409；
- 同 revision 并发 PUT 恰好一个成功，数据库只增加一次 revision；
- 409 返回稳定错误码和最新快照；
- 删除后的迟到 PUT 不能复活项目；
- 无权限用户无法读、写、订阅或上报 Presence；
- SSE 建连 ready、保存广播、断线补齐、keep-alive headers；
- 写入者与其他订阅者都收到 writerClientId；
- Presence 上报、同账号多个 client、断开清理、TTL 清理；
- Agent 与用户并发改画布最终无静默覆盖。

### 前端纯逻辑与类型检查

- 三方合并：不同节点、同节点、删除与连接清理；
- 自己事件防回声、旧 revision 丢弃、远端应用不触发 push；
- in-flight dirty 补发；
- 重连携带最后 revision；
- Presence 映射不进入项目 JSON。

### 浏览器双上下文验证

用 Playwright 同账号两个独立 context 打开同一画布：

1. A 新建/移动节点，B 自动出现并到达相同坐标；
2. B 修改另一节点，A 的改动不丢；
3. A 拖动节点时 B 看见 A 的昵称与高亮，停止后消失；
4. 中断 B 的实时连接，A 修改后恢复 B 网络，B 自动补齐；
5. 两端同时保存，最终 revision 一致且没有无限保存回声。

## 明确不在本批范围

- CRDT、字符级协同编辑、远端鼠标光标；
- 分享链接、团队、成员角色和匿名访问；
- Redis 或多服务实例广播；
- 将画布拆成节点表；
- Presence 历史记录。
