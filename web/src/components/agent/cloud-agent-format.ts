import type { ServerAgentMessage } from "@/services/api/server";
import type { AgentChatMessageItem } from "./agent-chat-message";

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
    return {
        id,
        role: "tool",
        title,
        text: failed ? failure : summary || "已完成",
        detail: { status: failed ? "failed" : "completed", rows, output: failed ? failure : clip(text(result?.data ?? "").trim(), MAX_OUTPUT_CHARS) },
    };
}

/**
 * 已消耗算力点的下界。服务端每轮模型调用扣一次点，但消息记录里
 * 相邻两轮「只返回工具调用」的回复会连成一片，无法反推出准确轮数，
 * 所以只按「每条 assistant 回复算一轮 + 不跟在回复后面的工具段各算一轮」给严格下界。
 */
export function minModelRounds(messages: ServerAgentMessage[]) {
    return messages.reduce((rounds, item, index) => {
        if (item.role === "assistant") return rounds + 1;
        const previous = messages[index - 1]?.role;
        return item.role === "tool" && previous !== "tool" && previous !== "assistant" ? rounds + 1 : rounds;
    }, 0);
}
