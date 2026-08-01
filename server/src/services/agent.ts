import { EventEmitter } from "node:events";
import { MoreThan } from "typeorm";

import { repo } from "../db/data-source";
import { AgentMessage, AgentSession, type AgentMessageRole, type AgentSessionStatus } from "../db/entities";
import { fail, newId, now, SafeError } from "../lib/errors";
import { upstreamJson } from "../lib/upstream";
import { listAgentTools, runAgentTool, type AgentTool } from "./agent-tools";
import { consumeUserCredits, refundUserCredits } from "./auth";
import { searchConfig } from "./search";
import { buildChannelUrl, modelCost, publicSettings, selectModelChannel, type ModelChannel, type PublicSetting } from "./settings";
import { readProjectCanvas } from "./sync";

export type AgentSessionView = { id: string; projectId: string; title: string; status: AgentSessionStatus; model: string; error: string; lastSeq: number; createdAt: string; updatedAt: string };
export type AgentMessageView = { seq: number; role: AgentMessageRole; content: string; toolName: string; toolArgs: string; toolResult: string; createdAt: string };
export type AgentEvent = { type: "message"; message: AgentMessageView } | { type: "status"; status: AgentSessionStatus; error: string };

type ToolCall = { name: string; args: Record<string, unknown> };
type ModelReply = { content: string; toolCalls: ToolCall[] };

const MAX_MESSAGES = 500;
const MODEL_TIMEOUT_MS = 180000;

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
    return { id: row.sessionId, projectId: row.projectId, title: row.title, status: row.status, model: row.model, error: row.error || "", lastSeq: row.lastSeq, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function toMessageView(row: AgentMessage): AgentMessageView {
    return { seq: row.seq, role: row.role, content: row.content || "", toolName: row.toolName || "", toolArgs: row.toolArgs || "", toolResult: row.toolResult || "", createdAt: row.createdAt };
}

export function subscribeAgentSession(userId: string, sessionId: string, listener: (event: AgentEvent) => void) {
    const key = busKey(userId, sessionId);
    bus.on(key, listener);
    return () => void bus.off(key, listener);
}

async function loadSession(userId: string, sessionId: string) {
    const row = await sessions().findOneBy({ userId, sessionId });
    if (!row || row.deleted) throw fail("会话不存在");
    return row;
}

async function patchSession(session: AgentSession, patch: Partial<AgentSession>) {
    Object.assign(session, patch, { updatedAt: now() });
    // 用 update 而不是 save：循环还在跑时会话可能已被删除，整行覆写会把软删除标记又抹回去。
    await sessions().update({ userId: session.userId, sessionId: session.sessionId }, { ...patch, updatedAt: session.updatedAt });
    if (patch.status) bus.emit(busKey(session.userId, session.sessionId), { type: "status", status: session.status, error: session.error || "" } satisfies AgentEvent);
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
        lastSeq: 0,
        deleted: false,
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

export async function abortAgentSession(userId: string, sessionId: string) {
    const session = await loadSession(userId, sessionId);
    running.get(busKey(userId, sessionId))?.abort();
    return toSessionView(session);
}

function systemPrompt(projectId: string, extra: string) {
    const base = [
        "你是无限画布应用里的画布助手，可以直接读写用户当前打开的画布。",
        `当前画布项目 ID 是 ${projectId}。`,
        "修改画布前先调用 read_canvas 拿到最新的节点 ID，不要凭记忆猜 ID。",
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

function toOpenAiMessages(system: string, history: AgentMessage[]) {
    const list: Array<Record<string, unknown>> = [{ role: "system", content: system }];
    for (const row of history) {
        if (row.role === "user") list.push({ role: "user", content: row.content || "" });
        else if (row.role === "assistant") list.push({ role: "assistant", content: row.content || "" });
        else {
            // 工具调用与结果按 seq 一一对应地还原，重连或重启后重建上下文不用额外存 tool_call_id。
            const id = `call_${row.seq}`;
            list.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: row.toolName, arguments: row.toolArgs || "{}" } }] });
            list.push({ role: "tool", tool_call_id: id, content: row.toolResult || "" });
        }
    }
    return list;
}

type OpenAiPayload = { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };

async function callOpenAi(channel: ModelChannel, model: string, system: string, history: AgentMessage[], tools: AgentTool[], signal: AbortSignal): Promise<ModelReply> {
    const payload = await upstreamJson<OpenAiPayload>(
        buildChannelUrl(channel, "/chat/completions"),
        {
            method: "POST",
            headers: { Authorization: `Bearer ${channel.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages: toOpenAiMessages(system, history), ...(tools.length ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}) }),
            signal,
        },
        "Agent 模型调用失败",
    );
    const message = payload.choices?.[0]?.message;
    return {
        content: (message?.content || "").trim(),
        toolCalls: (message?.tool_calls || []).map((call) => ({ name: (call.function?.name || "").trim(), args: parseArgs(call.function?.arguments || "") })).filter((call) => call.name),
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

function toGeminiContents(history: AgentMessage[]) {
    const contents: Array<{ role: string; parts: unknown[] }> = [];
    for (const row of history) {
        if (row.role === "user") contents.push({ role: "user", parts: [{ text: row.content || "" }] });
        else if (row.role === "assistant") contents.push({ role: "model", parts: [{ text: row.content || "" }] });
        else {
            contents.push({ role: "model", parts: [{ functionCall: { name: row.toolName, args: parseArgs(row.toolArgs) } }] });
            contents.push({ role: "user", parts: [{ functionResponse: { name: row.toolName, response: { result: row.toolResult || "" } } }] });
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

async function callGemini(channel: ModelChannel, model: string, system: string, history: AgentMessage[], tools: AgentTool[], signal: AbortSignal): Promise<ModelReply> {
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
                contents: toGeminiContents(history),
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

/** 扣点在调用上游之前，调用失败原路返还，和生成任务、AI 代理保持同一套计费口径。 */
async function callModel(channel: ModelChannel, model: string, credits: number, userId: string, system: string, history: AgentMessage[], tools: AgentTool[], signal: AbortSignal) {
    await consumeUserCredits(userId, model, credits, "/agent");
    try {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]);
        return channel.apiFormat === "gemini" ? await callGemini(channel, model, system, history, tools, timeout) : await callOpenAi(channel, model, system, history, tools, timeout);
    } catch (error) {
        await refundUserCredits(userId, model, credits, "/agent").catch(() => undefined);
        throw error;
    }
}

/** 超长会话只带最近的一批：倒序取再翻回来，丢掉的是最老的消息而不是刚发生的进度。 */
async function loadHistory(userId: string, sessionId: string) {
    const rows = await messages().find({ where: { userId, sessionId }, order: { seq: "DESC" }, take: MAX_MESSAGES });
    return rows.reverse();
}

async function runLoop(session: AgentSession, signal: AbortSignal) {
    const settings = await publicSettings();
    const channel = await selectModelChannel(session.model);
    const credits = await modelCost(session.model);
    const tools = listAgentTools({ search: Boolean(await searchConfig()), image: settings.capabilities.image && Boolean(settings.modelChannel.defaultImageModel) });
    const system = systemPrompt(session.projectId, settings.modelChannel.systemPrompt);

    for (let round = 0; round < settings.agent.maxRounds; round += 1) {
        if (signal.aborted) throw fail("已中止");
        const reply = await callModel(channel, session.model, credits, session.userId, system, await loadHistory(session.userId, session.sessionId), tools, signal);
        if (reply.content) await appendMessage(session, "assistant", { content: reply.content });
        if (!reply.toolCalls.length) return;

        for (const call of reply.toolCalls) {
            const args = JSON.stringify(call.args);
            // 先占好 seq 再执行：工具跑得慢时前端也能立刻看到「正在调用哪个工具」。
            const row = await appendMessage(session, "tool", { toolName: call.name, toolArgs: args });
            const result = await runAgentTool({ userId: session.userId, projectId: session.projectId, sessionId: session.sessionId, seq: row.seq, signal }, call.name, call.args).then(
                (value) => JSON.stringify({ ok: true, data: value ?? null }),
                // 工具报错不终止循环，把错误回灌给模型，让它自己换个做法或如实告诉用户。
                (error: unknown) => JSON.stringify({ ok: false, error: error instanceof SafeError ? error.message : "工具执行失败" }),
            );
            row.toolResult = result;
            await messages().save(row);
            bus.emit(busKey(session.userId, session.sessionId), { type: "message", message: toMessageView(row) } satisfies AgentEvent);
        }
    }
    await appendMessage(session, "assistant", { content: `已达到最大执行轮数（${settings.agent.maxRounds}），本次执行到此为止。` });
}

async function runSession(session: AgentSession) {
    const key = busKey(session.userId, session.sessionId);
    const controller = new AbortController();
    running.set(key, controller);
    try {
        await runLoop(session, controller.signal);
        await patchSession(session, { status: "idle", error: "" });
    } catch (error) {
        const aborted = controller.signal.aborted;
        if (!aborted) console.error(`agent session ${session.sessionId} failed:`, error);
        const message = error instanceof SafeError ? error.message : "Agent 执行失败，请稍后重试";
        await appendMessage(session, "assistant", { content: aborted ? "已中止本次执行。" : message }).catch(() => undefined);
        await patchSession(session, { status: aborted ? "idle" : "failed", error: aborted ? "" : message }).catch(() => undefined);
    } finally {
        running.delete(key);
    }
}

/**
 * 发消息即触发后台执行，接口立刻返回，不等循环跑完。
 * clientMessageId 是幂等键：断网重发同一个键只会拿回已存在的那条消息，不会重复执行、重复扣费。
 */
export async function sendAgentMessage(userId: string, sessionId: string, input: { clientMessageId: string; content: string; model: string }) {
    const clientMessageId = input.clientMessageId.trim();
    if (!clientMessageId) throw fail("缺少消息幂等键");
    const content = input.content.trim();
    if (!content) throw fail("消息内容不能为空");
    const settings = await publicSettings();
    if (!settings.agent.enabled || !settings.capabilities.text) throw fail("画布 Agent 未开放");

    const existing = await messages().findOneBy({ userId, clientMessageId });
    if (existing) return toMessageView(existing);

    const session = await loadSession(userId, sessionId);
    if (session.status === "running") throw fail("当前会话正在执行中，请等待完成或先中止");
    // 用户这次选了就按用户的来，没选就沿用会话上一轮用的模型，不再无条件按管理员配置对齐——
    // 那样会把用户在面板上的选择冲掉。模型被下线的情况由 resolveAgentModel 兜底回落到默认。
    // 模型只在这里定一次，跑到一半改选择也只对下一轮生效，当前这轮用的还是发消息时确定的那个。
    const model = resolveAgentModel(settings, input.model || session.model);
    if (!model) throw fail("系统未配置 Agent 使用的文本模型");

    await patchSession(session, { model, status: "running", error: "", title: session.lastSeq ? session.title : content.slice(0, 30) });
    const row = await appendMessage(session, "user", { content, clientMessageId });
    void runSession(session);
    return toMessageView(row);
}

/** 进程重启后内存里的循环已经没了，把残留的 running 标成失败，免得前端一直转圈等一个不存在的任务。 */
export async function resetRunningAgentSessions() {
    await sessions().update({ status: "running" }, { status: "failed", error: "服务已重启，请重新发送消息", updatedAt: now() });
}
