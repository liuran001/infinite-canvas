import dayjs from "dayjs";

import type { ServerAgentMessage, ServerAgentPendingAction } from "@/services/api/server";
import type { AgentChatMessageItem } from "./agent-chat-message";
import type { AgentSearchResult } from "./agent-search-card";

/** 服务端工具名到中文标题：面板要让用户看清 agent 到底动了画布的什么地方。执行中的一行也直接用它拼成「正在读取画布」。 */
const TOOL_LABELS: Record<string, string> = {
    read_canvas: "读取画布",
    create_node: "新建节点",
    update_node: "修改节点",
    delete_node: "删除节点",
    move_nodes: "移动节点",
    set_node_group: "调整分组",
    connect_nodes: "连接节点",
    disconnect_nodes: "断开连线",
    rename_canvas: "重命名画布",
    generate_image: "生成图片",
    generate_video: "生成视频",
    generate_audio: "生成音频",
    view_image: "查看图片",
    web_search: "联网搜索",
    read_webpage: "读取网页",
    import_image: "导入网络图片",
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

export type CloudAgentTimelineEntry =
    | { kind: "message"; id: string; message: ServerAgentMessage; item: AgentChatMessageItem }
    | { kind: "tools"; id: string; items: AgentChatMessageItem[]; label: string; running: boolean };

function toolFailed(message: ServerAgentMessage) {
    return Boolean(message.toolResult) && (parseJson(message.toolResult) as { ok?: boolean } | null)?.ok === false;
}

function elapsedText(startedAt: string, endedAt: string) {
    // 组还没等到后一条消息时用当前时间兜底，否则刚跑完的那一瞬间会先显示成 0 秒、过一会儿又冒出耗时。
    const seconds = Math.round(((endedAt ? dayjs(endedAt).valueOf() : Date.now()) - dayjs(startedAt).valueOf()) / 1000);
    if (!Number.isFinite(seconds) || seconds < 1) return "";
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/**
 * 一组工具调用折叠成的那一行。
 * 执行中直接报当前这个工具在干什么（「正在联网搜索」），比笼统的「正在执行工具」有用得多；
 * 跑完了收成「已执行 N 个操作 · 耗时 X 秒」，细节留给展开。
 * 结束时间只能取组后面那条消息的时间：服务端只落工具的开始时间，工具跑完是就地改同一行，没有结束时间可用。
 */
function toolGroupLabel(tools: ServerAgentMessage[], endedAt: string) {
    const last = tools[tools.length - 1];
    if (!last.toolResult) return { running: true, label: `正在${TOOL_LABELS[last.toolName] || "执行工具"}` };
    const failed = tools.filter(toolFailed).length;
    const elapsed = elapsedText(tools[0].createdAt, endedAt);
    return { running: false, label: `已执行 ${tools.length} 个操作${failed ? ` · ${failed} 个失败` : ""}${elapsed ? ` · 耗时 ${elapsed}` : ""}` };
}

/**
 * 把会话消息排成时间线，其中连续的工具调用合并成一组。
 * 分组边界取「两条模型可见发言之间」而不是「一轮」：服务端一轮可能只调一个工具就接着下一轮，
 * 按轮切完还是一屏卡片；而模型写出正文就说明它这段动作告一段落，正好是用户心里的一个段落。
 * 和本地 Agent 把同一 turn 的连续命令合成一行是同一个口径，两种模式切换时手感一致。
 */
export function cloudAgentTimeline(messages: ServerAgentMessage[]): CloudAgentTimelineEntry[] {
    const timeline: CloudAgentTimelineEntry[] = [];
    let tools: ServerAgentMessage[] = [];
    const flush = (endedAt: string) => {
        if (!tools.length) return;
        timeline.push({ kind: "tools", id: `tools-${tools[0].seq}`, items: tools.map(toCloudChatItem), ...toolGroupLabel(tools, endedAt) });
        tools = [];
    };
    messages.forEach((message) => {
        if (message.role === "tool") {
            tools.push(message);
            return;
        }
        flush(message.createdAt);
        timeline.push({ kind: "message", id: `cloud-${message.seq}`, message, item: toCloudChatItem(message) });
    });
    flush("");
    return timeline;
}

/**
 * 待确认请求的卡片文案。续跑要把「批准会再扣一次点」说在明面上：
 * 计费口径是每条消息扣一次，续跑等于替用户再发一条，不讲清楚就成了偷偷扣费。
 */
export function cloudPendingCard(action: ServerAgentPendingAction) {
    if (action.type === "continue") {
        const cost = action.credits ? `继续会再扣 ${action.credits} 点算力，和重新发一条消息一样` : "继续不再额外扣算力点";
        return { title: "是否继续执行", summary: `这条消息已经跑了 ${action.roundsUsed} 轮还没做完。${cost}；选择不继续就停在这里。` };
    }
    return { title: "是否修改画布标题", summary: `想把画布标题改成「${action.title}」${action.reason ? `，理由是${action.reason}` : ""}。` };
}
