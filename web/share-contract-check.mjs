// 分享通道的静态契约检查：确保分享态永远不会走到只认账号令牌的公共请求通道。
//
// 这类缺陷类型检查和构建都发现不了——两条通道的函数签名完全兼容，只是令牌来源不同。
// 而后端的 verify-share.ts 也测不到，因为断裂发生在纯前端的调用链里。
// 代价是真实的：分享页一旦走进公共通道拿到 401，readEnvelope 会清掉访客自己的账号会话，
// 于是"打开别人的分享链接"变成了"把自己从账号里踢出去"。
//
// 用法：node web/share-contract-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "src");
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
    if (ok) {
        console.log(`  \x1b[32mOK\x1b[0m   ${name}`);
        pass += 1;
    } else {
        console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ""}`);
        fail += 1;
    }
}

const read = (relative) => readFileSync(join(root, relative), "utf8");
const block = (source, start, end) => {
    const from = source.indexOf(start);
    const to = from < 0 ? -1 : source.indexOf(end, from);
    return from < 0 ? "" : source.slice(from, to < 0 ? undefined : to);
};

console.log("分享通道契约");

const helpers = read("lib/canvas/canvas-generation-helpers.ts");
const sharePage = read("pages/share/share-canvas.tsx");

// hydrateCanvasImages 遇到 dataURL 图片会上传，而上传只认账号令牌。
// 分享页必须显式关掉这一步，否则匿名访客打开一张含 dataURL 节点的画布就会被登出。
check("hydrateCanvasImages 支持关闭上传", /allowUpload\s*=\s*true/.test(helpers), "缺少 allowUpload 开关，分享态无法阻止上传");
check("关闭上传时 dataURL 原样保留", /!content\.startsWith\("data:image\/"\)\s*\|\|\s*!allowUpload/.test(helpers), "allowUpload 没有真正拦住上传分支");

const hydrateCalls = [...sharePage.matchAll(/hydrateCanvasImages\(([^;]*?)\)\s*(?:\.then|\))/gs)];
check("分享页确实调用了图片水合", hydrateCalls.length > 0, "没找到调用，断言失效需要更新脚本");
check(
    "分享页每次水合都关掉上传",
    hydrateCalls.every((matched) => /allowUpload:\s*false/.test(matched[1])),
    `${hydrateCalls.filter((m) => !/allowUpload:\s*false/.test(m[1])).length} 处调用没传 allowUpload: false`,
);

// 分享页只能用分享通道；一旦直接引入公共 API 通道，就等于绕开了 guest 令牌与 401 保护。
check("分享页不直接引入公共 API 通道", !/from\s+"@\/services\/api\/server"/.test(sharePage.replace(/import type[^;]+;/g, "")), "分享页不应直接调用 serverApi");
check("分享页不直接引入上传工具", !/from\s+"@\/services\/image-storage"/.test(sharePage), "上传只认账号令牌，分享页不能直接用");

const shareApi = read("services/api/share.ts");
// 分享通道自己绝不能碰账号会话，这是它存在的理由。
check("分享通道不清除账号会话", !/clearSession\(\)/.test(shareApi), "分享请求失败不得清掉用户的登录态");
check("分享通道不弹登录框", !/setLoginOpen\(/.test(shareApi), "分享链接失效不该表现为账号掉线");

const shareSync = read("services/share-sync.ts");
// 链接被降级成只读后，前端要立刻收权，否则访客会一直编辑而改动全部存不上。
check("保存被拒时识别只读", /isShareReadOnly\(error\)/.test(shareSync), "403 只读没有单独处理，访客会持续编辑并丢改动");
check("识别只读后切换角色", /(?:setRole\("viewer"\)|role:\s*"viewer"[\s\S]{0,80}?fullCanvas:\s*false)/.test(shareSync), "识别到只读却没收权");
check("重连时同步服务端角色", /event\.role/.test(shareSync), "ready 事件带了角色但前端不读，降级要等到下次续期才生效");

// 访客上传：后端按 projectId 判权并把文件记在所有者名下，漏掉任一条都会退化成「按账号身份上传」或直接 401。
const shareUpload = read("services/share-upload.ts");
const uploadSignature = /uploadFile:\s*\(([^)]*)\)/.exec(shareApi);
check("分享通道提供上传接口", Boolean(uploadSignature), "share.ts 里没有 uploadFile，分享页只能走公共通道");
check("分享上传要求 projectId 与 guestToken", /projectId/.test(uploadSignature?.[1] || "") && /guestToken/.test(uploadSignature?.[1] || ""), "上传接口签名缺少 projectId 或 guestToken");
check("分享上传把 projectId 放进表单", /form\.append\("projectId"/.test(shareApi), "不带 projectId，服务端会按账号身份判权，访客直接 401");
check("分享上传走带 guest 令牌的分享请求", /shareRequest<ServerFile>\("\/v1\/files"[^;]*guestToken\)/s.test(shareApi), "上传没有带上 guest 令牌");
check("分享上传工具不引入公共 API 通道的请求器", !/\bserverApi\b/.test(shareUpload), "share-upload 不能调用 serverApi，401 会清掉账号会话");
check("分享上传工具只调用分享通道", /shareApi\.uploadFile\(/.test(shareUpload), "share-upload 没有走 shareApi.uploadFile");
check("分享上传前先确认是可编辑访客", /role\s*!==\s*"editor"/.test(shareUpload), "只读访客也能触发上传，服务端 403 会变成用户可见的报错风暴");

// 上传入口必须挂在 editable 上：viewer 看到按钮就等于把 403 当交互展示给用户。
check("分享页从分享上传通道取上传能力", /from\s+"@\/services\/share-upload"/.test(sharePage), "分享页没有接上分享上传通道");
check("分享页上传按钮只给可编辑访客", /\{editable \? \(\s*<Tooltip[\s\S]{0,200}?上传图片/.test(sharePage), "上传按钮没有被 editable 包住，viewer 也会看到");
check("分享页文件选择框只给可编辑访客", /\{editable \? \(\s*<input/.test(sharePage), "隐藏的 file input 对 viewer 也渲染了");
check("分享页拖拽上传只给可编辑访客", /onDrop=\{\s*editable/.test(sharePage), "onDrop 没有按 editable 收口");
check("分享页粘贴上传只给可编辑访客", /if \(!editable\) return;[\s\S]{0,600}?addEventListener\("paste"/.test(sharePage), "粘贴监听没有按 editable 收口");
check("分享页上传前再兜一次权限", /if \(!editableRef\.current\) return;/.test(sharePage), "上传函数自身没有拦只读，绕过 UI 的路径会打到服务端");

console.log("分享链接的可复制性");

const sharePanel = read("components/canvas/share-panel.tsx");

// 服务端额外存了一份明文，链接因此随时可复制；但存量记录只有不可逆的哈希，永远还原不出完整地址。
// 这两类必须靠服务端给的 copyable 区分，不能拿 token 是否为空串去猜：
// 「旧记录取不回明文」和「这次请求出了别的岔子」在前端看来都是一个空字符串，
// 猜错的后果是把一条残缺链接渲染成可复制的样子，让用户复制了发出去。
check("类型里有 copyable 这个显式状态", /copyable: boolean/.test(shareApi), "ShareRecord 上没有 copyable，前端只能拿空串去猜有没有明文");
check("列表按 copyable 决定给不给复制入口", /share\.copyable \?/.test(sharePanel), "复制入口没有按 copyable 收口");
check("不靠 token 是否为空串来猜", !/share\.token\s*\?\s*</.test(sharePanel) && !/Boolean\(share\.token\)/.test(sharePanel), "还在拿 token 是否有值判断能不能复制");
// 不能复制时不能只是把按钮藏了：用户会以为是自己的问题，反复刷新等它出现。
check("不能复制时说明原因", /copyable \? null :/.test(sharePanel) && /早期创建的链接/.test(sharePanel), "旧链接没有给出「为什么复制不了」的说明");
// 拼链接优先用服务端给的 url：反代下前端自己拼主机名会拼错。
check("优先用服务端给的完整链接", /share\.url \|\|/.test(sharePanel), "没有优先使用服务端下发的 url");
// 顶部那段注释是这个文件的行为契约，改了行为却留着旧注释，下一个人会照着错的做。
check("顶部注释已同步成随时可复制", /完整链接随时可复制/.test(sharePanel), "文件顶部还写着「只在创建那一次可复制」");
check("创建弹窗不再说只显示一次", !/完整链接只在这一次显示/.test(sharePanel), "创建弹窗还在说链接只显示一次，和实际行为矛盾");

console.log("分享计费与匿名编辑契约");
check("分享类型包含 ownerPays", /ownerPays: boolean/.test(shareApi), "缺少 ownerPays");
check("分享类型包含 allowAnonymousEdit", /allowAnonymousEdit: boolean/.test(shareApi), "缺少 allowAnonymousEdit");
check("分享会话包含完整权限字段", /shareId: string/.test(shareApi) && /fullCanvas: boolean/.test(shareApi) && /selfPayRequired: boolean/.test(shareApi) && /anonymous: boolean/.test(shareApi), "ShareSession 缺少权限字段");
check("匿名编辑依赖条件集中校验", /role === "editor"[\s\S]*allowAnonymous[\s\S]*ownerPays/.test(read("components/canvas/share-panel.tsx")), "面板未按三重依赖开启匿名编辑");

console.log("分享生成与扣点契约");
const projectPage = read("pages/canvas/project.tsx");
const angleGeneration = block(projectPage, "const generateAngleNode = useCallback", "const handleFontSizeChange");
const retryGeneration = block(projectPage, "const handleRetryNode = useCallback", "const generateImageFromTextNode");
check("分享 API 提供任务接口", /createJob:/.test(shareApi) && /cancelJob:/.test(shareApi) && /guestToken/.test(shareApi), "缺少 guest 任务 API");
check("分享生成请求带账单确认", /billingProjectId/.test(shareApi) && /acceptSelfPay/.test(shareApi), "请求缺少账单字段");
check("生成器识别分享画布", /fullCanvas/.test(read("services/api/generation.ts")) && /shareApi\.createJob/.test(read("services/api/generation.ts")), "生成器未切换分享通道");
check("分享生成只接受当前画布的显式上下文", /context\?\.source\s*===\s*"canvas"[\s\S]{0,120}?context\.projectId\s*===\s*share\.project\.id/.test(read("services/api/generation.ts")), "缺少或错画布的 context 仍会误用当前分享的房主计费与存储");
check("分享账单同意服务存在", /selfPayRequired/.test(read("services/share-billing-consent.ts")) && /AbortError/.test(read("services/share-billing-consent.ts")), "缺少取消语义");
check("画布生成在创建占位前完成扣点确认", /ensureGenerationBillingConsent\(jobContext\(nodeId,[\s\S]{0,500}?let pendingChildIds/.test(projectPage), "取消自费确认后仍可能留下 loading 占位节点");
check("未接入蒙版生成时入口直接提示且不进入扣点流程", /onMaskEdit=\{\(\) => message\.(?:info|warning)\("服务端生成暂不支持蒙版编辑"\)\}/.test(projectPage) && !/setMaskEditNodeId/.test(projectPage), "蒙版入口仍会先打开编辑器、确认扣点或创建 loading 节点，最后才报不支持");
check("角度生成在创建占位前完成扣点确认", angleGeneration.indexOf("ensureGenerationBillingConsent") >= 0 && angleGeneration.indexOf("ensureGenerationBillingConsent") < angleGeneration.indexOf("setRunningNodeId") && /acceptSelfPay/.test(angleGeneration), "取消角度生成的自费确认后仍会留下 loading 子节点");
check("重试生成在写入 loading 前完成并复用扣点确认", retryGeneration.indexOf("ensureGenerationBillingConsent") >= 0 && retryGeneration.indexOf("ensureGenerationBillingConsent") < retryGeneration.indexOf("setRunningNodeId") && (retryGeneration.match(/acceptSelfPay/g) || []).length >= 5, "取消重试的自费确认会污染原节点，或部分重试类型没有复用确认结果");
check("预确认结果复用到任务提交", /acceptedSelfPay \?\?/.test(read("services/api/generation.ts")) && /acceptSelfPay \}/.test(projectPage), "批量生成会重复弹窗或忽略预确认结果");

console.log("分享生成轮询契约");
const jobStream = read("services/api/job-stream.ts");
const reconcileJob = block(jobStream, "async function reconcile", "function startStream");
check("分享任务使用轮询", /shareApi\.job\(share\.guestToken/.test(read("services/api/generation.ts")), "缺少分享任务轮询");
check("分享任务轮询会重试临时网络错误", /pollShareJob/.test(read("services/api/generation.ts")) && /SHARE_JOB_RETRY_DELAYS/.test(read("services/api/generation.ts")), "一次查询失败就把仍在服务端运行的任务误报成失败");
check("分享文本读取 job.text", /item\.text/.test(read("services/api/generation.ts")), "缺少分享文本结果");
check("参考媒体走分享上传", /shareApi\.uploadFile\(share\.project/.test(read("services/api/generation.ts")), "媒体参考未切换分享上传");
check("同意记录包含用户", /shareId\}:\$\{input\.userId/.test(read("services/share-billing-consent.ts")), "同意记录未绑定用户");
check("房主账号恢复分享任务时缺席账号事件流会启动轮询", /applyJob\(waiter, job\)[\s\S]*if \(waiters\.has\(waiter\)\) startFallback\(\)/.test(reconcileJob), "房主能查到协作者任务，但任务不在账号事件流时会永久停在 loading");

console.log("分享完整画布工作区契约");
const shareSession = read("services/share-session.ts");
const pluginHost = read("pages/canvas/hooks/use-plugin-host.tsx");
const agentPanel = read("components/agent/agent-panel.tsx");
const agentModeSwitch = read("components/agent/agent-mode-switch.tsx");
const localAgentPanel = read("components/agent/local-agent-panel.tsx");
check("完整画布工作区可被分享页复用", /export function InfiniteCanvasPage\(\{ shared = false \}/.test(projectPage), "InfiniteCanvasPage 还不是可注入分享运行时的公共工作区");
check("fullCanvas 分享进入完整工作区", /if \(fullCanvas\)[\s\S]{0,500}?<InfiniteCanvasPage shared/.test(sharePage), "分享页没有按 fullCanvas 切换到完整工作区");
check("完整分享工作区保存到 share store", /shared[\s\S]*pushShareProject\(/.test(projectPage), "分享工作区仍可能把项目写进 useCanvasStore");
check("完整分享工作区使用分享实时同步", /watchShareProject\(/.test(projectPage) && /createSharePresenceReporter\(/.test(projectPage), "分享工作区没有接入分享事件流或 Presence");
check("完整分享工作区上传走 guest 通道", /uploadShareImage/.test(projectPage) && /uploadShareMedia/.test(projectPage), "图片、视频或音频仍可能走账号上传");
check("完整分享工作区隐藏所有者操作", /shared \? <SharedCanvasTopBar/.test(projectPage), "分享工作区仍显示新建、删除或管理分享等所有者操作");
check("分享会话续期同步完整权限", /fullCanvas:\s*session\.fullCanvas/.test(shareSession) && /ownerPays:\s*session\.ownerPays/.test(shareSession) && /allowAnonymousEdit:\s*session\.allowAnonymousEdit/.test(shareSession), "续期只更新了令牌，权限收回不能立即生效");
check("分享完整工作区恢复进行中任务", /shareApi\.jobs\(guestToken/.test(projectPage) && /resumeCanvasJob\(job\)/.test(projectPage), "刷新会把仍在运行的分享任务误标成中断");
check("分享任务恢复按节点只取最新任务", /seenJobNodes\.has\(nodeId\)/.test(projectPage), "同一节点的历史任务会与当前任务同时恢复并互相覆盖");
check("已打开协作者持续接管新增分享任务", /shareJobByNodeRef/.test(projectPage) && /loadingShareNodeKey/.test(projectPage) && /window\.setInterval\(recoverShareJobs/.test(projectPage), "只有首次打开时恢复分享任务，远程新出现的 loading 节点会一直卡住");
check("动态接管只排除真正活跃的等待流程", /generationRequestsRef\.current\.has\(nodeId\)/.test(projectPage) && !/locallyTrackedJobIds/.test(projectPage), "持久化的旧任务记录会永久阻止后续接管");
check("恢复任务按 jobId fencing 并接入取消", /jobId\?: string/.test(projectPage) && /isCurrentCanvasJob/.test(projectPage) && /startGenerationRequest\([^;]*job\.jobId/.test(projectPage), "旧任务晚到仍可能覆盖新任务，或恢复中的任务无法取消");
check("恢复批量任务会结算批次根节点和来源节点", /settleRecoveredGenerationAncestors/.test(projectPage) && /batchRootId/.test(block(projectPage, "const resumeCanvasJob = useCallback", "const confirmStopGeneration")), "发起者离页后只回填子节点，批次根节点或配置节点会永久停在 loading");
check("恢复批量任务只让首个成功结果占据根节点", /!batchRoot\?\.metadata\?\.primaryImageId/.test(block(projectPage, "const resumeCanvasJob = useCallback", "const confirmStopGeneration")), "并发恢复的后续子任务会反复覆盖批次根节点");
check("分享完整工作区挂载自费确认", /useShareBillingConsentPrompt\(\)/.test(sharePage), "扣点操作前没有可用的自费确认弹窗");
check("登录协作者显示个人资产而匿名继续隐藏", /showAssets=\{!shared \|\| Boolean\(serverToken\)\}/.test(projectPage) && /\{!shared \|\| serverToken \? <AssetPickerModal/.test(projectPage), "登录协作者看不到个人资产，或匿名访客错误获得账号资产入口");
check("协作者插入个人图片前复制到房主空间", /uploadShareImage\(payload\.dataUrl \|\| resolveImageUrl\(payload\.storageKey\)\)/.test(projectPage), "个人图片 fileId 被直接写进房主画布，其他协作者无法读取");
check("协作者插入个人视频前复制到房主空间", /uploadShareMedia\(payload\.url,\s*"asset-video"\)/.test(projectPage), "个人视频 fileId 被直接写进房主画布，其他协作者无法读取");
check("分享完整工作区保留克隆与登录入口", /保存到我的账号/.test(projectPage) && /onLogin/.test(projectPage), "fullCanvas 分支丢失保存副本或登录入口");
check("匿名保存个人资产先要求登录", /shared && !useServerStore\.getState\(\)\.token[\s\S]{0,180}?setLoginOpen\(true\)/.test(projectPage), "匿名分享访客会把房主文件假装保存成自己的资产");
check("协作者保存媒体会复制到自己的空间", /shared[\s\S]{0,180}?uploadMediaFile\(node\.metadata\.content/.test(projectPage) && /shared[\s\S]{0,180}?uploadImage\(node\.metadata\.content/.test(projectPage), "分享节点资产仍引用房主文件，协作者之后无法读取");
check("分享完整工作区登录后继续克隆", /takePendingClone\(token\)/.test(projectPage), "fullCanvas 登录完成后没有续接保存副本");
check("权限收回取消待保存快照", /cancelSharePendingWrites\(\)/.test(shareSync), "降级为只读后仍保留待发送的分享快照");
check("权限收回后回拉服务端权威快照", /role === "viewer"[\s\S]{0,400}?loadShareProject\(/.test(shareSync) && /loadShareProject\(session\.project\.id\)/.test(shareSession), "降级后仍可能展示或重新提交未保存的本地快照");
check("保存遇到只读响应时立即回拉权威快照", /isShareReadOnly\(error\)[\s\S]{0,500}?loadShareProject\(project\.id\)/.test(shareSync), "首次从保存响应得知降权时仍会保留幽灵改动");
check("旧分享请求不会跨会话回写", /isCurrentScope\(scope/.test(shareSync) && /syncGeneration/.test(shareSync), "旧链接的异步保存或拉取仍可能污染新分享会话");
check("同一分享的续期响应按请求序号防乱序", /sessionRequestSeq/.test(shareSession) && /requestId !== sessionRequestSeq/.test(shareSession), "并发续期的旧响应仍可能覆盖较新的权限");
check("登录态变化立即重换分享身份", /\[status,\s*userToken\]/.test(sharePage) && /status !== "ready"[\s\S]{0,120}?refreshShareSession\(\)/.test(sharePage), "登录或退出后仍要等定时续期才刷新分享权限");
check("远程更新不会覆盖本地待保存改动", /hasLocalChanges[\s\S]{0,500}?mergeProjectSnapshots\(scope\.state\.base, local, remote\)/.test(shareSync), "协作者更新到达时会直接丢掉本地防抖队列里的改动");
check("异步远程水合会把期间本地编辑重放到远程快照", /pendingShareHydrationRef/.test(projectPage) && /mergeProjectSnapshots\(/.test(projectPage), "远程图片水合期间的本地编辑会覆盖远程新增内容");
check("远程快照只跳过完全相同的保存", /matchesRenderSnapshot\(pendingRemoteRenderRef\.current/.test(projectPage), "远程更新与同批次本地编辑可能一起被误判为无需保存");
const projectRealtime = read("services/project-realtime.ts");
check("分享实时 ready 不提前推进已应用版本", /pullReadyRevision/.test(shareSync) && !/lastRevision\s*=\s*Math\.max\(lastRevision,\s*Number\(ready\.revision\)/.test(shareSync), "ready 后紧跟的 catch-up 会被当成重复事件吞掉");
check("账号实时 ready 不提前推进已应用版本", /pullReadyRevision/.test(projectRealtime) && !/lastRevision\s*=\s*Math\.max\(lastRevision,\s*Number\(ready\.revision\)/.test(projectRealtime), "账号画布同样会吞掉 ready 后的 catch-up");
check("分享协作者不会写回个人视口", /if \(!projectLoaded \|\| shared\) return;[\s\S]{0,300}?updateProject\(projectId, \{ viewport/.test(projectPage), "分享协作者移动视角会污染其他人的初始视口");
check("插件文本生成复用分享任务计费", /generateText/.test(pluginHost) && !/requestImageQuestion/.test(pluginHost), "插件文本仍走只认账号 JWT 的同步 AI 接口，会绕过 ownerPays 与自费确认");
check("插件图像视频文本生成都携带分享画布上下文", (pluginHost.match(/context:\s*pluginGenerationContext\(/g) || []).length >= 3 && /shared:\s*boolean/.test(pluginHost), "插件调用没有携带分享 projectId，匿名会走错账号通道，登录协作者也会绕过分享计费");
check("完整分享工作区提供本地 Agent 面板", /<AgentPanel forceLocal/.test(sharePage) && /onToggleAgent=\{toggleAgentPanel\}/.test(projectPage) && !/if \(shared\) useAgentStore\.getState\(\)\.setCanvasContext\(null\)/.test(projectPage), "分享页没有 Agent 面板入口，或仍把分享画布上下文清空");
check("分享 Agent 强制本地模式", /forceLocal\?: boolean/.test(agentPanel) && /!forceLocal && cloudEnabled/.test(agentPanel) && /forceLocal\?: boolean/.test(agentModeSwitch), "分享页直接开放了不具备分享鉴权和计费语义的云端 Agent");
check("分享 Agent 禁止链接参数自动连接", /const urlAgentAutoConnect = !forceLocal &&/.test(localAgentPanel) && /const urlToken = forceLocal \? "" :/.test(localAgentPanel) && /const urlEndpoint = forceLocal \? "" :/.test(localAgentPanel) && /if \(forceLocal \|\| \(!autoConnect/.test(localAgentPanel), "分享链接仍可通过 agentUrl/agentToken 自动连接并外发画布快照");
check("分享 Agent 必须本页手动授权连接", /manualConnectionRef/.test(localAgentPanel) && /forceLocal && !manualConnectionRef\.current/.test(localAgentPanel) && /manualConnectionRef\.current = true/.test(localAgentPanel), "分享页会继承旧页面的 enabled 状态自动连接并上报画布");
check("分享 Agent 屏蔽账号级工具与页面跳转", /forceLocal && \(isSiteTool\(payload\.name\) \|\| payload\.name === "site_navigate"\)/.test(localAgentPanel), "分享 Agent 仍可读取账号资产、工作台或跳离当前分享画布");
check("本地 Agent 产物按分享通道复制", /uploadCanvasAgentImage/.test(localAgentPanel) && /uploadShareImage/.test(localAgentPanel) && /share\.fullCanvas/.test(localAgentPanel), "本地 Agent 插入的图片仍落在协作者个人空间，房主和其他协作者无法读取");

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
