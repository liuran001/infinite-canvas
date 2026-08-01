import type { CanvasResourceKind } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/**
 * 面板输入框里的一个画布节点引用。
 * label 是用户实际看到、也能整块删掉的那段文字（形如「@图片1」），提交时才展开成服务端认识的标记。
 */
export type CloudAgentDraftReference = { label: string; nodeId: string; type: string; title: string; kind: CanvasResourceKind; previewUrl?: string };

/** 面板里的图片拖回画布时用的自定义拖拽数据类型：带 storageKey 复用同一份服务端文件，不重新上传、不重复占配额。 */
export const CLOUD_AGENT_IMAGE_MIME = "application/x-cloud-agent-image";
/** 画布节点拖进面板时，用这个选择器认出「松手的地方是不是面板」。 */
export const CLOUD_AGENT_DROP_SELECTOR = "[data-cloud-agent-drop]";

const TYPE_LABELS: Record<string, string> = { image: "图片", text: "文本", video: "视频", audio: "音频", config: "配置", group: "分组" };

/** 引用标签显示节点标题，没有标题就退回类型名，插件节点直接用它自己的类型串。 */
export function nodeTypeLabel(type: string) {
    return TYPE_LABELS[type] || type;
}

/** 服务端的引用标记：@[标题](canvas-node:节点ID#类型)。标记插在正文里，位置本身有语义。 */
const REFERENCE_MARKER = /@\[([^\]]*)\]\(canvas-node:([^)]+)\)/g;

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 只有资源类节点在菜单里配得上缩略图，其余一律按「文本」画一个图标就够了。 */
function draftKind(node: CanvasNodeData): CanvasResourceKind {
    if (node.type === CanvasNodeType.Image) return "image";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    return "text";
}

/**
 * 给拖进来的节点起一个草稿标签。同一个节点重复拖入沿用同一个标签——
 * 「把（节点1）复制一份放到（节点1）右边」是合理用法，不该去重成两个不同的标签。
 * 标签之间必须互不相同、也不能是别人的前缀被吃掉，所以撞名时追加序号。
 */
export function buildDraftReference(node: CanvasNodeData, existing: CloudAgentDraftReference[]): CloudAgentDraftReference {
    const saved = existing.find((item) => item.nodeId === node.id);
    if (saved) return saved;
    // 标签里不能有空白：整块删除和高亮都按「一段连续文字」处理，夹了空格就会被拆开。
    const base = `@${(node.title || nodeTypeLabel(node.type)).replace(/\s+/g, "")}`.slice(0, 24) || "@节点";
    let label = base;
    for (let index = 2; existing.some((item) => item.label === label); index += 1) label = `${base}${index}`;
    return { label, nodeId: node.id, type: node.type, title: node.title || "", kind: draftKind(node), previewUrl: node.metadata?.content };
}

/**
 * 提交前把草稿标签展开成服务端标记，位置保持在用户插入的地方。
 * 一次性用一个合并正则替换，不能逐个标签依次 replace——展开后的标记里也含有「@标题」，
 * 后一轮替换会再吃进去一次。返回的 references 按首次出现顺序去重，正文里出现两次的节点只算一个引用。
 */
export function expandDraftReferences(prompt: string, draft: CloudAgentDraftReference[]) {
    const labels = draft.map((item) => item.label).filter(Boolean);
    if (!labels.length) return { content: prompt, references: [] as Array<{ nodeId: string }> };
    // 长标签优先匹配，避免「@图片1」先被「@图片」吃掉半截。
    const sorted = [...new Set(labels)].sort((a, b) => b.length - a.length);
    const byLabel = new Map(draft.map((item) => [item.label, item]));
    const references: Array<{ nodeId: string }> = [];
    const content = prompt.replace(new RegExp(sorted.map(escapeRegExp).join("|"), "g"), (match) => {
        const reference = byLabel.get(match);
        if (!reference) return match;
        if (!references.some((item) => item.nodeId === reference.nodeId)) references.push({ nodeId: reference.nodeId });
        return `@[${reference.title || nodeTypeLabel(reference.type)}](canvas-node:${reference.nodeId}#${reference.type})`;
    });
    return { content, references };
}

/** 会话记录里展示用户消息时把标记还原成「@标题」，别把一串节点 ID 糊在用户脸上。 */
export function stripReferenceMarkers(content: string) {
    return content.replace(REFERENCE_MARKER, (_match, label: string) => `@${label}`);
}

/**
 * 把用户消息拆成「普通文字」和「节点引用」两种片段。
 * 已发送消息里的引用同样要能悬停高亮、点击定位，所以不能像 stripReferenceMarkers 那样压成一整段纯文本。
 */
export function splitReferenceContent(content: string) {
    const parts: Array<{ text: string; nodeId?: string }> = [];
    let cursor = 0;
    for (const match of content.matchAll(REFERENCE_MARKER)) {
        const at = match.index ?? 0;
        if (at > cursor) parts.push({ text: content.slice(cursor, at) });
        // 标记里的目标写成「节点ID#类型」，类型只是给模型看的，定位只需要 ID。
        parts.push({ text: `@${match[1]}`, nodeId: match[2].split("#")[0] });
        cursor = at + match[0].length;
    }
    if (cursor < content.length) parts.push({ text: content.slice(cursor) });
    return parts;
}
