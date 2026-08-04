import { EventEmitter } from "node:events";
import { MoreThan, Not } from "typeorm";

import { repo } from "../db/data-source";
import { AgentMessage, AgentSession, type AgentMessageRole, type AgentPendingAction, type AgentSessionStatus } from "../db/entities";
import { fail, newId, NOT_FOUND, now, SafeError } from "../lib/errors";
import { readUpstreamSse, upstreamJson, upstreamStream } from "../lib/upstream";
import { fileIdOfStorageKey, listAgentTools, runAgentTool, storageKeyOf, type AgentTool, type AgentToolAccess, type ToolState } from "./agent-tools";
import { charge, payerOfProject, payerOfSession, refund, type ChargeReceipt } from "./billing";
import { listFiles } from "./files";
import { fileToBase64 } from "./generation";
import { getAgentGenerationPreference } from "./preferences";
import { searchConfig } from "./search";
import { buildChannelUrl, modelCost, modelSupportsVision, publicSettings, selectModelChannel, type ModelChannel, type PublicSetting } from "./settings";
import { readProjectCanvas, renameProjectCanvas } from "./sync";

/** 用户从画布拖进面板的节点引用。只带 ID / 类型 / 标题，内容让模型自己按需去取。 */
export type AgentMessageReference = { nodeId: string; type: string; title: string; storageKey?: string };
export type AgentSessionView = {
    id: string;
    projectId: string;
    title: string;
    status: AgentSessionStatus;
    model: string;
    error: string;
    /** 待用户确认的请求，没有时为 null。前端据此弹确认框，刷新或换设备后照样能拿到同一个请求。 */
    pendingAction: AgentPendingAction | null;
    lastSeq: number;
    createdAt: string;
    updatedAt: string;
};
export type AgentMessageView = { seq: number; role: AgentMessageRole; content: string; toolName: string; toolArgs: string; toolResult: string; attachments: string[]; references: AgentMessageReference[]; createdAt: string };
/** status 事件顺带把标题与待确认请求一起推出去：这两样都会在执行过程中变，而前端不该为它们再轮询一次会话。 */
export type AgentEvent = { type: "message"; message: AgentMessageView } | { type: "status"; status: AgentSessionStatus; error: string; title: string; pendingAction: AgentPendingAction | null };

type ToolCall = { name: string; args: Record<string, unknown> };
type ModelReply = { content: string; toolCalls: ToolCall[] };
/** 进上下文的图片，一份数据同时喂给 OpenAI（data url）和 Gemini（inlineData 裸 base64）。 */
type ContextImage = { mimeType: string; base64: string };

const MAX_MESSAGES = 500;
const MODEL_TIMEOUT_MS = 180000;
/** 一条消息最多带几张图，再多既费钱也没什么用。 */
const MAX_ATTACHMENTS = 6;
/** 一条消息最多引用几个画布节点。 */
const MAX_REFERENCES = 10;
/**
 * 上下文里最多保留几张图。图片进上下文后每一轮都要重算 token，一次对话可能跑到几十轮，
 * 所以只保留最近看过 / 最近上传的这几张，更早的图退化成纯文字记录。
 */
const MAX_CONTEXT_IMAGES = 6;
/**
 * 会话标题的字数上限。标题只用来在会话列表里认出这是哪一次对话，列表宽度就那么点，
 * 再长也会被省略号截掉；给模型一个明确的短上限，它才不会写成一句完整的话。
 */
const MAX_TITLE_CHARS = 16;
/** 生成标题的超时。它只是个锦上添花的东西，卡住就该放手用截断兜底，不能拖着发消息这条主链路。 */
const TITLE_TIMEOUT_MS = 20000;

/**
 * 推理循环跑在服务端后台，不依赖前端连接：SSE 断了这里照样跑完并落库。
 * 这个表只用来「有人在线时顺带推一把」，没人订阅时事件直接丢弃也不影响正确性。
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);
const running = new Map<string, AbortController>();

const sessions = () => repo(AgentSession);
const messages = () => repo(AgentMessage);
const busKey = (userId: string, sessionId: string) => `${userId}:${sessionId}`;

function toSessionView(row: AgentSession): AgentSessionView {
    return {
        id: row.sessionId,
        projectId: row.projectId,
        title: row.title,
        status: row.status,
        model: row.model,
        error: row.error || "",
        pendingAction: row.pendingAction || null,
        lastSeq: row.lastSeq,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function toMessageView(row: AgentMessage): AgentMessageView {
    return {
        seq: row.seq,
        role: row.role,
        content: row.content || "",
        toolName: row.toolName || "",
        toolArgs: row.toolArgs || "",
        toolResult: row.toolResult || "",
        attachments: row.attachments || [],
        references: row.references || [],
        createdAt: row.createdAt,
    };
}

export function subscribeAgentSession(userId: string, sessionId: string, listener: (event: AgentEvent) => void) {
    const key = busKey(userId, sessionId);
    bus.on(key, listener);
    return () => void bus.off(key, listener);
}

async function loadSession(userId: string, sessionId: string) {
    const row = await sessions().findOneBy({ userId, sessionId });
    // 必须带上 404/NOT_FOUND：默认的 code=1 到了前端只是「操作失败」，实时频道会把它当成可重试的错误，
    // 于是一个已删除或本来就不属于这个人的会话会被无限重订，每次都换一张票再拿一次同样的拒绝。
    if (!row || row.deleted) throw fail("会话不存在", 404, NOT_FOUND);
    return row;
}

async function patchSession(session: AgentSession, patch: Partial<AgentSession>) {
    Object.assign(session, patch, { updatedAt: now() });
    // 用 update 而不是 save：循环还在跑时会话可能已被删除，整行覆写会把软删除标记又抹回去。
    await sessions().update({ userId: session.userId, sessionId: session.sessionId }, { ...patch, updatedAt: session.updatedAt });
    // 状态、标题、待确认请求都是前端要立刻看到的，任意一样变了就推一次；轮数这类内部计数不推。
    if (patch.status || patch.title !== undefined || patch.pendingAction !== undefined) {
        bus.emit(busKey(session.userId, session.sessionId), { type: "status", status: session.status, error: session.error || "", title: session.title, pendingAction: session.pendingAction || null } satisfies AgentEvent);
    }
    return session;
}

/** 每落一条就广播一次，前端在线时看到的进度和数据库完全一致，断线重连用 sinceSeq 也能补齐同一批。 */
async function appendMessage(session: AgentSession, role: AgentMessageRole, patch: Partial<AgentMessage>) {
    const seq = session.lastSeq + 1;
    const row = await messages().save({
        userId: session.userId,
        sessionId: session.sessionId,
        seq,
        role,
        content: "",
        toolName: "",
        toolArgs: "",
        toolResult: "",
        attachments: [],
        references: [],
        clientMessageId: "",
        createdAt: now(),
        ...patch,
    } as AgentMessage);
    await patchSession(session, { lastSeq: seq });
    bus.emit(busKey(session.userId, session.sessionId), { type: "message", message: toMessageView(row) } satisfies AgentEvent);
    return row;
}

export async function listAgentSessions(userId: string, projectId: string) {
    const rows = await sessions().find({ where: { userId, deleted: false, ...(projectId ? { projectId } : {}) }, order: { updatedAt: "DESC" }, take: 200 });
    return rows.map(toSessionView);
}

export async function getAgentSession(userId: string, sessionId: string) {
    return toSessionView(await loadSession(userId, sessionId));
}

/**
 * 定这个会话该用哪个模型。用户选的优先，但必须是「已启用渠道里 capability 为 text」的模型：
 * 放行生图模型或没配过的模型，既会在上游直接报错，也会绕开按模型单价计费的口径。
 * 校验不通过时静默回落到管理员配置的默认，而不是报错——管理员随时可能下线某个模型，
 * 用户偏好里存着的旧选择会跟着失效，这时候把会话卡死比换个模型跑完更糟。
 */
function resolveAgentModel(settings: PublicSetting, preferred: string) {
    const name = preferred.trim();
    if (name && settings.modelChannel.models.some((model) => model.name === name && model.capability === "text")) return name;
    return settings.agent.model || settings.modelChannel.defaultTextModel;
}

/** 会话必须绑定一个存在的画布，否则工具改不到任何东西。 */
export async function createAgentSession(userId: string, input: { sessionId: string; projectId: string; title: string; model: string }) {
    const settings = await publicSettings();
    if (!settings.agent.enabled || !settings.capabilities.text) throw fail("画布 Agent 未开放");
    const projectId = input.projectId.trim();
    if (!projectId) throw fail("缺少画布项目 ID");
    await readProjectCanvas(userId, projectId);
    // 画布已经按 userId 核对过，这里按它的持久归属固化付费方，同一会话所有轮次都沿用它。
    const payer = await payerOfProject(userId, projectId);

    const model = resolveAgentModel(settings, input.model);
    if (!model) throw fail("系统未配置 Agent 使用的文本模型");
    const sessionId = input.sessionId.trim() || newId("agent");
    const saved = await sessions().findOneBy({ userId, sessionId });
    if (saved && !saved.deleted) return toSessionView(saved);
    // 复用已删会话的 ID 时要先清掉旧消息，否则 seq 从 1 重新开始会和残留记录撞主键。
    if (saved) await messages().delete({ userId, sessionId });

    const row = await sessions().save({
        userId,
        sessionId,
        projectId,
        title: input.title.trim() || "新会话",
        status: "idle",
        model,
        error: "",
        pendingAction: null,
        rounds: 0,
        autoRenamed: false,
        lastSeq: 0,
        deleted: false,
        payerKind: payer.kind,
        payerTeamId: payer.kind === "team" ? payer.teamId : "",
        payerLogId: "",
        payerCredits: 0,
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as AgentSession);
    return toSessionView(row);
}

/** 软删除，正在跑的循环一并中止，避免删掉会话后还在后台烧算力点。 */
export async function deleteAgentSession(userId: string, sessionId: string) {
    const row = await sessions().findOneBy({ userId, sessionId });
    if (!row) return;
    running.get(busKey(userId, sessionId))?.abort();
    await sessions().save({ ...row, deleted: true, status: "idle", updatedAt: now() });
}

export async function listAgentMessages(userId: string, sessionId: string, sinceSeq: number) {
    await loadSession(userId, sessionId);
    const rows = await messages().find({
        where: { userId, sessionId, ...(sinceSeq > 0 ? { seq: MoreThan(sinceSeq) } : {}) },
        order: { seq: "ASC" },
        take: MAX_MESSAGES,
    });
    return rows.map(toMessageView);
}

/**
 * 中止。running 时靠内存里的信号打断循环，awaiting 时循环早就退出了、内存里没有东西可打断，
 * 只能直接把待确认请求清掉收尾——不处理的话这个会话会一直卡在等确认，中止按钮等于没用。
 */
export async function abortAgentSession(userId: string, sessionId: string) {
    const session = await loadSession(userId, sessionId);
    running.get(busKey(userId, sessionId))?.abort();
    if (session.status === "awaiting") {
        await appendMessage(session, "assistant", { content: "已中止本次执行。" });
        await patchSession(session, { status: "idle", error: "", pendingAction: null });
    }
    return toSessionView(session);
}

function systemPrompt(projectId: string, extra: string, access: AgentToolAccess, remainingRounds: number, maxRounds: number) {
    const base = [
        "你是无限画布应用里的画布助手，可以直接读写用户当前打开的画布。",
        `当前画布项目 ID 是 ${projectId}。`,
        "修改画布前先调用 read_canvas 拿到最新的节点 ID，不要凭记忆猜 ID。",
        "画布上的图片、视频、音频统一用形如 server:xxx 的 storageKey 引用；用户上传的图片也会在消息里给出它的 storageKey，需要用到时照抄即可，不要自己编。",
        // 引用标记的位置本身有语义（「把 A 放到 B 右边」），必须把格式讲清楚，模型才知道哪个引用对应句子里的哪个位置。
        "用户消息里形如 @[标题](canvas-node:节点ID#节点类型) 的片段是他从画布拖进来的节点引用，出现在哪个位置就代表那句话的那个位置指的是这个节点，同一个节点可以在一句话里出现多次。",
        // 拖进来的引用只有 ID：明确告诉模型要自己去取内容，否则它会以为自己已经看过了。
        "引用只是在指认对象，不带任何节点内容，也不代表你已经看过它；需要内容就自己去 read_canvas，需要看图再调用看图工具。",
        ...(access.vision ? ["read_canvas 只返回结构不返回图片，确实需要看图时才调用 view_image；图片会占用后续每一轮的上下文，不要无差别地把所有图都看一遍。"] : []),
        // 轮数是硬预算，模型看得见才能规划：只剩两三轮时该先把最要紧的做完，而不是开一个做不完的新任务。
        `本次执行最多 ${maxRounds} 轮，含这一轮还剩 ${remainingRounds} 轮。轮数用完会暂停下来向用户申请继续（要再花一次算力点），所以请按剩余轮数安排：先做最要紧的事，快用完时先收尾并说明进度，不要开一个明显做不完的新任务。`,
        "一次只做用户要求的事，做完用中文简要说明改了什么。",
        "工具调用失败时把失败原因如实转述给用户，不要假装成功。",
    ].join("\n");
    return extra.trim() ? `${base}\n\n${extra.trim()}` : base;
}

function parseArgs(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value || "{}") as unknown;
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** view_image 成功后把 storageKey 记在工具结果里，重建上下文时据此把那张图重新塞回去。只认这个工具，别的工具结果里也有 storageKey。 */
function viewedFileId(row: AgentMessage) {
    if (row.role !== "tool" || row.toolName !== "view_image") return "";
    try {
        const parsed = JSON.parse(row.toolResult || "{}") as { ok?: boolean; data?: { storageKey?: string } };
        return parsed.ok && typeof parsed.data?.storageKey === "string" ? fileIdOfStorageKey(parsed.data.storageKey) : "";
    } catch {
        return "";
    }
}

/**
 * 要带进上下文的图片：只有「用户主动上传的附件」和「模型主动调 view_image 看过的图」两种来源。
 * 画布结构、拖进来的节点引用一律不带图——图片进上下文后每一轮都要重算 token，一次对话可能几十轮。
 * 同理只保留最近的几张，更早的图退化成纯文字记录。
 */
async function loadContextImages(userId: string, history: AgentMessage[], vision: boolean) {
    const images = new Map<string, ContextImage>();
    if (!vision) return images;
    const ids: string[] = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const row = history[index];
        const rowIds = row.role === "user" ? row.attachments || [] : [viewedFileId(row)];
        for (const id of rowIds) if (id && !ids.includes(id)) ids.push(id);
    }
    const wanted = ids.slice(0, MAX_CONTEXT_IMAGES);
    if (!wanted.length) return images;
    for (const file of await listFiles(userId, wanted)) images.set(file.id, { mimeType: file.mimeType, base64: await fileToBase64(file) });
    return images;
}

/**
 * 用户消息的纯文字部分。附件与画布引用各自在正文后面附一行：
 * 附件给出 storageKey，模型可以直接拿去建节点或生图；引用只给节点 ID 与类型，内容让它自己 read_canvas / view_image 去取。
 */
function userText(row: AgentMessage) {
    const lines = [row.content || ""];
    const attachments = row.attachments || [];
    if (attachments.length) lines.push(`[用户上传的图片] ${attachments.map(storageKeyOf).join(" ")}`);
    const references = row.references || [];
    if (references.length) lines.push(`[用户引用的画布节点] ${references.map((item) => `${item.nodeId}(${item.type}${item.title ? ` ${item.title}` : ""})`).join(" ")}`);
    return lines.filter((line) => line.trim()).join("\n\n");
}

function toOpenAiMessages(system: string, history: AgentMessage[], images: Map<string, ContextImage>) {
    // Chat Completions 的图片部分是 image_url + data url。generation.ts 里的 input_image 是 Responses 接口的写法，两个接口不能混用。
    const imagePart = (image: ContextImage) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}` } });
    const list: Array<Record<string, unknown>> = [{ role: "system", content: system }];
    for (const row of history) {
        if (row.role === "user") {
            const parts = (row.attachments || []).flatMap((id) => (images.has(id) ? [imagePart(images.get(id) as ContextImage)] : []));
            list.push(parts.length ? { role: "user", content: [{ type: "text", text: userText(row) }, ...parts] } : { role: "user", content: userText(row) });
        } else if (row.role === "assistant") list.push({ role: "assistant", content: row.content || "" });
        else {
            // 工具调用与结果按 seq 一一对应地还原，重连或重启后重建上下文不用额外存 tool_call_id。
            const id = `call_${row.seq}`;
            list.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: row.toolName, arguments: row.toolArgs || "{}" } }] });
            list.push({ role: "tool", tool_call_id: id, content: row.toolResult || "" });
            // tool 消息只能放文本，看到的图只能作为紧随其后的用户消息补进去。
            const viewed = images.get(viewedFileId(row));
            if (viewed) list.push({ role: "user", content: [{ type: "text", text: "上一步查看的图片内容如下。" }, imagePart(viewed)] });
        }
    }
    return list;
}

type OpenAiPayload = { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };

/**
 * 流式返回的增量块。tool_calls 按 index 分槽下发：name 通常只在第一块出现，
 * arguments 是一串 JSON 片段，必须按槽拼回去才能得到完整参数。
 */
type OpenAiChunk = {
    choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
    error?: { message?: string };
};

/**
 * 一律走流式，哪怕这里并不需要逐字输出。
 *
 * 原因是非流式那条路在真实网关上并不可靠：实测某中转的 gpt-5.6 系列在收到 tools 之后，
 * 非流式响应回的是 `{"role":"assistant","content":""}`——没有 tool_calls，可 usage 里明明记着
 * 32 个输出 token，也就是模型确实生成了工具调用，是网关在转换非流式响应时把它丢了。
 * 同一个请求加上 stream:true 就能完整拿到 tool_calls。这类网关很常见，而症状是 Agent
 * 转一会儿就毫无动静，最难查。流式是 OpenAI 的标准能力，没有理由为了省几行聚合代码去踩它。
 */
async function callOpenAi(channel: ModelChannel, model: string, system: string, history: AgentMessage[], images: Map<string, ContextImage>, tools: AgentTool[], signal: AbortSignal): Promise<ModelReply> {
    const body = await upstreamStream(
        buildChannelUrl(channel, "/chat/completions"),
        {
            method: "POST",
            headers: { Authorization: `Bearer ${channel.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({ model, messages: toOpenAiMessages(system, history, images), stream: true, ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}) }),
            signal,
        },
        "Agent 模型调用失败",
    );

    let content = "";
    // 用 Map 而不是数组：index 不保证从 0 连续，缺一个就会把两个工具调用的参数拼到一起。
    const calls = new Map<number, { name: string; args: string }>();
    await readUpstreamSse(body, (data) => {
        const chunk = JSON.parse(data) as OpenAiChunk;
        if (chunk.error?.message) throw fail(chunk.error.message);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string") content += delta.content;
        for (const call of delta.tool_calls || []) {
            const index = typeof call.index === "number" ? call.index : 0;
            const slot = calls.get(index) || { name: "", args: "" };
            if (call.function?.name) slot.name = call.function.name;
            if (call.function?.arguments) slot.args += call.function.arguments;
            calls.set(index, slot);
        }
    });

    return {
        content: content.trim(),
        toolCalls: [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => ({ name: call.name.trim(), args: parseArgs(call.args) }))
            .filter((call) => call.name),
    };
}

/** Gemini 的 Schema.type 用大写枚举，直接把 JSON Schema 的小写类型透传会被拒。 */
function toGeminiSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) return schema.map(toGeminiSchema);
    if (!schema || typeof schema !== "object") return schema;
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "type" && typeof value === "string" ? value.toUpperCase() : toGeminiSchema(value)]));
}

type GeminiPart = { text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } };
type GeminiPayload = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }>; promptFeedback?: { blockReason?: string } };

function toGeminiContents(history: AgentMessage[], images: Map<string, ContextImage>) {
    // Gemini 的图片部分是 inlineData + 裸 base64，和 OpenAI 的 data url 是两套写法。
    const imagePart = (image: ContextImage) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } });
    const contents: Array<{ role: string; parts: unknown[] }> = [];
    for (const row of history) {
        if (row.role === "user") {
            const parts = (row.attachments || []).flatMap((id) => (images.has(id) ? [imagePart(images.get(id) as ContextImage)] : []));
            contents.push({ role: "user", parts: [{ text: userText(row) }, ...parts] });
        } else if (row.role === "assistant") contents.push({ role: "model", parts: [{ text: row.content || "" }] });
        else {
            contents.push({ role: "model", parts: [{ functionCall: { name: row.toolName, args: parseArgs(row.toolArgs) } }] });
            const viewed = images.get(viewedFileId(row));
            contents.push({
                role: "user",
                parts: [{ functionResponse: { name: row.toolName, response: { result: row.toolResult || "" } } }, ...(viewed ? [imagePart(viewed)] : [])],
            });
        }
    }
    return contents;
}

function geminiUrl(channel: ModelChannel, model: string) {
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const lower = baseUrl.toLowerCase();
    const versioned = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? baseUrl : `${baseUrl}/v1beta`;
    return `${versioned}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
}

async function callGemini(channel: ModelChannel, model: string, system: string, history: AgentMessage[], images: Map<string, ContextImage>, tools: AgentTool[], signal: AbortSignal): Promise<ModelReply> {
    const declarations = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // 没有参数的工具不能带空 parameters，Gemini 会判成非法的函数声明。
        ...(Object.keys(tool.parameters.properties).length ? { parameters: toGeminiSchema(tool.parameters) } : {}),
    }));
    const payload = await upstreamJson<GeminiPayload>(
        geminiUrl(channel, model),
        {
            method: "POST",
            headers: { "x-goog-api-key": channel.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: toGeminiContents(history, images),
                systemInstruction: { parts: [{ text: system }] },
                ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
            }),
            signal,
        },
        "Agent 模型调用失败",
    );
    if (payload.promptFeedback?.blockReason) throw fail(`Gemini 拒绝了该请求：${payload.promptFeedback.blockReason}`);
    const parts = payload.candidates?.[0]?.content?.parts || [];
    return {
        content: parts
            .map((part) => part.text || "")
            .join("")
            .trim(),
        toolCalls: parts.filter((part) => part.functionCall?.name).map((part) => ({ name: String(part.functionCall?.name), args: part.functionCall?.args || {} })),
    };
}

/**
 * 单次模型调用。计费不在这里：口径是「用户每发一条消息扣一次」，
 * 一条消息触发的所有轮次共用那一次扣费，扣与返还都在 sendAgentMessage / runSession 里做。
 */
async function callModel(channel: ModelChannel, model: string, system: string, history: AgentMessage[], images: Map<string, ContextImage>, tools: AgentTool[], signal: AbortSignal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]);
    return channel.apiFormat === "gemini" ? callGemini(channel, model, system, history, images, tools, timeout) : callOpenAi(channel, model, system, history, images, tools, timeout);
}

/** 超长会话只带最近的一批：倒序取再翻回来，丢掉的是最老的消息而不是刚发生的进度。 */
async function loadHistory(userId: string, sessionId: string) {
    const rows = await messages().find({ where: { userId, sessionId }, order: { seq: "DESC" }, take: MAX_MESSAGES });
    return rows.reverse();
}

/**
 * 工具门禁。搜索看有没有配 key，生成类看能力开关加默认模型，看图看模型有没有被标注支持视觉。
 * 同一份开关既用来决定下发哪些工具，也在执行时再校验一次，前端和模型都绕不过去。
 */
async function toolAccess(settings: PublicSetting, model: string): Promise<AgentToolAccess> {
    return {
        search: Boolean(await searchConfig()),
        image: settings.capabilities.image && Boolean(settings.modelChannel.defaultImageModel),
        video: settings.capabilities.video && Boolean(settings.modelChannel.defaultVideoModel),
        audio: settings.capabilities.audio && Boolean(settings.modelChannel.defaultAudioModel),
        text: settings.capabilities.text && Boolean(settings.modelChannel.defaultTextModel),
        vision: modelSupportsVision(settings, model),
    };
}

/**
 * 推理循环。返回 true 表示「停下来等用户确认」，此时状态已经落成 awaiting，调用方不能再把它改回 idle。
 * 轮数计数落在会话行上而不是局部变量里：等待确认可能持续很久甚至跨越好几次请求，
 * 只记在内存里的话，用户点了同意之后轮数预算就对不上了。
 */
async function runLoop(session: AgentSession, signal: AbortSignal) {
    const settings = await publicSettings();
    const channel = await selectModelChannel(session.model);
    const access = await toolAccess(settings, session.model);
    const tools = listAgentTools(access);
    // 用户的「Agent 生成默认设置」整段执行只读一次库：一次执行里生成类工具可能被调很多次，
    // 每次都查一遍纯属白花开销，而偏好在跑的过程中改了也不该半路换规格——改动下一条消息就会生效。
    const prefs = await getAgentGenerationPreference(session.userId);
    // 工具要读「主动改标题的额度还在不在」，也要能把待确认请求写出来，统一放在这份状态里由循环负责落库。
    const state: ToolState = { autoRenamed: session.autoRenamed };

    while (session.rounds < settings.agent.maxRounds) {
        if (signal.aborted) throw fail("已中止");
        const system = systemPrompt(session.projectId, settings.modelChannel.systemPrompt, access, settings.agent.maxRounds - session.rounds, settings.agent.maxRounds);
        // 先把这一轮记账再调模型：中途崩了也不会白送一轮，恢复后剩余轮数仍然是对的。
        await patchSession(session, { rounds: session.rounds + 1 });
        const history = await loadHistory(session.userId, session.sessionId);
        const images = await loadContextImages(session.userId, history, access.vision);
        const reply = await callModel(channel, session.model, system, history, images, tools, signal);
        if (reply.content) await appendMessage(session, "assistant", { content: reply.content });
        if (!reply.toolCalls.length) {
            // 一句话没说、一个工具没调，这不是「做完了」，是这一轮什么都没发生。
            // 静默收工的话，用户看到的就是转一会儿然后一切如常：没有结果，没有报错，也没有任何线索，
            // 而真正的原因（模型不支持工具调用、网关把响应转坏了、上游把内容吞了）恰恰是他排查得动的。
            if (!reply.content) throw fail(`模型「${session.model}」这一轮什么都没有返回：既没有回复内容，也没有调用工具。可能是它不支持工具调用，或者上游网关没有把响应正确转回来；换一个模型再试，或联系管理员检查该模型的渠道配置。`);
            return false;
        }

        for (const call of reply.toolCalls) {
            const args = JSON.stringify(call.args);
            // 先占好 seq 再执行：工具跑得慢时前端也能立刻看到「正在调用哪个工具」。
            const row = await appendMessage(session, "tool", { toolName: call.name, toolArgs: args });
            const result = await runAgentTool({ userId: session.userId, projectId: session.projectId, sessionId: session.sessionId, seq: row.seq, access, prefs, state, signal }, call.name, call.args).then(
                (value) => JSON.stringify({ ok: true, data: value ?? null }),
                // 工具报错不终止循环，把错误回灌给模型，让它自己换个做法或如实告诉用户。
                (error: unknown) => JSON.stringify({ ok: false, error: error instanceof SafeError ? error.message : "工具执行失败" }),
            );
            row.toolResult = result;
            await messages().save(row);
            bus.emit(busKey(session.userId, session.sessionId), { type: "message", message: toMessageView(row) } satisfies AgentEvent);
            // 主动改标题的额度一旦用掉就立刻落库，否则同一次执行里模型还能再改一次。
            if (state.autoRenamed && !session.autoRenamed) await patchSession(session, { autoRenamed: true });
            if (state.action) {
                await appendMessage(session, "assistant", { content: `已请求把画布标题改成「${state.action.type === "rename_canvas" ? state.action.title : ""}」，等你确认后再改。` });
                await patchSession(session, { status: "awaiting", error: "", pendingAction: state.action });
                return true;
            }
        }
    }

    // 轮数耗尽不再直接收工，而是把「要不要接着跑」交给用户：接着跑要按当前模型单价再扣一次点。
    const credits = await modelCost(session.model);
    await appendMessage(session, "assistant", { content: `已经用完本次的 ${settings.agent.maxRounds} 轮执行。继续会重置轮数并再消耗 ${credits} 算力点，需要我接着做吗？` });
    await patchSession(session, { status: "awaiting", error: "", pendingAction: { type: "continue", roundsUsed: session.rounds, credits } });
    return true;
}

/**
 * 会话行上「已扣未结」的那一笔。退款只认它，不认内存里的回执：
 * 循环可能跨进程重启才走到退款，那时内存里的回执早没了，而钱是必须退的。
 */
function outstandingReceipt(session: AgentSession): ChargeReceipt {
    return { payer: payerOfSession(session), credits: session.payerCredits || 0, logId: session.payerLogId || "" };
}

/**
 * 扣费并把回执落到会话行上，两件事同一个事务：
 * 分两步做的话，进程崩在中间就是钱扣了、会话行上却查不到那笔流水，重启时既退不掉也没人认领。
 * 用 charge 的 persist 回调而不是在外面套一层事务：套在外面的话，团队池不足时 charge 抛出的错
 * 会把同事务里刚写下的 insufficient 留痕一起回滚。
 *
 * 一行只放得下一笔回执，所以扣新的一笔之前必须先把上一笔结清。
 * 上一笔退不掉就拒绝这次扣费：直接覆盖等于抹掉那笔钱唯一的线索，从此谁都退不回去；
 * 让用户稍后重试，最坏是这次发不出消息，而不是永久吞掉他上一次的钱。
 */
async function chargeSession(session: AgentSession, model: string, credits: number): Promise<ChargeReceipt> {
    if (session.payerCredits > 0 && session.payerLogId) {
        if (!(await settleRefund(session, session.model || model))) throw fail("上一次执行扣掉的算力点还没退回来，请稍后再试");
        await clearOutstanding(session);
    }
    // 零额不写回执。更要紧的是不能拿它去清行上的回执：那不是一次结清，只是把线索抹掉。
    if (credits <= 0) return { payer: payerOfSession(session), credits: 0, logId: "" };
    return charge(payerOfSession(session), credits, { model, path: "/agent" }, async (manager, receipt) => {
        await manager.getRepository(AgentSession).update({ userId: session.userId, sessionId: session.sessionId }, { payerLogId: receipt.logId, payerCredits: receipt.credits });
        session.payerLogId = receipt.logId;
        session.payerCredits = receipt.credits;
    });
}

/** 结清：执行成功、或退款成功之后，都必须把这两列清掉，否则下一次重启会把同一笔当成未结的再处理一遍。 */
async function clearOutstanding(session: AgentSession) {
    if (!session.payerLogId && !session.payerCredits) return;
    session.payerLogId = "";
    session.payerCredits = 0;
    await sessions().update({ userId: session.userId, sessionId: session.sessionId }, { payerLogId: "", payerCredits: 0 });
}

/**
 * 退掉会话行上「已扣未结」的那一笔，返回这笔账是不是已经结清。
 * 只有 refund 正常返回（真退了，或撞唯一约束说明早已退过）才算结清；抛错一律算没结清，
 * 此时必须原样保留回执——清掉就等于抹掉这笔钱唯一的线索，再也没人退得了。
 */
async function settleRefund(session: AgentSession, model: string) {
    if (!(session.payerCredits > 0 && session.payerLogId)) return true;
    try {
        await refund(outstandingReceipt(session), { model, path: "/agent" });
        return true;
    } catch (error) {
        console.error(`agent session ${session.sessionId} refund failed:`, error);
        return false;
    }
}

/** 失败或中止时把这条消息扣的那一次点原路返还；跑了多少轮都只返还这一次。 */
async function runSession(session: AgentSession, model: string) {
    const key = busKey(session.userId, session.sessionId);
    const controller = new AbortController();
    running.set(key, controller);
    try {
        // 停下来等确认时状态已经是 awaiting，这里不能再覆写成 idle，否则前端刚弹出的确认框会立刻消失。
        const awaiting = await runLoop(session, controller.signal);
        // 跑到这里就是这一段执行已经交付了（要么收工、要么停在等确认），那笔钱不再退。
        await clearOutstanding(session).catch(() => undefined);
        if (!awaiting) await patchSession(session, { status: "idle", error: "" });
    } catch (error) {
        const aborted = controller.signal.aborted;
        if (!aborted) console.error(`agent session ${session.sessionId} failed:`, error);
        // 退款只认会话行上固化的回执：这一轮跑的过程中用户可能已经被移出团队，重新解析会把团队的钱退进个人余额。
        // 退不成就把回执留在行上，下次启动的扫描会再退一次，绝不吞掉异常后把它清空。
        if (await settleRefund(session, model)) await clearOutstanding(session).catch(() => undefined);
        const message = error instanceof SafeError ? error.message : "Agent 执行失败，请稍后重试";
        await appendMessage(session, "assistant", { content: aborted ? "已中止本次执行。" : message }).catch(() => undefined);
        await patchSession(session, { status: aborted ? "idle" : "failed", error: aborted ? "" : message, pendingAction: null }).catch(() => undefined);
    } finally {
        running.delete(key);
    }
}

/**
 * 处理用户对待确认请求的答复。批准就接着跑，拒绝就正常收尾。
 * 两种请求共用这一个出口：它们的交互是同一套，分开写两个接口只会让前端各对接一遍。
 */
export async function resolveAgentSession(userId: string, sessionId: string, approved: boolean) {
    const session = await loadSession(userId, sessionId);
    const action = session.pendingAction;
    if (session.status !== "awaiting" || !action) throw fail("当前没有待确认的请求");

    if (!approved) {
        await appendMessage(session, "assistant", { content: action.type === "continue" ? "好的，本次执行到此为止。" : "好的，画布标题保持不变。" });
        await patchSession(session, { status: "idle", error: "", pendingAction: null });
        return toSessionView(session);
    }

    if (action.type === "rename_canvas") {
        await renameProjectCanvas(userId, session.projectId, action.title);
        await appendMessage(session, "assistant", { content: `已把画布标题改成「${action.title}」。` });
        // 轮数不重置：改个标题不该顺带送一整轮预算，接着用剩下的额度把原来的事做完。
        await patchSession(session, { status: "running", error: "", pendingAction: null });
        // 改标题不扣费，会话行上的 outstanding 也已经在上一段执行收尾时清空，这里不需要再扣一次。
        void runSession(session, session.model);
        return toSessionView(session);
    }

    // 续跑是用户明确要求的新一段执行，所以按当前模型单价重新扣一次点；余额不够就明确拒绝，不偷偷放行。
    const credits = await modelCost(session.model);
    await chargeSession(session, session.model, credits);
    await appendMessage(session, "assistant", { content: "好的，继续执行。" });
    await patchSession(session, { status: "running", error: "", pendingAction: null, rounds: 0 });
    void runSession(session, session.model);
    return toSessionView(session);
}

/**
 * 消息里的画布节点引用标记。用户把节点拖进输入框时插在光标处，位置本身有语义：
 * 「把 @[图片1](canvas-node:image-1#image) 放到 @[图片2](canvas-node:image-2#image) 右边」里两个引用指的是句中不同位置。
 * 标记只带 ID 与类型，不带任何内容，更不带图片。
 */
const REFERENCE_PATTERN = /@\[([^\]]*)\]\(canvas-node:([^)]+)\)/g;

function referenceMarker(nodeId: string, type: string, title: string) {
    return `@[${title || type}](canvas-node:${nodeId}#${type})`;
}

/**
 * 校验并归一化正文里的节点引用：客户端传来的标题与类型一律不信，按当前画布重写一遍。
 * 客户端也可以只给 references 不在正文里插标记（例如整条消息统一附上几个节点），
 * 这类引用在句子里没有位置，按顺序补到正文末尾，模型看到的始终是同一种标记格式。
 * 引用的节点已经被删掉时直接报错，比让模型拿着一个不存在的 ID 反复试要清楚得多。
 */
async function resolveReferences(userId: string, projectId: string, content: string, declared: AgentMessageReference[]) {
    const markers = [...content.matchAll(REFERENCE_PATTERN)];
    const declaredIds = [...new Set(declared.map((item) => String(item.nodeId || "").trim()).filter(Boolean))];
    if (!markers.length && !declaredIds.length) return { content, references: [] as AgentMessageReference[] };
    if (markers.length + declaredIds.length > MAX_REFERENCES) throw fail(`一条消息最多引用 ${MAX_REFERENCES} 个画布节点`);

    const project = await readProjectCanvas(userId, projectId);
    const references: AgentMessageReference[] = [];
    const resolve = (nodeId: string) => {
        const node = project.data.nodes.find((item) => item.id === nodeId);
        if (!node) throw fail(`引用的画布节点已不存在：${nodeId}`);
        const storageKey = typeof node.metadata?.storageKey === "string" ? node.metadata.storageKey : "";
        // 同一个节点可以在一句话里被引用多次，展示用的引用列表按节点去重即可。
        if (!references.some((item) => item.nodeId === node.id)) references.push({ nodeId: node.id, type: node.type, title: node.title || "", ...(storageKey ? { storageKey } : {}) });
        return referenceMarker(node.id, node.type, node.title || "");
    };
    const next = content.replace(REFERENCE_PATTERN, (_match, _label: string, payload: string) => {
        const cut = payload.lastIndexOf("#");
        return resolve(payload.slice(0, cut < 0 ? payload.length : cut));
    });
    const tail = declaredIds.filter((nodeId) => !references.some((item) => item.nodeId === nodeId)).map(resolve);
    return { content: [next, tail.join(" ")].filter((line) => line.trim()).join("\n\n"), references };
}

/** 附件必须是当前用户自己的图片文件：模型和前端都可能传别人的 ID 过来，这里是最后一道防线。 */
async function resolveAttachments(userId: string, ids: string[]) {
    const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!wanted.length) return [];
    if (wanted.length > MAX_ATTACHMENTS) throw fail(`一条消息最多上传 ${MAX_ATTACHMENTS} 张图片`);
    const files = await listFiles(userId, wanted);
    if (files.length !== wanted.length) throw fail("图片附件不存在或已被删除");
    if (files.some((file) => file.kind !== "image")) throw fail("只能给 Agent 发送图片");
    return wanted;
}

/**
 * 用模型给会话起一个短标题，只在会话的第一条用户消息时跑一次。
 * 刻意不扣算力点：标题就十来个字，成本可以忽略，而且它有天然限流——必须真的发出一条消息才会触发，
 * 而发消息本身已经按模型单价扣过一次了，再扣一次等于同一个动作收两遍钱。
 * 整条链路的失败都只是静默放弃，标题保持发消息时写好的截断兜底：起标题失败绝不能让发消息也跟着失败。
 */
async function generateSessionTitle(session: AgentSession, content: string) {
    const settings = await publicSettings();
    const model = settings.agent.titleModel;
    if (!model) return;
    const channel = await selectModelChannel(model);
    const system = `根据用户这句话给对话起一个标题，只输出标题本身：不超过 ${MAX_TITLE_CHARS} 个字，不要引号、不要句号、不要解释。标题只用来在会话列表里认人，长了会被截断。`;
    // 借用同一套模型调用：临时拼一条用户消息喂进去，OpenAI 与 Gemini 两种请求格式就不用再各写一遍。
    const row = messages().create({ role: "user", content, attachments: [], references: [] });
    const reply = await callModel(channel, model, system, [row], new Map(), [], AbortSignal.timeout(TITLE_TIMEOUT_MS));
    const title = reply.content
        .replace(/^[“”"'「『]+|[“”"'」』。！？]+$/g, "")
        .trim()
        .slice(0, MAX_TITLE_CHARS);
    if (title) await patchSession(session, { title });
}

/**
 * 发消息即触发后台执行，接口立刻返回，不等循环跑完。
 * clientMessageId 是幂等键：断网重发同一个键只会拿回已存在的那条消息，不会重复执行、重复扣费。
 * 计费口径是「按消息扣一次」：在真正开始执行之前按当前模型的单价扣一次，之后这条消息触发多少轮都不再扣。
 */
export async function sendAgentMessage(userId: string, sessionId: string, input: { clientMessageId: string; content: string; model: string; attachmentIds: string[]; references: AgentMessageReference[] }) {
    const clientMessageId = input.clientMessageId.trim();
    if (!clientMessageId) throw fail("缺少消息幂等键");
    const rawContent = input.content.trim();
    if (!rawContent && !input.attachmentIds.length && !input.references.length) throw fail("消息内容不能为空");
    const settings = await publicSettings();
    if (!settings.agent.enabled || !settings.capabilities.text) throw fail("画布 Agent 未开放");

    const existing = await messages().findOneBy({ userId, clientMessageId });
    if (existing) return toMessageView(existing);

    const session = await loadSession(userId, sessionId);
    if (session.status === "running") throw fail("当前会话正在执行中，请等待完成或先中止");
    // 等确认时也不能插新消息：那条待确认请求属于上一段执行，被顶掉之后用户点同意就没有东西可接着跑了。
    if (session.status === "awaiting") throw fail("当前会话正在等待你确认，请先处理确认请求或中止");
    // 用户这次选了就按用户的来，没选就沿用会话上一轮用的模型，不再无条件按管理员配置对齐——
    // 那样会把用户在面板上的选择冲掉。模型被下线的情况由 resolveAgentModel 兜底回落到默认。
    // 模型只在这里定一次，跑到一半改选择也只对下一轮生效，当前这轮用的还是发消息时确定的那个。
    const model = resolveAgentModel(settings, input.model || session.model);
    if (!model) throw fail("系统未配置 Agent 使用的文本模型");

    const attachments = await resolveAttachments(userId, input.attachmentIds);
    // 图片附件必须配视觉模型，否则上游会直接报一串看不懂的错；宁可在这里明确拒绝，也不要静默把图丢掉。
    if (attachments.length && !modelSupportsVision(settings, model)) throw fail("当前模型不支持识别图片，请换一个标注了「支持视觉」的模型再发图");
    const { content, references } = await resolveReferences(userId, session.projectId, rawContent, input.references);

    // 扣费在真正开始执行之前：余额不足就直接拒绝，连循环都不启动。
    // 付费方取会话创建时固化的那个，不按当前团队成员关系重算：一段会话中途换池子付款是对不上账的。
    const credits = await modelCost(model);
    await chargeSession(session, model, credits);
    const first = !session.lastSeq;
    try {
        // rounds 清零：轮数预算是按「一条用户消息」给的，不是按会话累计的。
        await patchSession(session, { model, status: "running", error: "", rounds: 0, title: first ? (content || "图片消息").slice(0, 30) : session.title });
        const row = await appendMessage(session, "user", { content, clientMessageId, attachments, references });
        void runSession(session, model);
        // 起标题和执行并行跑，接口不等它：拿到了就通过 SSE 把新标题推出去，拿不到就一直用上面的截断兜底。
        if (first) void generateSessionTitle(session, content).catch(() => undefined);
        return toMessageView(row);
    } catch (error) {
        // 还没开始跑就失败了，扣掉的那一次要还回去，否则用户白花一次钱。
        // 退不成就留在会话行上，下次启动重试；绝不吞掉异常后把回执清空。
        if (await settleRefund(session, model)) await clearOutstanding(session).catch(() => undefined);
        throw error;
    }
}

/**
 * 进程重启后内存里的循环已经没了，把残留的 running 标成失败，免得前端一直转圈等一个不存在的任务。
 * awaiting 一并清掉：那条待确认请求属于上一次执行，而那次执行的轮数预算与已经扣掉的算力点都随进程一起没了，
 * 留着让用户回来点同意，等于拿一份对不上账的上下文接着跑；不如直接失效，让他重新发一条消息。
 *
 * 结账的扫描不看状态，只看「行上还挂着回执」：退款失败过的会话早就被标成 failed 或 idle 了，
 * 只扫 running/awaiting 就等于放着那笔钱永远不再重试。退款成功才清回执，失败就原样留到下次启动，
 * 状态则各自维持原样——把一个 idle 会话因为一笔待退的钱改成 failed，用户会莫名其妙看到一次没发生过的失败。
 */
export async function resetRunningAgentSessions() {
    const outstanding = await sessions().find({ where: { payerCredits: MoreThan(0), payerLogId: Not("") } });
    for (const session of outstanding) {
        if (await settleRefund(session, session.model)) await clearOutstanding(session).catch(() => undefined);
    }
    await sessions().update({ status: "running" }, { status: "failed", error: "服务已重启，请重新发送消息", pendingAction: null, updatedAt: now() });
    await sessions().update({ status: "awaiting" }, { status: "failed", error: "服务已重启，待确认的请求已失效，请重新发送消息", pendingAction: null, updatedAt: now() });
}
