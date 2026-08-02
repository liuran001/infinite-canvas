# 实时协作层实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在保持整份画布 JSON 存储的前提下，实现同账号多端实时同步、原子并发保护、断线恢复，以及节点 Presence 高亮与操作者标识。

**架构：** 服务端使用严格 revision CAS 仲裁每次保存，以画布级 `EventEmitter` 向单条 SSE 广播版本和 Presence；客户端使用串行保存队列、三方合并和防回声闸门收敛数据。Presence 通过节流 POST 上行、SSE 下行，纯内存且不进入项目 JSON。

**技术栈：** Node.js 20、Express 5、TypeORM、React 19、Zustand 5、TypeScript、SSE、Bash smoke、Playwright。

---

## 文件结构

### 新建

- `server/src/services/project-access.ts`：项目 owner 访问解析边界，为后续分享权限保留唯一扩展点。
- `server/src/services/project-realtime.ts`：画布事件总线、Presence 内存态、TTL、颜色和订阅 API。
- `web/src/services/project-merge.ts`：可独立验证的画布三方合并与悬空连接清理。
- `web/src/services/project-realtime.ts`：画布 SSE 生命周期、退避重连、Presence 上报和事件分发。
- `web/src/stores/use-project-presence-store.ts`：当前画布的远端 Presence 与连接状态。
- `web/verify-realtime.mjs`：双浏览器 context 的多端同步与 Presence 端到端验证。

### 修改

- `server/src/lib/errors.ts`：业务错误增加 HTTP status、稳定错误码和可选 data。
- `server/src/lib/response.ts`：统一错误响应保留 `{code,msg,data}` 并使用正确 HTTP status。
- `server/src/services/sync.ts`：严格 CAS、结构化 409、Agent CAS 重试、成功/删除广播。
- `server/src/routes/sync.ts`：校验 `revision/clientId`，新增 realtime/presence 路由。
- `server/smoke-test.sh`：CAS 并发、越权、SSE、断线补齐、Presence 测试。
- `web/src/services/api/server.ts`：结构化 `ServerApiError`、实时事件类型、项目实时流和 Presence API。
- `web/src/services/remote-sync.ts`：项目级串行保存、dirty 补发、base snapshot、409 三方合并、防回声入口。
- `web/src/stores/canvas/use-canvas-store.ts`：远端应用闸门与项目确认版本更新 API。
- `web/src/pages/canvas/project.tsx`：绑定实时客户端、远端快照灌入 React state、Presence 上报。
- `web/src/components/canvas/canvas-node.tsx`：远端操作者描边和昵称标签。
- `web/ui-check.mjs`：单端 UI 的 Presence 渲染无报错检查。
- `CHANGELOG.md`：记录实时同步与协作 Presence。

---

### 任务 1：结构化业务错误与严格 CAS

**文件：**
- 修改：`server/src/lib/errors.ts`
- 修改：`server/src/lib/response.ts`
- 修改：`server/src/services/sync.ts:8-117`
- 修改：`server/src/routes/sync.ts:10-29`
- 测试：`server/smoke-test.sh:109-119`

- [ ] **步骤 1：先把严格版本行为写成失败的 smoke 断言**

在“画布项目同步”段用 `revision:0` 创建项目，并加入：缺 revision 返回 400、旧/未来 revision 返回 409 和 `REVISION_CONFLICT`、冲突响应含当前 revision/data、两次同 revision 并发写恰好一次成功、删除后迟到 PUT 不复活。

```bash
CREATE=$(curl -s -w '\n%{http_code}' -X PUT "$BASE/v1/projects/p1" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"我的画布","data":{"nodes":[1,2,3]},"revision":0,"clientId":"smoke-a"}')
check "首次保存 revision 为 1" "$(printf '%s' "$CREATE" | head -n1 | jq -r .data.revision)" "1"
check "缺 revision 被拒绝" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"clientId":"smoke-a"}')" "400"
CONFLICT=$(curl -s -X PUT "$BASE/v1/projects/p1" -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d '{"title":"x","data":{},"revision":0,"clientId":"smoke-b"}')
check "冲突有稳定错误码" "$(echo "$CONFLICT" | jq -r .code)" "REVISION_CONFLICT"
check "冲突带当前快照" "$(echo "$CONFLICT" | jq -r .data.revision)" "1"
```

并发请求分别写入文件，等待后统计 HTTP 200/409：

```bash
for suffix in a b; do
  curl -s -o "$WORK/cas-$suffix.json" -w '%{http_code}' -X PUT "$BASE/v1/projects/p1" \
    -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"title\":\"$suffix\",\"data\":{\"winner\":\"$suffix\"},\"revision\":1,\"clientId\":\"smoke-$suffix\"}" >"$WORK/cas-$suffix.status" &
done
wait
check "并发 CAS 恰好一个成功" "$(grep -h '^200$' "$WORK"/cas-*.status | wc -l | tr -d ' ')" "1"
check "并发 CAS 恰好一个冲突" "$(grep -h '^409$' "$WORK"/cas-*.status | wc -l | tr -d ' ')" "1"
```

- [ ] **步骤 2：运行 smoke 并确认新断言失败**

运行：`bash server/smoke-test.sh`

预期：首次创建因旧接口虽可成功，但缺 revision 仍返回 200、错误码仍为数字、并发可能两个都成功，因此至少三项 FAIL。

- [ ] **步骤 3：实现可携带协议字段的 `SafeError`**

在 `server/src/lib/errors.ts` 定义：

```ts
export class SafeError extends Error {
    readonly safe = true;
    constructor(message: string, readonly status = 400, readonly code: string | number = 1, readonly data: unknown = null) {
        super(message);
    }
}

export function fail(message: string, status = 400, code: string | number = 1, data: unknown = null) {
    return new SafeError(message, status, code, data);
}
```

保留 `safeMessage()` 供日志与旧调用使用。

- [ ] **步骤 4：让统一响应层保留 status/code/data**

在 `server/src/lib/response.ts` 增加：

```ts
export function errorResponse(res: Response, error: unknown) {
    if (error instanceof SafeError) return res.status(error.status).json({ code: error.code, data: error.data, msg: error.message });
    console.error("request failed:", error);
    return res.status(500).json({ code: 1, data: null, msg: "操作失败" });
}
```

`handle()` 与 `errorJson()` 改为调用它；`failResponse()` 继续服务鉴权旧路径。

- [ ] **步骤 5：实现严格 CAS**

`ProjectInput` 改为：

```ts
export type ProjectInput = { id: string; title: string; data: unknown; revision: number; clientId: string };
```

创建路径只接受 `revision === 0`，使用 `insert()`；已有路径使用：

```ts
const updatedAt = now();
const result = await projects.update(
    { userId, projectId: id, revision: input.revision, deleted: false },
    { title: input.title || saved.title, data: JSON.stringify(input.data ?? {}), revision: input.revision + 1, updatedAt },
);
if (result.affected !== 1) {
    const current = await projects.findOneBy({ userId, projectId: id });
    if (!current || current.deleted) throw fail("画布项目不存在", 404);
    throw fail("画布项目在其他设备上已更新，请先同步", 409, "REVISION_CONFLICT", toProjectView(current));
}
```

并发创建用 `insert()` 唯一键冲突后转成 `REVISION_CONFLICT`，不使用 `save()` 覆盖。

- [ ] **步骤 6：路由强制校验 revision/clientId**

```ts
const revision = Number(body.revision);
if (!Number.isInteger(revision) || revision < 0) throw fail("缺少有效的画布版本", 400, "INVALID_REVISION");
const clientId = String(body.clientId || "").trim();
if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw fail("缺少有效的客户端标识", 400, "INVALID_CLIENT_ID");
```

传入 `saveProject()`。

- [ ] **步骤 7：运行 smoke 与类型检查**

运行：

```bash
bash server/smoke-test.sh
cd server && npm run typecheck
```

预期：新增 CAS 断言全通过；现有 smoke 若有未传 revision 的旧调用，逐一改为创建传 0、更新传当前 revision；类型检查 0 错误。

---

### 任务 2：项目访问边界、实时总线与 Presence

**文件：**
- 创建：`server/src/services/project-access.ts`
- 创建：`server/src/services/project-realtime.ts`
- 修改：`server/src/services/sync.ts`
- 修改：`server/src/routes/sync.ts`
- 测试：`server/smoke-test.sh`

- [ ] **步骤 1：写失败的越权、SSE 和 Presence smoke**

覆盖：owner 建流收到 `ready`；保存后收到 `project.saved` 和 `writerClientId`；落后 revision 建流会补保存事件；另一个用户读/写/订阅/Presence 均 404；两个 client Presence 同时存在；DELETE Presence 后列表减少。

用受控超时读取 SSE，避免脚本挂死：

```bash
timeout 4 curl -sN "$BASE/v1/projects/p1/realtime?clientId=smoke-viewer&sinceRevision=0" \
  -H "Authorization: Bearer $USER_TOKEN" >"$WORK/project-stream.txt" &
STREAM_PID=$!
sleep 1
curl -s -X POST "$BASE/v1/projects/p1/presence" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"clientId":"smoke-viewer","nodeIds":["n1"],"activity":"editing"}' >/dev/null
# 使用当前 revision 保存一次，随后等待 timeout 收束
wait "$STREAM_PID" || true
check "项目流收到 ready" "$(grep -c '"type":"ready"' "$WORK/project-stream.txt")" "1"
check "项目流收到 Presence" "$([ "$(grep -c '"type":"presence.sync"' "$WORK/project-stream.txt")" -ge 1 ] && echo yes || echo no)" "yes"
```

- [ ] **步骤 2：运行 smoke 确认路由不存在**

运行：`bash server/smoke-test.sh`

预期：realtime/presence 断言 FAIL，返回“接口不存在”。

- [ ] **步骤 3：实现唯一项目授权入口**

`server/src/services/project-access.ts`：

```ts
export type ProjectPermission = "read" | "write";
export type ProjectActor = { id: string; displayName: string; avatarUrl: string };

export async function resolveProjectAccess(actor: ProjectActor, projectId: string, _permission: ProjectPermission) {
    const project = await repo(Project).findOneBy({ userId: actor.id, projectId });
    if (!project || project.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    return { ownerId: project.userId, project, permission: "owner" as const };
}
```

所有单项目读写和实时路由统一使用该函数；列表仍按 owner 查询。

- [ ] **步骤 4：实现内存实时总线**

`server/src/services/project-realtime.ts` 导出：

```ts
export type ProjectActivity = "idle" | "selecting" | "editing";
export type ProjectPresence = { clientId: string; principalId: string; displayName: string; avatarUrl: string; color: string; nodeIds: string[]; activity: ProjectActivity; updatedAt: string };
export type ProjectRealtimeEvent =
    | { type: "project.saved"; projectId: string; revision: number; writerClientId: string }
    | { type: "project.deleted"; projectId: string; revision: number; writerClientId: string }
    | { type: "presence.sync"; projectId: string; members: ProjectPresence[] };

export function subscribeProject(ownerId: string, projectId: string, listener: (event: ProjectRealtimeEvent) => void): () => void;
export function publishProjectSaved(ownerId: string, projectId: string, revision: number, writerClientId: string): void;
export function publishProjectDeleted(ownerId: string, projectId: string, revision: number, writerClientId: string): void;
export function updateProjectPresence(ownerId: string, projectId: string, actor: ProjectActor, input: { clientId: string; nodeIds: string[]; activity: ProjectActivity }): ProjectPresence[];
export function removeProjectPresence(ownerId: string, projectId: string, clientId: string): ProjectPresence[];
export function listProjectPresence(ownerId: string, projectId: string): ProjectPresence[];
```

Map key 为 `${ownerId}:${projectId}`；每 15 秒清理 `updatedAt` 超过 45 秒的项并广播全量 `presence.sync`。`nodeIds` 去重后截到 50 项。

- [ ] **步骤 5：成功 CAS 和删除后发布事件**

`saveProject()` 成功读取结果后调用 `publishProjectSaved(userId,id,row.revision,input.clientId)`。`deleteProject()` 接收 `clientId`，使用条件更新软删后调用 `publishProjectDeleted()`；路由 DELETE 从 `X-Client-Id` 请求头读取并验证。

- [ ] **步骤 6：实现 SSE 路由**

路由顺序放在普通 `/:id` 前或使用更具体路径。先 `subscribeProject()`，再读取 access/project；缓冲读取期间的事件，按 revision 去重后写出：

```ts
const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
if (access.project.revision > sinceRevision) write({ type: "project.saved", projectId, revision: access.project.revision, writerClientId: "" });
write({ type: "ready", revision: access.project.revision, members: listProjectPresence(access.ownerId, projectId) });
```

设置 SSE headers 与 25 秒 keep-alive，close 时清 timer、unsubscribe、移除本 client Presence。

- [ ] **步骤 7：实现 Presence POST/DELETE**

严格验证 `clientId`、`activity`、`nodeIds` 字符串数组。actor 的昵称头像取 `requireUser(req)`，不从 body 读取。POST 返回最新 members；DELETE 只允许删除当前连接提供的 clientId（clientId 是端身份，不是用户身份，但项目 access 必须已通过）。

- [ ] **步骤 8：运行 smoke 与类型检查**

运行：

```bash
bash server/smoke-test.sh
cd server && npm run typecheck
```

预期：SSE、Presence、越权断言通过，listener 在连接关闭后被清理，进程能正常退出。

---

### 任务 3：Agent 画布写入 CAS 重试

**文件：**
- 修改：`server/src/services/sync.ts:83-117`
- 测试：`server/smoke-test.sh` 的 Agent 画布段

- [ ] **步骤 1：增加 Agent 与用户并发写测试**

在 mock Agent 调用 `create_node` 的执行窗口中，以读取到的 revision 修改另一节点；最终断言用户节点与 Agent 节点同时存在、revision 连续增长，不能只检查任一方。

- [ ] **步骤 2：运行 smoke 观察当前静默覆盖或冲突失败**

运行：`bash server/smoke-test.sh`

预期：并发窗口命中时最终节点数或指定节点断言 FAIL。

- [ ] **步骤 3：抽出条件更新 helper**

```ts
async function updateExistingProject(userId: string, saved: Project, patch: Pick<Project, "title" | "data">) {
    const updatedAt = now();
    const result = await repo(Project).update(
        { userId, projectId: saved.projectId, revision: saved.revision, deleted: false },
        { ...patch, revision: saved.revision + 1, updatedAt },
    );
    return result.affected === 1 ? saved.revision + 1 : null;
}
```

- [ ] **步骤 4：Agent 更新与重命名最多重试三次**

每轮重新读取项目、重新执行 mutate，再 CAS；冲突继续下一轮，三次失败抛 `PROJECT_BUSY`。注意 `mutate` 可能修改传入对象，必须每轮从最新 JSON 重新构造，不复用旧对象。成功后广播 `writerClientId: "agent"`。

- [ ] **步骤 5：运行 smoke 与类型检查**

运行：`bash server/smoke-test.sh && (cd server && npm run typecheck)`

预期：并发测试稳定通过，既有 Agent 71 项相关行为不回归。

---

### 任务 4：前端 API 错误类型与画布三方合并

**文件：**
- 创建：`web/src/services/project-merge.ts`
- 创建：`web/verify-project-merge.mjs`
- 修改：`web/src/services/api/server.ts:65-118,177-180,204-261`

- [ ] **步骤 1：写独立的失败验证脚本**

`verify-project-merge.mjs` 通过 `tsx` 导入合并函数，覆盖：不同节点同时修改都保留；同节点本地字段优先；本地删除 vs 远端修改以删除为准；删除节点后清除 from/to 悬空连接；viewport 使用 local。脚本失败时 `process.exit(1)`。

- [ ] **步骤 2：运行并确认模块不存在**

运行：`cd web && npx tsx verify-project-merge.mjs`

预期：ERR_MODULE_NOT_FOUND。

- [ ] **步骤 3：实现结构化 `ServerApiError`**

```ts
export class ServerApiError<T = unknown> extends Error {
    constructor(message: string, readonly status: number, readonly code: string | number, readonly data: T | null) {
        super(message);
    }
}
```

`readEnvelope` 对非成功 envelope 抛此类型；401 仍执行清 session。`saveProject` body 改为 `{title,data,revision:number,clientId:string}`；DELETE 带 `X-Client-Id`。

新增事件和 API：

```ts
export type ServerProjectPresence = { clientId: string; principalId: string; displayName: string; avatarUrl: string; color: string; nodeIds: string[]; activity: "idle"|"selecting"|"editing"; updatedAt: string };
export type ServerProjectEvent =
  | { type:"project.saved"; projectId:string; revision:number; writerClientId:string }
  | { type:"project.deleted"; projectId:string; revision:number; writerClientId:string }
  | { type:"presence.sync"; projectId:string; members:ServerProjectPresence[] }
  | { type:"ready"; revision:number; members:ServerProjectPresence[] };
```

实现 `serverProjectStream()`、`updateProjectPresence()`、`removeProjectPresence()`。

- [ ] **步骤 4：实现三方合并**

`mergeProjectSnapshots(base, local, remote)` 先按 ID 对 nodes/connections 做三方选择，再清理引用不存在节点的 connection；顶层 `chatSessions/activeChatId/backgroundMode/showImageInfo/title` 用同样“单方修改保留、双方修改 local 优先”规则；`viewport` 总是 local；返回 remote 的 revision 和以本地当前时间更新的 `updatedAt`。

比较使用稳定深比较函数：对象 key 排序后 JSON stringify；不要依赖对象引用。

- [ ] **步骤 5：运行合并验证与 typecheck**

运行：

```bash
cd web
npx tsx verify-project-merge.mjs
npm run typecheck
```

预期：所有合并用例通过，类型检查 0 错误。

---

### 任务 5：项目保存队列、防回声与冲突恢复

**文件：**
- 修改：`web/src/services/remote-sync.ts`
- 修改：`web/src/stores/canvas/use-canvas-store.ts`
- 测试：`web/verify-project-merge.mjs`（增加队列可观测 helper 的断言）

- [ ] **步骤 1：添加失败的队列行为验证**

把保存调度核心设计为可注入的 `ProjectSaveCoordinator`，验证：同 project 只有一个在途；在途修改置 dirty，响应后补发；自己成功只更新 revision 不覆盖新本地 data；409 使用 `error.data` 三方合并并最多重试三次；远端应用期间不 schedule push。

- [ ] **步骤 2：运行验证确认导出不存在**

运行：`cd web && npx tsx verify-project-merge.mjs`

预期：缺少 `ProjectSaveCoordinator` 导出而失败。

- [ ] **步骤 3：在 canvas store 增加远端应用闸门**

模块级 `applyingRemoteProjects = new Set<string>()`，导出：

```ts
export function applyRemoteProject(project: CanvasProject) {
    applyingRemoteProjects.add(project.id);
    useCanvasStore.setState(/* replace or prepend */);
    queueMicrotask(() => applyingRemoteProjects.delete(project.id));
}
export function isApplyingRemoteProject(id: string) { return applyingRemoteProjects.has(id); }
```

`updateProject/renameProject` 在闸门开启时只更新本地，不调用 push；`replaceProjects` 的全量同步不误触发 push。

- [ ] **步骤 4：实现每项目串行 coordinator**

维护：

```ts
type ProjectSaveState = { inflight: boolean; dirty: boolean; retries: number; base: CanvasProject | null };
const projectSaves = new Map<string, ProjectSaveState>();
```

防抖到期调用 coordinator；在途则 `dirty=true`；成功保存后记录 confirmed snapshot/revision，如果 dirty 立即再跑；409 从 `ServerApiError<ServerProject>.data` 取 remote，调用三方合并并以 remote revision 重试；三次仍冲突设置 `syncState: failed`。

新项目没有 revision 时发送 `revision:0`。每个页面/标签的 clientId 由实时模块提供；列表页未打开实时流时也从共享 `getProjectClientId()` 获取。

- [ ] **步骤 5：泛化 cancel-before-apply**

导出 `cancelProjectPush(id)`；`pullProject()` 与实时远端应用都必须先 cancel。远端快照统一走 `applyRemoteProject()`，不直接 `useCanvasStore.setState()`。

- [ ] **步骤 6：运行验证、typecheck 与 build**

运行：

```bash
cd web
npx tsx verify-project-merge.mjs
npm run typecheck
npm run build
```

预期：队列断言通过，无保存回声，构建成功。

---

### 任务 6：实时客户端与 Presence store

**文件：**
- 创建：`web/src/services/project-realtime.ts`
- 创建：`web/src/stores/use-project-presence-store.ts`
- 修改：`web/src/pages/canvas/project.tsx:359-518`

- [ ] **步骤 1：定义 Presence store**

```ts
type ProjectRealtimeStatus = "idle" | "connecting" | "ready" | "reconnecting" | "failed";
type ProjectPresenceState = {
  projectId: string;
  clientId: string;
  status: ProjectRealtimeStatus;
  members: ServerProjectPresence[];
  setConnection(...): void;
  setMembers(...): void;
  clear(): void;
};
```

不使用 persist，Presence 刷新即清空。

- [ ] **步骤 2：实现 clientId 和流循环**

`getProjectClientId()` 在模块加载时 `nanoid()` 一次。`watchProject(projectId, handlers, signal)` 循环调用 `serverProjectStream(projectId,clientId,lastRevision,...)`，成功 ready 清退避；断流按 1.5s、3s、6s、12s、24s、30s 重连。AbortError 立即结束，不标失败。

- [ ] **步骤 3：实现事件收敛**

- self saved：调用 `confirmProjectRevision(id,revision)`；
- remote saved 且 revision 更新：合并并发 pull（同一 project 只有一个 Promise），调用 `pullProject()` 后交给页面 handler；
- deleted：取消保存、清 Presence、handler 导航列表；
- presence/ready：过滤当前 clientId 后写 store。

- [ ] **步骤 4：实现 Presence 上报器**

`createPresenceReporter(projectId)` 提供 `update(nodeIds,activity)` 与 `dispose()`。update 200ms trailing throttle；15 秒发送当前值心跳；dispose 清 timer 并发 DELETE（失败静默）。

- [ ] **步骤 5：接入画布页**

项目加载后启动 watch/reporter；卸载 abort + dispose。收到远端项目后 hydrate 图片/助手图片，再设置 nodes/connections/chatSessions/activeChatId/backgroundMode/showImageInfo；不覆盖 viewport；重置 undo 历史基线，避免撤销到远端之前的失效结构。

`selectedNodeIds` 变化上报 `selecting`；节点 mouse down/拖动期间上报 `editing`；结束恢复 `selecting` 或 `idle`。不要把 Presence 加进 `updateProject()` patch。

- [ ] **步骤 6：删除 cloud-agent 专用重载重复路径**

通用 project.saved 已覆盖 Agent 写画布。保留 Agent 流用于对话，但 `cloudAgentCanvasReload` effect 改为只做旧服务端兼容兜底或移除，确保同一 Agent 写入不会触发两次 pull。

- [ ] **步骤 7：运行 typecheck 和 build**

运行：`cd web && npm run typecheck && npm run build`

预期：0 错误，构建成功。

---

### 任务 7：节点远端操作者视觉展示

**文件：**
- 修改：`web/src/components/canvas/canvas-node.tsx`
- 修改：`web/src/pages/canvas/project.tsx:673,3004-3045`
- 修改：`web/ui-check.mjs`

- [ ] **步骤 1：扩展节点 props**

```ts
remoteEditors?: Array<Pick<ServerProjectPresence, "clientId" | "displayName" | "color" | "activity">>;
```

project 页把 Presence members 按 nodeId 建 `Map<string, ServerProjectPresence[]>`，传给对应 `CanvasNode`。

- [ ] **步骤 2：渲染描边和昵称**

节点最外层不破坏现有 selection border；用绝对定位 overlay：

```tsx
{remoteEditors.length ? (
  <>
    <div className="pointer-events-none absolute inset-[-3px] z-40 rounded-[inherit] border-2" style={{ borderColor: remoteEditors[0].color }} />
    <div className="pointer-events-none absolute -top-6 left-0 z-50 flex gap-1 text-[11px] text-white">
      {remoteEditors.slice(0, 2).map((editor) => <span key={editor.clientId} className="rounded px-1.5 py-0.5" style={{ backgroundColor: editor.color }}>{editor.displayName || "协作者"}</span>)}
      {remoteEditors.length > 2 ? <span className="rounded bg-slate-600 px-1.5 py-0.5">+{remoteEditors.length - 2}</span> : null}
    </div>
  </>
) : null}
```

确保透明背景节点、组节点和批量节点仍可见，overlay `pointer-events-none`。

- [ ] **步骤 3：增加 UI check**

在画布详情建流后通过 API 上报第二 client Presence，等待节点 DOM 出现操作者昵称；检查页面无 console/pageerror。测试结束 DELETE Presence。

- [ ] **步骤 4：运行 UI 类型与构建验证**

运行：`cd web && npm run typecheck && npm run build`

预期：0 错误，节点 props 完整传递。

---

### 任务 8：双端浏览器验证、全量复核与文档

**文件：**
- 创建：`web/verify-realtime.mjs`
- 修改：`CHANGELOG.md`
- 修改：`web/ui-check.mjs`（仅在验证发现不稳定时修正等待条件）

- [ ] **步骤 1：写双 context 验证脚本**

脚本接受 `UI_WEB/UI_API/UI_USER/UI_PASSWORD`；两个独立 context 注入同一账号 token，各自打开同一 project。覆盖：A 创建节点 B 自动出现；B 移动另一节点 A 不丢第一项；Presence 昵称/描边；B abort 实时请求后 A 修改，B 恢复/刷新自动补齐；并发编辑后两端 revision 与节点集合一致；监听 console/pageerror。

- [ ] **步骤 2：更新 CHANGELOG**

在 Unreleased 增加：

```markdown
+ [新增] 同一画布在多个设备或标签页打开时会实时同步；服务端用原子版本检查防止并发保存静默覆盖，断线重连后自动补齐最新版本。
+ [新增] 画布实时显示其他在线端正在操作的节点，以彩色描边和昵称标记；Presence 仅作提示，不锁定节点，也不会写入画布内容或撤销历史。
```

- [ ] **步骤 3：运行全部自动验证**

并行启动长期命令，随后执行：

```bash
bash server/smoke-test.sh
cd server && npm run typecheck && npm run build
cd web && npx tsx verify-project-merge.mjs && npm run typecheck && npm run build
```

本地服务就绪后：

```bash
cd web
node ui-check.mjs
node verify-realtime.mjs
```

预期：smoke 0 fail；server/web typecheck、build 通过；UI check 0 fail；双端验证全部通过。

- [ ] **步骤 4：扫描占位与密钥残留**

运行：

```bash
rg -n 'TODO|FIXME|test\.(skip|only)|describe\.(skip|only)|it\.(skip|only)' server/src web/src web/verify-realtime.mjs
rg -n 'KNOWN_SECRET_PREFIXES_FROM_PRIVATE_VERIFICATION' . --glob '!node_modules/**' --glob '!.git/**'
```

预期：无本次新增占位；已知真实密钥 0 命中。

- [ ] **步骤 5：独立代码审查与安全审查**

使用 `requesting-code-review`，重点检查：CAS 是否真原子；创建竞态；删除复活；SSE subscribe-before-read；listener/timer 泄漏；Presence 冒充；越权读写/订阅；409 是否会无限重试；远端应用回声；同节点冲突语义。

- [ ] **步骤 6：修复审查问题并重跑受影响测试及全量 smoke/UI**

任何确认问题都先加回归断言再修。最终重新运行步骤 3 的全部命令。

- [ ] **步骤 7：提交并推送**

先确认 `git status --short` 不包含 `.claude/` 或截图/临时数据库。按服务端、前端拆成原子提交：

```bash
git add server/src server/smoke-test.sh docs/superpowers/specs/2026-08-02-realtime-collaboration-design.md docs/superpowers/plans/2026-08-02-realtime-collaboration.md
git commit -m "feat(server): add atomic canvas collaboration stream"
git add web/src web/ui-check.mjs web/verify-project-merge.mjs web/verify-realtime.mjs CHANGELOG.md
git commit -m "feat(web): sync canvases live and show collaborators"
git push origin main
```

预期：push 成功，`git status --short --branch` 仅保留用户原有未跟踪文件，不包含本次应提交内容。

---

## 计划自检结果

- **规格覆盖：** CAS、Agent 并发、SSE 补齐、Presence 生命周期、owner 授权边界、客户端防回声、串行保存、三方合并、节点高亮、断线恢复、双端验证均有对应任务。
- **范围：** 未加入 CRDT、字符级编辑、分享/团队、Redis、多实例或节点表，符合本批边界。
- **类型一致性：** `revision` 是画布版本和流游标；`clientId` 是标签页身份；`principalId` 是用户/未来授权主体；事件名在服务端与前端保持一致。
- **失败语义：** 400 用于输入错误，404 用于不存在或无权，409 + `REVISION_CONFLICT` 携带当前快照，500 仅用于非安全异常。
- **无占位符：** 所有实现步骤都有精确接口、代码形状、命令与预期结果。
