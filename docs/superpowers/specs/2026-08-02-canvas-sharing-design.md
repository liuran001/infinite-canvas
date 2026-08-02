# 画布分享设计

**日期：** 2026-08-02

## 目标

在实时协作层（`ProjectRealtime` + revision CAS + Presence）已经就位的前提下，提供画布对外分享：

1. 画布所有者可以生成一条分享链接，选择只读或可编辑；
2. 分享链接可以允许匿名访问，也可以要求登录；
3. 可编辑分享的访客写入的是所有者的项目本体，复用现有 CAS、SSE 与 Presence，不产生第二套写路径；
4. 分享可随时撤销、可设过期时间，撤销后正在连接的访客立即断流；
5. 访客可以选择「克隆到我的画布」，得到一份属于自己的独立副本；
6. 分享页面不进入搜索引擎索引，且不暴露所有者的其他资源。

本批不实现团队、成员表、按人授权和评论。分享是「链接即权限」模型。

## 已确认的架构取舍

### 链接即权限，不引入成员表

一条分享链接就是一个能力凭证（capability token）。这样不需要邀请流程、成员状态机和权限继承，也不需要在匿名场景下先创建账号。代价是链接泄露等价于权限泄露，因此靠随机 token、可撤销、可过期和访问日志来控制风险。

### 访客身份用短期服务端 guest JWT，不直接把 token 当会话

浏览器拿到 `/s/:token` 后，先用 token 换一枚**短期、服务端签发**的 guest JWT。此后所有 API 调用（含 SSE、Presence、上传）都用这枚 JWT，而不是反复携带原始 token。理由：

- 原始 token 只出现在一次交换请求里，不会散落在每个 API 请求日志和 SSE URL 上；
- guest JWT 可以内嵌 `projectId`、`role`、`shareId`，服务端无需每次查库即可完成第一层判定；
- 短 TTL 让撤销的爆炸半径有上界，长连接的撤销由实时总线立即处理（见「撤销立即生效」）。

guest JWT 与普通用户 JWT 使用同一套签发与校验基础设施，但载荷带 `kind: "guest"` 标记，鉴权中间件必须能区分二者，避免 guest 身份被误当成账号身份用于账号级接口（设置、项目列表、邀请码等）。

### 唯一授权入口 `resolveProjectAccess`

实时协作批次已预留 `server/src/services/project-access.ts`。本批把它扩展为**所有**画布相关资源的唯一授权函数：

```ts
type ProjectAccess = {
  project: Project;      // 已加载的项目实体
  ownerId: string;       // 项目真实所有者，配额与文件归属都以它为准
  role: "owner" | "editor" | "viewer";
  share?: ProjectShare;  // 通过分享进入时存在
  actorId: string;       // 账号 id 或 guest:<shareId>:<随机> 形式的访客 id
};

resolveProjectAccess(ctx, projectId, need: "read" | "write"): Promise<ProjectAccess>;
```

规则：

- 项目路由、SSE 路由、Presence 路由、上传路由、克隆路由全部只能通过它取得项目，任何地方都不允许再出现裸的 `projectRepo.findOne({ id })` 后自行判断 `ownerId === userId`；
- 资源不存在、已删除、分享不存在、分享 `enabled = false`、已过期、匿名未允许而访客未登录，一律返回 **404**，不区分「没有」和「没权限」，避免 token 探测；
- 已通过读授权但角色为 `viewer` 却请求 `need: "write"`，返回 **403**，稳定错误码 `SHARE_READ_ONLY`。这条与上一条不冲突：403 只在访客已经证明自己持有合法只读凭证之后出现。

## 数据模型

### `ProjectShare`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `projectId` | string | 目标画布，索引 |
| `ownerId` | string | 创建分享时的项目所有者，冗余存储便于配额与审计 |
| `tokenHash` | string | token 的哈希值，唯一索引；**不存明文** |
| `tokenPrefix` | string | token 前若干字符，仅用于管理界面识别链接，不足以还原 token |
| `role` | `"viewer" \| "editor"` | 链接授予的角色 |
| `allowAnonymous` | boolean | 是否允许未登录访问；为 false 时必须先登录 |
| `allowClone` | boolean | 是否允许访客克隆为自己的画布 |
| `enabled` | boolean | 撤销开关，撤销为软删除语义 |
| `expiresAt` | Date \| null | 过期时间，null 表示不过期 |
| `createdAt` / `updatedAt` | Date | 时间戳 |

token 要求：

- 至少 128 bit 熵，使用 `crypto.randomBytes(24)` 并以 base64url 编码；
- 明文只在创建响应中返回一次，服务端仅保存哈希；
- 哈希用固定算法（SHA-256）而非慢哈希，因为 token 本身是高熵随机值，不存在字典攻击面，且查询需要按哈希做等值索引；
- 校验时按 `tokenHash` 等值查找，比较使用常量时间比较。

同一画布允许存在多条分享（例如一条只读、一条可编辑），逐条独立撤销。

### `ProjectAccessLog`

记录分享维度的访问事件，用于所有者查看「谁在什么时候看过」。

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `shareId` | 关联分享，索引 |
| `projectId` | 冗余，便于按画布聚合 |
| `actorId` | 账号 id，或访客的稳定匿名 id |
| `isAnonymous` | 是否匿名访问 |
| `event` | `"open" \| "edit" \| "clone"` |
| `ipHash` / `userAgent` | IP 取哈希后存储，UA 截断保存 |
| `createdAt` | 时间戳，索引 |

**写入必须节流。** 一次访客打开画布会立刻产生 SSE 连接、Presence 心跳和多次保存，逐次落库会把日志表写爆。规则：

- 以 `(shareId, actorId, event)` 为键在内存维护最近写入时间，**同键 5 分钟内只写一条**；
- `open` 在换取 guest JWT 时判定，不在每个 API 请求上判定；
- `edit` 在 CAS 保存成功后判定；
- `clone` 每次都写，因为它是低频且有实际副作用的操作；
- 节流状态为进程内存，多实例下退化为「每实例每 5 分钟一条」，这是可接受的。

## 服务端设计

### 1. 分享管理接口（仅所有者）

- `POST /v1/projects/:id/shares`：创建分享，body 含 `role`、`allowAnonymous`、`allowClone`、`expiresAt`。响应中**唯一一次**返回明文 token 与完整链接。
- `GET /v1/projects/:id/shares`：列出该画布的分享，返回 `tokenPrefix` 而非 token。
- `PATCH /v1/projects/:id/shares/:shareId`：修改 `role`、`allowAnonymous`、`allowClone`、`expiresAt`、`enabled`。
- `DELETE /v1/projects/:id/shares/:shareId`：撤销（置 `enabled = false`）。
- `GET /v1/projects/:id/shares/:shareId/logs`：分页查看访问日志。

以上路由一律要求真实账号身份且必须是 owner；guest JWT 访问这些路由返回 403。

### 2. token 交换

`POST /v1/shares/:token/session`

- 命中 `tokenHash`、`enabled = true`、未过期，且（`allowAnonymous = true` 或请求带有效用户 JWT）时，返回：
  - guest JWT（TTL 建议 30 分钟，可用同一 token 续期）；
  - 项目只读元信息（标题、`revision`、`role`、`allowClone`）。
- 任一条件不满足返回 404。
- 已登录用户通过分享进入时，`actorId` 用其账号 id，Presence 显示真实昵称；匿名访客生成稳定的 `guest:<shareId>:<随机>` 并写入 guest JWT，刷新页面沿用同一 id（存 sessionStorage）。

### 3. 写路径复用，不新建

`editor` 角色的保存走**现有** `PUT /v1/projects/:id`：

- 请求体、`revision` CAS、409 结构化冲突响应完全不变；
- 写入的是所有者的项目行，`ownerId` 不变；
- 保存成功后照常经 `project-realtime` 广播，owner 与其他访客同一条 SSE 收到更新；
- Presence 上行同样复用现有路由，`actor` 用 `resolveProjectAccess` 给出的 `actorId`，昵称对匿名访客显示为「访客-XXXX」。

这一点是整个设计的关键：分享**没有**引入第二条写路径，只是把 `resolveProjectAccess` 的判定结果从「必须是 owner」放宽到「owner 或 editor 分享」。

### 4. 撤销立即生效

仅靠 guest JWT 的短 TTL 不够——SSE 是长连接，撤销后不重连就不会重新鉴权。因此：

- `project-realtime` 为每条 SSE 连接记录其 `shareId`（owner 直连为 null）；
- `PATCH`（`enabled: false` 或调低 `role`）与 `DELETE` 成功后，向实时总线发 `share.revoked` 事件；
- 总线遍历该画布连接，**主动关闭**所有匹配 `shareId` 的连接，并清除其 Presence 条目；
- 客户端收到连接关闭且重连返回 404 时，停止重试并展示「链接已失效」；
- 除长连接外，每次写请求仍然完整走 `resolveProjectAccess`，所以最坏情况下失效延迟为零。

### 5. 上传与配额

访客上传（含匿名）落在所有者名下：

- 文件的 `ownerId` 记为项目所有者，计入**所有者**的存储配额，因为文件最终存在于所有者的画布里；
- 上传前检查所有者配额，超限返回 403 且错误码 `QUOTA_EXCEEDED`；
- 对访客单独做速率限制：按 `(shareId, actorId)` 限制上传次数与总字节数（建议每 10 分钟 20 个文件 / 100 MB），触发返回 429；
- 只读分享不允许上传，返回 403；
- 上传接口的项目归属同样只能通过 `resolveProjectAccess(ctx, projectId, "write")` 获得。

### 6. 明确不开放给分享访客的能力

以下接口对 guest JWT 一律 403，即使角色是 `editor`：

- Agent 对话与任何模型生成接口；
- 项目列表、项目创建与删除；
- 设置、邀请码、账号相关接口；
- 分享管理接口本身。

理由：这些能力直接消耗所有者的模型额度或影响其账号，链接持有者不应获得。可编辑分享的边界是「编辑这张画布的内容」，不是「以所有者身份使用系统」。

### 7. 克隆

`POST /v1/shares/:token/clone`，要求真实账号身份（匿名必须先登录）且 `allowClone = true`。

流程在**单个事务**内完成：

1. 读取源项目 JSON 与 `revision`；
2. 扫描 JSON 中引用的所有 `fileId`；
3. 对每个被引用文件，创建**新的 `StoredFile` 记录**，`ownerId` 为克隆者，但 **`blobKey` 指向同一份底层对象**——不复制字节，只增加引用；
4. 在新 JSON 中把旧 `fileId` 重写为新记录的 id；
5. 插入新项目行，`ownerId` 为克隆者，`revision` 从 1 开始，标题追加「的副本」；
6. 写入 `clone` 访问日志。

要点：

- 复用 blob 依赖存储层的引用计数（见 `docs/superpowers/specs/2026-08-02-storage-reference-counting-design.md`）：新增 `StoredFile` 即新增一个引用，源项目删除时不会误删仍被副本引用的 blob；
- **fileId 重写与项目插入必须同一事务**，否则可能产生指向不存在文件记录的画布，或产生无人引用的孤儿文件记录；
- 克隆后的画布与源画布完全独立，源画布的后续修改不影响副本；
- 克隆按克隆者的配额计费（新的 `StoredFile` 记账到克隆者），配额不足则整个事务回滚并返回 403。

## 客户端设计

### 独立分享页面 `/s/:token`

不复用 `/canvas/:projectId` 页面，而是新建独立路由。理由：项目页假定存在账号会话、项目列表、Agent 面板和设置入口，把这些在分享态下逐个条件隐藏会留下大量易错的分支。独立页面只挂载画布本体、Presence 和（editor 时的）保存逻辑，底层复用同一套 canvas store 与 remote-sync 服务。

页面行为：

- 挂载时先调 `POST /v1/shares/:token/session`，失败即渲染「链接不存在或已失效」；
- `viewer` 模式下画布只读：禁用拖拽创建、编辑、删除与上传，仍可平移缩放与查看；
- `editor` 模式下走完整的保存队列、CAS 冲突三方合并与 Presence 上报；
- 顶栏显示画布标题、角色徽标，以及 `allowClone` 时的「保存到我的画布」按钮；
- 匿名访客点击克隆时先跳转登录，登录后带回 token 继续。

### 三重 noindex

分享页面不应被搜索引擎收录：

1. 页面响应头 `X-Robots-Tag: noindex, nofollow`；
2. HTML 中 `<meta name="robots" content="noindex, nofollow">`；
3. `robots.txt` 中 `Disallow: /s/`。

三层同时存在是因为它们覆盖不同抓取路径：响应头对非 HTML 资源与代理有效，meta 对已抓取页面有效，robots.txt 对合规爬虫在抓取前有效。

### 所有者侧管理入口

在项目页新增「分享」面板：创建链接、复制链接（仅创建时可复制完整链接）、切换角色与开关、设置过期、撤销，以及查看访问日志列表。

## 错误码约定

| 场景 | HTTP | code |
| --- | --- | --- |
| token 不存在 / 已撤销 / 已过期 / 匿名未允许 / 项目已删除 | 404 | `NOT_FOUND` |
| 只读分享尝试写入或上传 | 403 | `SHARE_READ_ONLY` |
| guest 访问禁用能力 | 403 | `FORBIDDEN` |
| 所有者配额不足 | 403 | `QUOTA_EXCEEDED` |
| 访客上传超频 | 429 | `RATE_LIMITED` |
| 保存版本冲突 | 409 | `REVISION_CONFLICT` |
| 不允许克隆 | 403 | `CLONE_DISABLED` |

## 安全检查清单

- token 明文不入库、不入日志、不出现在 SSE URL 的查询串里；
- 分享不存在与无权限统一 404；
- 撤销主动断开长连接；
- guest 身份不能访问账号级接口与模型生成；
- 访客写入与上传计入所有者配额并单独限流；
- 访问日志的 IP 只存哈希；
- 分享页三重 noindex。
