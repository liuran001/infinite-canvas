import { config } from "../config";
import type { Job } from "../db/entities";
import { fail, newId } from "../lib/errors";
import { publicFileUrl } from "./files";
import { createJob, getJob, toJobView } from "./jobs";
import { webSearch } from "./search";
import { publicSettings } from "./settings";
import { readProjectCanvas, updateProjectCanvas, type CanvasNodeData, type CanvasProjectData } from "./sync";

/** 工具描述用 JSON Schema 表达，OpenAI 与 Gemini 两种格式都能直接套用，不用各写一份。 */
export type AgentTool = { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required: string[] } };

export type ToolContext = { userId: string; projectId: string; sessionId: string; seq: number; signal: AbortSignal };

/** 与 web/src/constant/canvas.ts 的 NODE_SPECS 保持一致，agent 建的节点才不会在前端显示成畸形尺寸或缺默认元数据。 */
const NODE_SPECS: Record<string, { width: number; height: number; title: string; metadata: Record<string, unknown> }> = {
    image: { width: 340, height: 240, title: "图片", metadata: { content: "", status: "idle" } },
    text: { width: 340, height: 240, title: "文本", metadata: { content: "", status: "idle", fontSize: 14 } },
    config: { width: 340, height: 240, title: "生成配置", metadata: { content: "", status: "idle", generationMode: "image" } },
    video: { width: 420, height: 236, title: "视频", metadata: { content: "", status: "idle" } },
    audio: { width: 340, height: 120, title: "音频", metadata: { content: "", status: "idle" } },
    group: { width: 760, height: 480, title: "组", metadata: { status: "idle" } },
};

const JOB_WAIT_LIMIT = 120;
const JOB_WAIT_INTERVAL_MS = 2000;
/** 单个节点回给模型的正文截断长度，画布里可能塞着整篇文章，全量喂进去会撑爆上下文。 */
const NODE_CONTENT_CHARS = 500;

const string = (description: string) => ({ type: "string", description });
const number = (description: string) => ({ type: "number", description });

export function listAgentTools(enabled: { search: boolean; image: boolean }): AgentTool[] {
    const tools: AgentTool[] = [
        { name: "read_canvas", description: "读取当前画布的全部节点、连线与结构概览。任何修改前都应先读一次拿到最新的节点 ID。", parameters: { type: "object", properties: {}, required: [] } },
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
            name: "connect_nodes",
            description: "把两个节点连起来，方向是 from → to。",
            parameters: { type: "object", properties: { fromNodeId: string("起点节点 ID"), toNodeId: string("终点节点 ID") }, required: ["fromNodeId", "toNodeId"] },
        },
        {
            name: "disconnect_nodes",
            description: "断开两个节点之间的连线。",
            parameters: { type: "object", properties: { fromNodeId: string("起点节点 ID"), toNodeId: string("终点节点 ID") }, required: ["fromNodeId", "toNodeId"] },
        },
    ];
    if (enabled.image) {
        tools.push({
            name: "generate_image",
            description: "按提示词生成图片并在画布上新建图片节点。会消耗用户的算力点与云空间，生成过程可能需要几十秒。",
            parameters: {
                type: "object",
                properties: {
                    prompt: string("生图提示词，尽量具体"),
                    count: number("生成张数，默认 1"),
                    size: string("尺寸或比例，例如 1024x1024、16:9"),
                    x: number("图片节点左上角横坐标"),
                    y: number("图片节点左上角纵坐标"),
                },
                required: ["prompt"],
            },
        });
    }
    if (enabled.search) {
        tools.push({
            name: "web_search",
            description: "联网搜索获取实时资料。需要最新信息或不确定的事实时使用。",
            parameters: { type: "object", properties: { query: string("搜索关键词"), limit: number("返回条数上限") }, required: ["query"] },
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
 * 生图复用现有任务队列：计费、配额、文件落库、幂等都沿用 jobs 那一套。
 * clientJobId 由「会话 + 消息序号」拼出来，同一次工具调用重试不会重复生成也不会重复扣费。
 */
async function generateImage(ctx: ToolContext, args: Record<string, unknown>) {
    const prompt = text(args, "prompt");
    if (!prompt) throw fail("缺少生图提示词");
    const settings = await publicSettings();
    const model = settings.modelChannel.defaultImageModel;
    if (!model) throw fail("系统未配置生图模型");

    const count = Math.max(1, Math.min(4, num(args, "count") || 1));
    const created = await createJob(ctx.userId, {
        clientJobId: `agent-${ctx.sessionId}-${ctx.seq}`,
        kind: "image",
        model,
        prompt,
        params: { count, ...(text(args, "size") ? { size: text(args, "size") } : {}) },
        inputFileIds: [],
        context: { source: "agent", projectId: ctx.projectId, sessionId: ctx.sessionId },
    });

    let job: Job = created;
    for (let attempt = 0; attempt < JOB_WAIT_LIMIT && (job.status === "pending" || job.status === "running"); attempt += 1) {
        await delay(JOB_WAIT_INTERVAL_MS, ctx.signal);
        job = await getJob(ctx.userId, created.id);
    }
    if (job.status === "failed" || job.status === "canceled") throw fail(job.error || "生图失败");
    if (job.status !== "succeeded") throw fail("生图超时，请稍后在画布上查看任务结果");

    const outputs = (await toJobView(job)).outputs;
    if (!outputs.length) throw fail("生图没有返回结果");
    return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
        const nodes = outputs.map((file, index) => {
            const spec = specOf("image");
            // 图片节点尊重原图比例，只在宽度上对齐默认尺寸。
            const height = file.width && file.height ? Math.round((spec.width * file.height) / file.width) : spec.height;
            return appendNode(
                data,
                "image",
                { ...args, x: num(args, "x") === undefined ? undefined : (num(args, "x") as number) + index * (spec.width + 40), height },
                {
                    storageKey: `server:${file.id}`,
                    // 前端会用 storageKey 重新解析直链，没配公网地址时留空即可。
                    content: config.publicBaseUrl ? publicFileUrl(config.publicBaseUrl, file.id) : "",
                    status: "success",
                    prompt,
                    model,
                    naturalWidth: file.width,
                    naturalHeight: file.height,
                    mimeType: file.mimeType,
                    bytes: file.bytes,
                },
            );
        });
        return { jobId: job.id, model, credits: job.credits, nodes: nodes.map(nodeSummary) };
    });
}

export async function runAgentTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "read_canvas") {
        const project = await readProjectCanvas(ctx.userId, ctx.projectId);
        return { projectId: ctx.projectId, title: project.title, revision: project.revision, nodeCount: project.data.nodes.length, nodes: project.data.nodes.map(nodeSummary), connections: project.data.connections };
    }

    if (name === "create_node") {
        const type = text(args, "type") || "text";
        if (!NODE_SPECS[type]) throw fail(`不支持的节点类型：${type}`);
        return updateProjectCanvas(ctx.userId, ctx.projectId, (data) => {
            const metadata: Record<string, unknown> = {};
            if (text(args, "content")) metadata.content = text(args, "content");
            if (text(args, "prompt")) metadata.prompt = text(args, "prompt");
            return nodeSummary(appendNode(data, type, args, metadata));
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

    if (name === "generate_image") return generateImage(ctx, args);

    if (name === "web_search") {
        const results = await webSearch(text(args, "query"), num(args, "limit") || 0, ctx.signal);
        return { count: results.length, results };
    }

    throw fail(`未知工具：${name}`);
}
