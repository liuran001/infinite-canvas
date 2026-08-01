import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { ArrowUp, ImagePlus, LoaderCircle, Square, X } from "lucide-react";

import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import type { canvasThemes } from "@/lib/canvas-theme";
import { useMissingCanvasNodeIds } from "@/stores/canvas/use-canvas-store";
import { useCloudAgentStore, type CloudAgentAttachment } from "@/stores/use-cloud-agent-store";
import { CLOUD_AGENT_IMAGE_MIME } from "./cloud-agent-references";

type Theme = (typeof canvasThemes)[keyof typeof canvasThemes];

/**
 * 云端 Agent 的输入区。和本地 Agent 共用的 AgentChatComposer 相比多两件事：
 * 一是正文里可以插行内的画布节点引用（复用画布上那套 mention 输入框，删除时整块删掉），
 * 二是上传的图片能直接拖回画布，复用同一份服务端文件。
 */
export function CloudAgentComposer({ theme, disabled, sending, placeholder, visionWarning, left, onSubmit, onStop }: { theme: Theme; disabled?: boolean; sending?: boolean; placeholder: string; visionWarning?: string; left?: ReactNode; onSubmit: () => void; onStop?: () => void }) {
    const prompt = useCloudAgentStore((state) => state.prompt);
    const attachments = useCloudAgentStore((state) => state.attachments);
    const draftReferences = useCloudAgentStore((state) => state.draftReferences);
    const pendingInsert = useCloudAgentStore((state) => state.pendingInsert);
    const referenceDropActive = useCloudAgentStore((state) => state.referenceDropActive);
    const uploading = useCloudAgentStore((state) => state.uploading);
    const projectId = useCloudAgentStore((state) => state.projectId);
    const setPrompt = useCloudAgentStore((state) => state.setPrompt);
    const addAttachments = useCloudAgentStore((state) => state.addAttachments);
    const removeAttachment = useCloudAgentStore((state) => state.removeAttachment);
    const consumePendingInsert = useCloudAgentStore((state) => state.consumePendingInsert);
    const highlightReference = useCloudAgentStore((state) => state.highlightReference);
    const revealReference = useCloudAgentStore((state) => state.revealReference);
    // 引用的节点可能在插入之后又被删掉了，标签要能自己变灰，不能等用户点了才发现指不到东西。
    const missingNodeIds = useMissingCanvasNodeIds(
        projectId,
        draftReferences.map((item) => item.nodeId),
    );
    const nodeIdOfLabel = (label: string) => draftReferences.find((item) => item.label === label)?.nodeId || "";

    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // 从画布拖节点过来时输入框通常没有焦点，插入点只能用最后一次记下来的光标位置。
    const caretRef = useRef(0);
    const rememberCaret = () => {
        const el = textareaRef.current;
        if (el) caretRef.current = el.selectionStart;
    };

    useEffect(() => {
        if (!pendingInsert) return;
        const value = useCloudAgentStore.getState().prompt;
        const at = Math.min(caretRef.current, value.length);
        const before = value.slice(0, at);
        const after = value.slice(at);
        // 标签两侧留空白：整块删除和高亮都按「被空白包住的一段文字」匹配，紧贴着别的字就认不出来了。
        const inserted = `${before && !/\s$/.test(before) ? " " : ""}${pendingInsert.label}${/^\s/.test(after) ? "" : " "}`;
        const caret = before.length + inserted.length;
        caretRef.current = caret;
        setPrompt(before + inserted + after);
        consumePendingInsert();
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(caret, caret);
        });
    }, [consumePendingInsert, pendingInsert, setPrompt]);

    // mention 输入框只认 CanvasResourceReference：草稿引用照它的形状转一层，就能直接复用高亮与整块删除。
    const mentionReferences = useMemo(
        () => draftReferences.map((item) => ({ id: item.nodeId, nodeId: item.nodeId, kind: item.kind, label: item.label, title: item.title || item.label, previewUrl: item.previewUrl, active: true, missing: missingNodeIds.has(item.nodeId) })),
        [draftReferences, missingNodeIds],
    );
    const canSubmit = !disabled && !sending && !visionWarning && Boolean(prompt.trim() || attachments.length);

    return (
        <div className="px-2 pb-2 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
            <div
                data-cloud-agent-drop="true"
                className="rounded-[24px] border px-3 pb-3 pt-3 shadow-lg transition"
                style={{ background: theme.toolbar.panel, borderColor: referenceDropActive ? "#2f80ff" : theme.node.stroke }}
            >
                {referenceDropActive ? <div className="mb-2 rounded-lg px-2 py-1 text-[11px]" style={{ background: "rgba(47,128,255,.1)", color: "#2f80ff" }}>松手把这个节点作为引用插进光标位置</div> : null}
                {attachments.length ? (
                    <div className="thin-scrollbar mb-2 flex gap-2 overflow-x-auto pb-1">
                        {attachments.map((item) => (
                            <div key={item.id} className="group relative size-14 shrink-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }} title={`${item.name}（可拖到画布上）`}>
                                <CloudAgentImage image={item} className="size-full cursor-grab object-cover" />
                                <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded-full border opacity-0 shadow-sm transition group-hover:opacity-100" style={{ background: theme.toolbar.panel, borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => removeAttachment(item.id)} aria-label="移除图片">
                                    <X className="size-3" />
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    value={prompt}
                    references={mentionReferences}
                    placeholder={placeholder}
                    containerClassName="!h-auto"
                    className="thin-scrollbar max-h-32 min-h-20 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-5 outline-none placeholder:opacity-45"
                    style={{ color: theme.node.text }}
                    onChange={(value) => {
                        setPrompt(value);
                        requestAnimationFrame(rememberCaret);
                    }}
                    onSubmit={() => {
                        if (canSubmit) onSubmit();
                    }}
                    onSelect={rememberCaret}
                    onKeyUp={rememberCaret}
                    onPointerUp={rememberCaret}
                    onBlur={rememberCaret}
                    // 悬停引用即在画布上高亮对应节点，移开（label 为空）就撤掉；点击再把节点带进视口。
                    onLabelHover={(label) => highlightReference(nodeIdOfLabel(label))}
                    onLabelClick={(label) => {
                        const nodeId = nodeIdOfLabel(label);
                        if (nodeId && !missingNodeIds.has(nodeId)) revealReference(nodeId);
                    }}
                    onPaste={(event) => {
                        const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (!images.length) return;
                        event.preventDefault();
                        void addAttachments(images);
                    }}
                />
                {visionWarning ? <div className="mt-1 px-1 text-[11px] leading-4" style={{ color: "#dc2626" }}>{visionWarning}</div> : null}
                <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1">
                        <input
                            ref={fileInputRef}
                            hidden
                            type="file"
                            accept="image/*"
                            multiple
                            onChange={(event) => {
                                void addAttachments(event.target.files);
                                event.target.value = "";
                            }}
                        />
                        <Tooltip title="上传图片，可拖到画布上">
                            <Button type="text" shape="circle" className="!h-9 !w-9 !min-w-9" disabled={disabled || sending || uploading} style={{ color: theme.node.muted }} icon={uploading ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} onClick={() => fileInputRef.current?.click()} aria-label="上传图片" />
                        </Tooltip>
                        {left}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        {sending && onStop ? (
                            <Button danger shape="circle" className="!h-10 !w-10 !min-w-10" icon={<Square className="size-4" />} onClick={() => onStop()} aria-label="停止" />
                        ) : (
                            <Button type="primary" shape="circle" className="!h-10 !w-10 !min-w-10" disabled={!canSubmit} icon={sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />} onClick={onSubmit} aria-label="发送" />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * 面板里的图片缩略图。拖到画布上会带着 storageKey 一起走：画布拿到的是同一份服务端文件，
 * 既不重新上传也不重复占配额。
 */
export function CloudAgentImage({ image, className }: { image: CloudAgentAttachment; className?: string }) {
    return (
        <img
            src={image.url}
            alt={image.name}
            className={className}
            draggable
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(CLOUD_AGENT_IMAGE_MIME, JSON.stringify(image));
            }}
        />
    );
}

/** 会话记录里用户自己发过的图。和输入框里的缩略图一样可以拖回画布。 */
export function CloudAgentImageStrip({ images, alignRight }: { images: CloudAgentAttachment[]; alignRight?: boolean }) {
    return (
        <div className={`mt-1.5 flex flex-wrap gap-1.5 ${alignRight ? "justify-end" : "justify-start"}`}>
            {images.map((item) => (
                <CloudAgentImage key={item.id} image={item} className="size-10 cursor-grab rounded-lg object-cover" />
            ))}
        </div>
    );
}
