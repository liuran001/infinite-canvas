import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import { CloudOff, Eye, ImagePlus, Link2Off, Loader2, LogIn, Pencil, Save, Users } from "lucide-react";

import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { AgentPanel } from "@/components/agent/agent-panel";
import { useNoIndexMeta } from "@/hooks/use-noindex-meta";
import { InfiniteCanvasPage } from "@/pages/canvas/project";
import { useShareBillingConsentPrompt } from "@/pages/share/use-share-billing-consent";
import { canvasThemes } from "@/lib/canvas-theme";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { isHiddenBatchChild, isHiddenBatchConnectionEndpoint } from "@/lib/canvas/canvas-node-geometry";
import { IMAGE_FILE_ACCEPT, isImageFile } from "@/lib/image-transcode";
import { shareApi, isShareGone } from "@/services/api/share";
import { uploadShareImage } from "@/services/share-upload";
import { openShareSession, rememberPendingClone, refreshShareSession, takePendingClone } from "@/services/share-session";
import { createSharePresenceReporter, flushShareProject, loadShareProject, pushShareProject, resetShareSync, watchShareProject } from "@/services/share-sync";
import { useServerStore } from "@/stores/use-server-store";
import { useShareStore } from "@/stores/use-share-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

/**
 * 独立的分享画布页 `/s/:token`。
 *
 * viewer 继续使用轻量只读页；服务端明确下发 fullCanvas 时复用项目页的完整工作区，
 * 但数据始终留在 share store，保存、Presence 与上传也只走 guest 通道，不进入账号画布或本地缓存。
 *
 * 路由挂在 UserLayout 与 LoginGuard 之外——分享页本来就允许匿名访问，
 * 放在守卫里会被直接踢回首页。
 */
export default function ShareCanvasPage() {
    const { token = "" } = useParams();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];

    const status = useShareStore((state) => state.status);
    const error = useShareStore((state) => state.error);
    const role = useShareStore((state) => state.role);
    const fullCanvas = useShareStore((state) => state.fullCanvas);
    const allowClone = useShareStore((state) => state.allowClone);
    const project = useShareStore((state) => state.project);
    const members = useShareStore((state) => state.members);
    const displayName = useShareStore((state) => state.displayName);
    const cloning = useShareStore((state) => state.cloning);
    const userToken = useServerStore((state) => state.token);

    const editable = !fullCanvas && role === "editor" && status === "ready";

    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const viewportRef = useRef(viewport);
    const selectedRef = useRef(selectedNodeIds);
    const editableRef = useRef(editable);
    const didCenterRef = useRef(false);
    const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, initial: [] as Array<{ id: string; x: number; y: number }> });
    const rafRef = useRef<number | null>(null);
    const presenceRef = useRef<ReturnType<typeof createSharePresenceReporter> | null>(null);

    // 分享页三重 noindex 的运行时那一层：进页面注入 robots meta，离开时移除。
    useNoIndexMeta();
    useShareBillingConsentPrompt();

    useEffect(() => {
        nodesRef.current = nodes;
        viewportRef.current = viewport;
        selectedRef.current = selectedNodeIds;
    }, [nodes, selectedNodeIds, viewport]);

    useEffect(() => {
        editableRef.current = editable;
    }, [editable]);

    const connections = useMemo(() => project?.connections || [], [project]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const visibleNodes = useMemo(() => nodes.filter((node) => !isHiddenBatchChild(node, nodes)), [nodes]);
    const remotePresenceByNodeId = useMemo(() => {
        const map = new Map<string, typeof members>();
        members.forEach((member) => member.nodeIds.forEach((nodeId) => map.set(nodeId, [...(map.get(nodeId) || []), member])));
        return map;
    }, [members]);

    /** 换取访客凭据 → 读画布 → 解析图片直链。全程失败都不动账号登录态。 */
    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        void (async () => {
            const session = await openShareSession(token);
            if (cancelled || !session) return;
            await loadShareProject(session.project.id);
        })();
        return () => {
            cancelled = true;
            void flushShareProject();
            resetShareSync();
            useShareStore.getState().reset();
        };
    }, [token]);

    /** 短期令牌到点前续一次，长时间停留在页面上也不会掉线。 */
    useEffect(() => {
        if (status !== "ready") return;
        const timer = window.setInterval(() => void refreshShareSession(), 10 * 60 * 1000);
        return () => window.clearInterval(timer);
    }, [status]);

    /** 登录或退出会改变分享里的真实身份，不能继续沿用最多十分钟的旧 guest 权限。 */
    useEffect(() => {
        if (status !== "ready") return;
        void refreshShareSession();
    }, [status, userToken]);

    /** SSE 与 Presence：与账号侧同一套语义，撤销后服务端断流，这里判定失效并停止重试。 */
    useEffect(() => {
        if (fullCanvas || status !== "ready" || !project) return;
        const controller = new AbortController();
        const reporter = createSharePresenceReporter(project.id);
        presenceRef.current = reporter;
        watchShareProject(
            project.id,
            {
                onProject: () => undefined,
                onDeleted: () => useShareStore.getState().markGone("画布已被删除"),
            },
            controller.signal,
        );
        return () => {
            controller.abort();
            reporter.dispose();
            presenceRef.current = null;
        };
    }, [fullCanvas, project?.id, status]);

    useEffect(() => {
        if (fullCanvas || !project) return;
        let cancelled = false;
        void hydrateCanvasImages(project.nodes, { allowUpload: false }).then((next) => {
            if (!cancelled) setNodes(next);
        });
        return () => {
            cancelled = true;
        };
    }, [fullCanvas, project?.id, project?.revision]);

    useEffect(() => {
        if (status !== "ready") return;
        presenceRef.current?.update([...selectedNodeIds], dragRef.current.active ? "editing" : selectedNodeIds.size ? "selecting" : "idle");
    }, [selectedNodeIds, status]);

    /** 首次量到尺寸时把原点放到视口中央，与项目页一致。 */
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            if (didCenterRef.current) return;
            didCenterRef.current = true;
            setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(el);
        return () => observer.disconnect();
    }, [status]);

    /** 把内存里的节点回写进 share store 并排队保存。只读时这条路径根本不会被调用。 */
    const commitNodes = useCallback((next: CanvasNodeData[]) => {
        const current = useShareStore.getState().project;
        if (!current) return;
        const merged: CanvasProject = { ...current, nodes: next, updatedAt: new Date().toISOString() };
        pushShareProject(merged);
    }, []);

    /**
     * 访客上传：粘贴、拖拽、按钮三个入口都汇到这里，与项目页一样落成图片节点。
     * 上传走的是分享通道（guest 令牌 + projectId），文件记在画布所有者名下并按访客单独限流。
     * 只读访客拿不到入口，这里再拦一次，避免键盘粘贴之类的路径绕过 UI。
     */
    const addImageFiles = useCallback(
        async (files: File[], at?: { clientX: number; clientY: number }) => {
            if (!editableRef.current) return;
            const images = files.filter(isImageFile);
            if (!images.length) return;
            const rect = containerRef.current?.getBoundingClientRect();
            const current = viewportRef.current;
            const localX = at ? at.clientX - (rect?.left || 0) : (rect?.width || 0) / 2;
            const localY = at ? at.clientY - (rect?.top || 0) : (rect?.height || 0) / 2;
            const center = { x: (localX - current.x) / current.k, y: (localY - current.y) / current.k };
            setUploading(true);
            const hide = message.loading("正在上传图片…", 0);
            try {
                const created: CanvasNodeData[] = [];
                for (const [index, file] of images.entries()) {
                    const image = await uploadShareImage(file);
                    const size = fitNodeSize(image.width, image.height);
                    created.push({
                        id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        type: CanvasNodeType.Image,
                        title: file.name,
                        position: { x: center.x - size.width / 2 + index * 24, y: center.y - size.height / 2 + index * 24 },
                        width: size.width,
                        height: size.height,
                        metadata: imageMetadata(image),
                    });
                }
                const next = [...nodesRef.current, ...created];
                nodesRef.current = next;
                setNodes(next);
                setSelectedNodeIds(new Set(created.map((node) => node.id)));
                commitNodes(next);
                message.success(`已添加 ${created.length} 张图片`);
            } catch (uploadError) {
                // 只读、超频、配额不足的中文文案都由服务端给出，原样展示。
                message.error(uploadError instanceof Error ? uploadError.message : "上传失败，请重试");
            } finally {
                hide();
                setUploading(false);
            }
        },
        [commitNodes, message],
    );

    /** 粘贴图片。输入框里的粘贴不劫持，否则会把节点里的文本编辑弄坏。 */
    useEffect(() => {
        if (!editable) return;
        const onPaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.closest("[contenteditable='true']")) return;
            const files = Array.from(event.clipboardData?.files || []).filter(isImageFile);
            if (!files.length) return;
            event.preventDefault();
            void addImageFiles(files);
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, [addImageFiles, editable]);

    const handleNodeMouseDown = useCallback((event: React.MouseEvent, nodeId: string) => {
        event.stopPropagation();
        const next = new Set(event.shiftKey || event.metaKey || event.ctrlKey ? selectedRef.current : []);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        setSelectedNodeIds(next);
        dragRef.current = {
            active: true,
            moved: false,
            startX: event.clientX,
            startY: event.clientY,
            initial: nodesRef.current.filter((node) => next.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
    }, []);

    useEffect(() => {
        if (!editable) return;
        const move = (event: MouseEvent) => {
            if (!dragRef.current.active) return;
            const scale = viewportRef.current.k;
            const dx = (event.clientX - dragRef.current.startX) / scale;
            const dy = (event.clientY - dragRef.current.startY) / scale;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
            const initial = dragRef.current.initial;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                setNodes((prev) =>
                    prev.map((node) => {
                        const from = initial.find((item) => item.id === node.id);
                        return from ? { ...node, position: { x: from.x + dx, y: from.y + dy } } : node;
                    }),
                );
            });
        };
        const up = () => {
            if (!dragRef.current.active) return;
            const moved = dragRef.current.moved;
            dragRef.current.active = false;
            dragRef.current.moved = false;
            if (moved) commitNodes(nodesRef.current);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [commitNodes, editable]);

    const handleNodeResize = useCallback(
        (nodeId: string, width: number, height: number, position?: { x: number; y: number }) => {
            setNodes((prev) => {
                const next = prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node));
                nodesRef.current = next;
                return next;
            });
            commitNodes(nodesRef.current.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
        },
        [commitNodes],
    );

    const handleContentChange = useCallback(
        (nodeId: string, content: string) => {
            setNodes((prev) => {
                const next = prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node));
                nodesRef.current = next;
                commitNodes(next);
                return next;
            });
        },
        [commitNodes],
    );

    const handleTitleChange = useCallback(
        (nodeId: string, title: string) => {
            setNodes((prev) => {
                const next = prev.map((node) => (node.id === nodeId ? { ...node, title } : node));
                nodesRef.current = next;
                commitNodes(next);
                return next;
            });
        },
        [commitNodes],
    );

    /** 保存到自己账号：服务端克隆。未登录先记下意图并唤起登录，登录后自动接着走。 */
    const cloneToMyAccount = useCallback(async () => {
        const store = useShareStore.getState();
        if (!store.allowClone || store.cloning) return;
        if (!useServerStore.getState().token) {
            rememberPendingClone(token);
            useServerStore.getState().setLoginOpen(true);
            message.info("请先登录，登录后会继续保存到你的账号");
            return;
        }
        store.setCloning(true);
        try {
            const created = await shareApi.clone(token, store.guestToken);
            message.success("已保存到你的画布");
            navigate(`/canvas/${created.id}`);
        } catch (cloneError) {
            if (isShareGone(cloneError)) useShareStore.getState().markGone("链接已失效");
            else message.error(cloneError instanceof Error ? cloneError.message : "保存到我的账号失败");
        } finally {
            useShareStore.getState().setCloning(false);
        }
    }, [message, navigate, token]);

    // 登录弹窗关掉、账号令牌就绪后，把「登录前想做的克隆」补上。
    useEffect(() => {
        if (!userToken || status !== "ready") return;
        if (takePendingClone(token)) void cloneToMyAccount();
    }, [cloneToMyAccount, status, token, userToken]);

    // 离开页面前把还在防抖队列里的改动立刻推出去，免得用户以为已经存上了。
    useEffect(() => {
        if (!editable) return;
        const flush = () => void flushShareProject();
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            flush();
        };
    }, [editable]);

    if (status === "gone" || status === "error") return <ShareNotice tone={status === "gone" ? "gone" : "error"} title={status === "gone" ? "链接不存在或已失效" : "打开分享画布失败"} detail={error} />;
    if (status !== "ready" || !project) return <ShareNotice tone="loading" title="正在打开分享画布" detail="" />;
    if (fullCanvas)
        return (
            <div className="flex h-dvh overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
                <div className="min-w-0 flex-1 overflow-hidden">
                    <InfiniteCanvasPage shared />
                </div>
                <AgentPanel forceLocal />
            </div>
        );

    return (
        <main className="relative flex h-dvh w-full flex-col overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <ShareTopBar
                title={project.title || "未命名画布"}
                editable={editable}
                allowClone={allowClone}
                cloning={cloning}
                uploading={uploading}
                viewerName={displayName}
                viewers={members.length}
                onClone={() => void cloneToMyAccount()}
                onUpload={() => fileInputRef.current?.click()}
            />

            {/* 上传入口只在可编辑分享上存在；viewer 连这个 input 都不渲染。 */}
            {editable ? (
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={IMAGE_FILE_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        event.target.value = "";
                        void addImageFiles(files);
                    }}
                />
            ) : null}

            <section className="relative min-h-0 flex-1">
                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={project.backgroundMode || "lines"}
                    onViewportChange={setViewport}
                    onCanvasDeselect={() => setSelectedNodeIds(new Set())}
                    // 只读时右键菜单整体不可用；可编辑时分享态也不开放右键菜单里的生成类操作，一律拦掉。
                    onContextMenu={(event) => event.preventDefault()}
                    // 拖拽上传只在可编辑分享上挂；viewer 连 onDrop 都不接，拖进来的文件由浏览器默认处理。
                    onDrop={
                        editable
                            ? (event) => {
                                  const files = Array.from(event.dataTransfer?.files || []).filter(isImageFile);
                                  if (!files.length) return;
                                  event.preventDefault();
                                  void addImageFiles(files, { clientX: event.clientX, clientY: event.clientY });
                              }
                            : undefined
                    }
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .filter((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
                            })
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;
                                return <ConnectionPath key={connection.id} connection={connection} from={from} to={to} active={false} onSelect={() => undefined} />;
                            })}
                    </svg>

                    {/*
                     * 只读的落点在交互层，而不是藏几个按钮：整层节点 pointer-events 关掉之后，
                     * 拖拽、选中、缩放手柄、连线点、双击进编辑态、节点右键菜单一次性全部失效，
                     * 平移与缩放仍然作用在外层容器上，照常可用。
                     */}
                    <div style={{ pointerEvents: editable ? undefined : "none" }}>
                        {/* 缩放起止在这里是空实现：那对回调只用来临时藏掉跟随节点的浮层工具条，而分享页没有工具条。 */}
                        {visibleNodes.map((node) => (
                            <CanvasNode
                                key={node.id}
                                data={node}
                                scale={viewport.k}
                                remoteEditors={remotePresenceByNodeId.get(node.id) || []}
                                isSelected={selectedNodeIds.has(node.id)}
                                isRelated={false}
                                isFocusRelated={false}
                                isConnectionTarget={false}
                                isConnecting={false}
                                showPanel={false}
                                showImageInfo={Boolean(project.showImageInfo)}
                                batchCount={0}
                                groupChildCount={0}
                                onMouseDown={handleNodeMouseDown}
                                onHoverStart={() => undefined}
                                onHoverEnd={() => undefined}
                                onConnectStart={() => undefined}
                                onResizeStart={() => undefined}
                                onResize={handleNodeResize}
                                onResizeEnd={() => undefined}
                                onContentChange={handleContentChange}
                                onTitleChange={handleTitleChange}
                                onContextMenu={(event) => event.preventDefault()}
                            />
                        ))}
                    </div>
                </InfiniteCanvas>

                <CanvasZoomControls
                    scale={viewport.k}
                    onScaleChange={(scale) => setViewport((current) => ({ ...current, k: scale }))}
                    onReset={() => {
                        const rect = containerRef.current?.getBoundingClientRect();
                        setViewport({ x: (rect?.width || 0) / 2, y: (rect?.height || 0) / 2, k: 1 });
                    }}
                    isMiniMapOpen={isMiniMapOpen}
                    onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)}
                />
            </section>
        </main>
    );
}

function ShareTopBar({
    title,
    editable,
    allowClone,
    cloning,
    uploading,
    viewerName,
    viewers,
    onClone,
    onUpload,
}: {
    title: string;
    editable: boolean;
    allowClone: boolean;
    cloning: boolean;
    uploading: boolean;
    viewerName: string;
    viewers: number;
    onClone: () => void;
    onUpload: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const syncState = useShareStore((state) => state.syncState);
    const syncError = useShareStore((state) => state.syncError);
    const streamStatus = useShareStore((state) => state.streamStatus);

    return (
        <header className="z-50 flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4" style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}>
            <div className="flex min-w-0 items-center gap-3">
                <span className="truncate text-base font-semibold tracking-tight">{title}</span>
                <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
                    style={editable ? { background: "rgba(34,197,94,.14)", color: "#16a34a" } : { background: theme.toolbar.activeBg, color: theme.node.muted }}
                >
                    {editable ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
                    {editable ? "可编辑" : "只读"}
                </span>
                {syncState === "saving" ? (
                    <span className="inline-flex items-center gap-1 text-xs" style={{ color: theme.node.muted }}>
                        <Loader2 className="size-3.5 animate-spin" />
                        保存中
                    </span>
                ) : null}
                {syncState === "failed" ? (
                    <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs" style={{ background: "rgba(239,68,68,.12)", color: "#ef4444" }} title={syncError}>
                        <CloudOff className="size-3.5" />
                        可能未同步
                    </span>
                ) : null}
                {streamStatus === "reconnecting" ? (
                    <span className="text-xs" style={{ color: theme.node.muted }}>
                        重新连接中…
                    </span>
                ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
                <Tooltip title={viewerName ? `你在此画布上的身份：${viewerName}` : ""}>
                    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                        <Users className="size-4" />
                        {viewers + 1}
                    </span>
                </Tooltip>
                {editable ? (
                    <Tooltip title="也可以直接粘贴或把图片拖进画布">
                        <Button icon={<ImagePlus className="size-4" />} loading={uploading} onClick={onUpload}>
                            上传图片
                        </Button>
                    </Tooltip>
                ) : null}
                {allowClone ? (
                    <Button type="primary" icon={<Save className="size-4" />} loading={cloning} onClick={onClone}>
                        保存到我的账号
                    </Button>
                ) : null}
            </div>
        </header>
    );
}

function ShareNotice({ tone, title, detail }: { tone: "loading" | "gone" | "error"; title: string; detail: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const hasAccount = useServerStore((state) => Boolean(state.token));
    return (
        <main className="grid h-dvh w-full place-items-center px-6" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
                <span className="grid size-14 place-items-center rounded-2xl border" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    {tone === "loading" ? <Loader2 className="size-6 animate-spin" /> : <Link2Off className="size-6" />}
                </span>
                <div className="space-y-1.5">
                    <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
                    <p className="text-sm" style={{ color: theme.node.muted }}>
                        {detail || (tone === "gone" ? "分享链接可能已被创建者停用、设置了过期时间，或需要登录后才能访问。" : "")}
                    </p>
                </div>
                {tone === "gone" && !hasAccount ? (
                    <Button icon={<LogIn className="size-4" />} onClick={() => setLoginOpen(true)}>
                        登录后重试
                    </Button>
                ) : null}
                <a href="/" className="text-sm underline underline-offset-4" style={{ color: theme.node.muted }}>
                    返回首页
                </a>
            </div>
        </main>
    );
}
