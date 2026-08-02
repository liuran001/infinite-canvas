# 全局文件去重与引用计数实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将物理文件与用户逻辑引用拆分，在保留全部现有 fileId 和生产数据的前提下，实现跨用户 SHA-256 去重、独立逻辑配额和最后引用回收。

**架构：** 新增 `PhysicalBlob` 作为全局物理对象，以 checksum 为主键；现有 `StoredFile` 保持用户引用和对外稳定 ID。启动时在 listen 前运行幂等回填/对账，上传与删除用短事务维护 refCount，物理删除由宽限期 GC 完成。

**技术栈：** Node.js 20、TypeScript、TypeORM 0.3、SQLite/MySQL/PostgreSQL、本地文件系统、AWS S3 SDK、Bash smoke。

---

## 文件结构

### 新建

- `server/src/services/file-migration.ts`：启动期幂等回填、校验与 refCount 对账。
- `server/src/services/blob-gc.ts`：pending blob 宽限期回收和重试。
- `server/verify-file-migration.ts`：构造旧 schema SQLite 数据并验证升级、幂等与 fileId 保留。

### 修改

- `server/src/db/entities.ts`：增加 `PhysicalBlob`，保留 `StoredFile` 结构。
- `server/src/index.ts`：数据库初始化后、监听前执行迁移并启动 GC。
- `server/src/services/storage.ts`：对象操作支持显式 local/S3 driver。
- `server/src/services/files.ts`：跨用户 blob 去重、逻辑引用创建、事务 refCount、按 blob 读取。
- `server/src/routes/files.ts`：内容读取使用 blob 的 storage/path。
- `server/src/services/generation.ts`：生成参考文件读取物理 blob。
- `server/src/services/cleanup.ts`：补齐 Job 和 AgentMessage 引用来源。
- `server/src/services/review.ts`：后台文件列表继续按逻辑引用展示，必要时带物理 checksum/path。
- `server/smoke-test.sh`：跨用户去重、独立配额、最后引用回收和并发上传。
- `CHANGELOG.md`：记录存储语义变化。

---

### 任务 1：增加 PhysicalBlob 实体与旧库迁移验证

**文件：**
- 修改：`server/src/db/entities.ts:145-170,329`
- 创建：`server/src/services/file-migration.ts`
- 创建：`server/verify-file-migration.ts`
- 修改：`server/src/index.ts:12-20`

- [ ] **步骤 1：编写失败的旧库升级验证**

脚本创建临时 SQLite 数据库，只包含旧版 `files` 表，插入：用户 A/B 同 checksum、不同 id/path 的两行；同用户另一条独立文件；然后使用生产 `initDatabase()` 和 `migratePhysicalBlobs()`，断言：

```ts
assert.equal(await blobRepo.countBy({ checksum: sharedChecksum }), 1);
assert.equal((await blobRepo.findOneByOrFail({ checksum: sharedChecksum })).refCount, 2);
assert.equal(await fileRepo.count(), 3);
assert.deepEqual((await fileRepo.find({ order: { id: "ASC" } })).map(x => x.id), oldIds);
```

重复运行迁移后计数仍相同。

- [ ] **步骤 2：运行并确认失败**

运行：`cd server && npx tsx verify-file-migration.ts`

预期：`PhysicalBlob` 或 `migratePhysicalBlobs` 不存在。

- [ ] **步骤 3：定义实体**

`PhysicalBlob` 精确字段：checksum 主键 varchar64、bytes bigint、kind varchar32、mimeType varchar128、width/height/durationMs int、storage varchar16、path varchar512、refCount int、state varchar16、pendingSince varchar255、createdAt varchar255+Index。加入 `entities` 数组。

- [ ] **步骤 4：实现启动期幂等迁移**

`migratePhysicalBlobs()`：按 createdAt/id 排序读取 files；空 checksum 通过 `readStoredObject(file.storage,file.path)` 重算；按 checksum 首条创建 blob；最后对每个 blob 用实际 `files.countBy({checksum})` 绝对写 refCount。校验每个 file 都有 blob且计数相等，否则抛错阻止启动。

- [ ] **步骤 5：接入启动顺序**

`initDatabase()` 后立即 `await migratePhysicalBlobs()`，之后才运行 admin/prompt/job 初始化和 listen。

- [ ] **步骤 6：运行迁移验证与 typecheck**

```bash
cd server
npx tsx verify-file-migration.ts
npm run typecheck
```

预期：迁移首次和第二次运行都通过，旧 ID 原样保留。

---

### 任务 2：让存储驱动按每个 blob 显式选择

**文件：**
- 修改：`server/src/services/storage.ts`
- 修改：`server/src/services/files.ts`
- 修改：`server/src/routes/files.ts`
- 修改：`server/src/services/generation.ts`

- [ ] **步骤 1：提取显式 driver API**

导出：

```ts
export function putObject(path: string, body: Buffer, mimeType: string, storage: FileStorage = configuredStorage)
export function getObject(path: string, options?: RangeOptions, storage: FileStorage = configuredStorage)
export function deleteObject(path: string, storage: FileStorage = configuredStorage)
```

S3/local 分支根据参数而非模块级 `useS3` 选择；新增 `configuredFileStorage()`。

- [ ] **步骤 2：给逻辑文件解析 blob**

在 `files.ts` 导出 `physicalBlobOf(file)` 与 `storedObjectOf(file)`，有 blob 时返回 blob.storage/path，没有时回退旧 file.storage/path（仅迁移失败诊断使用）。

- [ ] **步骤 3：替换读取路径**

routes content、generation `readFileBuffer`、public URL 需要物理读取的地方都使用 `storedObjectOf()` 并向 `getObject` 传 storage。

- [ ] **步骤 4：运行现有文件 smoke 段和类型检查**

运行完整 `bash server/smoke-test.sh`，确认上传、匿名直链、Range、生成参考图仍通过；环境已有 mock 主机名 502 单独记录。

---

### 任务 3：跨用户去重上传与逻辑配额

**文件：**
- 修改：`server/src/services/files.ts:69-132`
- 修改：`server/smoke-test.sh:96-108,531-541`

- [ ] **步骤 1：写失败的跨用户 smoke**

创建第二普通用户并上传同一 tiny.png，断言：两个 fileId 不同；两个账号 storage.used 都等于完整文件 bytes；后台/调试查询 blob 数为 1（测试可通过临时只读脚本查询 SQLite，不新增公开管理接口）；两个直链都能读。

- [ ] **步骤 2：写失败的并发同用户上传 smoke**

8 个并发上传同一全新文件，断言返回 fileId 集合大小 1，用户 used 只增加一次。

- [ ] **步骤 3：实现 checksum 串行段**

模块级 `Map<string, Promise<unknown>>` 以 checksum 排队；进入后重新检查 `(userId,checksum)`。这保护当前单进程；blob checksum PK 保护物理唯一。

- [ ] **步骤 4：实现 blob 创建和逻辑引用事务**

不存在 blob 时先写对象并 insert blob(refCount 0)；主键冲突则读取胜出 blob。assertQuota 按 blob.bytes。事务内 insert StoredFile（新 fileId、用户独立）并执行原子 `refCount = refCount + 1`。同用户竞态失败后回查并返回已有行。

- [ ] **步骤 5：验证跨用户、并发和配额**

运行：`bash server/smoke-test.sh` 与 `npm --prefix server run typecheck`。

---

### 任务 4：引用删除与延迟 GC

**文件：**
- 创建：`server/src/services/blob-gc.ts`
- 修改：`server/src/services/files.ts`
- 修改：`server/src/index.ts`
- 修改：`server/smoke-test.sh`

- [ ] **步骤 1：写失败的最后引用测试**

A/B 同内容：删除 A 后 B 内容 200；删除 B 后 blob 为 pending；测试调用 `collectPendingBlobs({graceMs:0})` 后旧物理路径不存在、blob 行不存在。

- [ ] **步骤 2：实现事务删除**

transaction 内按 id+userId 删除 StoredFile，并使用 SQL expression/QueryBuilder 原子 refCount-1；计数归零标记 pending_delete/pendingSince。删除操作幂等。

- [ ] **步骤 3：实现 GC**

`collectPendingBlobs` 对每行先 count files checksum：有引用则恢复 active/refCount；无引用则按 blob.storage `deleteObject`，成功后条件删除 blob。每分钟调度，timer.unref()；启动时先执行一次处理过期项。

- [ ] **步骤 4：处理上传与 pending 并发**

上传命中 pending blob 时事务前恢复 active、事务内增加 refCount；GC 删除前再次对账。测试让删除和 B 上传交错，最终 B 可读。

- [ ] **步骤 5：运行 smoke/typecheck/build**

```bash
bash server/smoke-test.sh
npm --prefix server run typecheck
npm --prefix server run build
```

---

### 任务 5：补齐业务引用扫描与后台兼容

**文件：**
- 修改：`server/src/services/cleanup.ts`
- 修改：`server/src/services/review.ts`
- 修改：`server/smoke-test.sh`

- [ ] **步骤 1：增加 Job/Agent 引用回归**

构造只由 Job.outputFileIds 引用的文件和只由 AgentMessage.attachments/references 引用的文件，删除包含相同文件的画布/素材后，文件仍应存在。

- [ ] **步骤 2：扩展 kept 集合**

`releaseFiles` 除 Project/UserAsset 文本外，收集该用户所有 Job input/output IDs、AgentMessage attachments、references 中 `storageKey` 和 content 正则引用。批量查询并使用 Set，避免逐行 DB 请求。

- [ ] **步骤 3：保持后台文件列表语义**

`listReviewFiles` 继续按 StoredFile userId/kind 分页；`loadFiles` 仍按逻辑 fileId 返回，不暴露其他用户。可增加 checksum，但不返回 blob.path/storage 给普通用户。

- [ ] **步骤 4：运行完整 smoke**

预期新增引用保护断言通过，原有文件回收断言继续通过。

---

### 任务 6：完整迁移复核、审查、提交推送

**文件：**
- 修改：`CHANGELOG.md`
- 测试：上述全部文件

- [ ] **步骤 1：更新 CHANGELOG**

记录跨用户物理去重、逻辑配额独立、最后引用回收、旧数据自动迁移且 fileId 不变。

- [ ] **步骤 2：运行全量验证**

```bash
cd server && npx tsx verify-file-migration.ts
npm --prefix server run typecheck
npm --prefix server run build
bash server/smoke-test.sh
npm --prefix web run typecheck
npm --prefix web run build
```

预期除已知环境 `mock 图床可按主机名访问` 502 外无失败；存储新增断言全部通过。

- [ ] **步骤 3：迁移静态三方言复核**

审查所有 QueryBuilder/DDL 不依赖 SQLite 专属语法；migration 使用 repository API 和通用事务。若环境有 MYSQL/POSTGRES DSN 则分别运行 verify；没有则明确报告未实跑。

- [ ] **步骤 4：扫描密钥、占位和 diff**

```bash
git diff --check
rg -n 'TODO|FIXME|test\.(skip|only)|describe\.(skip|only)|it\.(skip|only)' server/src server/verify-file-migration.ts
```

- [ ] **步骤 5：独立代码与安全审查**

重点：跨用户路径泄漏、checksum 竞态、refCount 漂移、先删对象后删 DB、GC 与上传竞争、迁移覆盖历史 path、空 checksum、S3/local 驱动选择、用户配额是否错误按物理占用计算。

- [ ] **步骤 6：修复确认问题并重跑受影响测试及全量验证**

任何 Critical/Important 必须先加回归再修。

- [ ] **步骤 7：提交并推送**

```bash
git add server/src server/smoke-test.sh server/verify-file-migration.ts CHANGELOG.md docs/superpowers
git commit -m "feat(storage): deduplicate physical files across users"
git push origin HEAD:main
```

---

## 自检

- 覆盖全局物理去重、用户逻辑配额、最后引用删除、稳定 fileId、幂等迁移、崩溃恢复、驱动切换和业务引用扫描。
- 不重写历史 JSON，不删除迁移落选物理对象，不引入多实例锁或分享逻辑。
- `StoredFile` 始终指用户引用，`PhysicalBlob` 始终指物理对象，职责不混用。
