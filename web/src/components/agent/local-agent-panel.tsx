import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import { History, MessageSquare, PanelRightClose, PlugZap, Plus, Terminal } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { uploadImage } from "@/services/image-storage";
import { deleteAgentThreadMessages, readAgentUserMessages, saveAgentUserMessage } from "@/services/agent-chat-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useShallow } from "zustand/react/shallow";
import { useAgentStore, type AgentCanvasContext, type AgentChatItem, type AgentModel, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode, type AgentReasoningEffort, type AgentThreadSummary } from "@/stores/use-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { activateAgentClient, discoverAgentConfig, fetchAgentJson, postCodexApproval, postState, postToolResult } from "./agent-api";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentConnectView } from "./agent-connect-view";
import {
    activityDeltaFallback,
    activityDetail,
    activityKind,
    activityPlaceholder,
    agentAttachmentToChatAttachment,
    agentErrorView,
    attachmentPayloadBytes,
    compactText,
    eventUsage,
    formatAgentActivity,
    formatAgentEvent,
    formatAgentEventLog,
    formatAgentPlan,
    formatBytes,
    isCanvasWriteTool,
    isConnectionErrorMessage,
    isCurrentThreadEvent,
    mergeHistoryAttachments,
    mergeHistoryMessages,
    mergeAgentText,
    normalizeHistoryMessages,
    normalizeText,
    parseEventData,
    promptWithAttachments,
    routeName,
    siteToolSummary,
    stringText,
    toolCallDetail,
    toolName,
    turnPlanStatus,
    type AgentEventItem,
    type AgentEventPayload,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentModeSwitch } from "./agent-mode-switch";
import { AgentPanelTabs } from "./agent-panel-tabs";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const AGENT_REASONING_EFFORTS = new Set<AgentReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const AGENT_REASONING_LABELS: Record<AgentReasoningEffort, string> = { minimal: "最低", low: "轻度", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "Ultra" };

type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; thread?: AgentThreadSummary; messages?: AgentChatItem[] };
type AgentModelsResponse = { ok?: boolean; data?: AgentModel[] };
type AgentCodexState = { busy?: boolean; threadId?: string; turnId?: string };
type AgentHelloEvent = { ok?: boolean; clientId?: string; codex?: AgentCodexState };
type AgentWorkspaceEvent = { activeThreadId?: string; threadId?: string; emptyThread?: boolean; draftThread?: boolean };
type AgentChatEvent = { threadId?: string; sourceClientId?: string; message?: AgentChatItem };

export function LocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // 逐字段 selector + useShallow：只有这些字段变化时才重渲染。
    // 注意：canvasContext 不在此订阅内 —— 它在拖拽/resize 时会被 project 每帧写入，
    // 但面板只在 ref 同步与防抖 postState 中用到它、渲染层从不读它。若把它放进订阅，
    // 面板会随画布每帧重渲染（性能问题，也是 #185 崩溃的放大器）。改为下方 subscribe 命令式监听。
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, permissionMode, models, model, reasoningEffort, activity, connectError, pendingTool, pendingApprovals } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const closePanel = useAgentStore((state) => state.closePanel);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const messageCount = useAgentStore((state) => state.messages.length);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef(randomId());
    const loadThreadsSequenceRef = useRef(0);
    const resetThreadRef = useRef<Promise<unknown> | null>(null);
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    const loadThreads = useCallback(async (skipHistory = false) => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        const sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const currentThreadId = useAgentStore.getState().activeThreadId;
            const currentThreadRequest = currentThreadId && !skipHistory ? fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(currentThreadId)}`).catch(() => null) : null;
            const storedMessagesRequest = currentThreadId && !skipHistory ? readAgentUserMessages(currentThreadId) : null;
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/agent/codex/threads`);
            let nextMessages: AgentChatItem[] = [];
            if (currentThreadId && !skipHistory) {
                let thread = await currentThreadRequest;
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(currentThreadId)}`);
                const storedMessages = (await storedMessagesRequest) || [];
                const currentMessages = useAgentStore.getState().messages;
                nextMessages = mergeHistoryMessages(mergeHistoryAttachments(normalizeHistoryMessages(thread.messages || []), [...storedMessages, ...currentMessages]), currentMessages);
            }
            if (sequence !== loadThreadsSequenceRef.current) return;
            setAgentState({ threads: data.data || [], workspacePath: data.workspace?.workspacePath || "", ...(skipHistory ? {} : { messages: nextMessages }) });
        } catch (error) {
            addEventLog("读取历史失败", error);
        } finally {
            if (sequence === loadThreadsSequenceRef.current) setAgentState({ loadingThreads: false });
        }
    }, [endpoint, setAgentState, token]);
    // canvasContext 命令式订阅：保持 ref 最新，并在快照变化时防抖上报，全程不触发面板重渲染。
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!enabled || !token.trim()) return;
        localStorage.setItem("canvas-agent-url", endpoint);
        localStorage.setItem("canvas-agent-token", token);
        const clientId = clientIdRef.current;
        let eventQueue = Promise.resolve();
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(task).catch((error) => addEventLog("同步会话失败", error));
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            const busy = Boolean(parseEventData<AgentHelloEvent>(event)?.codex?.busy);
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({ connected: true, activity: busy ? "Codex 正在运行" : "已连接", waiting: busy, sending: false, connectError: "", silentConnect: false, messages: useAgentStore.getState().messages.filter((item) => !isConnectionErrorMessage(item)) });
            if (!headless) message.success("本地 Agent 已连接");
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
        });
        source.addEventListener("codex_state", (event) => {
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                setAgentState({ activity: busy ? "Codex 正在运行" : "完成", waiting: busy, ...(busy ? {} : { sending: false }) });
                if (!busy) await loadThreads();
            });
        });
        source.addEventListener("tool_call", (event) => {
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("codex_approval", (event) => {
            const data = parseEventData<AgentPendingApproval>(event);
            if (!data || !isCurrentThreadEvent(data)) return;
            setAgentState({ pendingApprovals: [...useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: "等待权限确认" });
            addEventLog("等待权限确认", data.reason || data.method, data);
        });
        source.addEventListener("codex_approval_resolved", (event) => {
            const data = parseEventData<{ requestId?: string }>(event);
            if (data?.requestId) setAgentState({ pendingApprovals: useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId) });
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                if (isCurrentThreadEvent(data)) handleAgentEvent(data);
            });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
                const current = useAgentStore.getState();
                const keepPendingMessage = Boolean(data.emptyThread && current.sending && current.messages.some((message) => message.role === "user"));
                pendingToolRef.current = null;
                setAgentState({ activeThreadId: nextThreadId, ...(keepPendingMessage ? {} : { messages: [] }), tokenUsage: null, pendingTool: null, pendingApprovals: [] });
                if (!data.draftThread) await loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                addMessage(data.message!);
            });
        });
        source.addEventListener("agent_log", (event) => {
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog("日志", text, text);
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                showAgentError(data.message, data.turn_id);
            });
        });
        source.onerror = () => {
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = wasConnected ? "本地 Agent 连接失败或已断开" : "连接失败，请检查地址和 token";
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(wasConnected ? "连接断开" : "连接失败", text);
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            clearAgentSession({ activity: wasConnected ? "连接断开" : "连接失败", connected: false, connectError: silent ? "" : text, silentConnect: false });
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            source.close();
            connectedRef.current = false;
            loadThreadsSequenceRef.current += 1;
        };
    }, [enabled, endpoint, loadThreads, message, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (!connected) return;
        void fetchAgentJson<AgentModelsResponse>(endpoint, token, "/agent/codex/models").then(({ data = [] }) => {
            const names = new Set<string>();
            const models = data.flatMap((item) => {
                const name = item.displayName || item.model;
                const efforts = item.supportedReasoningEfforts.filter(({ reasoningEffort }) => AGENT_REASONING_EFFORTS.has(reasoningEffort));
                if (item.model === "codex-auto-review" || names.has(name) || !efforts.length) return [];
                names.add(name);
                const defaultReasoningEffort = efforts.some((effort) => effort.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0].reasoningEffort;
                return [{ ...item, supportedReasoningEfforts: efforts, defaultReasoningEffort }];
            });
            if (!models.length) return;
            const savedModel = useAgentStore.getState().model;
            const current = models.find((item) => item.model === savedModel) || models.find((item) => item.isDefault) || models[0];
            const savedEffort = useAgentStore.getState().reasoningEffort;
            const efforts = current.supportedReasoningEfforts.map((item) => item.reasoningEffort);
            const nextEffort = efforts.includes(savedEffort as AgentReasoningEffort) ? savedEffort as AgentReasoningEffort : current.defaultReasoningEffort || efforts[0];
            localStorage.setItem("canvas-agent-model", current.model);
            localStorage.setItem("canvas-agent-reasoning-effort", nextEffort);
            setAgentState({ models, model: current.model, reasoningEffort: nextEffort });
        }).catch((error) => addEventLog("读取模型列表失败", error));
    }, [connected, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => void activateAgentClient(endpoint, token, clientIdRef.current);
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, endpoint, token]);
    const sendPrompt = async () => {
        const text = prompt.trim();
        const files = attachments;
        const requestPrompt = promptWithAttachments(text, files);
        if (!connected || !requestPrompt || sending || waiting) return;
        if (attachmentPayloadBytes(files) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            addMessage({ role: "error", title: "图片过大", text: "图片附件超过 30MB，请删减后再发送。" });
            return;
        }
        const messageId = createId();
        const userText = text || `发送了 ${files.length} 张图片`;
        setAgentState({ prompt: "", attachments: [], activity: "发送中", sending: true });
        addMessage({ id: messageId, role: "user", text: userText, historyText: requestPrompt, attachments: files });
        let threadId = useAgentStore.getState().activeThreadId;
        try {
            await resetThreadRef.current;
            if (!threadId) {
                const created = await fetchAgentJson<AgentThreadResponse>(endpoint, token, "/agent/codex/threads/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode }) });
                threadId = created.thread?.id || created.workspace?.activeThreadId || "";
                if (!threadId) throw new Error("新建对话失败");
                setAgentState({ activeThreadId: threadId, tokenUsage: null });
            }
            if (files.length) void saveAgentUserMessage(threadId, { id: messageId, role: "user", text: userText, historyText: requestPrompt, attachments: files }).catch(() => undefined);
            const modelName = models.find((item) => item.model === model)?.displayName || model || "默认模型";
            const effortName = reasoningEffort ? AGENT_REASONING_LABELS[reasoningEffort] : "默认强度";
            addEventLog("发送任务", `${modelName} · ${effortName}${files.length ? ` · 附件 ${files.length}` : ""} · ${compactText(text) || "仅附件"}`);
            const data = await fetchAgentJson<{ threadId?: string }>(endpoint, token, "/agent/codex/turn", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    permissionMode,
                    model,
                    effort: reasoningEffort,
                    attachments: files.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                }),
            });
            if (data.threadId) setAgentState({ activeThreadId: data.threadId });
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
            setAgentState({ sending: false, waiting: true, activity: "Codex 正在运行" });
        } catch (error) {
            const text = error instanceof Error ? error.message : "发送失败";
            const busy = text.includes("Codex 正在运行");
            const state = useAgentStore.getState();
            setAgentState({
                activity: busy ? "Codex 正在运行" : "发送失败",
                ...(state.prompt || state.attachments.length ? {} : { prompt, attachments: files }),
            });
            addMessage({ role: "error", title: busy ? "任务仍在运行" : "发送失败", text });
            addEventLog("发送失败", error);
        } finally {
            setAgentState({ sending: false });
        }
    };

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        setAgentState({ activity: "停止中" });
        try {
            await fetch(`${endpoint}/agent/codex/interrupt?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: useAgentStore.getState().activeThreadId || undefined }) });
            addEventLog("停止任务", "已发送停止请求");
        } catch {
            setAgentState({ activity: "停止失败" });
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: "图片过大", text: "图片附件最多约 30MB。" });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: "图片读取失败", text: error instanceof Error ? error.message : "图片读取失败" });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: "仍有待确认的画布工具调用" });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog("等待确认", payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                addEventLog(`${toolName(payload.name)}完成`, result, result);
                addMessage({ role: "tool", title: toolName(payload.name), text: siteToolSummary(payload.name, result), detail: toolCallDetail(payload.name, payload.input, "completed") });
            } catch (error) {
                const message = error instanceof Error ? error.message : "工具执行失败";
                addMessage({ role: "tool", title: toolName(payload.name), text: message, detail: toolCallDetail(payload.name, payload.input, "failed", message) });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                navigate(path);
                result = { ok: true, path };
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error("当前不在画布页，请先用 site_navigate 打开画布");
                result = snapshot;
            }
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            addEventLog(`${toolName(payload.name)}完成`, result, result);
            addMessage({
                role: "tool",
                title: toolName(payload.name),
                text: appliedOps.length ? summarizeCanvasAgentOps(appliedOps) || "已完成画布操作" : payload.name === "site_navigate" ? `已打开${routeName(input.path || "/")}` : "已完成",
                detail: toolCallDetail(payload.name, input, "completed"),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "画布操作失败";
            addMessage({ role: "tool", title: toolName(payload.name), text: message, detail: toolCallDetail(payload.name, payload.input, "failed", message) });
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: "用户取消了画布工具调用" });
        addMessage({ role: "tool", title: toolName(pendingTool.name), text: "用户已取消本次操作", detail: toolCallDetail(pendingTool.name, pendingTool.input, "declined") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => {
        setAgentState({ pendingApprovals: useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== approval.requestId), activity: decision === "decline" ? "已拒绝权限请求" : "Codex 正在运行" });
        try {
            await postCodexApproval(endpoint, token, approval.requestId, decision);
            addEventLog(decision === "decline" ? "已拒绝权限" : "已批准权限", approval.reason || approval.method, approval);
        } catch (error) {
            addEventLog("权限审批失败", error);
            message.error(error instanceof Error ? error.message : "权限审批失败");
        }
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const apply = () => {
            localStorage.setItem("canvas-agent-permission-mode", nextMode);
            setAgentState({ permissionMode: nextMode });
        };
        if (nextMode !== "full") return apply();
        modal.confirm({
            title: "启用完全访问权限",
            content: "Codex 将不受沙箱限制，可访问互联网及本机任意文件。请仅在信任当前任务时使用。",
            okText: "启用完全访问",
            okType: "danger",
            cancelText: "取消",
            onOk: apply,
        });
    };

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: "离线", connectError: "" });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = (urlEndpoint || discovered?.url || endpoint || DEFAULT_AGENT_URL).trim().replace(/\/$/, "");
        const nextToken = (urlToken || token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = "请填写本地 Agent 地址";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = "没有发现本地 Agent，请先在 Codex 使用插件或手动启动 Canvas Agent";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        try {
            const parsed = new URL(nextEndpoint);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            const text = "本地 Agent 地址格式不正确";
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, activity: "连接中", connectError: "", activeTab: "setup" });
    };

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if (!autoConnect || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection({ silent: true });
    }, [autoConnect, connected, enabled]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        loadThreadsSequenceRef.current += 1;
        setAgentState({
            messages: [],
            tokenUsage: null,
            threads: [],
            activeThreadId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            pendingTool: null,
            pendingApprovals: [],
            ...patch,
        });
        pendingToolRef.current = null;
    }

    const startNewThread = () => {
        if (!connected || sending || waiting) return;
        setAgentState({ activeThreadId: "", messages: [], tokenUsage: null, activeTab: "chat", activity: "新对话", pendingTool: null, pendingApprovals: [] });
        pendingToolRef.current = null;
        const request = fetchAgentJson(endpoint, token, "/agent/codex/threads/reset", { method: "POST" }).catch((error) => {
            addEventLog("新建对话失败", error);
            message.error(error instanceof Error ? error.message : "新建对话失败");
            throw error;
        });
        resetThreadRef.current = request;
        void request.finally(() => {
            if (resetThreadRef.current === request) resetThreadRef.current = null;
        }).catch(() => undefined);
    };

    const resumeThread = async (threadId: string) => {
        if (!connected || !threadId || sending || waiting) return;
        setAgentState({ loadingThreads: true });
        try {
            const current = useAgentStore.getState();
            const [data, storedMessages] = await Promise.all([
                fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode }) }),
                readAgentUserMessages(threadId),
            ]);
            const localMessages = current.activeThreadId === threadId ? current.messages : [];
            setAgentState({ activeThreadId: data.thread?.id || threadId, messages: mergeHistoryAttachments(normalizeHistoryMessages(data.messages || []), [...storedMessages, ...localMessages]), tokenUsage: null, activeTab: "chat", activity: "已恢复会话" });
        } catch (error) {
            addEventLog("恢复对话失败", error);
            message.error(error instanceof Error ? error.message : "恢复对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting) return;
        setAgentState({ loadingThreads: true });
        try {
            await Promise.all(threadIds.map((threadId) => fetchAgentJson(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })));
            void deleteAgentThreadMessages(threadIds).catch(() => undefined);
            const current = useAgentStore.getState();
            const deleted = new Set(threadIds);
            setAgentState({
                threads: current.threads.filter((thread) => !deleted.has(thread.id)),
                activeThreadId: deleted.has(current.activeThreadId) ? "" : current.activeThreadId,
                messages: deleted.has(current.activeThreadId) ? [] : current.messages,
                tokenUsage: deleted.has(current.activeThreadId) ? null : current.tokenUsage,
            });
            message.success(`已删除 ${threadIds.length} 条记录`);
        } catch (error) {
            addEventLog("删除对话失败", error);
            message.error(error instanceof Error ? error.message : "删除对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        modal.confirm({
            title: `删除 ${threadIds.length} 条对话记录`,
            content: "删除后无法恢复，确定继续吗？",
            okText: "删除",
            okType: "danger",
            cancelText: "取消",
            onOk: () => deleteThreads(threadIds),
        });
    };

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const next = { ...item, id: item.id || `${Date.now()}-${Math.random()}`, text } as AgentChatItem;
        const currentMessages = useAgentStore.getState().messages;
        if (currentMessages.some((message) => message.id === next.id)) return;
        if (next.streamId) {
            const index = currentMessages.findIndex((message) => message.streamId === next.streamId);
            if (index >= 0) {
                setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, ...next, id: message.id, text: next.text || message.text } : message)) });
                return;
            }
        }
        const last = currentMessages.at(-1);
        if (last?.role === "assistant" && next.role === "assistant" && last.title === next.title) {
            const merged = mergeAgentText(last.text, next.text);
            if (merged === last.text) return;
            setAgentState({ messages: [...useAgentStore.getState().messages.slice(0, -1), { ...last, text: merged, meta: next.meta || last.meta }] });
            return;
        }
        pushMessage(next);
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        const value = normalizeText(text) || title;
        const last = useAgentStore.getState().eventLogs.at(-1);
        if (last?.title === title && last.text === value) return;
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title, text: value, raw });
    };

    const upsertActivityMessage = (item: AgentChatItem) => {
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === item.id);
        if (index < 0) {
            pushMessage(item);
            return;
        }
        setAgentState({
            messages: currentMessages.map((message, i) => {
                if (i !== index) return message;
                const preserveReasoning = item.title === "思考摘要" && item.text === "已完成分析" && Boolean(message.text.trim()) && message.text !== activityPlaceholder("reasoning");
                return { ...message, ...item, ...(preserveReasoning ? { text: message.text } : {}) };
            }),
        });
    };

    const appendActivityDelta = (item: AgentEventItem) => {
        if (!item.id) return;
        const delta = stringText(item.delta);
        if (!delta) return;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === item.id);
        if (index < 0) {
            if (!delta.trim()) return;
            upsertActivityMessage(activityDeltaFallback(item, delta));
            return;
        }
        const current = currentMessages[index];
        if (item.type === "command_execution") {
            const detail = activityDetail(current.detail, "command", "inProgress");
            detail.output = `${detail.output || ""}${delta}`;
            setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, detail } : message)) });
            return;
        }
        const placeholder = activityPlaceholder(item.type);
        if (!delta.trim() && current.text === placeholder) return;
        const text = current.text === placeholder ? delta : `${current.text}${delta}`;
        setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, text, detail: { ...activityDetail(message.detail, activityKind(item.type), "inProgress") } } : message)) });
    };

    const finishPlanActivity = (turnId: string, status?: string) => {
        const id = `plan-${turnId}`;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === id);
        if (index < 0) return;
        const current = currentMessages[index];
        const detail = activityDetail(current.detail, "todo", turnPlanStatus(current.detail, status));
        setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, detail } : message)) });
    };

    const showAgentError = (value: unknown, turnId?: string) => {
        const error = agentErrorView(value);
        const item = { id: turnId ? `error-${turnId}` : createId(), role: "error" as const, title: error.title, text: error.text };
        upsertActivityMessage(item);
        setAgentState({ activity: "处理失败", waiting: false, sending: false });
        addEventLog("处理失败", error.text, value);
    };

    const handleAgentEvent = async (event: AgentEventPayload) => {
        if (event.type === "usage.updated") setAgentState({ tokenUsage: eventUsage(event) });
        const log = formatAgentEventLog(event);
        if (log) addEventLog(log.title, log.text);
        if (event.type === "thread.started" && event.thread_id) setAgentState({ activeThreadId: event.thread_id });
        if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
            appendStreamDelta(event.item.id, stringText(event.item.delta));
            return;
        }
        if (event.type === "item.updated" && event.item) {
            appendActivityDelta(event.item);
            return;
        }
        if (event.type === "plan.updated" && event.turn_id) {
            const plan = formatAgentPlan(event);
            if (plan) upsertActivityMessage({ ...plan, id: `plan-${event.turn_id}` });
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.streamId === event.item?.id);
            if (index >= 0) {
                const text = stringText(event.item.text);
                setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, text: text || message.text, streamId: undefined } : message)) });
                return;
            }
        }
        if (event.type === "item.completed" && event.item?.type === "image_generation" && event.item.id) {
            const generated = await importGeneratedImages(endpoint, token, event.item);
            if (generated.length) {
                const context = canvasContextRef.current;
                if (context) {
                    const right = Math.max(0, ...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
                    const ops = generated.map<CanvasAgentOp>((image, index) => {
                        const size = fitNodeSize(image.upload.width, image.upload.height);
                        return {
                            type: "add_node",
                            id: `image-${createId()}`,
                            nodeType: "image",
                            title: image.name,
                            position: { x: right + index * 40, y: index * 40 },
                            ...size,
                            metadata: imageMetadata(image.upload),
                        };
                    });
                    const result = context.applyOps(ops);
                    void postState(endpoint, token, clientIdRef.current, result);
                }
                addMessage({ id: `generated-${event.item.id}`, role: "assistant", text: context ? "已将生成图片添加到当前画布。" : "图片已生成。", attachments: generated.map((image) => image.attachment) });
                return;
            }
        }
        const activity = formatAgentActivity(event);
        if (activity && event.item?.id) {
            upsertActivityMessage({ ...activity, id: event.item.id });
            return;
        }
        if (event.type === "turn.completed") {
            if (event.turn_id) finishPlanActivity(event.turn_id, event.status);
            setAgentState({ messages: useAgentStore.getState().messages.map((message) => (message.streamId ? { ...message, streamId: undefined } : message)) });
            if (event.status === "failed") showAgentError(event.error?.message, event.turn_id);
        }
        const item = formatAgentEvent(event);
        if (item) addMessage(item);
    };

    const appendStreamDelta = (streamId: string, delta: string) => {
        if (!delta) return;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.streamId === streamId);
        if (index < 0) {
            pushMessage({ id: `stream-${streamId}`, role: "assistant", title: "Codex", text: delta, streamId });
            return;
        }
        setAgentState({ messages: currentMessages.map((message, i) => (i === index ? { ...message, text: `${message.text}${delta}` } : message)) });
    };

    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={<AgentModeSwitch theme={theme} />}
                items={[
                    { value: "setup", label: "连接", icon: <PlugZap className="size-3.5" /> },
                    { value: "chat", label: "对话", icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: threads.length },
                    { value: "log", label: "日志", icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Button size="small" type="text" disabled={!connected || loadingThreads || sending || waiting} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                            新对话
                        </Button>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <AgentChatTimeline theme={theme} pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} />
                    <AgentTaskProgress theme={theme} busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map(agentAttachmentToChatAttachment)}
                        disabled={!connected}
                        sending={sending || waiting}
                        placeholder="询问 Codex，或让它操作网站/画布"
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => item.model === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort;
                            localStorage.setItem("canvas-agent-model", model);
                            if (effort) localStorage.setItem("canvas-agent-reasoning-effort", effort);
                            setAgentState({ model, ...(effort ? { reasoningEffort: effort } : {}) });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            localStorage.setItem("canvas-agent-reasoning-effort", reasoningEffort);
                            setAgentState({ reasoningEffort });
                        }}
                        left={
                            attachments.length ? (
                                <span className="text-[11px]" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error("没有可添加的图片附件");
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error("图片附件节点参数无效");
            const res = await fetch(`${endpoint}/agent/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || "读取图片附件失败");
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || "参考图"),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}

function createId() {
    return randomId();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function importGeneratedImages(endpoint: string, token: string, item: AgentEventItem) {
    const sources = Array.from(generatedImageSources(item));
    return await Promise.all(
        sources.map(async (source, index) => {
            const response = source.startsWith("data:image/")
                ? await fetch(source)
                : await fetch(`${endpoint}/agent/local-image?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: source }) });
            if (!response.ok) throw new Error("读取 Codex 生成图片失败");
            const blob = await response.blob();
            const upload = await uploadImage(blob);
            const dataUrl = await readDataUrl(blob);
            const name = source.startsWith("/") ? source.split("/").at(-1) || `生成图片 ${index + 1}` : `生成图片 ${index + 1}`;
            return { upload, name, attachment: { id: createId(), name, type: blob.type || upload.mimeType, size: blob.size, width: upload.width, height: upload.height, url: upload.url, dataUrl } };
        }),
    );
}

function generatedImageSources(value: unknown, result = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("data:image/") || (/^\/.+\.(?:avif|gif|jpe?g|png|webp)$/i.test(value) && !value.includes("\n"))) result.add(value);
        return result;
    }
    if (Array.isArray(value)) value.forEach((item) => generatedImageSources(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => generatedImageSources(item, result));
    return result;
}

function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}
