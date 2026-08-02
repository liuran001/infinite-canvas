import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import { CloudOff, Eye, Link2Off, Loader2, LogIn, Pencil, Save, Users } from "lucide-react";

import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useNoIndexMeta } from "@/hooks/use-noindex-meta";
import { canvasThemes } from "@/lib/canvas-theme";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { isHiddenBatchChild, isHiddenBatchConnectionEndpoint } from "@/lib/canvas/canvas-node-geometry";
import { shareApi, isShareGone } from "@/services/api/share";
import { openShareSession, rememberPendingClone, refreshShareSession, takePendingClone } from "@/services/share-session";
import { createSharePresenceReporter, flushShareProject, loadShareProject, pushShareProject, resetShareSync, watchShareProject } from "@/services/share-sync";
import { useServerStore } from "@/stores/use-server-store";
import { useShareStore } from "@/stores/use-share-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

/**
 * 独立的分享画布页 `/s/:token`。
 *
 * 刻意不复用 `/canvas/:id`：项目页假定存在账号会话、项目列表、Agent 面板与生成入口，
 * 在分享态下逐个条件隐藏会留下大量易错分支。这里只挂画布本体、Presence 与（editor 时的）保存，
 * 底层复用同一套画布组件与三方合并逻辑。
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
    const allowClone = useShareStore((state) => state.allowClone);
    const project = useShareStore((state) => state.project);
    const members = useShareStore((state) => state.members);
    const displayName = useShareStore((state) => state.displayName);
    const cloning = useShareStore((state) => state.cloning);
    const userToken = useServerStore((state) => state.token);

    const editable = role === "editor" && status === "ready";

    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const nodesRef = useRef<CanvasNodeData[]>([]);
    const viewportRef = useRef(viewport);
    const selectedRef = useRef(selectedNodeIds);
    const didCenterRef = useRef(false);
    const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, initial: [] as Array<{ id: string; x: number; y: number }> });
    const rafRef = useRef<number | null>(null);
    const presenceRef = useRef<ReturnType<typeof createSharePresenceReporter> | null>(null);

    // 分享页三重 noindex 的运行时那一层：进页面注入 robots meta，离开时移除。
    useNoIndexMeta();

    useEffect(() => {
        nodesRef.current = nodes;
        viewportRef.current = viewport;
        selectedRef.current = selectedNodeIds;
    }, [nodes, selectedNodeIds, viewport]);

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
            const loaded = await loadShareProject(session.project.id);
            if (cancelled || !loaded) return;
            setNodes(await hydrateCanvasImages(loaded.nodes, { allowUpload: false }));
        })();
        return () => {
            cancelled = true;
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

    /** SSE 与 Presence：与账号侧同一套语义，撤销后服务端断流，这里判定失效并停止重试。 */
    useEffect(() => {
        if (status !== "ready" || !project) return;
        const controller = new AbortController();
        const reporter = createSharePresenceReporter(project.id);
        presenceRef.current = reporter;
        watchShareProject(
            project.id,
            {
                onProject: (next) => void hydrateCanvasImages(next.nodes, { allowUpload: false }).then(setNodes),
                onDeleted: () => useShareStore.getState().markGone("画布已被删除"),
            },
            controller.signal,
        );
        return () => {
            controller.abort();
            reporter.dispose();
            presenceRef.current = null;
        };
    }, [project?.id, status]);

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

    return (
        <main className="relative flex h-dvh w-full flex-col overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <ShareTopBar title={project.title || "未命名画布"} editable={editable} allowClone={allowClone} cloning={cloning} viewerName={displayName} viewers={members.length} onClone={() => void cloneToMyAccount()} />

            <section className="relative min-h-0 flex-1">
                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={project.backgroundMode || "lines"}
                    onViewportChange={setViewport}
                    onCanvasDeselect={() => setSelectedNodeIds(new Set())}
                    // 只读时右键菜单整体不可用；可编辑时分享态也不开放右键菜单里的生成类操作，一律拦掉。
                    onContextMenu={(event) => event.preventDefault()}
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
                                onResize={handleNodeResize}
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

function ShareTopBar({ title, editable, allowClone, cloning, viewerName, viewers, onClone }: { title: string; editable: boolean; allowClone: boolean; cloning: boolean; viewerName: string; viewers: number; onClone: () => void }) {
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
