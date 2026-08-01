import { useMemo, useState } from "react";
import { Check, Download, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "antd";

import { resolveImageUrl } from "@/services/image-storage";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

/** 缩略图只是让人认出画布，多了会盖过卡片本身的信息。 */
const PREVIEW_LIMIT = 4;

/** 节点里存的 content 可能是别的设备写下的旧地址，有 storageKey 时以当前服务端直链为准。 */
function previewImageUrls(nodes: CanvasNodeData[]) {
    const urls = new Set<string>();
    for (const node of nodes) {
        if (node.type !== CanvasNodeType.Image) continue;
        const url = resolveImageUrl(node.metadata?.storageKey, node.metadata?.content || "");
        if (url) urls.add(url);
        if (urls.size >= PREVIEW_LIMIT) break;
    }
    return [...urls];
}

export function CanvasProjectCard({ project }: { project: CanvasProject }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const [failedUrls, setFailedUrls] = useState<string[]>([]);
    const editing = editingId === project.id;
    const selected = selectedIds.includes(project.id);
    const previews = useMemo(() => previewImageUrls(project.nodes), [project.nodes]).filter((url) => !failedUrls.includes(url));
    const open = () => navigate(`/canvas/${project.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`);
    const saveTitle = () => {
        renameProject(project.id, editingTitle);
        stopEditing();
    };

    return (
        <article className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(project.id, event.target.checked)}
                    className="mt-1 size-4 accent-stone-950 dark:accent-stone-100"
                    aria-label={`选择 ${project.title}`}
                />
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && saveTitle()} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-xl font-semibold">{project.title}</h2>
                        <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                            {project.nodes.length} 个节点 · {project.connections.length} 条连线
                        </p>
                    </button>
                )}
            </div>
            {previews.length ? (
                <div className="mt-4 grid grid-cols-4 gap-1.5">
                    {previews.map((url) => (
                        // 图片可能已被清理或换了服务端，加载失败就把这张剔掉，别留破图占位
                        <img key={url} src={url} alt="" loading="lazy" onError={() => setFailedUrls((urls) => [...urls, url])} className="aspect-square w-full rounded-lg bg-black/5 object-cover dark:bg-white/10" />
                    ))}
                </div>
            ) : null}
            <div className="mt-8 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">更新于 {new Date(project.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={saveTitle} aria-label="保存名称" />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label="取消重命名" />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects([project], project.title || "无限画布")} aria-label="导出" />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(project.id, project.title)} aria-label="重命名" />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([project.id])} aria-label="删除" />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
