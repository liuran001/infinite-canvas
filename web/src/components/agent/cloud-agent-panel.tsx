import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { CircleAlert, MessageSquare, PanelRightClose, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { canvasThemes } from "@/lib/canvas-theme";
import { ModelPicker } from "@/components/model-picker";
import { MENTION_LABEL_CLASS, MENTION_LABEL_MISSING_CLASS } from "@/components/canvas/canvas-resource-mention-textarea";
import { serverFileUrl } from "@/services/api/server";
import { serverStorageKey } from "@/services/image-storage";
import { modelCreditCost, modelOptionLabel, resolveAgentModel, useEffectiveConfig } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useMissingCanvasNodeIds } from "@/stores/canvas/use-canvas-store";
import { useCloudAgentStore } from "@/stores/use-cloud-agent-store";
import { useIsServerMode, useServerStore } from "@/stores/use-server-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { AgentChatMessage, AgentWorkingMessage } from "./agent-chat-message";
import { AgentModeSwitch } from "./agent-mode-switch";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentScrollToBottom } from "./agent-scroll-to-bottom";
import { CloudAgentComposer, CloudAgentImageStrip } from "./cloud-agent-composer";
import { cloudAgentActivity, toCloudChatItem } from "./cloud-agent-format";
import { splitReferenceContent, stripReferenceMarkers } from "./cloud-agent-references";

const SCROLL_BOTTOM_THRESHOLD = 48;
type CloudAgentTab = "chat" | "sessions";

/**
 * 云端 Agent 面板：模型跑在服务端，前端只负责发消息、订阅事件和展示过程。
 * 关页面、断网都不会中断服务端循环，重新进来靠 sinceSeq 补齐增量即可续上。
 */
export function CloudAgentPanel() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { modal } = App.useApp();
    const isServerMode = useIsServerMode();
    const settings = useServerStore((state) => state.settings);
    const credits = useServerStore((state) => state.user?.credits ?? 0);
    const closePanel = useAgentStore((state) => state.closePanel);
    const [tab, setTab] = useState<CloudAgentTab>("chat");

    const { projectId, sessions, sessionId, sessionModel, messages, status, error, loading, sending, attachments } = useCloudAgentStore(
        useShallow((state) => ({
            projectId: state.projectId,
            sessions: state.sessions,
            sessionId: state.sessionId,
            sessionModel: state.model,
            messages: state.messages,
            status: state.status,
            error: state.error,
            loading: state.loading,
            sending: state.sending,
            attachments: state.attachments,
        })),
    );
    const setModel = useCloudAgentStore((state) => state.setModel);
    const send = useCloudAgentStore((state) => state.send);
    const abort = useCloudAgentStore((state) => state.abort);
    const newSession = useCloudAgentStore((state) => state.newSession);
    const openSession = useCloudAgentStore((state) => state.openSession);
    const deleteSession = useCloudAgentStore((state) => state.deleteSession);
    const refreshSessions = useCloudAgentStore((state) => state.refreshSessions);

    const running = status === "running";
    const config = useEffectiveConfig();
    // 会话已经在用的模型优先，其次用户偏好，最后回落管理员默认；settings 与 config 都订阅了，配置变了会重算。
    const model = useMemo(() => resolveAgentModel(sessionModel), [config.agentModel, sessionModel, settings]);
    const messageCost = modelCreditCost(model);
    const maxRounds = settings?.agent.maxRounds || 0;
    // 附件要进上下文，模型不支持视觉时上游会直接报一串看不懂的错；这里先明确挡住，服务端仍然会再校验一次。
    const visionWarning = attachments.length && !settings?.modelChannel.models.some((item) => item.name === model && item.vision) ? "当前模型不支持识别图片，请换一个标注了「支持视觉」的模型，或先移除图片" : "";
    // 用户消息里的引用标记是给模型看的，展示时还原成可交互的标签；附件按文件 ID 直接取直链画缩略图。
    const items = useMemo(
        () =>
            messages.map((message) => {
                const parts = message.role === "user" ? splitReferenceContent(message.content) : [];
                return {
                    view:
                        message.role === "user"
                            ? { ...toCloudChatItem(message), text: stripReferenceMarkers(message.content), body: parts.some((part) => part.nodeId) ? <CloudAgentMessageText parts={parts} /> : undefined }
                            : toCloudChatItem(message),
                    images: (message.attachments || []).map((id) => ({ id, name: "图片", url: serverFileUrl(id), storageKey: serverStorageKey(id), width: 0, height: 0 })),
                };
            }),
        [messages],
    );
    // 等待提示按实际进度说话：在跑工具就报工具名，其余情况说「正在思考」。
    const activity = useMemo(() => cloudAgentActivity(messages), [messages]);
    // 服务端执行失败时会把同一句中文既写进对话又放进 session.error，对话里已经有了就不再重复弹一条。
    const showError = Boolean(error) && !messages.some((item) => item.role === "assistant" && item.content === error);

    const listRef = useRef<HTMLDivElement>(null);
    const followRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
    }, []);
    useEffect(() => {
        const frame = requestAnimationFrame(() => (followRef.current ? scrollToBottom("auto") : updateScrollState()));
        return () => cancelAnimationFrame(frame);
    }, [items, running, scrollToBottom, updateScrollState]);

    // 面板关掉时组件被卸载，这时候必须收回引用高亮，否则画布上会留下一个再也取消不掉的亮节点。
    useEffect(() => () => useCloudAgentStore.getState().highlightReference(""), []);

    const confirmDelete = (id: string, title: string) => {
        modal.confirm({
            title: "删除会话？",
            content: `「${title}」的对话记录会被删除，正在执行的任务也会一并中止。`,
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => deleteSession(id),
        });
    };

    // 计费口径是「每发一条消息扣一次」：一条消息触发多少轮思考与工具调用都不再额外扣，文案必须说清楚，别让用户以为还按轮算。
    const billingHint = messageCost
        ? `系统模型按「每条消息」扣费：发一条消息扣 ${messageCost} 点，这条消息触发的多轮思考与工具调用都不再额外扣点（单次最多 ${maxRounds} 轮）。`
        : "当前模型未配置算力点消耗，本次对话不扣点。";

    return (
        <>
            <AgentPanelTabs
                value={tab}
                theme={theme}
                leading={<AgentModeSwitch theme={theme} />}
                items={[
                    { value: "chat" as CloudAgentTab, label: "对话", icon: <MessageSquare className="size-3.5" /> },
                    { value: "sessions" as CloudAgentTab, label: "会话", icon: <Sparkles className="size-3.5" />, count: sessions.length },
                ]}
                onChange={(next) => {
                    setTab(next);
                    if (next === "sessions") void refreshSessions();
                }}
                right={
                    <>
                        <Button size="small" type="text" disabled={!isServerMode || running} icon={<Plus className="size-3.5" />} onClick={newSession}>
                            新会话
                        </Button>
                        <Tooltip title="收起对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {tab === "sessions" ? (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                    <div className="flex items-center justify-between gap-2 text-sm" style={{ color: theme.node.muted }}>
                        <span>{sessions.length ? `${sessions.length} 个会话` : "当前画布还没有会话"}</span>
                        <Button size="small" type="text" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={!isServerMode || loading} onClick={() => void refreshSessions()}>
                            刷新
                        </Button>
                    </div>
                    {sessions.map((session) => (
                        <div
                            key={session.id}
                            role="button"
                            tabIndex={0}
                            className="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 transition hover:bg-black/5 focus-visible:outline-none dark:hover:bg-white/10"
                            style={{ borderColor: session.id === sessionId ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                            onClick={() => {
                                void openSession(session.id);
                                setTab("chat");
                            }}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                void openSession(session.id);
                                setTab("chat");
                            }}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium leading-5">{session.title || "未命名会话"}</div>
                                <div className="truncate text-[11px] leading-4 opacity-65">
                                    {session.status === "running" ? "执行中 · " : session.status === "failed" ? `${session.error || "执行失败"} · ` : ""}
                                    {new Date(session.updatedAt).toLocaleString()}
                                </div>
                            </div>
                            <Button
                                danger
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8 shrink-0"
                                icon={<Trash2 className="size-3.5" />}
                                aria-label={`删除会话 ${session.title || session.id}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    confirmDelete(session.id, session.title || "未命名会话");
                                }}
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <>
                    <div className="relative min-h-0 flex-1">
                        <div ref={listRef} className="thin-scrollbar h-full select-text space-y-4 overflow-y-auto px-4 pt-4" onScroll={updateScrollState}>
                            {items.length ? (
                                items.map(({ view, images }) => (
                                    <div key={view.id}>
                                        <AgentChatMessage item={view} theme={theme} />
                                        {images.length ? <CloudAgentImageStrip images={images} alignRight={view.role === "user"} /> : null}
                                    </div>
                                ))
                            ) : (
                                <CloudAgentIntro theme={theme} model={model} ready={isServerMode && Boolean(projectId)} />
                            )}
                            {running || sending ? <AgentWorkingMessage text={activity} activityKey={`${sessionId}-${messages.length}-${activity}`} theme={theme} /> : null}
                        </div>
                        {showScrollToBottom ? <AgentScrollToBottom theme={theme} title="查看最新消息" onClick={() => scrollToBottom()} /> : null}
                    </div>

                    {showError ? (
                        <div className="mx-4 mb-1 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.32)", background: "rgba(220,38,38,.04)", color: "#dc2626" }}>
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">{error}</span>
                        </div>
                    ) : null}

                    <div className="flex items-center justify-center gap-3 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
                        <Tooltip title={billingHint}>
                            <span className="cursor-help underline decoration-dotted underline-offset-2">每条消息 {messageCost} 点</span>
                        </Tooltip>
                        <span style={credits < messageCost ? { color: "#dc2626" } : undefined}>余额 {credits} 点</span>
                    </div>

                    <CloudAgentComposer
                        disabled={!isServerMode || !projectId}
                        sending={running || sending}
                        placeholder={projectId ? "让系统模型帮你读取或修改当前画布，可以把画布节点拖进来作为引用" : "请先打开一个画布"}
                        theme={theme}
                        visionWarning={visionWarning}
                        onSubmit={() => void send()}
                        onStop={() => void abort()}
                        left={
                            // 执行中不让改：这一轮用哪个模型在发消息时就定死了，改了也只会误导用户以为当前这轮换了模型。
                            <ModelPicker
                                config={config}
                                value={model}
                                capability="text"
                                disabled={running || sending}
                                ariaLabel="选择系统模型"
                                className="h-9 max-w-44 rounded-full border-0 bg-transparent px-2.5 text-xs font-medium shadow-none hover:bg-black/5 dark:hover:bg-white/10"
                                onChange={setModel}
                            />
                        }
                    />
                </>
            )}
        </>
    );
}

/**
 * 已发送消息里的节点引用。和输入框里的标签一样：悬停在画布上高亮，点击把节点带进视口。
 * 引用的节点可能早就被删了，这种就置灰划掉，别让用户对着一个指不到东西的标签乱点。
 */
function CloudAgentMessageText({ parts }: { parts: ReturnType<typeof splitReferenceContent> }) {
    const projectId = useCloudAgentStore((state) => state.projectId);
    const highlightReference = useCloudAgentStore((state) => state.highlightReference);
    const revealReference = useCloudAgentStore((state) => state.revealReference);
    const missingNodeIds = useMissingCanvasNodeIds(
        projectId,
        parts.flatMap((part) => (part.nodeId ? [part.nodeId] : [])),
    );
    return (
        <>
            {parts.map((part, index) => {
                const nodeId = part.nodeId;
                if (!nodeId) return <span key={index}>{part.text}</span>;
                const missing = missingNodeIds.has(nodeId);
                return (
                    <span
                        key={index}
                        data-canvas-node-reference={nodeId}
                        className={missing ? MENTION_LABEL_MISSING_CLASS : `${MENTION_LABEL_CLASS} cursor-pointer`}
                        title={missing ? "引用的节点已从画布中删除" : "点击在画布上定位这个节点"}
                        onMouseEnter={() => highlightReference(nodeId)}
                        onMouseLeave={() => highlightReference("")}
                        onClick={() => {
                            if (!missing) revealReference(nodeId);
                        }}
                    >
                        {part.text}
                    </span>
                );
            })}
        </>
    );
}

/** 空会话时说明这个模式能做什么：能力按服务端实际开关展示，没配搜索密钥就不要宣称能联网。 */
function CloudAgentIntro({ theme, model, ready }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; model: string; ready: boolean }) {
    const settings = useServerStore((state) => state.settings);
    const config = useEffectiveConfig();
    const messageCost = modelCreditCost(model);
    const abilities = [
        "读取画布结构、新建 / 修改 / 删除节点、连接与断开连线",
        "把画布节点拖进输入框作为引用，也可以上传图片、把图片拖回画布",
        ...(settings?.capabilities.image && settings.modelChannel.defaultImageModel ? ["按提示词生成图片并放进画布"] : []),
        ...(settings?.agent.searchEnabled ? ["联网搜索最新资料"] : []),
    ];
    return (
        <div className="space-y-3 px-1 py-6 text-sm leading-6" style={{ color: theme.node.muted }}>
            <div style={{ color: theme.node.text }}>{ready ? "描述你想要的改动，系统模型会直接操作当前画布。" : "登录并打开一个画布后即可使用。"}</div>
            <ul className="ml-4 list-disc space-y-1">
                {abilities.map((item) => (
                    <li key={item}>{item}</li>
                ))}
            </ul>
            <div className="text-xs leading-5">
                任务跑在服务端，关掉面板、刷新页面或换设备都不会中断，回来还能看到结果。
                {model ? `当前模型 ${modelOptionLabel(config, model)}，` : ""}
                {messageCost ? `每发一条消息扣 ${messageCost} 点，这条消息触发的多轮思考与工具调用不再额外扣点（单次最多 ${settings?.agent.maxRounds || 0} 轮）。` : "当前模型未配置算力点消耗。"}
            </div>
        </div>
    );
}
