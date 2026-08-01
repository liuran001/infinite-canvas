import dayjs from "dayjs";

import type { ServerAgentMessage } from "@/services/api/server";
import type { AgentChatMessageItem } from "./agent-chat-message";
import type { AgentSearchResult } from "./agent-search-card";

/** 服务端工具名到中文标题：面板要让用户看清 agent 到底动了画布的什么地方。 */
const TOOL_LABELS: Record<string, string> = {
    read_canvas: "读取画布",
    create_node: "新建节点",
    update_node: "修改节点",
    delete_node: "删除节点",
    connect_nodes: "连接节点",
    disconnect_nodes: "断开连线",
    generate_image: "生成图片",
    web_search: "联网搜索",
};

/** 一行摘要优先取最能说明「在干什么」的参数。 */
const SUMMARY_KEYS = ["query", "prompt", "title", "content", "nodeId", "fromNodeId", "type"];
const MAX_VALUE_CHARS = 200;
const MAX_OUTPUT_CHARS = 600;

function parseJson(value: string) {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function text(value: unknown) {
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
}

function clip(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 来源只展示域名并去掉 www 前缀：完整 URL 又长又挤，用户判断可信度看域名就够了。解析不出来就不展示。 */
function hostname(url: string) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/** publishedDate 是 UTC 的 ISO 串，直接展示用户读不出是什么时候，按本地时区转成年月日。 */
function localDate(value: string) {
    const day = dayjs(value);
    return value && day.isValid() ? day.format("YYYY-MM-DD") : "";
}

/**
 * 联网搜索的结果整块 JSON 摊给用户根本没法读，这里拆成条目交给 AgentSearchCard 渲染。
 * 正文（Exa 可能返回整页内容）在这里就截断，避免一条搜索结果把整个面板撑爆；完整内容留在折叠的原始 JSON 里。
 */
function searchResults(data: unknown): AgentSearchResult[] {
    const list = data && typeof data === "object" ? (data as { results?: unknown }).results : undefined;
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
        const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const url = text(row.url).trim();
        const title = text(row.title).trim();
        if (!title && !url) return [];
        return [{ title: title || url, url, host: hostname(url), date: localDate(text(row.publishedDate).trim()), summary: clip(text(row.text).trim(), MAX_VALUE_CHARS) }];
    });
}

/** 把服务端消息转成现有聊天组件的数据结构，工具调用连参数和结果一起展示。 */
export function toCloudChatItem(message: ServerAgentMessage): AgentChatMessageItem {
    const id = `cloud-${message.seq}`;
    if (message.role !== "tool") return { id, role: message.role, text: message.content };

    const args = (parseJson(message.toolArgs) as Record<string, unknown> | null) || {};
    const rows = Object.entries(args).flatMap(([label, value]) => {
        const shown = clip(text(value).trim(), MAX_VALUE_CHARS);
        return shown ? [{ label, value: shown }] : [];
    });
    const title = TOOL_LABELS[message.toolName] || message.toolName;
    const summary = clip(SUMMARY_KEYS.map((key) => text(args[key]).trim()).find(Boolean) || "", MAX_VALUE_CHARS);
    // 没有 toolResult 说明工具还在跑：服务端先落一条占位消息，拿到结果后用同一个 seq 再推一次。
    if (!message.toolResult) return { id, role: "tool", title, text: summary || "正在执行", detail: { status: "running", rows } };

    const result = parseJson(message.toolResult) as { ok?: boolean; data?: unknown; error?: string } | null;
    const failed = result?.ok === false;
    const failure = String(result?.error || "工具执行失败");
    // 只有联网搜索拆条目，其余工具照旧摊 output；原始 JSON 不截断，折叠起来备查。
    const results = !failed && message.toolName === "web_search" ? searchResults(result?.data) : [];
    const output = failed ? failure : results.length ? text(result?.data ?? "").trim() : clip(text(result?.data ?? "").trim(), MAX_OUTPUT_CHARS);
    return {
        id,
        role: "tool",
        title,
        text: failed ? failure : summary || "已完成",
        detail: { status: failed ? "failed" : "completed", rows, output, ...(results.length ? { results } : {}) },
    };
}

/**
 * 等待提示按当前实际进度说话：正在跑工具就说在跑哪个工具，其余情况一律用中性的「正在思考」。
 * 不能一概说成「正在操作画布」——模型多数时间是在思考、写回复或联网搜索，压根没碰画布。
 */
export function cloudAgentActivity(messages: ServerAgentMessage[]) {
    const last = messages[messages.length - 1];
    // 工具消息先落一条没有结果的占位，拿到结果后用同一个 seq 再推一次；没有结果才代表这个工具还在跑。
    if (last?.role === "tool" && !last.toolResult) return `正在${TOOL_LABELS[last.toolName] || "执行工具"}`;
    return "正在思考";
}
