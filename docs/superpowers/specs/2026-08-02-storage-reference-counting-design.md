# 全局文件去重与引用计数设计

**日期：** 2026-08-02

## 目标

1. 相同文件内容无论由哪个用户上传，物理存储只保留一份；
2. 每个用户的云空间仍按其逻辑文件引用独立计费，不受物理去重影响；
3. 现有 `server:<fileId>`、文件直链、画布、任务、Agent 引用全部保持兼容；
4. 只有最后一个用户引用删除后，物理对象才进入回收流程；
5. 从现有 SQLite、MySQL、PostgreSQL 数据库升级时不丢数据库记录、不改文件 ID、不移动现有本地/S3 对象；
6. 迁移和回收过程可重复执行，服务异常退出后能够自动恢复。

## 方案选择

### 采用 `PhysicalBlob + StoredFile` 双层模型

推荐且采用：新增 `file_blobs` 存全局物理对象，现有 `files` 继续作为用户逻辑引用。

不采用以下方案：

- **直接给现有文件行加 refCount：** 仍无法同时表达多个用户各自的稳定 fileId 和一个全局物理对象；
- **把所有相同内容改成同一个 fileId：** 会跨用户泄漏归属，并要求重写所有画布、任务和 Agent 历史；
- **删除时动态统计 files 数量而不存 refCount：** 删除与并发上传之间需要方言相关的锁语义，跨三种数据库难以保证一致。

## 数据模型

### `file_blobs`

```ts
@Entity("file_blobs")
class PhysicalBlob {
    @PrimaryColumn({ type: "varchar", length: 64 }) checksum: string;
    bytes: string;
    kind: FileKind;
    mimeType: string;
    width: number;
    height: number;
    durationMs: number;
    storage: FileStorage;
    path: string;
    refCount: number;
    state: "active" | "pending_delete";
    pendingSince: string;
    createdAt: string;
}
```

- `checksum` 是 SHA-256 十六进制值，也是全局唯一物理身份；
- `path` 必须保留迁移时选中的历史对象 key，不能按 checksum 重算；
- `storage` 决定应使用 local 还是 S3 读取，不能依赖当前全局驱动；
- `refCount` 只统计 `files` 逻辑引用行数；
- `pending_delete` 提供回收宽限期和崩溃重试点。

### `files`

保留现有全部列和 `id` 主键。它继续表示“某用户拥有的逻辑文件”：

- `id` 不变，因而 `server:<fileId>` 和现有直链不变；
- `userId + checksum` 表示该用户对物理 blob 的逻辑引用；
- `bytes/kind/mimeType/尺寸` 冗余保留，配额和后台列表不需要改变语义；
- `storage/path` 在本版本保留，用于旧版本回滚和迁移观察，不主动清空；新代码实际读取优先使用 blob。

本批不强制建立 `(userId, checksum)` 唯一索引。原因是存量可能已有同用户重复记录，而这些不同 `fileId` 可能已写入画布或历史记录，强行合并会破坏稳定链接。新上传通过用户级串行锁和事务避免继续产生重复；迁移保守保留存量行。

## 迁移

### 启动顺序

```text
initDatabase()                  // synchronize 只负责建出 file_blobs
migratePhysicalBlobs()          // 阻塞、幂等、服务尚未 listen
reconcileBlobRefCounts()        // 按 files 绝对重算计数
startBlobGarbageCollector()
其余初始化与 listen
```

迁移必须在监听端口前完成，避免迁移期间仍有旧语义上传。

### 幂等迁移步骤

1. 读取全部 `files`，按 `(createdAt, id)` 稳定排序；
2. 对 checksum 为空的行，从该行自己的 `storage/path` 读取对象并重算 SHA-256；对象不可读时保留原行、记录明确错误并中止启动，绝不静默跳过或删除；
3. 按 checksum 分组；
4. 每组选择最早且可读的一行作为物理对象来源，原样复制其 metadata、storage 和 path 到 `file_blobs`；
5. 已存在的 blob 不覆盖 path，只补齐缺失字段；
6. `refCount` 按 `files WHERE checksum=?` 的实际行数绝对赋值，而不是累加；
7. 迁移完成后再次校验：每个非空 checksum 文件行都存在对应 blob，blob.refCount 等于引用行数；任一不一致则启动失败。

迁移不执行以下破坏性动作：

- 不删除任何 `files` 行；
- 不改已有 `files.id`；
- 不重写画布或任务 JSON；
- 不立即删除同 checksum 的落选历史物理对象；
- 不移动 local/S3 对象。

因此回滚旧镜像时，旧代码仍可读取原来的 `files.path`。

## 上传流程

1. 计算 checksum；
2. 若该用户已有相同 checksum 的逻辑文件，直接返回原 fileId，配额不增加；
3. 检查用户逻辑配额，按完整 blob.bytes 计费；
4. 按 checksum 进入进程内串行段，重新检查用户引用与 blob；
5. blob 已存在：不上传对象；若是 `pending_delete`，原子恢复为 `active`；
6. blob 不存在：先写物理对象，再插入 `file_blobs`；唯一主键冲突表示另一请求抢先完成，使用胜出 blob，并把本请求多写的物理 key 记入延迟孤儿回收；
7. 数据库事务内插入 `files`，并执行 `refCount = refCount + 1`；
8. 事务失败不删除已存在 blob；无引用对象由 GC 恢复。

进程内锁符合当前单服务实例部署约束；数据库 checksum 主键仍保护跨请求 blob 唯一性。

## 删除与 GC

### 删除逻辑引用

单事务执行：

1. 校验 `file.id + userId`；
2. 删除 `files` 行；
3. 对对应 blob 原子执行 `refCount = refCount - 1 WHERE refCount > 0`；
4. refCount 归零时标记 `pending_delete` 并记录 `pendingSince`。

事务提交后不立即删除对象，避免数据库仍有引用但物理对象已先消失。

### 垃圾回收

- 默认宽限 15 分钟；
- 每分钟扫描 `pending_delete`；
- 删除前再次对账实际 `files` 数量：大于 0 则恢复 active 和正确 refCount；
- 确认 0 引用后按 blob.storage 删除对应对象，再用 `checksum + state + refCount=0` 条件删除 blob 行；
- 对象删除成功而进程在删 DB 前退出，下轮 DeleteObject 仍幂等；
- 对象删除失败则保留 pending 行，下轮重试。

迁移产生的“落选历史物理对象”本批只统计和记录，不自动删除，避免首次上线不可逆损失。后续在生产观察确认后再增加保守孤儿清理。

## 驱动兼容

`storage.ts` 的对象操作增加显式 driver 参数：

```ts
getObject(path, options, storage)
putObject(path, body, mimeType, storage)
deleteObject(path, storage)
```

未传时仍使用当前配置；读取历史 blob 时必须传 `blob.storage`。这修复切换 local/S3 后旧文件无法读取的问题。

## 引用与配额语义

- 用户已拥有同 checksum 文件：重复上传不增加逻辑占用；
- 不同用户拥有同 checksum 文件：每个用户都按完整 bytes 计入自己的配额；
- 后台用户文件列表仍列 `files` 逻辑引用；
- 物理磁盘占用可在后续管理页单独展示，不混入用户云空间数值。

`releaseFiles` 继续负责“该用户的 fileId 是否还被业务数据引用”，但补齐扫描来源：

- 未删除 Project；
- 未删除 UserAsset；
- Job 的 inputFileIds 与 outputFileIds；
- AgentMessage 的 attachments、references.storageKey，以及内容中的 `server:file-*`。

只有确认该用户所有业务引用都不存在后才删除其 `files` 逻辑引用。物理 blob 是否删除由全局 refCount 决定。

## 故障与一致性

- 上传对象成功、DB 事务失败：留下无引用 blob/对象，GC 在宽限后回收；
- 删除事务成功、标记后崩溃：GC 下次继续；
- refCount 漂移：每次启动执行绝对对账，GC 删除前再对账；
- 迁移中断：已插入 blob 保留；下次启动按 checksum 幂等继续；
- 迁移遇到不可读历史对象：中止启动并输出 fileId/storage/path，禁止以“跳过”伪装成功；
- S3/local 驱动切换：按每个 blob 自己的 storage 读取，不把当前配置错误应用到历史对象。

## 测试

1. 迁移旧 SQLite：旧 fileId、直链、配额保持不变；重复启动幂等；
2. 构造跨用户同 checksum 历史行：迁移后只一个 blob、refCount 正确、两个旧 fileId 都能读取；
3. 用户 A/B 上传同内容：fileId 不同、物理 path 相同、各自 usedBytes 都增加完整 bytes；
4. A 删除：B 仍可读；B 删除：blob 进入 pending；运行 GC 后物理对象删除；
5. 同用户重复上传：返回同 fileId、usedBytes 不变；
6. 8 个并发同内容上传：全局只有一个 blob，单用户只有一个新逻辑引用；
7. 删除和另一用户上传并发：最终引用可读，blob 不被 GC 误删；
8. local 历史 blob 在当前 S3 配置下仍按 local 读取；反向同理；
9. releaseFiles 不会删除仍由 Job 或 AgentMessage 引用的文件；
10. MySQL/PostgreSQL 至少通过 schema/typecheck 和方言 SQL 审查；若 CI 提供 DSN，则运行同一迁移集成脚本。

## 明确不在本批范围

- 重写历史 JSON 合并重复 fileId；
- 立即清理迁移产生的旧重复物理对象；
- 多实例分布式锁；
- 面向用户展示物理去重节省量；
- 分享画布保存到自己账号时的引用复制（由下一批分享功能调用本批 `cloneFileReference` API）。
