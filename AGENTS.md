# AGENTS.md

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；本地存储结构调整时直接按新设计修改，不写旧字段兼容或数据迁移兜底，除非用户明确要求。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 后端规范

- 后端在 `server/`，使用 Node、TypeScript、Express、TypeORM，通过 `STORAGE_DRIVER` 支持 sqlite / mysql / postgres 三种数据库。
- 实体统一定义在 `server/src/db/entities.ts`，靠 TypeORM 的 `synchronize` 自动建表；项目尚未上线，直接改实体即可，不写迁移脚本。
- 接口统一返回 `{ code, data, msg }`：成功 `code: 0`，失败 `code: 1` 且 `msg` 是可直接展示的中文文案。鉴权失败额外返回 HTTP 401，前端据此清理登录态。
- 只有用 `fail()` 抛出的错误才会把文案透传给用户，其余异常一律收敛成「操作失败」并打日志，避免泄漏内部信息。
- 路由放 `server/src/routes/`，业务逻辑放 `server/src/services/`，两者不要互相塞逻辑；路由只做参数读取、鉴权与响应。
- 鉴权中间件要挂在具体路由上（`router.get(path, userAuth, handler)`），**不要用 `router.use(userAuth)` 配合 `api.use(router)` 这种无路径前缀的挂载**：Express 会让所有请求都先过该中间件，把同层挂载在它后面的公开接口（`/settings`、`/prompts`、文件直链）一并拦成 401。只有确定整个 router 都需要同一种鉴权、且挂载时带了路径前缀（如 `api.use("/admin", adminRouter)`）才可以用 `router.use()`。
- 图片、视频、音频统一走 `services/files.ts` 的文件对象，`FILE_DRIVER` 切换本地磁盘与 S3 兼容对象存储；不要在业务代码里直接读写磁盘。
- 生成任务必须带客户端下发的 `clientJobId` 幂等键，重复提交只命中已有任务；扣算力点在调用上游之前，失败路径统一返还。
- 视频类任务要把上游任务 ID 落库，服务重启后继续轮询同一个上游任务，不重新发起生成。
- 前端已归一化的生成参数（尺寸、时长、音色等）由服务端直接透传，不要在两侧各写一套归一化规则。
- 后台配置里的密钥（渠道 API Key、OAuth Secret、搜索 API Key）一律「读取时抹成空串、保存时留空表示保持不变」；由密钥推导出来的公开开关（例如 `agent.searchEnabled`）必须在补回密钥之后再计算，否则管理员每次保存都会把开关误判成未配置。
- 服务端 Agent 的推理循环跑在后台，不依赖前端连接：SSE 断开只是取消订阅，绝不能中断或取消循环；循环每走一步就要落库，前端靠 `sinceSeq` 拉增量续上。
- 会话类数据用会话内自增的 `seq` 做增量游标，不要用时间戳：同一毫秒内落多条消息时时间戳会漏数据。
- Agent 工具改画布必须走 `services/sync.ts` 的 `updateProjectCanvas`，`revision` 照常递增，前端现有的增量同步才能拉到变更；工具生成图片要复用 `services/jobs.ts` 的任务队列，不要另起一套生成、计费与配额逻辑。
- 改完后端跑 `bash server/smoke-test.sh` 自查，新增接口要同步补断言。脚本用随机端口启动服务与 mock 上游，可以并发跑；不要把端口改回固定值。
- 需要验证模型工具调用循环这类多轮交互时，扩展 `smoke-test.sh` 里已有的 mock 上游按请求路径分支返回，真的把循环跑一遍，不要只断言 HTTP 状态码。

## 前端规范

- 前端使用 Vite、React、React Router、TypeScript、Ant Design、Tailwind、Zustand。
- 编写 Ant Design 相关代码时，参考 https://ant.design/llms-full.txt 理解组件 API、示例和设计规范，并优先结合项目当前 antd 版本与既有写法。
- 外部服务请求统一放在 `web/src/services/api/`，一律经由 `server/` 后端；前端不再持有任何模型渠道地址与密钥，也不直连第三方接口。
- 前端只有服务器模式，没有本地模式。画布、素材、图片、插件、提示词都存在服务端，未登录时接口返回 401，由前端提示登录，不做路由守卫。
- 服务器连接状态放在 `web/src/stores/use-server-store.ts`，后端接口客户端放在 `web/src/services/api/server.ts`，两者是前后端公共契约，改动前先确认调用方。
- 用户偏好（默认模型、生成参数、系统提示词）放 `web/src/stores/use-config-store.ts`，只存个人偏好；模型列表、算力点成本、功能入口开关等都从服务端 `/api/settings` 读。
- 全局或跨页面状态优先放在 `web/src/stores/`。
- 已经放在全局 store 或全局 hook 中的状态/动作，组件需要时直接使用对应 store/hook，不要为了“纯组件”层层透传 props；避免一个组件传递过多参数。
- 全局组件、全局常量、全局配置等全局性质的内容不要作为 props 或参数层层传递；哪里需要就在哪里直接从对应全局入口获取。
- 多个页面重复出现的 UI 副作用动作，例如复制文本并提示、下载并提示、统一确认弹窗，优先抽成 `web/src/hooks/` 下的全局 hook；不要放进 store，除非它确实是需要共享/订阅的状态。
- 路由页面放在 `web/src/pages/`，页面布局放在 `web/src/layouts/`，路由配置放在 `web/src/router.tsx`。
- 画布页面放在 `web/src/pages/canvas/`，画布组件放在 `web/src/components/canvas/`，画布状态放在 `web/src/stores/canvas/`，画布工具函数放在 `web/src/lib/canvas/`。
- 页面按目录组织，例如 `web/src/pages/image/index.tsx`；页面里只有一个主业务组件时直接写在对应页面入口中，不要单独拆 `Manager` 组件再传一堆 props。
- 不要新增只做简单转发的组件，例如只 `return <X>{children}</X>` 或只换个名字透传 props；直接在使用处使用真实组件或把逻辑写进当前文件。
- 页面私有 hook 放在对应页面目录下，例如 `admin/assets/use-admin-assets.ts`；只有多个页面真实复用的 hook 才放到外层 `hooks/`。
- 管理后台页面私有组件放到各自页面目录的 `components/` 下，例如 `admin/assets/components/`、`admin/prompts/components/`；不要为了单页面使用放到 `admin/components/` 共享目录。
- 管理后台主题、背景、卡片阴影、表格配色等统一在 `web/src/lib/app-theme.ts`、`AppProviders` 或必要的全局 CSS 作用域中配置；页面私有组件不要自己写 `dark ? ...` 主题分支。
- 组件优先使用函数组件和现有 hooks，不新增大型状态管理方案。
- UI 图标优先使用 `lucide-react` 或项目已经使用的 Ant Design 图标。
- 页面文案保持中文。
- 不要在组件里堆太多无关逻辑；复杂逻辑优先抽成同目录工具函数或小组件。
- 样式优先由组件自己管理；组件私有样式优先使用 Tailwind className 或少量内联 style，不要为单个组件新增大量全局 CSS。
- 全局 CSS 只放基础变量、全局重置、跨页面通用样式和少量第三方组件必要覆盖；不要在 `globals.css` 堆页面私有样式。
- 代码尽量短小直接，少拆不必要组件，少做多层 props 传递，避免为了抽象堆出更多代码。
- 前端业务数据需要浏览器本地持久化时，默认使用 `localforage`；`localStorage` 只用于极小的简单配置，不要用来保存业务列表、生成记录、图片、base64 或大 JSON。

## 画布 UI 规范

- 做 canvas 前端 UI 时必须遵循当前画布主题。
- 优先使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token。
- 不要硬编码黑白、stone、slate 等颜色导致浅色/深色主题不一致。
- 新增画布按钮、弹窗、浮层时，尽量复用已有工具栏、节点面板、Modal 的视觉风格。
- 画布顶部工具栏和状态信息优先采用极简扁平风格：无边框、无阴影、无胶囊背景，融入整体背景，弱化按钮感，仅保留轻微 hover 反馈，保持简洁现代、低视觉重量。
- 左侧画布面板等列表里的节点/元素缩略图容器，非图片类型（文本、配置、视频、音频等）不要使用 `theme.node.fill`（`#e7e5df`/`#292524`）这类灰色背景，图标直接无背景展示，尽量不要给多余底色，保持干净。
- 画布内的操作按钮（如面板里的「添加」「导出」「选择」等）默认用扁平无底色样式：透明背景、仅 `hover:bg-black/5 dark:hover:bg-white/10` 轻微反馈，靠图标+文字表达，不要用 `theme.toolbar.activeBg`（`#e7e5df`/`#3a3631`）或 `theme.node.fill` 之类的灰色作为按钮填充底色。灰色 `activeBg` 只允许用于「选中态」等需要表达状态的高亮，不要当普通装饰底色。
- 图片节点尺寸逻辑要尊重原始比例，除非功能明确要求自由变形。
- 批量生成、多图展示、助手面板等画布交互要尽量简洁，不要占用过多画布空间。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- `docs/index.md` 放给 AI 使用的文档索引，不要再放到 `docs/content/docs/` 内容目录里。
- 详细功能介绍写到 `docs/content/docs/overview/features.mdx`。
- 后续待办写到 `docs/content/docs/progress/todo.mdx`。
- 已实现但还需要用户测试确认的事项写到 `docs/content/docs/progress/pending-test.mdx`。
- `docs/content/docs/progress/pending-test.mdx` 用来记录这个版本实际做了哪些可测试变更；`CHANGELOG.md` 的 `Unreleased` 只保留对这些变更的版本级归纳，避免逐条照搬实现细节。
- 每次重大改动（新增/调整/删除功能、接口或工具，影响用户可感知行为）完成后，都要在 `CHANGELOG.md` 的 `Unreleased` 追加一条记录，按 `[新增]` / `[调整]` / `[修复]` / `[优化]` 前缀分类，用一句中文归纳；纯内部重构、格式化、无用户可感知影响的小改动可不记。
- 每次 todo 事项完成后，先从 `docs/content/docs/progress/todo.mdx` 移到 `docs/content/docs/progress/pending-test.mdx`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/content/docs/overview/features.mdx`。
- 每次任务完成前，都要根据实际变更检查并更新 `docs/content/docs/progress/todo.mdx` 和 `docs/content/docs/progress/pending-test.mdx`；如果功能或待办没有变化，也要确认无需修改。
- 文档不要写过期日期；除非用户明确要求记录具体时间。

## 发版本流程

- 发版本时，先把 `CHANGELOG.md` 的 `Unreleased` 变更整理成新的版本记录，并保留空的 `Unreleased` 标题。
- 按当前版本号提升一个版本，更新根目录 `VERSION`。
- 将当前未提交的代码全部提交到 Git。
- 提交完成后，给当前提交打最新版本号对应的 tag，例如 `v0.0.5`。
- 发版本流程中不要执行编译、测试或构建，除非用户明确要求。

## 项目注意事项

- 画布项目、「我的素材」、图片与节点插件都保存在服务端，登录同一账号即可多设备同步；本地 localforage 只作为缓存，不是权威数据源。
- 模型渠道与密钥只存在服务端，由管理员在管理后台配置；接口读取时密钥会被抹成空串，保存时留空表示保持不变。
- 生成任务在服务端执行，前端提交时必须带 `clientJobId` 幂等键；客户端断网重试不会重复生成，也不会重复扣算力点。
- 用户自定义模型调用脚本、WebDAV 同步、浏览器直连提示词仓库这三项能力已经移除，不要在文档或代码里再引用。
- Docker 静态资源路径目前仍是待办项，文档中不要过度承诺生产部署已经完全验证。
- Agent 对话消息必须同时按 `threadId`、`turnId` 和 `itemId` 归属；实时事件只用于补充未物化的 turn，历史快照成为权威后不得重复合并同一条消息。
