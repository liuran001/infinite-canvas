import { config } from "../config";
import type { AgentPendingAction, Job, JobKind, StoredFile } from "../db/entities";
import { fail, newId } from "../lib/errors";
import { imageTypeOf, listFiles, publicFileUrl, saveFile } from "./files";
import type { GenerationParams } from "./generation";
import { createJob, getJob, toJobView } from "./jobs";
import type { AgentGenerationPreference } from "./preferences";
import { storageTeamOfProject } from "./project-team";
import { safeWebUrl, webFetch, webSearch } from "./search";
import { publicSettings, type ModelCapability, type PublicSetting } from "./settings";
import { readProjectCanvas, renameProjectCanvas, updateProjectCanvas, type CanvasNodeData, type CanvasProjectData } from "./sync";

/** 工具描述用 JSON Schema 表达，OpenAI 与 Gemini 两种格式都能直接套用，不用各写一份。 */
export type AgentTool = { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } };

/**
 * 工具门禁。前端不显示只是省得用户困惑，真正拦住的是这里：
 * 下发工具列表和执行工具都要过同一份开关，模型硬编一个工具名调过来也会被挡下。
 */
export type AgentToolAccess = { search: boolean; image: boolean; video: boolean; audio: boolean; text: boolean; vision: boolean };

/**
 * 一次执行里工具与推理循环共享的可变状态。
 * 工具只往里写，落库、暂停、恢复统一由推理循环做：
 * 工具自己去改会话行的话，「请求确认」这件事就会散落在每个工具里各写一遍。
 */
export type ToolState = { autoRenamed: boolean; action?: AgentPendingAction };

export type ToolContext = { userId: string; projectId: string; sessionId: string; seq: number; access: AgentToolAccess; prefs: AgentGenerationPreference; state: ToolState; signal: AbortSignal };

/** 与 web/src/constant/canvas.ts 的 NODE_SPECS 保持一致，agent 建的节点才不会在前端显示成畸形尺寸或缺默认元数据。 */
const NODE_SPECS: Record<string, { width: number; height: number; title: string; metadata: Record<string, unknown> }> = {
    image: { width: 340, height: 240, title: "图片", metadata: { content: "", status: "idle" } },
    text: { width: 340, height: 240, title: "文本", metadata: { content: "", status: "idle", fontSize: 14 } },
    config: { width: 340, height: 240, title: "生成配置", metadata: { content: "", status: "idle", generationMode: "image" } },
    video: { width: 420, height: 236, title: "视频", metadata: { content: "", status: "idle" } },
    audio: { width: 340, height: 120, title: "音频", metadata: { content: "", status: "idle" } },
    group: { width: 760, height: 480, title: "组", metadata: { status: "idle" } },
};

const JOB_WAIT_LIMIT = 180;
const JOB_WAIT_INTERVAL_MS = 2000;
/** 单个节点回给模型的正文截断长度，画布里可能塞着整篇文章，全量喂进去会撑爆上下文。 */
const NODE_CONTENT_CHARS = 500;
/** 一次批量操作最多影响多少个节点，避免模型一口气把整张画布搅乱。 */
const MAX_BATCH_NODES = 50;
/**
 * 读网页回给模型的正文上限。搜索摘要的 1200 是给「扫一眼判断相关性」用的，
 * 读全文要能覆盖到文章中段的表格、接口参数这类细节，所以放宽到 8000：
 * 纯中文约 8k token、英文约 2k token，在常见的 128k 上下文里连读两三篇也还塞得下多轮循环的历史。
 * 再往上就该换更具体的来源，而不是继续放宽——每读一篇，后面每一轮都要把它重新算一遍 token。
 */
const MAX_PAGE_CHARS = 8000;

/**
 * 从网址导入图片的大小上限。
 * 定成 10MB 是因为：默认云空间配额只有 100MB，模型挑的一张配图占掉一成已经是上限了；
 * 而搜索结果里的网页配图通常只有几百 KB，10MB 足够覆盖到高清原图。
 * 用户自己上传的图仍然按 files.ts 的 30MB 走——那是用户自己决定要存什么，模型不是。
 */
const MAX_IMPORT_BYTES = 10 << 20;
/** 外部地址可能一直不响应，超时了就得放手，不能让 agent 的这一轮卡死在下载上。 */
const IMPORT_TIMEOUT_MS = 20000;
/**
 * 允许导入的图片格式，是「浏览器能显示 ∩ OpenAI 能收 ∩ Gemini 能收」的交集。
 * 导进来的图既要在画布上用 <img> 显示，又要能当参考图发给上游模型，少满足一头就会在另一头炸；
 * 服务端没有图像处理库，不做转码，认不出或不在交集里的格式直接报错让模型换一张。
 * 键是 image-size 认出来的格式名，值是真正落库的 mime——一律以字节为准，不采信响应头。
 */
const IMPORT_IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** 画布里的图片引用统一是 server:<fileId>，工具参数也用同一套写法，模型不用去猜内部 ID。 */
const STORAGE_PREFIX = "server:";

/** 画布标题落库前的截断长度，标题栏再长也放不下。 */
const MAX_CANVAS_TITLE_CHARS = 60;

/**
 * 前端新建画布时用的两种默认标题：`无限画布 N`（画布列表页新建时按序号生成）与 `未命名画布`（store 兜底）。
 * 只有严格精确匹配这两种格式才算「用户还没起过名字」——用户自己把画布命名成「无限画布 3」时，
 * 那就是他要的名字，不该被模型擅自改掉，所以这里不做包含匹配、不做前缀匹配。
 */
const DEFAULT_CANVAS_TITLE = /^(?:无限画布 \d+|未命名画布)$/;

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });
const boolean = (description: string) => ({ type: "boolean", description });
const stringList = (description: string) => ({ type: "array", description, items: { type: "string" } });

/**
 * 生成类工具的模型参数说明。四个工具共用一句，既省描述长度，也保证四处口径一致。
 * 校验放在服务端而不是靠这句话：模型完全可能拿文本模型来生图。
 * 「默认」是用户偏好里配的那个，没配过才是全站默认，所以这里不写死成「系统默认」。
 */
const modelParam = (kind: string) => string(`指定${kind}模型，留空用默认设置；填了不存在或能力不匹配的模型会自动回落到默认，不会报错`);

export function listAgentTools(access: AgentToolAccess): AgentTool[] {
    const tools: AgentTool[] = [
        {
            name: "read_canvas",
            description: "读取当前画布的标题、全部节点、连线与结构概览。只返回结构与文字，不含图片内容；任何修改前都应先读一次拿到最新的节点 ID。",
            parameters: { type: "object", properties: {}, required: [] },
        },
        {
            name: "create_node",
            description: "在画布上新建一个节点。不传坐标时自动放到现有节点右侧。",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", description: "节点类型：text 文本、image 图片、config 生成配置、video 视频、audio 音频、group 组", enum: Object.keys(NODE_SPECS) },
                    title: string("节点标题，留空用类型默认名"),
                    content: string("节点正文，文本节点写文字内容"),
                    prompt: string("生成类节点的提示词"),
                    storageKey: string("图片节点要引用的图片，填形如 server:xxx 的 storageKey（用户上传的附件或画布上已有图片都用这个键）"),
                    groupId: string("要放进的组节点 ID，留空表示不入组"),
                    x: number("左上角横坐标"),
                    y: number("左上角纵坐标"),
                    width: number("节点宽度"),
                    height: number("节点高度"),
                },
                required: ["type"],
            },
        },
        {
            name: "update_node",
            description: "修改已存在节点的标题、正文、提示词、位置或尺寸，只传需要改的字段。",
            parameters: {
                type: "object",
                properties: {
                    nodeId: string("要修改的节点 ID"),
                    title: string("新标题"),
                    content: string("新正文"),
                    prompt: string("新提示词"),
                    x: number("新的左上角横坐标"),
                    y: number("新的左上角纵坐标"),
                    width: number("新宽度"),
                    height: number("新高度"),
                },
                required: ["nodeId"],
            },
        },
        { name: "delete_node", description: "删除节点，与它相连的连线会一并删除。", parameters: { type: "object", properties: { nodeId: string("要删除的节点 ID") }, required: ["nodeId"] } },
        {
            name: "move_nodes",
            description: "批量平移节点，按给定的横纵偏移量整体移动。整理布局时比逐个 update_node 快得多。",
            parameters: { type: "object", properties: { nodeIds: stringList("要移动的节点 ID 列表"), dx: number("横向偏移量，正数向右"), dy: number("纵向偏移量，正数向下") }, required: ["nodeIds"] },
        },
        {
            name: "set_node_group",
            description: "把节点放进组节点或移出所在的组。groupId 传组节点 ID 表示加入，留空表示移出。",
            parameters: { type: "object", properties: { nodeIds: stringList("要调整归属的节点 ID 列表"), groupId: string("目标组节点 ID，留空表示移出当前的组") }, required: ["nodeIds"] },
        },
        {
            name: "connect_nodes",
            description: "把两个节点连起来，方向是 from → to。",
            parameters: { type: "object", properties: { fromNodeId: string("起点节点 ID"), toNodeId: string("终点节点 ID") }, required: ["fromNodeId", "toNodeId"] },
        },
        {
            name: "disconnect_nodes",
            description: "断开两个节点之间的连线。",
            parameters: { type: "object", properties: { fromNodeId: string("起点节点 ID"), toNodeId: string("终点节点 ID") }, required: ["fromNodeId", "toNodeId"] },
        },
        {
            name: "rename_canvas",
            description:
                "重命名当前画布。画布还是系统默认标题（「无限画布 N」或「未命名画布」）时，可以在弄清用户意图后主动改一次，立刻生效；" +
                "其余情况会先向用户发出确认请求，等他同意后才会真的改，所以 reason 要写清楚为什么值得改。",
            parameters: { type: "object", properties: { title: string("新的画布标题"), reason: string("改名理由，会原样展示给用户确认") }, required: ["title"] },
        },
    ];
    if (access.image) {
        tools.push({
            name: "generate_image",
            description: "按提示词生成图片并在画布上新建图片节点。传了参考图就是以图生图。会消耗用户的算力点与云空间，生成过程可能需要几十秒。",
            parameters: {
                type: "object",
                properties: {
                    prompt: string("生图提示词，尽量具体"),
                    referenceStorageKeys: stringList("参考图的 storageKey 列表（形如 server:xxx），可以是用户上传的附件或画布上已有的图片"),
                    model: modelParam("生图"),
                    count: number("生成张数，默认 1"),
                    size: string("尺寸或比例，例如 1024x1024、16:9"),
                    quality: string("画质档位，例如 low、medium、high；档位越高越贵"),
                    background: string("背景，例如 transparent 透明、opaque 不透明"),
                    x: number("图片节点左上角横坐标"),
                    y: number("图片节点左上角纵坐标"),
                },
                required: ["prompt"],
            },
        });
    }
    if (access.video) {
        tools.push({
            name: "generate_video",
            description: "按提示词生成视频并在画布上新建视频节点。可以带参考图当首帧。会消耗算力点与云空间，通常需要几分钟。",
            parameters: {
                type: "object",
                properties: {
                    prompt: string("视频提示词，尽量具体"),
                    referenceStorageKeys: stringList("参考图的 storageKey 列表（形如 server:xxx）"),
                    model: modelParam("视频"),
                    seconds: string("时长秒数，例如 5"),
                    ratio: string("画面比例，例如 16:9"),
                    resolution: string("分辨率档位，例如 720p"),
                    generateAudio: boolean("是否同时生成配音，默认生成"),
                    watermark: boolean("是否打水印，默认不打"),
                    x: number("视频节点左上角横坐标"),
                    y: number("视频节点左上角纵坐标"),
                },
                required: ["prompt"],
            },
        });
    }
    if (access.audio) {
        tools.push({
            name: "generate_audio",
            description: "把文字转成语音并在画布上新建音频节点。会消耗算力点与云空间。",
            parameters: {
                type: "object",
                properties: {
                    prompt: string("要朗读的文字内容"),
                    model: modelParam("音频"),
                    voice: string("音色名，例如 alloy"),
                    format: string("音频格式，例如 mp3"),
                    speed: number("语速倍率，1 为正常"),
                    instructions: string("朗读方式说明，例如语气、情绪、口音"),
                    x: number("音频节点左上角横坐标"),
                    y: number("音频节点左上角纵坐标"),
                },
                required: ["prompt"],
            },
        });
    }
    if (access.text) {
        tools.push({
            name: "generate_text",
            description:
                "让文本模型写一段内容，并把结果建成画布上的文本节点。会消耗算力点，长文可能要等十几秒到一分钟。" +
                "默认自己写：短文案、标题、清单、表格、总结，以及你已经想清楚该写什么的内容，直接用 create_node 写进去更快，也不用额外花钱。" +
                "只有这三种情况才调这个工具：需要成篇的长文（例如整篇文章、故事、报告）；需要特定文风或专业深度而你自己写不到位；用户明确要求换某个模型来写。",
            parameters: {
                type: "object",
                properties: {
                    prompt: string("要写什么，把体裁、篇幅、风格、受众都写清楚，模型看不到当前对话"),
                    model: modelParam("文本"),
                    reasoningEffort: string("推理强度，例如 low、medium、high；需要深度思考时才填"),
                    title: string("文本节点标题，留空用默认名"),
                    x: number("文本节点左上角横坐标"),
                    y: number("文本节点左上角纵坐标"),
                },
                required: ["prompt"],
            },
        });
    }
    if (access.vision) {
        tools.push({
            name: "view_image",
            description: "查看一张图片的真实内容。read_canvas 只给结构不给图，确实需要看图时才调用这个工具，看过的图会留在后续对话里。",
            parameters: {
                type: "object",
                properties: { nodeId: string("画布上图片节点的 ID"), storageKey: string("图片的 storageKey（形如 server:xxx），用户上传的附件用这个") },
                required: [],
            },
        });
    }
    if (access.search) {
        tools.push({
            name: "web_search",
            description:
                "联网搜索获取实时资料。需要最新信息或不确定的事实时使用。返回的是每条结果的摘要，只够判断相关性；摘要里没有的细节要用 read_webpage 读原文。" +
                "结果里的 imageUrl 是该条结果自带的配图，顶层 images 是本次搜索搜到、但说不清属于哪条结果的图；" +
                "要把图用到画布上，先用 import_image 把图片地址导入成服务端文件，不能直接把网址填进节点。",
            parameters: { type: "object", properties: { query: string("搜索关键词"), limit: number("返回条数上限") }, required: ["query"] },
        });
        tools.push({
            name: "read_webpage",
            description:
                "读取一个网址的网页正文，用来看清搜索摘要里没有的细节：接口参数、文章中段的论述、表格数据等。" +
                "正确用法是先用 web_search 拿到候选网址，再挑其中真正需要细读的一两条调这个工具；" +
                "一次只读一个网址，读回来的正文会占掉大量上下文，不要把搜到的结果逐条读一遍。" +
                "正文过长会被截断，返回里的 truncated 为 true 时说明只看到了开头部分。",
            parameters: { type: "object", properties: { url: string("要读取的网页网址，必须是完整的 http/https 地址") }, required: ["url"] },
        });
        tools.push({
            name: "import_image",
            description:
                "把一个公网图片地址下载成服务端文件，返回可以直接用的 storageKey。" +
                "标准用法是 web_search 拿到 imageUrl 或 images 里的图片地址 → 用这个工具导入 → 把返回的 storageKey 交给 create_node 建图片节点，或放进 generate_image 的 referenceStorageKeys 当参考图。" +
                "一次只导一张，会占用户的云空间，所以只导真正要用的那张；" +
                `只接受 png、jpeg、webp 三种格式且不超过 ${MAX_IMPORT_BYTES >> 20}MB，报错说格式不支持时换搜索结果里的另一个图片地址重试。`,
            parameters: { type: "object", properties: { url: string("图片的完整 http/https 地址，通常来自 web_search 结果里的 imageUrl 或 images") }, required: ["url"] },
        });
    }
    return tools;
}

function text(args: Record<string, unknown>, key: string) {
    return typeof args[key] === "string" ? (args[key] as string).trim() : "";
}

function num(args: Record<string, unknown>, key: string) {
    const value = Number(args[key]);
    return Number.isFinite(value) ? value : undefined;
}

/** 布尔参数要容忍模型传字符串 "true"/"false"，各家模型对 boolean 的序列化并不一致。 */
function bool(args: Record<string, unknown>, key: string) {
    const value = args[key];
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
}

/** 数组参数要容忍模型只传一个字符串的写法，否则一个格式抖动就整条工具调用失败。 */
function list(args: Record<string, unknown>, key: string) {
    const value = args[key];
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return items.map((item) => String(item ?? "").trim()).filter(Boolean);
}

export function storageKeyOf(fileId: string) {
    return `${STORAGE_PREFIX}${fileId}`;
}

export function fileIdOfStorageKey(key: string) {
    const value = key.trim();
    return value.startsWith(STORAGE_PREFIX) ? value.slice(STORAGE_PREFIX.length) : value;
}

/**
 * 把工具参数里的 storageKey 还原成真实文件。
 * 一定要走 listFiles 按 userId 过滤：模型的参数完全可能来自用户输入，不校验归属就等于开了任意读别人文件的口子。
 */
async function resolveFiles(userId: string, keys: string[]) {
    const ids = [...new Set(keys.map(fileIdOfStorageKey).filter(Boolean))];
    if (!ids.length) return [];
    const files = await listFiles(userId, ids);
    const missing = ids.filter((id) => !files.some((file) => file.id === id));
    if (missing.length) throw fail(`找不到图片：${missing.map(storageKeyOf).join("、")}`);
    return ids.map((id) => files.find((file) => file.id === id) as StoredFile);
}

function specOf(type: string) {
    return NODE_SPECS[type] || { width: 340, height: 240, title: type, metadata: { content: "", status: "idle" } };
}

/** 与前端 createCanvasNode 的 ID 规则一致，避免同一画布里出现两套 ID 风格。 */
function newNodeId(type: string) {
    return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 不给坐标时排到最右侧节点之后，免得所有新节点叠在原点。 */
function nextPosition(data: CanvasProjectData) {
    // 空画布时留出边距：画布顶栏是浮在内容上的，节点落在原点会被压住一截。
    if (!data.nodes.length) return { x: 80, y: 80 };
    return { x: Math.max(...data.nodes.map((node) => node.position.x + node.width)) + 60, y: Math.min(...data.nodes.map((node) => node.position.y)) };
}

function appendNode(data: CanvasProjectData, type: string, args: Record<string, unknown>, metadata: Record<string, unknown>) {
    const spec = specOf(type);
    const auto = nextPosition(data);
    const node: CanvasNodeData = {
        id: newNodeId(type),
        type,
        title: text(args, "title") || spec.title,
        position: { x: num(args, "x") ?? auto.x, y: num(args, "y") ?? auto.y },
        width: num(args, "width") || spec.width,
        height: num(args, "height") || spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
    data.nodes.push(node);
    return node;
}

function nodeSummary(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    const content = typeof metadata.content === "string" ? metadata.content : "";
    return {
        id: node.id,
        type: node.type,
        title: node.title,
        x: node.position.x,
        y: node.position.y,
        width: node.width,
        height: node.height,
        ...(content ? { content: content.slice(0, NODE_CONTENT_CHARS) } : {}),
        ...(typeof metadata.prompt === "string" && metadata.prompt ? { prompt: metadata.prompt.slice(0, NODE_CONTENT_CHARS) } : {}),
        ...(typeof metadata.storageKey === "string" && metadata.storageKey ? { storageKey: metadata.storageKey } : {}),
        // 归属组也要带出来，否则模型没法知道现在哪些节点已经在组里。
        ...(typeof metadata.groupId === "string" && metadata.groupId ? { groupId: metadata.groupId } : {}),
    };
}

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(fail("已中止"));
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(fail("已中止"));
        }, { once: true });
    });
}

/**
 * 生成类工具统一复用现有任务队列：计费、配额、文件落库、幂等都沿用 jobs 那一套，不另起一份。
 * clientJobId 由「会话 + 消息序号 + 类型」拼出来，同一次工具调用重试不会重复生成也不会重复扣费。
 */
async function runGenerationJob(ctx: ToolContext, kind: JobKind, model: string, prompt: string, params: GenerationParams, inputFileIds: string[]) {
    const created = await createJob(ctx.userId, {
        clientJobId: `agent-${ctx.sessionId}-${ctx.seq}-${kind}`,
        kind,
        model,
        prompt,
        params,
        inputFileIds,
        context: { source: "agent", projectId: ctx.projectId, sessionId: ctx.sessionId },
        // 计费归属走独立参数而不是 context：context 是给界面看的自定义信息，不该决定谁付钱。
        billingProjectId: ctx.projectId,
    });

    let job: Job = created;
    for (let attempt = 0; attempt < JOB_WAIT_LIMIT && (job.status === "pending" || job.status === "running"); attempt += 1) {
        await delay(JOB_WAIT_INTERVAL_MS, ctx.signal);
        job = await getJob(ctx.userId, created.id);
    }
    if (job.status === "failed" || job.status === "canceled") throw fail(job.error || "生成失败");
    if (job.status !== "succeeded") throw fail("生成超时，请稍后在画布上查看任务结果");

    const view = await toJobView(job);
    // 文本任务的产出是 text 而不是文件，两者只会有一边有内容。
    if (kind !== "text" && !view.outputs.length) throw fail("生成没有返回结果");
    return { job, outputs: view.outputs, text: view.text };
}

/**
 * 定这次生成用哪个模型。候选按「模型显式传的 → 用户偏好里配的 → 全站默认」的顺序给，
 * 前面的候选必须是「已启用渠道里 capability 对得上」的才作数：
 * 放行一个文本模型去生图，上游只会回一串看不懂的错，还会绕开按模型单价计费的口径。
 * 不匹配时静默往下一层落而不是报错——不管是模型挑错了名字，还是用户偏好里的模型被管理员下线、改了能力，
 * 换个能用的把活干完，都比中断整轮执行、让用户看见一条工具报错有用得多。
 * 最后一个候选是全站默认，直接兜底不再校验：它由管理员保证，这里多挡一道只会把「管理员配错」变成更难查的静默失败。
 */
function resolveGenerationModel(settings: PublicSetting, capability: ModelCapability, ...candidates: string[]) {
    const fallback = candidates.pop() || "";
    const usable = candidates.map((item) => item.trim()).find((name) => name && settings.modelChannel.models.some((model) => model.name === name && model.capability === capability));
    return usable || fallback;
}

/** 生成结果落到节点上的公共元数据，和前端生成完写回节点的字段保持一致。 */
function outputMetadata(file: { id: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number }, prompt: string, model: string) {
    return {
        storageKey: storageKeyOf(file.id),
        // 前端会用 storageKey 重新解析直链，没配公网地址时留空即可。
        content: config.publicBaseUrl ? publicFileUrl(config.publicBaseUrl, file.id) : "",
        status: "success",
        prompt,
        model,
        mimeType: file.mimeType,
        bytes: file.bytes,
        ...(file.width ? { naturalWidth: file.width } : {}),
        ...(file.height ? { naturalHeight: file.height } : {}),
        ...(file.durationMs ? { durationMs: file.durationMs } : {}),
    };
}

async function generateImage(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.image) throw fail("生图能力当前未开放");
    const prompt = text(args, "prompt");
    if (!prompt) throw fail("缺少生图提示词");
    const settings = await publicSettings();
    const model = resolveGenerationModel(settings, "image", text(args, "model"), ctx.prefs.imageModel, settings.modelChannel.defaultImageModel);
    if (!model) throw fail("系统未配置生图模型");

    // 规格逐项回落：模型传了就按它的，没传就按用户偏好补齐，两边都没有才让上游用自己的默认。
    // 逐项而不是整组回落，是因为模型往往只想得起其中一两项（例如只指定了尺寸），
    // 整组切换的话，它一传尺寸就会把用户配好的画质、背景一起丢掉。
    const count = Math.max(1, Math.min(4, num(args, "count") || ctx.prefs.imageCount || 1));
    const size = text(args, "size") || ctx.prefs.imageSize;
    const quality = text(args, "quality") || ctx.prefs.imageQuality;
    const background = text(args, "background") || ctx.prefs.imageBackground;
    const references = await resolveFiles(ctx.userId, list(args, "referenceStorageKeys"));
    const { job, outputs } = await runGenerationJob(
        ctx,
        "image",
        model,
        prompt,
        {
            count,
            ...(size ? { size } : {}),
            ...(quality ? { quality } : {}),
            ...(background ? { background } : {}),
        },
        references.map((file) => file.id),
    );

    return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
        const nodes = outputs.map((file, index) => {
            const spec = specOf("image");
            // 图片节点尊重原图比例，只在宽度上对齐默认尺寸。
            const height = file.width && file.height ? Math.round((spec.width * file.height) / file.width) : spec.height;
            return appendNode(data, "image", { ...args, x: num(args, "x") === undefined ? undefined : (num(args, "x") as number) + index * (spec.width + 40), height }, outputMetadata(file, prompt, model));
        });
        return { jobId: job.id, model, credits: job.credits, nodes: nodes.map(nodeSummary) };
    });
}

async function generateVideo(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.video) throw fail("视频生成当前未开放");
    const prompt = text(args, "prompt");
    if (!prompt) throw fail("缺少视频提示词");
    const settings = await publicSettings();
    const model = resolveGenerationModel(settings, "video", text(args, "model"), settings.modelChannel.defaultVideoModel);
    if (!model) throw fail("系统未配置视频模型");

    const references = await resolveFiles(ctx.userId, list(args, "referenceStorageKeys"));
    const { job, outputs } = await runGenerationJob(
        ctx,
        "video",
        model,
        prompt,
        {
            ...(text(args, "seconds") ? { seconds: text(args, "seconds") } : {}),
            ...(text(args, "ratio") ? { ratio: text(args, "ratio") } : {}),
            ...(text(args, "resolution") ? { resolution: text(args, "resolution") } : {}),
            ...(bool(args, "generateAudio") === undefined ? {} : { generateAudio: bool(args, "generateAudio") }),
            ...(bool(args, "watermark") === undefined ? {} : { watermark: bool(args, "watermark") }),
        },
        references.map((file) => file.id),
    );

    return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
        const node = appendNode(data, "video", args, outputMetadata(outputs[0], prompt, model));
        return { jobId: job.id, model, credits: job.credits, node: nodeSummary(node) };
    });
}

async function generateAudio(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.audio) throw fail("音频生成当前未开放");
    const prompt = text(args, "prompt");
    if (!prompt) throw fail("缺少要朗读的文字");
    const settings = await publicSettings();
    const model = resolveGenerationModel(settings, "audio", text(args, "model"), settings.modelChannel.defaultAudioModel);
    if (!model) throw fail("系统未配置音频模型");

    const { job, outputs } = await runGenerationJob(ctx, "audio", model, prompt, {
        ...(text(args, "voice") ? { voice: text(args, "voice") } : {}),
        ...(text(args, "format") ? { format: text(args, "format") } : {}),
        ...(num(args, "speed") ? { speed: num(args, "speed") } : {}),
        ...(text(args, "instructions") ? { instructions: text(args, "instructions") } : {}),
    }, []);

    return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
        const node = appendNode(data, "audio", args, outputMetadata(outputs[0], prompt, model));
        return { jobId: job.id, model, credits: job.credits, node: nodeSummary(node) };
    });
}

/**
 * 让文本模型写一段内容再建成文本节点。走的是 jobs 里已有的 text 任务：
 * 计费、幂等、流式落库、后台重启续跑都跟着那一套走，这里不重新实现一遍。
 * 产出是 job.text 而不是文件，所以不能套 outputMetadata。
 */
async function generateTextNode(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.text) throw fail("文本生成当前未开放");
    const prompt = text(args, "prompt");
    if (!prompt) throw fail("缺少文本生成提示词");
    const settings = await publicSettings();
    const model = resolveGenerationModel(settings, "text", text(args, "model"), ctx.prefs.textModel, settings.modelChannel.defaultTextModel);
    if (!model) throw fail("系统未配置文本模型");

    const { job, text: content } = await runGenerationJob(ctx, "text", model, prompt, { ...(text(args, "reasoningEffort") ? { reasoningEffort: text(args, "reasoningEffort") } : {}) }, []);
    if (!content.trim()) throw fail("文本生成没有返回内容");

    return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
        const node = appendNode(data, "text", args, { content, status: "success", prompt, model });
        return { jobId: job.id, model, credits: job.credits, chars: content.length, node: nodeSummary(node) };
    });
}

/**
 * 改画布标题。画布还是系统默认标题、且这次会话还没主动改过时直接改，不打扰用户；
 * 其余情况一律变成一条待确认请求交给用户点头——标题是用户自己的东西，模型不该替他改掉已经起好的名字。
 * 「只能主动改一次」靠会话上的标记落库，不靠模型自觉：不落库的话它每一轮都可能重新起念再改一次。
 */
async function renameCanvas(ctx: ToolContext, args: Record<string, unknown>) {
    const title = text(args, "title").slice(0, MAX_CANVAS_TITLE_CHARS);
    if (!title) throw fail("画布标题不能为空");
    const project = await readProjectCanvas(ctx.userId, ctx.projectId);
    if (project.title === title) return { title, changed: false, note: "画布已经是这个标题了" };

    if (DEFAULT_CANVAS_TITLE.test(project.title) && !ctx.state.autoRenamed) {
        ctx.state.autoRenamed = true;
        return { ...(await renameProjectCanvas(ctx.userId, ctx.projectId, title)), changed: true, note: "画布原来是默认标题，已直接改名；之后再要改标题都需要用户确认" };
    }
    ctx.state.action = { type: "rename_canvas", title, reason: text(args, "reason") };
    return { title, changed: false, pending: true, note: "已请求用户确认这次改名，等他同意后才会生效；不要重复请求" };
}

/**
 * 看图。只返回图片的引用信息，真正的图片内容由推理循环在重建上下文时按各家格式塞进去，
 * 这样图片进上下文这件事是「模型主动要求的一次」，不会被 read_canvas 一股脑带进来每轮重算 token。
 */
async function viewImage(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.vision) throw fail("当前模型不支持识别图片");
    let key = text(args, "storageKey");
    const nodeId = text(args, "nodeId");
    if (!key && nodeId) {
        const project = await readProjectCanvas(ctx.userId, ctx.projectId);
        const node = project.data.nodes.find((item) => item.id === nodeId);
        if (!node) throw fail(`节点不存在：${nodeId}`);
        key = typeof node.metadata?.storageKey === "string" ? node.metadata.storageKey : "";
        if (!key) throw fail(`这个节点没有图片：${nodeId}`);
    }
    if (!key) throw fail("请指定要查看的图片节点或 storageKey");

    const [file] = await resolveFiles(ctx.userId, [key]);
    if (file.kind !== "image") throw fail("只能查看图片");
    return { storageKey: storageKeyOf(file.id), mimeType: file.mimeType, width: file.width, height: file.height, note: "图片已加入对话上下文，可以直接描述或据此继续操作" };
}

/** 边收边数，超上限立刻掐断连接：等整份下完再判断，内存和带宽已经先被吃掉了。 */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number, message: string) {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw fail(message);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/**
 * 把公网图片地址导入成服务端文件。这是「搜到图 → 用上图」中间缺的那一步：
 * 画布节点和生成任务只认 server:<fileId>，外部网址得先变成用户自己的文件才能用。
 * 只返回 storageKey、不顺手建节点，是因为导进来的图有一半是要当 generate_image 的参考图的，
 * 那种情况下画布上并不需要多出一个图片节点；真要建节点，create_node 已经把标题、坐标、入组这些参数都表达好了，
 * 在这里再写一份只会变成两处维护。
 */
async function importImage(ctx: ToolContext, args: Record<string, unknown>) {
    if (!ctx.access.search) throw fail("未配置联网搜索");
    // 地址是模型给的，和 read_webpage 过同一套内网拦截。这条路径比读正文更要紧：读正文只是把文字塞进上下文，
    // 这里会把响应体当成用户的文件存下来，内网探测的结果会直接落进画布。
    const url = safeWebUrl(text(args, "url"));
    const response = await fetch(url, {
        // 明确告诉对方我们只要这几种格式：会做内容协商的 CDN 会直接回 png/jpeg/webp，
        // 省掉一次「拿回 avif 再报错、让模型换一张」的往返。
        headers: { Accept: "image/png,image/jpeg,image/webp,image/*;q=0.8" },
        // 超时和用户中止合成一个信号：外部地址不响应要能自己放手，用户点中止也要立刻停。
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(IMPORT_TIMEOUT_MS)]),
    }).catch(() => {
        throw fail("图片下载失败：地址无响应或已超时");
    });
    if (!response.ok) throw fail(`图片下载失败：HTTP ${response.status}`);
    if (!response.body) throw fail("图片下载失败：这个地址没有返回内容");
    const declared = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!declared.startsWith("image/")) throw fail(`这个地址返回的不是图片：${declared || "未知类型"}`);

    const body = await readCapped(response.body, MAX_IMPORT_BYTES, `图片超过 ${MAX_IMPORT_BYTES >> 20}MB，已中止下载，请换一张小一点的图`);
    // 响应头说是图片不算数，最终以字节魔数为准，落库的 mime 也用认出来的那个。
    const type = imageTypeOf(body);
    if (!type) throw fail("这个地址的内容不是图片");
    const mimeType = IMPORT_IMAGE_MIME[type];
    if (!mimeType) throw fail(`暂不支持 ${type} 格式的图片，请换一张 png、jpeg 或 webp 的图片地址`);

    // 走和用户上传同一条 saveFile：同样占云空间配额、同样按内容去重，配额不够时由它抛中文错误。
    // 归属跟着画布走：团队画布里导进来的图记团队的账，和用户手动上传落在同一本账上。
    const file = await saveFile(ctx.userId, body, mimeType, {}, await storageTeamOfProject(ctx.userId, ctx.projectId));
    return {
        storageKey: storageKeyOf(file.id),
        mimeType: file.mimeType,
        width: file.width,
        height: file.height,
        bytes: Number(file.bytes),
        note: "图片已存进这个用户的云空间，可以把 storageKey 交给 create_node 建图片节点，或放进 generate_image 的 referenceStorageKeys 当参考图",
    };
}

export async function runAgentTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "read_canvas") {
        const project = await readProjectCanvas(ctx.userId, ctx.projectId);
        return { projectId: ctx.projectId, title: project.title, revision: project.revision, nodeCount: project.data.nodes.length, nodes: project.data.nodes.map(nodeSummary), connections: project.data.connections };
    }

    if (name === "create_node") {
        const type = text(args, "type") || "text";
        if (!NODE_SPECS[type]) throw fail(`不支持的节点类型：${type}`);
        // 引用的图片先解析出来再进事务：越权或不存在时直接报错，不会先建出一个空壳节点。
        const [reference] = text(args, "storageKey") ? await resolveFiles(ctx.userId, [text(args, "storageKey")]) : [];
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            const metadata: Record<string, unknown> = {};
            if (text(args, "content")) metadata.content = text(args, "content");
            if (text(args, "prompt")) metadata.prompt = text(args, "prompt");
            if (text(args, "groupId")) {
                if (!data.nodes.some((item) => item.id === text(args, "groupId") && item.type === "group")) throw fail(`组节点不存在：${text(args, "groupId")}`);
                metadata.groupId = text(args, "groupId");
            }
            if (reference) {
                Object.assign(metadata, outputMetadata(reference, text(args, "prompt"), ""));
                // 引用已有图片不是一次生成，别把 model 之类的生成信息写进节点。
                delete metadata.model;
            }
            const spec = specOf(type);
            const height = reference?.width && reference?.height && num(args, "height") === undefined ? Math.round((spec.width * reference.height) / reference.width) : undefined;
            return nodeSummary(appendNode(data, type, height ? { ...args, height } : args, metadata));
        });
    }

    if (name === "update_node") {
        const nodeId = text(args, "nodeId");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            const node = data.nodes.find((item) => item.id === nodeId);
            if (!node) throw fail(`节点不存在：${nodeId}`);
            if (text(args, "title")) node.title = text(args, "title");
            if (num(args, "x") !== undefined) node.position.x = num(args, "x") as number;
            if (num(args, "y") !== undefined) node.position.y = num(args, "y") as number;
            if (num(args, "width")) node.width = num(args, "width") as number;
            if (num(args, "height")) node.height = num(args, "height") as number;
            if (typeof args.content === "string" || typeof args.prompt === "string") {
                node.metadata = {
                    ...node.metadata,
                    ...(typeof args.content === "string" ? { content: args.content } : {}),
                    ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
                };
            }
            return nodeSummary(node);
        });
    }

    if (name === "delete_node") {
        const nodeId = text(args, "nodeId");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            if (!data.nodes.some((item) => item.id === nodeId)) throw fail(`节点不存在：${nodeId}`);
            data.nodes = data.nodes.filter((item) => item.id !== nodeId);
            // 悬空连线会让前端渲染出指向空气的箭头，必须一并清掉。
            const before = data.connections.length;
            data.connections = data.connections.filter((item) => item.fromNodeId !== nodeId && item.toNodeId !== nodeId);
            return { deletedNodeId: nodeId, removedConnections: before - data.connections.length };
        });
    }

    if (name === "move_nodes") {
        const nodeIds = list(args, "nodeIds");
        if (!nodeIds.length) throw fail("请指定要移动的节点");
        if (nodeIds.length > MAX_BATCH_NODES) throw fail(`一次最多移动 ${MAX_BATCH_NODES} 个节点`);
        const dx = num(args, "dx") || 0;
        const dy = num(args, "dy") || 0;
        if (!dx && !dy) throw fail("横纵偏移量至少要给一个");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            const nodes = nodeIds.map((id) => {
                const node = data.nodes.find((item) => item.id === id);
                if (!node) throw fail(`节点不存在：${id}`);
                return node;
            });
            nodes.forEach((node) => {
                node.position.x += dx;
                node.position.y += dy;
            });
            return { moved: nodes.length, dx, dy, nodes: nodes.map(nodeSummary) };
        });
    }

    if (name === "set_node_group") {
        const nodeIds = list(args, "nodeIds");
        if (!nodeIds.length) throw fail("请指定要调整归属的节点");
        if (nodeIds.length > MAX_BATCH_NODES) throw fail(`一次最多调整 ${MAX_BATCH_NODES} 个节点`);
        const groupId = text(args, "groupId");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            if (groupId && !data.nodes.some((item) => item.id === groupId && item.type === "group")) throw fail(`组节点不存在：${groupId}`);
            if (groupId && nodeIds.includes(groupId)) throw fail("组节点不能放进它自己");
            const nodes = nodeIds.map((id) => {
                const node = data.nodes.find((item) => item.id === id);
                if (!node) throw fail(`节点不存在：${id}`);
                return node;
            });
            // 节点归属靠 metadata.groupId，移出组就是把这个键删掉，留个空串前端会当成还在组里。
            nodes.forEach((node) => {
                const metadata = { ...node.metadata };
                if (groupId) metadata.groupId = groupId;
                else delete metadata.groupId;
                node.metadata = metadata;
            });
            return { groupId, changed: nodes.length, nodes: nodes.map(nodeSummary) };
        });
    }

    if (name === "connect_nodes") {
        const fromNodeId = text(args, "fromNodeId");
        const toNodeId = text(args, "toNodeId");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            if (fromNodeId === toNodeId) throw fail("不能把节点连到自己");
            for (const id of [fromNodeId, toNodeId]) if (!data.nodes.some((item) => item.id === id)) throw fail(`节点不存在：${id}`);
            const existing = data.connections.find((item) => item.fromNodeId === fromNodeId && item.toNodeId === toNodeId);
            if (existing) return { connectionId: existing.id, created: false };
            const connection = { id: newId("conn"), fromNodeId, toNodeId };
            data.connections.push(connection);
            return { connectionId: connection.id, created: true };
        });
    }

    if (name === "disconnect_nodes") {
        const fromNodeId = text(args, "fromNodeId");
        const toNodeId = text(args, "toNodeId");
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            const before = data.connections.length;
            data.connections = data.connections.filter((item) => !(item.fromNodeId === fromNodeId && item.toNodeId === toNodeId));
            if (before === data.connections.length) throw fail("这两个节点之间没有连线");
            return { removed: before - data.connections.length };
        });
    }

    if (name === "rename_canvas") return renameCanvas(ctx, args);

    if (name === "generate_image") return generateImage(ctx, args);
    if (name === "generate_video") return generateVideo(ctx, args);
    if (name === "generate_audio") return generateAudio(ctx, args);
    if (name === "generate_text") return generateTextNode(ctx, args);
    if (name === "view_image") return viewImage(ctx, args);

    if (name === "web_search") {
        if (!ctx.access.search) throw fail("未配置联网搜索");
        const { results, images } = await webSearch(text(args, "query"), num(args, "limit") || 0, ctx.signal);
        return { count: results.length, results, images };
    }

    if (name === "import_image") return importImage(ctx, args);

    if (name === "read_webpage") {
        if (!ctx.access.search) throw fail("未配置联网搜索");
        // 多要一个字符：正好读满上限和后面还有内容，只靠长度是分不出来的，多要一个才能确定是不是真被截断。
        // 上限一律以这里为准，不能指望服务商替我们截——Tavily 的 /extract 就是整篇原文都给。
        const page = await webFetch(text(args, "url"), MAX_PAGE_CHARS + 1, ctx.signal);
        const truncated = page.text.length > MAX_PAGE_CHARS;
        return {
            ...page,
            text: truncated ? page.text.slice(0, MAX_PAGE_CHARS) : page.text,
            // 明确告诉模型内容没读完，否则它会拿半篇文章当全文下结论。
            truncated,
            ...(truncated ? { note: `正文超过 ${MAX_PAGE_CHARS} 字符，这里只有开头部分，后面的内容没有读到` } : {}),
        };
    }

    throw fail(`未知工具：${name}`);
}
