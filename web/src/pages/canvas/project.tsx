import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bot, CloudOff, Download, Group, Home, Loader2, LogIn, PanelLeftClose, PanelLeftOpen, Puzzle, Redo2, Save, Settings2, Undo2, Upload, Users, Video } from "lucide-react";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ensureGenerationBillingConsent, generateAudio, generateImages, generateText, generateVideo, isGenerationReady, resumeImages, resumeMedia, resumeText, storeGeneratedImage } from "@/services/api/generation";
import { useJobStore, type JobContext, type TrackedJob } from "@/stores/use-job-store";
import { defaultConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadShareImage, uploadShareMedia } from "@/services/share-upload";
import { isShareGone, shareApi } from "@/services/api/share";
import { rememberPendingClone, takePendingClone } from "@/services/share-session";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { App, Button, Modal, Tooltip } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildNodeGenerationContext, buildNodeGenerationInputs, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasMobileHintDialog } from "@/components/canvas/canvas-mobile-hint-dialog";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { IMAGE_FILE_ACCEPT, isImageFile } from "@/lib/image-transcode";
import { useCloudAgentStore } from "@/stores/use-cloud-agent-store";
import { CLOUD_AGENT_DROP_SELECTOR, CLOUD_AGENT_IMAGE_MIME } from "@/components/agent/cloud-agent-references";
import { isServerMode, useIsServerMode, useServerStore } from "@/stores/use-server-store";
import { finishApplyingRemoteProject, onRemoteProjectApplied, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { pullProject } from "@/services/remote-sync";
import { createPresenceReporter, watchProject } from "@/services/project-realtime";
import { createSharePresenceReporter, flushShareProject, pushShareProject, watchShareProject } from "@/services/share-sync";
import { mergeProjectSnapshots } from "@/services/project-merge";
import { useProjectPresenceStore } from "@/stores/use-project-presence-store";
import { useShareReadOnly, useShareStore } from "@/stores/use-share-store";
import type { ServerJob, ServerProjectPresence } from "@/services/api/server";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { SharePanel } from "@/components/canvas/share-panel";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

function matchesRenderSnapshot(snapshot: CanvasHistoryEntry | null, current: CanvasHistoryEntry) {
    return Boolean(
        snapshot &&
            snapshot.nodes === current.nodes &&
            snapshot.connections === current.connections &&
            snapshot.chatSessions === current.chatSessions &&
            snapshot.activeChatId === current.activeChatId &&
            snapshot.backgroundMode === current.backgroundMode &&
            snapshot.showImageInfo === current.showImageInfo,
    );
}

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
    jobId?: string;
};

type PendingShareHydration = { sequence: number; base: CanvasProject; remote: CanvasProject; local: CanvasHistoryEntry | null };

function projectWithRender(project: CanvasProject, render: CanvasHistoryEntry): CanvasProject {
    return { ...project, ...render, updatedAt: new Date().toISOString() };
}

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
/**
 * 同理，但这一个是 zustand selector 的返回值，后果比掉 memo 严重得多：
 * selector 就是 useSyncExternalStore 的 getSnapshot，每次返回新的 `[]` 会让 React 认为快照一直在变，
 * 于是无限重渲染并抛「Maximum update depth exceeded」——协作状态还没绑上的那一瞬间画布就白屏了。
 */
const EMPTY_PRESENCE: ServerProjectPresence[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

function trackedShareCanvasJob(job: ServerJob, projectId: string): TrackedJob | null {
    const context = (job.context || {}) as Record<string, unknown>;
    if (context.source !== "canvas" || context.projectId !== projectId || typeof context.nodeId !== "string") return null;
    return {
        clientJobId: job.clientJobId,
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        progress: job.progress,
        model: job.model,
        context: { source: "canvas", projectId, nodeId: context.nodeId, prompt: typeof context.prompt === "string" ? context.prompt : "" },
    };
}

function trackedShareCanvasJobs(jobs: ServerJob[], projectId: string) {
    const seenClientJobIds = new Set<string>();
    return jobs
        .map((job) => trackedShareCanvasJob(job, projectId))
        .filter((job): job is TrackedJob => {
            if (!job || seenClientJobIds.has(job.clientJobId)) return false;
            seenClientJobIds.add(job.clientJobId);
            return true;
        });
}

function canvasJobNode(nodes: CanvasNodeData[], job: TrackedJob) {
    return nodes.find((node) => node.id === job.context.nodeId);
}

function canvasJobImageId(node: CanvasNodeData | undefined, job: TrackedJob) {
    return job.kind === "image" && node?.metadata?.images?.some((image) => image.id === job.clientJobId) ? job.clientJobId : undefined;
}

function canvasJobRequestKey(nodes: CanvasNodeData[], job: TrackedJob) {
    return canvasJobImageId(canvasJobNode(nodes, job), job) || job.context.nodeId || "";
}

function isResumableCanvasJob(nodes: CanvasNodeData[], job: TrackedJob) {
    const node = canvasJobNode(nodes, job);
    if (!node || node.metadata?.status !== NODE_STATUS_LOADING || job.status === "canceled") return false;
    if (job.kind !== "image" || !node.metadata.images?.length) return true;
    return node.metadata.images.some((image) => image.id === job.clientJobId && image.status === NODE_STATUS_LOADING);
}

function resetInterruptedCanvasJobs(nodes: CanvasNodeData[], resumable: TrackedJob[]) {
    const resumingNodeIds = new Set(resumable.map((job) => job.context.nodeId || ""));
    const resumingImageIds = new Set(resumable.filter((job) => job.kind === "image").map((job) => job.clientJobId));
    return resetInterruptedGeneration(nodes, resumingNodeIds).map((node) => {
        if (!node.metadata?.images?.some((image) => image.status === NODE_STATUS_LOADING && !resumingImageIds.has(image.id))) return node;
        const images = node.metadata.images.map((image) =>
            image.status === NODE_STATUS_LOADING && !resumingImageIds.has(image.id) ? { ...image, status: NODE_STATUS_ERROR, errorDetails: "页面刷新后生成已中断，请重新生成。" } : image,
        );
        const status = images.some((image) => image.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : images.some((image) => image.status === NODE_STATUS_SUCCESS) ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR;
        return { ...node, metadata: { ...node.metadata, images, status, errorDetails: status === NODE_STATUS_ERROR ? node.metadata.errorDetails || "页面刷新后生成已中断，请重新生成。" : undefined } };
    });
}

function settleRecoveredGenerationAncestors(nodes: CanvasNodeData[], connections: CanvasConnection[], targetNodeId: string) {
    let next = nodes;
    let frontier = new Set([targetNodeId]);
    const visited = new Set(frontier);
    for (let depth = 0; depth < 3; depth += 1) {
        const parentIds = new Set(
            connections
                .filter((connection) => frontier.has(connection.toNodeId) && !visited.has(connection.fromNodeId))
                .map((connection) => connection.fromNodeId),
        );
        if (!parentIds.size) break;
        parentIds.forEach((id) => visited.add(id));
        const nodeById = new Map(next.map((node) => [node.id, node]));
        next = next.map((node) => {
            if (!parentIds.has(node.id) || ![NODE_STATUS_LOADING, NODE_STATUS_ERROR].includes(node.metadata?.status as typeof NODE_STATUS_LOADING | typeof NODE_STATUS_ERROR)) return node;
            const children = connections.map((connection) => (connection.fromNodeId === node.id ? nodeById.get(connection.toNodeId) : undefined)).filter((item): item is CanvasNodeData => Boolean(item));
            if (!children.length) return node;
            if (children.some((child) => child.metadata?.status === NODE_STATUS_SUCCESS)) return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } };
            if (children.every((child) => child.metadata?.status !== NODE_STATUS_LOADING)) return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: node.metadata?.errorDetails || "生成失败" } };
            return node;
        });
        frontier = parentIds;
    }
    return next;
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

export function InfiniteCanvasPage({ shared = false }: { shared?: boolean } = {}) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const sharedProject = useShareStore((state) => (shared ? state.project : null));
    const sharedMembers = useShareStore((state) => (shared ? state.members : EMPTY_PRESENCE));
    const sharedAllowClone = useShareStore((state) => shared && state.allowClone);
    const sharedCloning = useShareStore((state) => shared && state.cloning);
    const sharedDisplayName = useShareStore((state) => (shared ? state.displayName : ""));
    const sharedAnonymous = useShareStore((state) => shared && state.anonymous);
    const sharedAgentIdentity = useShareStore((state) => (shared ? `${state.shareId}:${state.actorId}` : ""));
    const shareReadOnly = useShareReadOnly();
    const sharedReadOnly = shared && shareReadOnly;
    const projectId = shared ? sharedProject?.id || "" : params.id || "";
    const localAgentConnected = useAgentStore((state) => state.connected);
    const localAgentActivity = useAgentStore((state) => state.activity);
    const localAgentEnabled = useAgentStore((state) => state.enabled);
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const toggleAgentPanel = useAgentStore((state) => state.togglePanel);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const ownedProject = useCanvasStore((state) => (shared ? undefined : state.projects.find((project) => project.id === projectId)));
    const currentProject = shared ? sharedProject : ownedProject;
    const bindCloudAgentProject = useCloudAgentStore((state) => state.bindProject);
    const cloudAgentCanvasReload = useCloudAgentStore((state) => state.canvasReload);
    /** Agent 面板里悬停/点击的那个引用，画布把它高亮出来，好让用户确认自己引的到底是哪个节点。 */
    const cloudReferenceNodeId = useCloudAgentStore((state) => state.referenceNodeId);
    const cloudReferenceReveal = useCloudAgentStore((state) => state.referenceReveal);
    const consumeCloudReferenceReveal = useCloudAgentStore((state) => state.consumeReferenceReveal);
    const isServerModeReady = useIsServerMode();
    const serverToken = useServerStore((state) => state.token);
    const cloudAgentEnabled = useServerStore((state) => Boolean(state.settings?.agent.enabled));
    const ownedPresence = useProjectPresenceStore((state) => (!shared && state.projectId === projectId ? state.members : EMPTY_PRESENCE));
    const remotePresence = shared ? sharedMembers : ownedPresence;
    const appliedCanvasReloadRef = useRef(0);
    const canvasReloadRetryRef = useRef(0);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [canvasTool, setCanvasTool] = useState<"select" | "pan">("pan");
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [generationRequestVersion, setGenerationRequestVersion] = useState(0);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [sharePanelOpen, setSharePanelOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedImageNodeId, setExpandedImageNodeId] = useState<string | null>(null);
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

    const presenceReporterRef = useRef<ReturnType<typeof createPresenceReporter> | ReturnType<typeof createSharePresenceReporter> | null>(null);
    const applyingRemoteRenderRef = useRef(false);
    const pendingRemoteRenderRef = useRef<CanvasHistoryEntry | null>(null);
    const pendingShareHydrationRef = useRef<PendingShareHydration | null>(null);
    const remoteApplySeqRef = useRef(0);
    const localRenderSeqRef = useRef(0);
    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const currentRenderRef = useRef<CanvasHistoryEntry>({ nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    /** 同一服务端任务只接管一次，避免远程快照与低频轮询重复启动等待流程。 */
    const shareJobByRequestRef = useRef(new Map<string, string>());
    const uploadCanvasImage = useCallback((input: string | Blob) => (shared ? uploadShareImage(input) : uploadImage(input)), [shared]);
    const uploadCanvasMedia = useCallback((input: string | Blob, prefix: string) => (shared ? uploadShareMedia(input, prefix) : uploadMediaFile(input, prefix)), [shared]);
    const loadingShareNodeKey = useMemo(
        () =>
            shared
                ? nodes
                      .filter((node) => node.metadata?.status === NODE_STATUS_LOADING)
                      .map((node) => node.id)
                      .sort()
                      .join("\0")
                : "",
        [nodes, shared],
    );

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController(), jobId?: string) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller, jobId });
        if (!jobId) shareJobByRequestRef.current.delete(targetNodeId);
        setGenerationRequestVersion((version) => version + 1);
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) {
            generationRequestsRef.current.delete(targetNodeId);
            setGenerationRequestVersion((version) => version + 1);
        }
    }, []);

    const isCurrentCanvasJob = useCallback((nodeId: string, jobId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(nodeId);
        return request?.controller === controller && request.jobId === jobId && (!shared || shareJobByRequestRef.current.get(nodeId) === jobId);
    }, [shared]);

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        if (affectedNodeIds.size) setGenerationRequestVersion((version) => version + 1);
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) =>
            prev.map((node) =>
                affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined, images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)) } }
                    : node,
            ),
        );
    }, [t]);

    /** 生成任务的归属信息，刷新后靠它把服务端任务定位回对应节点。 */
    const jobContext = useCallback((nodeId: string, prompt: string): JobContext => ({ source: "canvas", projectId, nodeId, prompt }), [projectId]);

    /** 续查刷新前留下的服务端生成任务，结果直接写回原节点，不重新发起生成。 */
    const resumeCanvasJob = useCallback(async (job: TrackedJob) => {
        const nodeId = job.context.nodeId || "";
        if (!nodeId) return;
        const target = nodesRef.current.find((item) => item.id === nodeId);
        if (!target) return;
        const imageId = canvasJobImageId(target, job);
        if (job.kind === "image" && target.metadata?.images?.length && !imageId) return;
        const requestKey = imageId || nodeId;
        if (shared) shareJobByRequestRef.current.set(requestKey, job.jobId);
        const controller = startGenerationRequest(requestKey, nodeId, nodeId, new AbortController(), job.jobId);
        const current = () => isCurrentCanvasJob(requestKey, job.jobId, controller);
        try {
            if (job.kind === "text") {
                // 文本任务已经生成出来的部分在服务端，续订事件流即可先拿回这一半，再接着收后面的内容。
                const answer = await resumeText(
                    job,
                    (text) => {
                        if (current()) setNodes((prev) => (current() ? prev.map((item) => (item.id === nodeId ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text } } : item)) : prev));
                    },
                    { signal: controller.signal, context: job.context },
                );
                if (current()) setNodes((prev) => (current() ? settleRecoveredGenerationAncestors(prev.map((item) => (item.id === nodeId ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : item)), connectionsRef.current, nodeId) : prev));
                return;
            }
            if (job.kind === "image") {
                const image = await storeGeneratedImage((await resumeImages(job, { signal: controller.signal, context: job.context }))[0]);
                if (!current()) return;
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const size = fitNodeSize(image.width, image.height, spec.width, spec.height);
                setNodes((prev) => {
                    if (!current()) return prev;
                    const next = prev.map((item) => {
                        if (item.id !== nodeId) return item;
                        const center = { x: item.position.x + item.width / 2, y: item.position.y + item.height / 2 };
                        if (!imageId) {
                            return {
                                ...item,
                                position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
                                width: size.width,
                                height: size.height,
                                metadata: { ...item.metadata, ...imageMetadata(image) },
                            };
                        }
                        const recoveredImage: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: image.url, storageKey: image.storageKey, naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
                        const images = item.metadata?.images?.map((currentImage) => (currentImage.id === imageId ? recoveredImage : currentImage)) || [];
                        const makePrimary = !item.metadata?.content || !item.metadata?.primaryImageId || item.metadata.primaryImageId === imageId;
                        const status = images.some((currentImage) => currentImage.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : images.some((currentImage) => currentImage.status === NODE_STATUS_SUCCESS) ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR;
                        return {
                            ...item,
                            ...(makePrimary ? { position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, width: size.width, height: size.height } : {}),
                            metadata: { ...item.metadata, ...(makePrimary ? imageMetadata(image) : {}), images, primaryImageId: makePrimary ? imageId : item.metadata?.primaryImageId, status, errorDetails: status === NODE_STATUS_ERROR ? item.metadata?.errorDetails : undefined },
                        };
                    });
                    return settleRecoveredGenerationAncestors(next, connectionsRef.current, nodeId);
                });
                return;
            }
            const media = await resumeMedia(job, { signal: controller.signal, context: job.context });
            if (!current()) return;
            if (job.kind === "audio") {
                setNodes((prev) => (current() ? settleRecoveredGenerationAncestors(prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, ...audioMetadata(media) } } : item)), connectionsRef.current, nodeId) : prev));
                return;
            }
            const size = fitNodeSize(media.width || VIDEO_NODE_MAX_WIDTH, media.height || VIDEO_NODE_MAX_HEIGHT, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
            setNodes((prev) => (current() ? settleRecoveredGenerationAncestors(prev.map((item) => (item.id === nodeId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...videoMetadata(media) } } : item)), connectionsRef.current, nodeId) : prev));
        } catch (error) {
            if (!current() || isGenerationCanceled(error)) return;
            const errorDetails = error instanceof Error ? error.message : "生成失败";
            setNodes((prev) => {
                if (!current()) return prev;
                const next = prev.map((item) => {
                    if (item.id !== nodeId) return item;
                    if (!imageId) return { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } };
                    const images = item.metadata?.images?.map((currentImage) => (currentImage.id === imageId ? { ...currentImage, status: NODE_STATUS_ERROR, errorDetails } : currentImage)) || [];
                    const status = images.some((currentImage) => currentImage.status === NODE_STATUS_LOADING) ? NODE_STATUS_LOADING : images.some((currentImage) => currentImage.status === NODE_STATUS_SUCCESS) ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR;
                    return { ...item, metadata: { ...item.metadata, images, status, errorDetails: status === NODE_STATUS_ERROR ? errorDetails : undefined } };
                });
                return settleRecoveredGenerationAncestors(next, connectionsRef.current, nodeId);
            });
        } finally {
            finishGenerationRequest(requestKey, controller);
            if (shareJobByRequestRef.current.get(requestKey) === job.jobId) shareJobByRequestRef.current.delete(requestKey);
        }
    }, [finishGenerationRequest, isCurrentCanvasJob, shared, startGenerationRequest]);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: t("canvas.projectPage.stopDescription"),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        shareJobByRequestRef.current.clear();
    }, [projectId]);

    useEffect(() => {
        if (!shared || !projectId) return;
        const project = useShareStore.getState().project;
        if (!project || project.id !== projectId) return;
        let cancelled = false;
        setProjectLoaded(false);
        void (async () => {
            const { guestToken } = useShareStore.getState();
            let fetchedJobs = false;
            let jobs: TrackedJob[] = [];
            if (guestToken) {
                try {
                    const response = await shareApi.jobs(guestToken, ["pending", "running", "succeeded", "failed", "canceled"]);
                    fetchedJobs = true;
                    jobs = trackedShareCanvasJobs(response.items, projectId);
                } catch {
                    // 任务列表临时不可用时保留服务端快照里的 loading 状态，避免把仍在跑的任务误标为中断。
                }
            }
            const resumable = jobs.filter((job) => isResumableCanvasJob(project.nodes, job));
            const restoredSource = fetchedJobs ? resetInterruptedCanvasJobs(project.nodes, resumable) : project.nodes;
            const restoredNodes = await hydrateCanvasImages(restoredSource, { allowUpload: false });
            const restoredSessions = project.chatSessions || [];
            if (cancelled) return;
            const restoredRender = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            applyingRemoteRenderRef.current = true;
            pendingRemoteRenderRef.current = restoredRender;
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            lastHistoryRef.current = restoredRender;
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
            resumable.forEach((job) => void resumeCanvasJob(job));
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId, resumeCanvasJob, shared]);

    useEffect(() => {
        if (!shared || !projectLoaded || !projectId || !loadingShareNodeKey) return;
        let disposed = false;
        let polling = false;
        const recoverShareJobs = async () => {
            if (disposed || polling) return;
            polling = true;
            try {
                const { guestToken } = useShareStore.getState();
                if (!guestToken) return;
                const response = await shareApi.jobs(guestToken, ["pending", "running", "succeeded", "failed", "canceled"]);
                if (disposed) return;
                const loadingNodeIds = new Set(loadingShareNodeKey.split("\0"));
                trackedShareCanvasJobs(response.items, projectId).forEach((job) => {
                    const nodeId = job.context.nodeId || "";
                    const requestKey = canvasJobRequestKey(nodesRef.current, job);
                    if (!loadingNodeIds.has(nodeId) || !isResumableCanvasJob(nodesRef.current, job) || generationRequestsRef.current.has(requestKey) || generationRequestsRef.current.has(nodeId) || shareJobByRequestRef.current.get(requestKey) === job.jobId) return;
                    shareJobByRequestRef.current.set(requestKey, job.jobId);
                    void resumeCanvasJob(job);
                });
            } catch {
                // 分享任务列表暂时不可用时保留 loading；下个低频周期继续恢复，不把仍在跑的任务误报为失败。
            } finally {
                polling = false;
            }
        };
        void recoverShareJobs();
        const timer = window.setInterval(recoverShareJobs, 2000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [loadingShareNodeKey, projectId, projectLoaded, resumeCanvasJob, shared]);

    useEffect(() => {
        if (shared) return;
        // 登录态是异步就绪的（要等 /auth/me 回来）。本地已经缓存过这张画布时，画布恢复会比登录态先跑完，
        // 那一刻查服务端任务会被判成「未登录」直接返回空，仍在跑的节点就被误报成「生成已中断」。
        // 有令牌就先等它确认完再恢复；令牌失效会被清空，这里也会跟着重新跑，不会卡死。
        if (!hydrated || (serverToken && !isServerModeReady)) return;
        setProjectLoaded(false);
        let cancelled = false;

        const restore = async () => {
            let project = openProject(projectId);
            // 换设备登录或直接打开画布链接时，本地还没同步到这张画布。
            // 这时先按 ID 拉一次再判定，否则会被误判成「画布不存在」踢回列表。
            if (!project && isServerMode()) {
                await pullProject(projectId).catch(() => null);
                if (cancelled) return;
                project = openProject(projectId);
            }
            if (!project) {
                navigate("/canvas", { replace: true });
                return;
            }
            // 服务端仍在跑的任务对应的节点保持「生成中」并继续续查；刷新那一刻任务可能刚好已经跑完，
            // 已结束的任务也补一份，否则结果拿不回来，已经生成好的内容会被误报成「生成已中断」。
            const [pendingJobs, finishedJobs] = await Promise.all([useJobStore.getState().restorePendingJobs(), useJobStore.getState().restoreFinishedJobs()]);
            const canvasJobs = [...pendingJobs, ...finishedJobs].filter((job) => job.context.source === "canvas" && job.context.projectId === projectId);
            // 只回填仍是「生成中」的节点：节点早就拿到结果的历史任务再续查一遍只是白打请求。
            const resumable = canvasJobs.filter((job) => isResumableCanvasJob(project.nodes, job));
            canvasJobs.filter((job) => !resumable.includes(job)).forEach((job) => useJobStore.getState().untrackJob(job.clientJobId));
            const restoredNodes = await hydrateCanvasImages(resetInterruptedCanvasJobs(project.nodes, resumable));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
            resumable.forEach((job) => void resumeCanvasJob(job));
        };
        void restore();
        return () => {
            cancelled = true;
        };
    }, [hydrated, isServerModeReady, navigate, openProject, projectId, serverToken, shared]);

    useEffect(() => {
        if (shared || !projectLoaded) return;
        return onRemoteProjectApplied((project) => {
            if (project.id !== projectId) return;
            const sequence = ++remoteApplySeqRef.current;
            const localSequence = localRenderSeqRef.current;
            void Promise.all([hydrateCanvasImages(project.nodes), hydrateAssistantImages(project.chatSessions || [])]).then(([nextNodes, nextSessions]) => {
                if (sequence !== remoteApplySeqRef.current || localSequence !== localRenderSeqRef.current) return;
                applyingRemoteRenderRef.current = true;
                pendingRemoteRenderRef.current = { nodes: nextNodes, connections: project.connections, chatSessions: nextSessions, activeChatId: project.activeChatId || null, backgroundMode: project.backgroundMode, showImageInfo: project.showImageInfo || false };
                setNodes(nextNodes);
                setConnections(project.connections);
                setChatSessions(nextSessions);
                setActiveChatId(project.activeChatId || null);
                setBackgroundMode(project.backgroundMode);
                setShowImageInfo(project.showImageInfo || false);
            });
        });
    }, [projectId, projectLoaded, shared]);

    useEffect(() => {
        if (!projectLoaded || (!shared && !isServerModeReady)) return;
        const controller = new AbortController();
        const applyProject = (incoming: CanvasProject, fromShare: boolean) => {
            const sequence = ++remoteApplySeqRef.current;
            const localSequence = localRenderSeqRef.current;
            let project = incoming;
            if (fromShare) {
                const pending = pendingShareHydrationRef.current;
                if (pending?.local) {
                    project = mergeProjectSnapshots(pending.base, projectWithRender(pending.base, pending.local), incoming);
                    pushShareProject(project);
                }
                pendingShareHydrationRef.current = { sequence, base: projectWithRender(project, currentRenderRef.current), remote: project, local: null };
            }
            void Promise.all([hydrateCanvasImages(project.nodes, fromShare ? { allowUpload: false } : undefined), fromShare ? Promise.resolve(project.chatSessions || []) : hydrateAssistantImages(project.chatSessions || [])])
                .then(([nextNodes, nextSessions]) => {
                    if (sequence !== remoteApplySeqRef.current) return;
                    let appliedProject = { ...project, nodes: nextNodes, chatSessions: nextSessions };
                    if (fromShare) {
                        const pending = pendingShareHydrationRef.current;
                        if (!pending || pending.sequence !== sequence) return;
                        const local = pending.local || (localSequence !== localRenderSeqRef.current ? currentRenderRef.current : null);
                        if (local) {
                            appliedProject = mergeProjectSnapshots(pending.base, projectWithRender(pending.base, local), appliedProject);
                            pushShareProject(appliedProject);
                        }
                        pendingShareHydrationRef.current = null;
                    } else if (localSequence !== localRenderSeqRef.current) return;
                    const render = {
                        nodes: appliedProject.nodes,
                        connections: appliedProject.connections,
                        chatSessions: appliedProject.chatSessions || [],
                        activeChatId: appliedProject.activeChatId || null,
                        backgroundMode: appliedProject.backgroundMode,
                        showImageInfo: appliedProject.showImageInfo || false,
                    };
                    applyingRemoteRenderRef.current = true;
                    pendingRemoteRenderRef.current = render;
                    setNodes(render.nodes);
                    setConnections(render.connections);
                    setChatSessions(render.chatSessions);
                    setActiveChatId(render.activeChatId);
                    setBackgroundMode(render.backgroundMode);
                    setShowImageInfo(render.showImageInfo);
                })
                .catch(() => {
                    if (!fromShare) return;
                    const pending = pendingShareHydrationRef.current;
                    if (!pending || pending.sequence !== sequence) return;
                    pendingShareHydrationRef.current = null;
                    if (pending.local) pushShareProject(mergeProjectSnapshots(pending.base, projectWithRender(pending.base, pending.local), pending.remote));
                });
        };
        const reporter = shared ? createSharePresenceReporter(projectId) : createPresenceReporter(projectId);
        presenceReporterRef.current = reporter;
        if (shared) {
            watchShareProject(projectId, { onProject: (project) => applyProject(project, true), onDeleted: () => useShareStore.getState().markGone("画布已被删除") }, controller.signal);
        } else {
            watchProject(
                projectId,
                {
                    onProject: () => {
                        const project = useCanvasStore.getState().openProject(projectId);
                        if (project) applyProject(project, false);
                    },
                    onDeleted: () => navigate("/canvas", { replace: true }),
                },
                controller.signal,
            );
        }
        return () => {
            remoteApplySeqRef.current += 1;
            const pending = pendingShareHydrationRef.current;
            pendingShareHydrationRef.current = null;
            if (shared && pending?.local) pushShareProject(mergeProjectSnapshots(pending.base, projectWithRender(pending.base, pending.local), pending.remote));
            controller.abort();
            reporter.dispose();
            presenceReporterRef.current = null;
            if (!shared) useProjectPresenceStore.getState().clear();
        };
    }, [isServerModeReady, navigate, projectId, projectLoaded, shared]);

    useEffect(() => {
        if (!projectLoaded || (!shared && !isServerModeReady)) return;
        presenceReporterRef.current?.update([...selectedNodeIds], isNodeDragging ? "editing" : selectedNodeIds.size ? "selecting" : "idle");
    }, [isNodeDragging, isServerModeReady, projectLoaded, selectedNodeIds, shared]);

    useEffect(() => {
        if (!shared || !projectLoaded) return;
        const flush = () => void flushShareProject();
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            flush();
        };
    }, [projectLoaded, shared]);

    // 云端 Agent 的会话按画布归属，进入画布就绑定：面板没打开也会挂上事件流，
    // agent 在后台改画布时画面才能实时刷新。登录态与服务端配置是异步就绪的，就绪后要再绑一次。
    useEffect(() => {
        if (!projectLoaded) return;
        bindCloudAgentProject(projectId, shared ? "share" : "account");
    }, [bindCloudAgentProject, cloudAgentEnabled, isServerModeReady, projectId, projectLoaded, shared, sharedAgentIdentity]);

    // 离开画布就解绑并断开事件流，免得在别的页面对着上一张画布继续发指令；回来会重新绑定并补齐进度。
    useEffect(() => () => useCloudAgentStore.getState().bindProject(""), []);

    // 画布是被服务端直接改的，本地这份是 React state，必须显式拉回来覆盖，
    // 否则不仅看不到新节点，本地旧状态回写还会把 agent 的改动顶掉。
    useEffect(() => {
        if (shared || !projectLoaded || cloudAgentCanvasReload === appliedCanvasReloadRef.current) return;
        appliedCanvasReloadRef.current = cloudAgentCanvasReload;
        void pullProject(projectId)
            .then(async (project) => {
                if (!project || useCloudAgentStore.getState().projectId !== projectId) return;
                canvasReloadRetryRef.current = 0;
                setNodes(await hydrateCanvasImages(project.nodes));
                setConnections(project.connections);
            })
            .catch((error) => {
                console.warn("拉取云端画布失败", error);
                // 断网时这次拉取必然失败，隔一会再排一次，恢复网络后画布才不会停在旧数据上。
                if (canvasReloadRetryRef.current >= 5) return;
                canvasReloadRetryRef.current += 1;
                setTimeout(() => useCloudAgentStore.getState().requestCanvasReload(), 3000);
            });
    }, [cloudAgentCanvasReload, projectId, projectLoaded, shared]);

    useEffect(() => {
        if (shared || !projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (!searchParams.has("agentUrl")) openAgentPanel();
    }, [openAgentPanel, projectLoaded, searchParams, shared]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useLayoutEffect(() => {
        if (!projectLoaded || matchesRenderSnapshot(pendingRemoteRenderRef.current, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo })) return;
        localRenderSeqRef.current += 1;
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        if (shared) {
            const render = { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo };
            const pendingHydration = pendingShareHydrationRef.current;
            if (pendingHydration) {
                pendingHydration.local = render;
                return;
            }
            const exactRemoteRender = matchesRenderSnapshot(pendingRemoteRenderRef.current, render);
            pendingRemoteRenderRef.current = null;
            applyingRemoteRenderRef.current = false;
            if (exactRemoteRender) return;
            const project = useShareStore.getState().project;
            if (project) pushShareProject(projectWithRender(project, render));
            return;
        }
        pendingRemoteRenderRef.current = null;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
        if (applyingRemoteRenderRef.current) {
            applyingRemoteRenderRef.current = false;
            finishApplyingRemoteProject(projectId);
        }
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, projectLoaded, shared, showImageInfo, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded || shared) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, shared, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        currentRenderRef.current = { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo };
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [activeChatId, backgroundMode, chatSessions, connections, connectionTargetNodeId, connectingParams, nodes, pendingConnectionCreate, selectedNodeIds, showImageInfo, viewport]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const remotePresenceByNodeId = useMemo(() => {
        const map = new Map<string, typeof remotePresence>();
        remotePresence.forEach((member) => member.nodeIds.forEach((nodeId) => map.set(nodeId, [...(map.get(nodeId) || []), member])));
        return map;
    }, [remotePresence]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        projectId,
        shared,
        effectiveConfig,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
        },
        [],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setExpandedImageNodeId(null);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
    }, [deselectCanvas]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    /** 平滑滑到目标视口。侧栏定位与面板引用定位共用一份缓动，别各写各的。 */
    const animateViewport = useCallback((target: ViewportTransform) => {
        if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
        const start = { ...viewportRef.current };
        const duration = 450;
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
        let startTime: number | null = null;
        const step = (now: number) => {
            if (startTime === null) startTime = now;
            const progress = Math.min((now - startTime) / duration, 1);
            const t = easeOutCubic(progress);
            setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
            focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
        };
        focusAnimRef.current = requestAnimationFrame(step);
    }, []);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1.5);
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            animateViewport({ x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k });
        },
        [animateViewport, size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    /**
     * 面板里点了某个节点引用：节点已经看得见就别动画面，看不见才平移过去。
     * 只改 x/y 不改 k——缩放是用户自己调的，替他改掉等于把他的视角搞乱；也不碰 selectedNodeIds。
     */
    useEffect(() => {
        if (shared || !cloudReferenceReveal) return;
        consumeCloudReferenceReveal();
        const node = nodesRef.current.find((item) => item.id === cloudReferenceReveal.nodeId);
        if (!node) return;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        // 视口边缘留一圈余量，节点刚好卡在边上也算「看不见」，照样移过去。
        const margin = 60;
        const topLeft = screenToCanvas((rect?.left || 0) + margin, (rect?.top || 0) + margin);
        const bottomRight = screenToCanvas((rect?.left || 0) + width - margin, (rect?.top || 0) + height - margin);
        if (node.position.x >= topLeft.x && node.position.y >= topLeft.y && node.position.x + node.width <= bottomRight.x && node.position.y + node.height <= bottomRight.y) return;
        const k = viewportRef.current.k;
        animateViewport({ x: width / 2 - (node.position.x + node.width / 2) * k, y: height / 2 - (node.position.y + node.height / 2) * k, k });
    }, [animateViewport, cloudReferenceReveal, consumeCloudReferenceReveal, screenToCanvas, shared, size.height, size.width]);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        navigate(`/canvas/${id}`);
    }, [createProject, navigate, t]);

    const deleteCurrentProject = useCallback(() => {
        deleteProjects([projectId]);
        navigate("/canvas");
    }, [deleteProjects, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = shared ? useShareStore.getState().project : useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error("未找到当前画布");
        const hide = message.loading("正在导出当前画布…", 0);
        try {
            await exportCanvasProjects([project], project.title || t("canvas.title"));
            message.success(t("canvas.projectPage.exported"));
        } catch (error) {
            console.error(error);
            message.error(t("canvas.sidePanel.exportFailed"));
        } finally {
            hide();
        }
    }, [message, projectId, shared]);

    const cloneSharedProject = useCallback(async () => {
        if (!shared) return;
        const store = useShareStore.getState();
        if (!store.allowClone || store.cloning) return;
        if (!useServerStore.getState().token) {
            rememberPendingClone(store.token);
            useServerStore.getState().setLoginOpen(true);
            message.info("请先登录，登录后会继续保存到你的账号");
            return;
        }
        store.setCloning(true);
        try {
            const created = await shareApi.clone(store.token, store.guestToken);
            message.success("已保存到你的画布");
            navigate(`/canvas/${created.id}`);
        } catch (error) {
            if (isShareGone(error)) useShareStore.getState().markGone("链接已失效");
            else message.error(error instanceof Error ? error.message : "保存到我的账号失败");
        } finally {
            useShareStore.getState().setCloning(false);
        }
    }, [message, navigate, shared]);

    useEffect(() => {
        if (!shared || !serverToken) return;
        const token = useShareStore.getState().token;
        if (token && takePendingClone(token)) void cloneSharedProject();
    }, [cloneSharedProject, serverToken, shared]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setExpandedImageNodeId(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            setEditingNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;
        // 松手的地方在右侧 Agent 面板上：这是「把节点作为引用插进输入框」，不是把节点挪过去。
        const onAgentPanel = clientX != null && clientY != null && Boolean(document.elementFromPoint(clientX, clientY)?.closest(CLOUD_AGENT_DROP_SELECTOR));

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        useCloudAgentStore.getState().setReferenceDropActive(false);
        if (onAgentPanel) {
            // 面板压在画布右侧，真按落点挪过去用户就再也看不见这些节点了，位置一律回滚到拖拽前。
            const cloud = useCloudAgentStore.getState();
            nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id)).forEach((node) => cloud.dropReference(node));
            if (dragRef.current.hasMoved) {
                setNodes((prev) =>
                    prev.map((node) => {
                        const initial = initialPositions.find((item) => item.id === node.id);
                        return initial ? { ...node, position: { x: initial.x, y: initial.y } } : node;
                    }),
                );
            }
        } else if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);
                // 拖到 Agent 面板上方时给个可以松手的提示。面板没开就不用查，省下每次 mousemove 的一次命中测试。
                if (useAgentStore.getState().panelOpen) {
                    const overPanel = Boolean(document.elementFromPoint(event.clientX, event.clientY)?.closest(CLOUD_AGENT_DROP_SELECTOR));
                    if (useCloudAgentStore.getState().referenceDropActive !== overPanel) useCloudAgentStore.getState().setReferenceDropActive(overPanel);
                }

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadCanvasImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [uploadCanvasImage]);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadCanvasMedia(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [uploadCanvasMedia]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadCanvasMedia(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, [uploadCanvasMedia]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
        setExpandedImageNodeId(null);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        setExpandedImageNodeId((current) => (current === nodeId ? null : nodeId));
    }, []);

    const setBatchPrimary = useCallback((nodeId: string, imageId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const image = node.metadata?.images?.find((item) => item.id === imageId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const downloadBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        saveAs(image.content, `canvas-image-${node.id}-${image.id}.${imageExtension(image.content)}`);
    }, []);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (shared && !useServerStore.getState().token) {
                useServerStore.getState().setLoginOpen(true);
                message.info("请先登录后再加入我的资产");
                return;
            }
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error(t("canvas.projectPage.noTextToSave"));
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasText"), coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                let copied: Awaited<ReturnType<typeof uploadMediaFile>> | null = null;
                if (shared) {
                    try {
                        copied = await uploadMediaFile(node.metadata.content, "canvas-video");
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "保存视频失败");
                        return;
                    }
                }
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || t("canvas.projectPage.canvasVideo"),
                    coverUrl: "",
                    tags: [],
                    source: "Canvas",
                    data: { url: copied?.url || node.metadata.content, storageKey: copied?.storageKey || node.metadata.storageKey, width: copied?.width || node.width, height: copied?.height || node.height, bytes: copied?.bytes || node.metadata.bytes || 0, mimeType: copied?.mimeType || node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success(t("common.addedToAssets"));
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            let copied: Awaited<ReturnType<typeof uploadImage>> | null = null;
            if (shared) {
                try {
                    copied = await uploadImage(node.metadata.content);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "保存图片失败");
                    return;
                }
            }
            const dataUrl = copied || node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: copied?.url || node.metadata.content,
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: copied?.storageKey || node.metadata.storageKey,
                    width: copied?.width || node.metadata.naturalWidth || node.width,
                    height: copied?.height || node.metadata.naturalHeight || node.height,
                    bytes: copied?.bytes || node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: copied?.mimeType || node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success(t("common.addedToAssets"));
        },
        [addAsset, message, shared],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadCanvasImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, [uploadCanvasImage]);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadCanvasImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, uploadCanvasImage],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadCanvasImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, [uploadCanvasImage]);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isGenerationReady()) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            let acceptSelfPay = false;
            try {
                acceptSelfPay = await ensureGenerationBillingConsent(jobContext(childId, prompt));
            } catch (error) {
                if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : "生成失败");
                return;
            }
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await generateImages(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    { signal: controller.signal, context: jobContext(childId, prompt), acceptSelfPay },
                ).then((items) => items[0]);
                const uploaded = await storeGeneratedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, jobContext, message, openConfigDialog, startGenerationRequest],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => isImageFile(f) || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadCanvasMedia(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadCanvasMedia(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadCanvasImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width, uploadCanvasImage, uploadCanvasMedia],
    );

    /** 面板里的图片拖回画布：复用它已有的 storageKey，指向的还是同一份服务端文件，不重新上传也不重复占配额。 */
    const createStoredImageNode = useCallback(async (payload: { name?: string; url: string; storageKey: string; width?: number; height?: number }, position: Position) => {
        // 会话记录里的缩略图只有直链没有尺寸，这时候读一次原图的固有尺寸，节点比例才不会被拉歪。
        const meta = payload.width && payload.height ? { width: payload.width, height: payload.height, mimeType: "image/png" } : await readImageMeta(payload.url);
        const size = fitNodeSize(meta.width, meta.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Image,
                title: payload.name || "图片",
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata({ url: payload.url, storageKey: payload.storageKey, width: meta.width, height: meta.height, bytes: 0, mimeType: meta.mimeType }),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            // Agent 面板里的图片：拖拽数据里只有 storageKey，落点用鼠标松开处的画布坐标。
            const stored = event.dataTransfer.getData(CLOUD_AGENT_IMAGE_MIME);
            if (stored) {
                try {
                    const payload = JSON.parse(stored) as { name?: string; url: string; storageKey: string; width?: number; height?: number };
                    if (payload?.storageKey && payload.url) void createStoredImageNode(payload, screenToCanvas(event.clientX, event.clientY));
                } catch {
                    message.error("拖入的图片信息无法识别");
                }
                return;
            }
            const files = Array.from(event.dataTransfer.files).filter(
                (item) => isImageFile(item) || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createStoredImageNode, createVideoFileNode, message, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || t("canvas.projectPage.untitledCanvas"));
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) {
            if (shared) {
                const project = useShareStore.getState().project;
                if (project) pushShareProject({ ...project, title: nextTitle, updatedAt: new Date().toISOString() });
            } else {
                renameProject(projectId, nextTitle);
            }
        }
        setTitleEditing(false);
    }, [projectId, renameProject, shared, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isGenerationReady()) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                let acceptSelfPay = false;
                try {
                    acceptSelfPay = await ensureGenerationBillingConsent(jobContext(nodeId, scene));
                } catch (error) {
                    if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : "生成失败");
                    return;
                }
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    // Upstream image nodes become references; without them this is text-to-image.
                    const upstreamNodes = connectionsRef.current
                        .filter((conn) => conn.toNodeId === nodeId)
                        .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node));
                    const refs = upstreamNodes.flatMap((up) =>
                        typeof up.metadata?.content === "string" && up.metadata.content && up.type !== sourceNode.type
                            ? [{ id: up.id, name: `${up.title || up.id}.png`, type: up.metadata.mimeType || "image/png", dataUrl: up.metadata.content, storageKey: up.metadata.storageKey }]
                            : [],
                    );
                    const image = await generateImages({ ...generationConfig, count: "1" }, fullPrompt, refs, { signal: controller.signal, context: jobContext(nodeId, fullPrompt), acceptSelfPay }).then((items) => items[0]);
                    const uploaded = await storeGeneratedImage(image);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt }) : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let acceptSelfPay = false;
            try {
                acceptSelfPay = await ensureGenerationBillingConsent(jobContext(nodeId, effectivePrompt));
            } catch (error) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : "生成失败");
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            ...generationMetadata,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    await Promise.all(
                        imageIds.map(async (imageId) => {
                            try {
                                const image = await generateImages({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, { signal: controller.signal, clientJobId: imageId, context: jobContext(rootId, effectivePrompt), acceptSelfPay }).then((items) => items[0]);
                                const uploaded = await storeGeneratedImage(image);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.allFailed") } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const video = await generateVideo(generationConfig, effectivePrompt, generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios, { signal: controller.signal, context: jobContext(videoId, effectivePrompt), acceptSelfPay });
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await generateAudio(generationConfig, effectivePrompt, { signal: controller.signal, context: jobContext(audioId, effectivePrompt), acceptSelfPay });
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return generateText(
                            generationConfig,
                            effectivePrompt,
                            generationContext.referenceImages,
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                            },
                            { signal: controller.signal, context: jobContext(targetNodeId, effectivePrompt), acceptSelfPay },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, jobContext, message, openConfigDialog, startGenerationRequest],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isGenerationReady()) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"), images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)) } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];
            let acceptSelfPay = false;
            try {
                acceptSelfPay = await ensureGenerationBillingConsent(jobContext(node.id, prompt));
            } catch (error) {
                if (!isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : "生成失败");
                return;
            }

            const previousImageId = node.type === CanvasNodeType.Image ? imageId || node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id : undefined;
            const imageClientJobId = previousImageId ? nanoid() : undefined;
            setRunningNodeId(node.id);
            setNodes((prev) =>
                prev.map((item) =>
                    item.id === node.id
                        ? {
                              ...item,
                              metadata: {
                                  ...item.metadata,
                                  status: NODE_STATUS_LOADING,
                                  errorDetails: undefined,
                                  images: item.metadata?.images?.map((image) => (image.id === previousImageId ? { ...image, id: imageClientJobId || image.id, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)),
                                  primaryImageId: item.metadata?.primaryImageId === previousImageId ? imageClientJobId || previousImageId : item.metadata?.primaryImageId,
                              },
                          }
                        : item,
                ),
            );
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await generateText(
                        generationConfig,
                        prompt,
                        context.referenceImages,
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal, context: jobContext(node.id, prompt), acceptSelfPay },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const video = await generateVideo(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], { signal: controller.signal, context: jobContext(node.id, prompt), acceptSelfPay });
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await generateAudio(generationConfig, prompt, { signal: controller.signal, context: jobContext(node.id, prompt), acceptSelfPay });
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const image = await generateImages(generationConfig, prompt, useReferenceImages ? retryImages : [], { signal: controller.signal, clientJobId: imageClientJobId, context: jobContext(node.id, prompt), acceptSelfPay }).then((items) => items[0]);
                const uploadedImage = await storeGeneratedImage(image);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: imageClientJobId || previousImageId || nanoid(),
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    }),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : t("canvas.projectPage.generationFailed");
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : errorDetails, images: item.metadata?.images?.map((image) => (image.id === (imageClientJobId || imageId) ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, jobContext, message, openConfigDialog, startGenerationRequest],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedImageNodeId(null);
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                const primaryImage = item.metadata?.primaryImageId === imageId ? images[0] : undefined;
                return {
                    ...item,
                    metadata: {
                        ...item.metadata,
                        ...(primaryImage
                            ? {
                                  content: primaryImage.content,
                                  storageKey: primaryImage.storageKey,
                                  naturalWidth: primaryImage.naturalWidth,
                                  naturalHeight: primaryImage.naturalHeight,
                                  bytes: primaryImage.bytes,
                                  mimeType: primaryImage.mimeType,
                              }
                            : {}),
                        images,
                        count: images.length,
                        primaryImageId: primaryImage?.id ?? (item.metadata?.primaryImageId === imageId ? undefined : item.metadata?.primaryImageId),
                    },
                };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            const storedImage = image.storageKey ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadCanvasImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width, uploadCanvasImage],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        async (payload: InsertAssetPayload) => {
            try {
                if (payload.kind === "text") {
                    insertAssistantText(payload.content, payload.title);
                } else if (payload.kind === "video") {
                    const copied = shared ? await uploadShareMedia(payload.url, "asset-video") : null;
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                    const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                    const width = copied?.width || payload.width || spec.width;
                    const height = copied?.height || payload.height || spec.height;
                    const nextSize = fitNodeSize(width, height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) => [
                        ...prev,
                        {
                            id,
                            type: CanvasNodeType.Video,
                            title: payload.title,
                            position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                            width: nextSize.width,
                            height: nextSize.height,
                            metadata: copied ? videoMetadata(copied) : { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                        },
                    ]);
                    setSelectedNodeIds(new Set([id]));
                } else {
                    const source = payload.dataUrl || resolveImageUrl(payload.storageKey);
                    if (!source) throw new Error("图片资产无法读取，请重新上传");
                    const copied = shared ? await uploadShareImage(payload.dataUrl || resolveImageUrl(payload.storageKey)) : null;
                    await insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: copied?.url || source, storageKey: copied?.storageKey || payload.storageKey });
                }
                setAssetPickerOpen(false);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "插入资产失败");
            }
        },
        [insertAssistantImage, insertAssistantText, message, screenToCanvas, shared, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const isGenerationRunning = useCallback(
        (nodeId: string) => runningNodeId === nodeId || [...generationRequestsRef.current.values()].some((request) => request.runningNodeId === nodeId),
        [generationRequestVersion, runningNodeId],
    );

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={isGenerationRunning(panelNode.id)}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, isGenerationRunning, mentionReferencesByNodeId, renderPluginPanel],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={isGenerationRunning(contentNode.id)}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, isGenerationRunning],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} showAssets={!shared || Boolean(serverToken)} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                {shared ? <SharedCanvasTopBar title={currentProject?.title || "未命名画布"} titleDraft={titleDraft} isTitleEditing={titleEditing} onTitleDraftChange={setTitleDraft} onStartTitleEditing={startTitleEditing} onFinishTitleEditing={finishTitleEditing} onCancelTitleEditing={() => setTitleEditing(false)} canUndo={historyState.canUndo} canRedo={historyState.canRedo} viewers={remotePresence.length + 1} viewerName={sharedDisplayName} anonymous={sharedAnonymous} readOnly={Boolean(sharedReadOnly)} allowClone={sharedAllowClone} cloning={sharedCloning} agentOpen={agentPanelOpen} onClone={() => void cloneSharedProject()} onLogin={() => useServerStore.getState().setLoginOpen(true)} onHome={() => navigate("/")} onExport={exportCurrentProject} onImport={() => handleUploadRequest()} onOpenConfig={() => openConfigDialog(false)} onOpenPlugins={() => setPluginManagerOpen(true)} onUndo={undoCanvas} onRedo={redoCanvas} onToggleAgent={toggleAgentPanel} /> : (
                    <CanvasTopBar
                        title={currentProject?.title || "未命名画布"}
                        viewers={remotePresence.length + 1}
                        titleDraft={titleDraft}
                        isTitleEditing={titleEditing}
                        onTitleDraftChange={setTitleDraft}
                        onStartTitleEditing={startTitleEditing}
                        onFinishTitleEditing={finishTitleEditing}
                        onCancelTitleEditing={() => setTitleEditing(false)}
                        canUndo={historyState.canUndo}
                        canRedo={historyState.canRedo}
                        onHome={() => navigate("/")}
                        onProjects={() => navigate("/canvas")}
                        onCreateProject={createAndOpenProject}
                        onDeleteProject={deleteCurrentProject}
                        onExportProject={exportCurrentProject}
                        onImportImage={() => handleUploadRequest()}
                        onOpenPlugins={() => setPluginManagerOpen(true)}
                        onOpenShare={isServerModeReady ? () => setSharePanelOpen(true) : undefined}
                        onUndo={undoCanvas}
                        onRedo={redoCanvas}
                        agentOpen={agentPanelOpen}
                        compactAgentStatus={{ connected: localAgentConnected, enabled: localAgentEnabled, activity: localAgentActivity }}
                        onToggleAgent={toggleAgentPanel}
                    />
                )}

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    tool={canvasTool}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                        onContextMenu={(event) => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                        }}
                                    />
                                );
                            })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            remoteEditors={remotePresenceByNodeId.get(node.id) || []}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id || cloudReferenceNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedImageNodeId === node.id}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={handleNodeViewImage}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedImageNodeId ? null : toolbarNode}
                    viewport={viewport}
                    readOnly={Boolean(sharedReadOnly)}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={() => message.info("服务端生成暂不支持蒙版编辑")}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                {!sharedReadOnly ? <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canvasTool={canvasTool}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onCanvasToolChange={setCanvasTool}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                /> : null}

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        readOnly={Boolean(sharedReadOnly)}
                        node={contextMenu.type === "node" ? nodesRef.current.find((item) => item.id === contextMenu.nodeId) : undefined}
                        onInfo={() => contextMenu.type === "node" && setInfoNodeId(contextMenu.nodeId)}
                        onDownload={() => contextMenu.type === "node" && downloadNodeImage(nodesRef.current.find((item) => item.id === contextMenu.nodeId)!)}
                        onViewImage={() => contextMenu.type === "node" && setPreviewNodeId(contextMenu.nodeId)}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept={`${IMAGE_FILE_ACCEPT},video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav`} className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />
                {!shared && isServerModeReady ? <SharePanel projectId={projectId} open={sharePanelOpen} onClose={() => setSharePanelOpen(false)} /> : null}

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                <Modal
                    title={t("canvas.projectPage.imageDetails")}
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content ? <img src={previewNode.metadata.content} alt={previewNode.title || t("assets.kinds.image")} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} /> : null}
                </Modal>

                <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal>

                {!shared || serverToken ? <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} /> : null}
                {shared ? <AppConfigModal /> : null}
                <CanvasMobileHintDialog />
            </section>
        </main>
    );
}

function SharedCanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    viewers,
    viewerName,
    anonymous,
    readOnly,
    allowClone,
    cloning,
    agentOpen,
    onClone,
    onLogin,
    onHome,
    onExport,
    onImport,
    onOpenConfig,
    onOpenPlugins,
    onUndo,
    onRedo,
    onToggleAgent,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    viewers: number;
    viewerName: string;
    anonymous: boolean;
    readOnly: boolean;
    allowClone: boolean;
    cloning: boolean;
    agentOpen: boolean;
    onClone: () => void;
    onLogin: () => void;
    onHome: () => void;
    onExport: () => void;
    onImport: () => void;
    onOpenConfig: () => void;
    onOpenPlugins: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onToggleAgent: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const syncState = useShareStore((state) => state.syncState);
    const syncError = useShareStore((state) => state.syncError);
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);
    const titleRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    const actionClass = "grid size-8 place-items-center rounded-lg transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-white/10";
    const action = (label: string, icon: ReactNode, onClick: () => void, options?: { disabled?: boolean; active?: boolean }) => (
        <Tooltip title={label}>
            <button type="button" className={actionClass} aria-label={label} aria-pressed={options?.active} disabled={options?.disabled} onClick={onClick}>
                {icon}
            </button>
        </Tooltip>
    );
    return (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between gap-3 pl-1 pr-4">
            <div className="pointer-events-auto flex min-w-0 items-center gap-2">
                {action(sidePanelOpen ? "收起面板" : "展开面板", sidePanelOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />, toggleSidePanel)}
                {action("返回首页", <Home className="size-4" />, onHome)}
                <div ref={titleRef} className="min-w-0">
                    {isTitleEditing ? (
                        <input
                            autoFocus
                            value={titleDraft}
                            onChange={(event) => onTitleDraftChange(event.target.value)}
                            onBlur={onFinishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") onFinishTitleEditing();
                                if (event.key === "Escape") onCancelTitleEditing();
                            }}
                            className="max-w-[280px] bg-transparent p-0 text-lg font-semibold outline-none"
                        />
                    ) : (
                        <button type="button" className="max-w-[280px] truncate border-b border-dashed border-transparent text-left text-lg font-semibold transition hover:border-current" onDoubleClick={readOnly ? undefined : onStartTitleEditing} title={readOnly ? title : "双击修改画布名称"}>
                            {title}
                        </button>
                    )}
                </div>
                <span className="inline-flex items-center gap-1 text-xs" style={{ color: theme.node.muted }} title="当前协作人数">
                    <Users className="size-3.5" />
                    {viewers}
                </span>
                <span className="max-w-40 truncate text-xs" style={{ color: theme.node.muted }} title={viewerName}>
                    {viewerName || (anonymous ? "匿名协作者" : "已登录协作者")}
                </span>
                {syncState === "saving" ? (
                    <span className="inline-flex items-center gap-1 text-xs" style={{ color: theme.node.muted }}>
                        <Loader2 className="size-3.5 animate-spin" /> 保存中
                    </span>
                ) : syncState === "failed" ? (
                    <span className="inline-flex items-center gap-1 text-xs text-red-500" title={syncError || "分享画布同步失败"}>
                        <CloudOff className="size-3.5" /> 可能未同步
                    </span>
                ) : null}
            </div>
            <div className="pointer-events-auto flex items-center gap-1" style={{ color: theme.node.text }}>
                {!readOnly ? action("撤销", <Undo2 className="size-4" />, onUndo, { disabled: !canUndo }) : null}
                {!readOnly ? action("重做", <Redo2 className="size-4" />, onRedo, { disabled: !canRedo }) : null}
                {!readOnly ? action("导入素材", <Upload className="size-4" />, onImport) : null}
                {action("偏好设置", <Settings2 className="size-4" />, onOpenConfig)}
                {!readOnly ? action("插件", <Puzzle className="size-4" />, onOpenPlugins) : null}
                {action("导出画布", <Download className="size-4" />, onExport)}
                {action("打开 Agent", <Bot className="size-4" />, onToggleAgent, { active: agentOpen })}
                {anonymous ? action("登录", <LogIn className="size-4" />, onLogin) : null}
                {allowClone ? action(cloning ? "正在保存到我的账号" : "保存到我的账号", cloning ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />, onClone, { disabled: cloning }) : null}
            </div>
        </div>
    );
}
