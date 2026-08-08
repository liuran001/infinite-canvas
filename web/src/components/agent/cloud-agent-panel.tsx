import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { CircleAlert, MessageSquare, PanelRightClose, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { useShareStore } from "@/stores/use-share-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { AgentChatMessage, AgentPendingToolCard, AgentToolGroup, AgentWorkingMessage } from "./agent-chat-message";
import { AgentModeSwitch } from "./agent-mode-switch";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentScrollToBottom } from "./agent-scroll-to-bottom";
import { CloudAgentComposer, CloudAgentImageStrip } from "./cloud-agent-composer";
import { cloudAgentActivity, cloudAgentTimeline, cloudPendingCard } from "./cloud-agent-format";
import { splitReferenceContent, stripReferenceMarkers } from "./cloud-agent-references";

const SCROLL_BOTTOM_THRESHOLD = 48;
type CloudAgentTab = "chat" | "sessions";

/**
 * 云端 Agent 面板：模型跑在服务端，前端只负责发消息、订阅事件和展示过程。
 * 关页面、断网都不会中断服务端循环，重新进来靠 sinceSeq 补齐增量即可续上。
 */
export function CloudAgentPanel() {
    const { t, i18n } = useTranslation();
    const resolvedLanguage = i18n.resolvedLanguage || i18n.language;
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { modal } = App.useApp();
    const isServerMode = useIsServerMode();
    const settings = useServerStore((state) => state.settings);
    const credits = useServerStore((state) => state.user?.credits ?? 0);
    const closePanel = useAgentStore((state) => state.closePanel);
    const [tab, setTab] = useState<CloudAgentTab>("chat");

    const { channel, anonymous, projectId, sessions, sessionId, sessionModel, messages, status, pendingAction, resolving, error, loading, sending, attachments } = useCloudAgentStore(
        useShallow((state) => ({
            channel: state.channel,
            anonymous: state.anonymous,
            projectId: state.projectId,
            sessions: state.sessions,
            sessionId: state.sessionId,
            sessionModel: state.model,
            messages: state.messages,
            status: state.status,
            pendingAction: state.pendingAction,
            resolving: state.resolving,
            error: state.error,
            loading: state.loading,
            sending: state.sending,
            attachments: state.attachments,
        })),
    );
    const setModel = useCloudAgentStore((state) => state.setModel);
    const send = useCloudAgentStore((state) => state.send);
    const abort = useCloudAgentStore((state) => state.abort);
    const resolvePending = useCloudAgentStore((state) => state.resolvePending);
    const newSession = useCloudAgentStore((state) => state.newSession);
    const openSession = useCloudAgentStore((state) => state.openSession);
    const deleteSession = useCloudAgentStore((state) => state.deleteSession);
    const refreshSessions = useCloudAgentStore((state) => state.refreshSessions);
    const shareReady = useShareStore((state) => state.status === "ready" && state.fullCanvas && state.role === "editor" && Boolean(state.guestToken));
    const shareOwnerPays = useShareStore((state) => state.ownerPays);
    const ready = channel === "share" ? shareReady : isServerMode;

    const running = status === "running";
    // 等确认时循环并没有结束：不能发新消息，但中止按钮要留着，用户随时可以直接收工。
    const awaiting = status === "awaiting" && Boolean(pendingAction);
    const busy = running || sending || awaiting;
    const config = useEffectiveConfig();
    // 会话已经在用的模型优先，其次用户偏好，最后回落管理员默认；settings 与 config 都订阅了，配置变了会重算。
    const model = useMemo(() => resolveAgentModel(sessionModel), [config.agentModel, sessionModel, settings]);
    const messageCost = modelCreditCost(model);
    const maxRounds = settings?.agent.maxRounds || 0;
    // 附件要进上下文，模型不支持视觉时上游会直接报一串看不懂的错；这里先明确挡住，服务端仍然会再校验一次。
    const visionWarning = attachments.length && !settings?.modelChannel.models.some((item) => item.name === model && item.vision) ? t("agent.cloud.panel.visionWarning") : "";
    // 用户消息里的引用标记是给模型看的，展示时还原成可交互的标签；附件按文件 ID 直接取直链画缩略图。
    // 连续的工具调用先在这里合并成一组，一轮下来十几个工具只占一行，点开才展开完整调用列表。
    const timeline = useMemo(
        () =>
            cloudAgentTimeline(messages).map((entry) => {
                if (entry.kind !== "message") return entry;
                const parts = entry.message.role === "user" ? splitReferenceContent(entry.message.content) : [];
                return {
                    ...entry,
                    item:
                        entry.message.role === "user"
                            ? { ...entry.item, text: stripReferenceMarkers(entry.message.content), body: parts.some((part) => part.nodeId) ? <CloudAgentMessageText parts={parts} /> : undefined }
                            : entry.item,
                    images: (entry.message.attachments || []).map((id) => ({ id, name: t("agent.cloud.panel.imageAttachment"), url: serverFileUrl(id), storageKey: serverStorageKey(id), width: 0, height: 0 })),
                };
            }),
        [messages, resolvedLanguage, t],
    );
    // 工具还在跑时那一组自己会显示「正在联网搜索」，再挂一条等待提示就是同一句话说两遍。
    const toolRunning = messages[messages.length - 1]?.role === "tool" && !messages[messages.length - 1]?.toolResult;
    // 等待提示按实际进度说话：在跑工具就报工具名，其余情况说「正在思考」。
    const activity = useMemo(() => cloudAgentActivity(messages), [messages, resolvedLanguage]);
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
    }, [timeline, running, scrollToBottom, updateScrollState]);

    // 面板关掉时组件被卸载，这时候必须收回引用高亮，否则画布上会留下一个再也取消不掉的亮节点。
    useEffect(() => () => useCloudAgentStore.getState().highlightReference(""), []);

    const confirmDelete = (id: string, title: string) => {
        modal.confirm({
            title: t("agent.cloud.panel.deleteSessionTitle"),
            content: t("agent.cloud.panel.deleteSessionContent", { title }),
            okText: t("agent.cloud.panel.delete"),
            cancelText: t("agent.cloud.panel.cancel"),
            okButtonProps: { danger: true },
            onOk: () => deleteSession(id),
        });
    };

    // 计费口径是「每发一条消息扣一次」：一条消息触发多少轮思考与工具调用都不再额外扣，文案必须说清楚，别让用户以为还按轮算。
    const billingHint = messageCost
        ? t(channel === "share" && shareOwnerPays ? "agent.cloud.billing.ownerMessageCost" : "agent.cloud.billing.messageCost", { cost: messageCost, maxRounds })
        : t("agent.cloud.billing.free");

    return (
        <>
            <AgentPanelTabs
                value={tab}
                theme={theme}
                leading={<AgentModeSwitch theme={theme} />}
                items={[
                    { value: "chat" as CloudAgentTab, label: t("agent.cloud.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "sessions" as CloudAgentTab, label: t("agent.cloud.panel.sessions"), icon: <Sparkles className="size-3.5" />, count: sessions.length },
                ]}
                onChange={(next) => {
                    setTab(next);
                    if (next === "sessions") void refreshSessions();
                }}
                right={
                    <>
                        <Button size="small" type="text" disabled={!ready || busy} icon={<Plus className="size-3.5" />} onClick={newSession}>
                            {t("agent.cloud.panel.newSession")}
                        </Button>
                        <Tooltip title={t("agent.cloud.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {tab === "sessions" ? (
                <div className="thin-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                    <div className="flex items-center justify-between gap-2 text-sm" style={{ color: theme.node.muted }}>
                        <span>{sessions.length ? t("agent.cloud.panel.sessionCount", { count: sessions.length }) : t("agent.cloud.panel.emptySessions")}</span>
                        <Button size="small" type="text" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={!ready || loading} onClick={() => void refreshSessions()}>
                            {t("agent.cloud.panel.refresh")}
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
                                <div className="truncate text-sm font-medium leading-5">{session.title || t("agent.cloud.panel.untitledSession")}</div>
                                <div className="truncate text-[11px] leading-4 opacity-65">
                                    {session.status === "running"
                                        ? `${t("agent.cloud.panel.running")} · `
                                        : session.status === "awaiting"
                                          ? `${t("agent.cloud.panel.awaiting")} · `
                                          : session.status === "failed"
                                            ? `${session.error || t("agent.cloud.panel.failed")} · `
                                            : ""}
                                    {new Date(session.updatedAt).toLocaleString(resolvedLanguage)}
                                </div>
                            </div>
                            <Button
                                danger
                                type="text"
                                shape="circle"
                                className="!h-8 !w-8 !min-w-8 shrink-0"
                                icon={<Trash2 className="size-3.5" />}
                                aria-label={t("agent.cloud.panel.deleteSessionLabel", { title: session.title || session.id })}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    confirmDelete(session.id, session.title || t("agent.cloud.panel.untitledSession"));
                                }}
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <>
                    <div className="relative min-h-0 flex-1">
                        <div ref={listRef} className="thin-scrollbar h-full select-text space-y-4 overflow-y-auto px-4 pt-4" onScroll={updateScrollState}>
                            {timeline.length ? (
                                timeline.map((entry) =>
                                    entry.kind === "tools" ? (
                                        <AgentToolGroup key={entry.id} items={entry.items} label={entry.label} running={entry.running} theme={theme} />
                                    ) : (
                                        <div key={entry.id}>
                                            <AgentChatMessage item={entry.item} theme={theme} />
                                            {entry.images.length ? <CloudAgentImageStrip images={entry.images} alignRight={entry.item.role === "user"} /> : null}
                                        </div>
                                    ),
                                )
                            ) : (
                                <CloudAgentIntro theme={theme} model={model} ready={ready && Boolean(projectId)} />
                            )}
                            {pendingAction ? (
                                <AgentPendingToolCard {...cloudPendingCard(pendingAction)} theme={theme} deciding={resolving} onApprove={() => void resolvePending(true)} onReject={() => void resolvePending(false)} />
                            ) : null}
                            {(running || sending) && !toolRunning ? <AgentWorkingMessage text={activity} activityKey={`${sessionId}-${messages.length}-${activity}`} theme={theme} /> : null}
                        </div>
                        {showScrollToBottom ? <AgentScrollToBottom theme={theme} title={t("agent.cloud.panel.latestMessages")} onClick={() => scrollToBottom()} /> : null}
                    </div>

                    {showError ? (
                        <div className="mx-4 mb-1 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.32)", background: "rgba(220,38,38,.04)", color: "#dc2626" }}>
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">{error}</span>
                        </div>
                    ) : null}

                    {channel === "share" && anonymous ? (
                        <div className="mx-4 mb-1 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                            <span>{t("agent.cloud.panel.anonymousHistoryWarning")}</span>
                        </div>
                    ) : null}

                    <div className="flex items-center justify-center gap-3 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
                        <Tooltip title={billingHint}>
                            <span className="cursor-help underline decoration-dotted underline-offset-2">{t("agent.cloud.panel.perMessageCost", { cost: messageCost })}</span>
                        </Tooltip>
                        {channel === "share" && shareOwnerPays ? <span>{t("agent.cloud.panel.ownerPays")}</span> : <span style={credits < messageCost ? { color: "#dc2626" } : undefined}>{t("agent.cloud.panel.balance", { credits })}</span>}
                    </div>

                    <CloudAgentComposer
                        disabled={!ready || !projectId}
                        sending={busy}
                        placeholder={awaiting ? t("agent.cloud.panel.awaitingPlaceholder") : projectId ? t("agent.cloud.panel.canvasPlaceholder") : t("agent.cloud.panel.openCanvasPlaceholder")}
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
                                disabled={busy}
                                ariaLabel={t("agent.cloud.panel.selectModel")}
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
    const { t } = useTranslation();
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
                        title={missing ? t("agent.cloud.panel.referenceMissing") : t("agent.cloud.panel.referenceLocate")}
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
    const { t } = useTranslation();
    const settings = useServerStore((state) => state.settings);
    const config = useEffectiveConfig();
    const messageCost = modelCreditCost(model);
    const abilities = [
        t("agent.cloud.intro.canvasOperations"),
        t("agent.cloud.intro.references"),
        ...(settings?.capabilities.image && settings.modelChannel.defaultImageModel ? [t("agent.cloud.intro.imageGeneration")] : []),
        ...(settings?.agent.searchEnabled ? [t("agent.cloud.intro.webSearch")] : []),
    ];
    return (
        <div className="space-y-3 px-1 py-6 text-sm leading-6" style={{ color: theme.node.muted }}>
            <div style={{ color: theme.node.text }}>{t(ready ? "agent.cloud.intro.ready" : "agent.cloud.intro.unavailable")}</div>
            <ul className="ml-4 list-disc space-y-1">
                {abilities.map((item) => (
                    <li key={item}>{item}</li>
                ))}
            </ul>
            <div className="text-xs leading-5">
                {t("agent.cloud.intro.durable")} {model ? t("agent.cloud.intro.currentModel", { model: modelOptionLabel(config, model) }) : ""}{" "}
                {messageCost ? t("agent.cloud.intro.messageCost", { cost: messageCost, maxRounds: settings?.agent.maxRounds || 0 }) : t("agent.cloud.intro.free")}
            </div>
        </div>
    );
}
