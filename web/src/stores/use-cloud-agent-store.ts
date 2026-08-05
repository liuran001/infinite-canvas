import { nanoid } from "nanoid";
import { create } from "zustand";

import { buildDraftReference, expandDraftReferences, type CloudAgentDraftReference } from "@/components/agent/cloud-agent-references";
import { serverAgentStream, serverApi, type ServerAgentEvent, type ServerAgentMessage, type ServerAgentPendingAction, type ServerAgentSession, type ServerAgentSessionStatus } from "@/services/api/server";
import { shareApi } from "@/services/api/share";
import { serverFileIdOf, uploadImage } from "@/services/image-storage";
import { realtimeAvailable, subscribeRealtime, type RealtimeSubscription } from "@/services/realtime/connection";
import { ensureShareBillingConsent } from "@/services/share-billing-consent";
import { readAnonymousShareAgentHistory, removeAnonymousShareAgentSession, saveAnonymousShareAgentHistory, type AnonymousShareAgentScope } from "@/services/share-agent-history";
import { uploadShareImage } from "@/services/share-upload";
import { notifyTeamCreditsExhausted, notifyTeamQuotaExceeded } from "@/services/team-realtime";
import { resolveAgentModel, useConfigStore } from "@/stores/use-config-store";
import { isServerMode, useServerStore } from "@/stores/use-server-store";
import { useShareStore } from "@/stores/use-share-store";
import type { CanvasNodeData } from "@/types/canvas";

/** 记住上次打开的会话，刷新页面或换设备回来能接回原来那条对话；只是一个会话 ID，放 localStorage 足够。 */
const SESSION_KEY = "canvas-agent-cloud-session";
/** 这些工具会直接改服务端画布，拿到结果就通知画布页重新拉一次远程数据，前端不重复实现一遍节点写入。 */
const CANVAS_WRITE_TOOLS = new Set(["create_node", "update_node", "delete_node", "connect_nodes", "disconnect_nodes", "generate_image"]);
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 8000;
const RETRY_LIMIT = 6;
/** 和服务端 MAX_ATTACHMENTS 对齐：超出的部分服务端会直接拒绝，前端先拦一道省得白传。 */
const MAX_ATTACHMENTS = 6;

let streamAbort: AbortController | null = null;
/** 共享 WebSocket 上的会话订阅。与 streamAbort 二选一：同一时刻只会有一条传输在跑。 */
let agentSocket: RealtimeSubscription | null = null;
let streamToken = 0;
/** 已经拉过会话列表的画布；登录态与服务端配置是异步就绪的，就绪前不算绑定成功，之后要补拉一次。 */
let loadedBindingKey = "";
/** 发送失败时保留幂等键，用户原样重发时复用，服务端就不会把重试当成新消息重复执行、重复扣点。 */
let pendingSend: { clientMessageId: string; key: string } | null = null;
/** 每次拖入都要触发一次插入，即使拖的是同一个节点；用自增序号让输入框认得出「这是新的一次」。 */
let insertToken = 0;
/** 同上：重复点同一个引用也该再定位一次，靠自增序号区分「又点了一下」。 */
let revealToken = 0;

/** 用户在面板里上传的图片。走的是和素材同一套服务端文件，storageKey 形如 server:<fileId>。 */
export type CloudAgentAttachment = { id: string; name: string; url: string; storageKey: string; width: number; height: number };
export type CloudAgentChannel = "account" | "share";

/** 换画布、换会话时必须收回引用高亮，否则画布上会留下一个永远亮着、也没人再取消得掉的节点。 */
const clearedHighlight = { referenceNodeId: "", referenceReveal: null };

function errorText(error: unknown) {
    return error instanceof Error ? error.message : "操作失败";
}

/**
 * 断线续传游标停在最后一条「已完结」的消息上。
 * 工具消息会先后推两次（占位、带结果），两次 seq 相同，
 * 直接用最大 seq 续传会漏掉结果回填，界面上工具就永远停在「进行中」。
 */
function resumeSeq(messages: ServerAgentMessage[]) {
    let seq = 0;
    for (const item of messages) {
        if (item.role === "tool" && !item.toolResult) break;
        seq = item.seq;
    }
    return seq;
}

/** 按 seq 覆盖式合并，重放的历史与实时事件混在一起也不会出现重复消息。 */
function mergeMessages(list: ServerAgentMessage[], incoming: ServerAgentMessage[]) {
    const merged = new Map(list.map((item) => [item.seq, item]));
    incoming.forEach((item) => merged.set(item.seq, item));
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

function bindingKey(projectId: string, channel: CloudAgentChannel) {
    if (channel === "share") {
        const share = useShareStore.getState();
        return `${channel}:${share.shareId}:${share.actorId}:${projectId}`;
    }
    return `${channel}:${useServerStore.getState().user?.id || ""}:${projectId}`;
}

function channelReady(projectId: string, channel: CloudAgentChannel) {
    if (!projectId) return false;
    if (channel === "account") return isServerMode();
    const share = useShareStore.getState();
    return share.status === "ready" && share.fullCanvas && share.role === "editor" && share.project?.id === projectId && Boolean(share.guestToken);
}

function anonymousScope(channel: CloudAgentChannel): AnonymousShareAgentScope | null {
    if (channel !== "share") return null;
    const share = useShareStore.getState();
    return share.anonymous && share.shareId && share.actorId ? { shareId: share.shareId, actorId: share.actorId } : null;
}

function sessionStorageKey(channel: CloudAgentChannel) {
    if (channel === "account") return SESSION_KEY;
    const share = useShareStore.getState();
    return `${SESSION_KEY}:share:${share.shareId}:${share.actorId}`;
}

function agentApi(channel: CloudAgentChannel) {
    if (channel === "account") {
        return {
            sessions: (projectId: string) => serverApi.agentSessions(projectId),
            createSession: (body: { sessionId: string; projectId: string; title: string; model: string }, _acceptSelfPay: boolean) => serverApi.createAgentSession(body),
            session: (id: string) => serverApi.agentSession(id),
            deleteSession: (id: string) => serverApi.deleteAgentSession(id),
            messages: (id: string, sinceSeq: number) => serverApi.agentMessages(id, sinceSeq),
            send: (id: string, body: { clientMessageId: string; content: string; model: string; attachmentIds: string[]; references: Array<{ nodeId: string }> }, _acceptSelfPay: boolean) => serverApi.sendAgentMessage(id, body),
            abort: (id: string) => serverApi.abortAgentSession(id),
            resolve: (id: string, approved: boolean, _acceptSelfPay: boolean) => serverApi.resolveAgentSession(id, approved),
            stream: (id: string, sinceSeq: number, onEvent: (event: ServerAgentEvent) => void, signal: AbortSignal) => serverAgentStream(id, sinceSeq, onEvent, signal),
        };
    }
    const guestToken = () => useShareStore.getState().guestToken;
    return {
        sessions: (projectId: string) => shareApi.agentSessions(guestToken(), projectId),
        createSession: (body: { sessionId: string; projectId: string; title: string; model: string }, acceptSelfPay: boolean) => shareApi.createAgentSession(guestToken(), { ...body, acceptSelfPay }),
        session: (id: string) => shareApi.agentSession(guestToken(), id),
        deleteSession: (id: string) => shareApi.deleteAgentSession(guestToken(), id),
        messages: (id: string, sinceSeq: number) => shareApi.agentMessages(guestToken(), id, sinceSeq),
        send: (id: string, body: { clientMessageId: string; content: string; model: string; attachmentIds: string[]; references: Array<{ nodeId: string }> }, acceptSelfPay: boolean) => shareApi.sendAgentMessage(guestToken(), id, { ...body, acceptSelfPay }),
        abort: (id: string) => shareApi.abortAgentSession(guestToken(), id),
        resolve: (id: string, approved: boolean, acceptSelfPay: boolean) => shareApi.resolveAgentSession(guestToken(), id, approved, acceptSelfPay),
        stream: (id: string, sinceSeq: number, onEvent: (event: ServerAgentEvent) => void, signal: AbortSignal) => shareApi.agentStream(guestToken(), id, sinceSeq, onEvent, signal),
    };
}

async function ensureAgentBillingConsent(channel: CloudAgentChannel) {
    if (channel !== "share") return false;
    const share = useShareStore.getState();
    return ensureShareBillingConsent({
        shareId: share.shareId,
        selfPayRequired: share.selfPayRequired,
        userId: useServerStore.getState().user?.id,
        anonymous: share.anonymous,
        ownerPays: share.ownerPays,
    });
}

type CloudAgentStore = {
    channel: CloudAgentChannel;
    bindingKey: string;
    anonymous: boolean;
    projectId: string;
    sessions: ServerAgentSession[];
    sessionId: string;
    /** 当前会话正在用的模型。空表示还没有会话，面板按用户偏好 / 管理员默认展示。 */
    model: string;
    messages: ServerAgentMessage[];
    status: ServerAgentSessionStatus;
    /** 服务端停下来等用户点头的那条请求；status 为 awaiting 时必然有值，回应完就清空。 */
    pendingAction: ServerAgentPendingAction | null;
    /** 正在回应待确认请求，按钮据此禁用，避免连点批准发出两次。 */
    resolving: boolean;
    error: string;
    loading: boolean;
    sending: boolean;
    prompt: string;
    /** 输入框里已经插入的画布节点引用。用户把标签删掉后提交时自然就不算数了，不用额外清理。 */
    draftReferences: CloudAgentDraftReference[];
    /** 拖进来的节点要插到输入框的光标处，而不是追加到末尾；输入框自己知道光标在哪，所以这里只发一个信号。 */
    pendingInsert: { label: string; token: number } | null;
    /** 画布节点正被拖到面板上方，输入框据此给出可以松手的提示。 */
    referenceDropActive: boolean;
    /** 鼠标停在（或点了）哪个引用标签上，画布据此把对应节点高亮出来；面板和画布是两棵组件树，只能靠 store 递这个信号。 */
    referenceNodeId: string;
    /** 点击引用时请画布把节点移进视口；token 自增，重复点同一个引用也能再定位一次。 */
    referenceReveal: { nodeId: string; token: number } | null;
    attachments: CloudAgentAttachment[];
    uploading: boolean;
    /** 服务端改过画布的次数，画布页据此重新拉一次远程画布并刷新到界面上。 */
    canvasReload: number;
    requestCanvasReload: () => void;
    setPrompt: (prompt: string) => void;
    setModel: (model: string) => void;
    addAttachments: (files: FileList | File[] | null) => Promise<void>;
    removeAttachment: (id: string) => void;
    dropReference: (node: CanvasNodeData) => void;
    consumePendingInsert: () => void;
    setReferenceDropActive: (active: boolean) => void;
    highlightReference: (nodeId: string) => void;
    revealReference: (nodeId: string) => void;
    consumeReferenceReveal: () => void;
    bindProject: (projectId: string, channel?: CloudAgentChannel) => void;
    refreshSessions: () => Promise<void>;
    openSession: (sessionId: string) => Promise<void>;
    newSession: () => void;
    deleteSession: (sessionId: string) => Promise<void>;
    send: () => Promise<void>;
    abort: () => Promise<void>;
    resolvePending: (approved: boolean) => Promise<void>;
};

export const useCloudAgentStore = create<CloudAgentStore>((set, get) => {
    const detach = () => {
        streamToken += 1;
        streamAbort?.abort();
        streamAbort = null;
        agentSocket?.close();
        agentSocket = null;
    };

    const persistAnonymous = () => {
        const state = get();
        const scope = state.anonymous ? anonymousScope(state.channel) : null;
        if (!scope) return;
        void saveAnonymousShareAgentHistory(scope, { sessions: state.sessions, activeSessionId: state.sessionId, messages: state.sessionId ? state.messages : undefined }).catch(() => undefined);
    };

    const applyEvent = (sessionId: string, event: ServerAgentEvent) => {
        if (get().sessionId !== sessionId) return;
        if (event.type === "status") {
            // 待确认请求跟着 status 事件推过来，回到 running / idle 时服务端会带 null 把它清掉。
            set((state) => ({
                status: event.status,
                error: event.error,
                pendingAction: event.pendingAction || null,
                // 服务端会在跑起来之后自动给会话起标题，也从这个事件推回来；会话列表跟着改，不用等下一次刷新。
                sessions: state.sessions.map((item) =>
                    item.id === sessionId ? { ...item, status: event.status, error: event.error, pendingAction: event.pendingAction || null, title: event.title || item.title, updatedAt: new Date().toISOString() } : item,
                ),
            }));
            // 真正跑完了再兜底刷一次画布，工具事件万一漏收也不会让界面停在旧数据上；
            // awaiting 只是停下来等人，画布没有新变化，不用白拉一次。
            if (event.status === "idle" || event.status === "failed") set((state) => ({ canvasReload: state.canvasReload + 1 }));
            persistAnonymous();
            return;
        }
        set((state) => ({ messages: mergeMessages(state.messages, [event.message]) }));
        // 工具有结果才代表画布真的改完了，这时候再拉，避免拉到改了一半的数据。
        if (event.message.role === "tool" && event.message.toolResult && CANVAS_WRITE_TOOLS.has(event.message.toolName)) set((state) => ({ canvasReload: state.canvasReload + 1 }));
        persistAnonymous();
    };

    /**
     * 挂事件流并在断线后自动重连。优先走共享 WebSocket，它不可用或被判定为终态时退回 SSE 循环。
     * 服务端的推理循环不受前端连接影响，两条路径都靠 sinceSeq 续上，切换传输不会丢消息。
     */
    const attach = async (sessionId: string) => {
        detach();
        const channel = get().channel;
        // 分享访客不能订阅账号级 WebSocket 频道：那条连接只携带账号 JWT，也没有 guest 权限语义。
        if (channel === "account" && realtimeAvailable()) {
            // 这一轮 attach 的代号。降级起 SSE 时不再自增，否则 WebSocket 回调里的比较全部失效，
            // 恢复回调会被当成过期的一轮直接忽略，SSE 就永远关不掉了。
            const token = streamToken;
            agentSocket = subscribeRealtime<ServerAgentEvent>({
                channel: `agent:${sessionId}`,
                payload: () => ({ sinceSeq: resumeSeq(get().messages) }),
                onEvent: (event) => applyEvent(sessionId, event),
                onDegrade: () => {
                    // WebSocket 连不上就交给 SSE：Agent 还在后台跑，界面不能停在半截消息上。
                    // 但订阅要留着——它自己还在重连，接回来之后要靠 onRecover 把 SSE 收掉。
                    if (token !== streamToken) return;
                    void attachViaSse(sessionId, token, channel);
                },
                onRecover: () => {
                    // WebSocket 这条频道重新 ready 了，降级流必须停：两条流同时喂同一个会话，
                    // 消息虽然按 seq 去重不会重复，但重连、重放的开销会一直翻倍地留着。
                    if (token !== streamToken) return;
                    streamAbort?.abort();
                    streamAbort = null;
                },
                onTerminal: (failure) => {
                    if (token !== streamToken) return;
                    agentSocket = null;
                    // 会话已被删除，或这个 id 根本不属于当前账号：换成 SSE 也是同一个 404，
                    // 只会再空转一轮重试，然后把「连接中断，稍后重开会话」这种指错方向的提示留给用户。
                    if (failure.code === "NOT_FOUND") {
                        set({ error: "这个会话已经不存在了，可能已被删除；新建一个会话继续。" });
                        return;
                    }
                    void attachViaSse(sessionId, token, channel);
                },
            });
            return;
        }
        await attachViaSse(sessionId, undefined, channel);
    };

    /** 已上线的 SSE 实现，保留为降级路径。token 由 WebSocket 降级时传入，用来共享同一轮的代号。 */
    const attachViaSse = async (sessionId: string, sharedToken?: number, channel: CloudAgentChannel = get().channel) => {
        // 已经有一条降级流在跑就别再起第二条：onDegrade 每次连接失败都可能再来一遍。
        if (sharedToken !== undefined && streamAbort) return;
        const token = sharedToken ?? ++streamToken;
        const abort = new AbortController();
        streamAbort = abort;
        for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
            try {
                await agentApi(channel).stream(sessionId, resumeSeq(get().messages), (event) => applyEvent(sessionId, event), abort.signal);
                attempt = -1;
            } catch (error) {
                if (abort.signal.aborted) return;
                console.warn("Agent 事件流断开，准备重连", error);
            }
            if (abort.signal.aborted || token !== streamToken || get().sessionId !== sessionId || get().channel !== channel) return;
            // 已经跑完就不用再连，服务端也不会再推事件；awaiting 例外，它还在等人回应，
            // 别的设备批准之后的续跑事件要靠这条连接收回来。
            if (get().status !== "running" && get().status !== "awaiting") return;
            await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))));
            if (abort.signal.aborted || token !== streamToken) return;
        }
        set({ error: "与服务端的事件连接中断，Agent 仍在后台执行，稍后重新打开会话即可看到结果" });
    };

    const loadSessions = async (autoOpen: boolean) => {
        const { projectId, channel, bindingKey: currentBindingKey } = get();
        if (!channelReady(projectId, channel)) return;
        const scope = anonymousScope(channel);
        const cached = scope ? await readAnonymousShareAgentHistory(scope).catch(() => null) : null;
        set({ loading: true });
        try {
            const { items } = await agentApi(channel).sessions(projectId);
            if (get().bindingKey !== currentBindingKey) return;
            set({ sessions: items, loading: false });
            persistAnonymous();
            if (!autoOpen || get().sessionId) return;
            // 刷新页面 / 换设备回来时接回上次那条会话，接不上就用最近更新的一条。
            const rememberedId = cached?.activeSessionId || localStorage.getItem(sessionStorageKey(channel));
            const target = items.find((item) => item.id === rememberedId) || items[0];
            if (target) await get().openSession(target.id);
        } catch (error) {
            if (get().bindingKey !== currentBindingKey) return;
            const sessions = cached?.sessions || [];
            set({ sessions, loading: false, error: sessions.length ? "暂时无法连接服务端，当前显示此浏览器保存的匿名历史" : errorText(error) });
            if (autoOpen && !get().sessionId) {
                const target = sessions.find((item) => item.id === cached?.activeSessionId) || sessions[0];
                if (target) await get().openSession(target.id);
            }
        }
    };

    return {
        channel: "account",
        bindingKey: "",
        anonymous: false,
        projectId: "",
        sessions: [],
        sessionId: "",
        model: "",
        messages: [],
        status: "idle",
        pendingAction: null,
        resolving: false,
        error: "",
        loading: false,
        sending: false,
        prompt: "",
        draftReferences: [],
        pendingInsert: null,
        referenceDropActive: false,
        referenceNodeId: "",
        referenceReveal: null,
        attachments: [],
        uploading: false,
        canvasReload: 0,
        requestCanvasReload: () => set((state) => ({ canvasReload: state.canvasReload + 1 })),
        setPrompt: (prompt) => set({ prompt }),

        /** 普通画布上传到本人空间；分享画布上传到房主空间，其他协作者和 Agent 工具才能读取同一文件。 */
        addAttachments: async (files) => {
            const picked = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
            if (!picked.length || get().uploading) return;
            const room = MAX_ATTACHMENTS - get().attachments.length;
            if (room <= 0) return set({ error: `一条消息最多带 ${MAX_ATTACHMENTS} 张图片` });
            set({ uploading: true, error: "" });
            try {
                const uploaded = await Promise.all(
                    picked.slice(0, room).map(async (file) => {
                        const image = get().channel === "share" ? await uploadShareImage(file) : await uploadImage(file);
                        return { id: serverFileIdOf(image.storageKey), name: file.name || "图片", url: image.url, storageKey: image.storageKey, width: image.width, height: image.height };
                    }),
                );
                set((state) => ({ attachments: [...state.attachments, ...uploaded], uploading: false }));
            } catch (error) {
                set({ uploading: false, error: errorText(error) });
            }
        },

        // 只从草稿里去掉，不删服务端文件：这张图可能已经被拖到画布上建了节点，删了那个节点就成了死链。
        removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) })),

        /** 画布节点拖进面板：登记引用并请输入框把标签插到光标处。同一个节点重复拖入沿用同一个标签。 */
        dropReference: (node) => {
            const draft = get().draftReferences;
            const reference = buildDraftReference(node, draft);
            insertToken += 1;
            set({
                draftReferences: draft.some((item) => item.nodeId === node.id) ? draft : [...draft, reference],
                pendingInsert: { label: reference.label, token: insertToken },
                referenceDropActive: false,
            });
        },

        consumePendingInsert: () => set({ pendingInsert: null }),
        setReferenceDropActive: (referenceDropActive) => set({ referenceDropActive }),

        /**
         * 悬停引用标签只高亮，绝不动 selectedNodeIds：用户可能正框着一堆节点，
         * 顺手替他改选中集合会直接毁掉他手上的多选。传空串表示鼠标移开、取消高亮。
         */
        highlightReference: (referenceNodeId) => set({ referenceNodeId }),

        /** 点击引用：高亮之外再请画布把节点移进视口，具体移不移由画布判断（已经看得见就别乱动画面）。 */
        revealReference: (nodeId) => {
            revealToken += 1;
            set({ referenceNodeId: nodeId, referenceReveal: { nodeId, token: revealToken } });
        },

        consumeReferenceReveal: () => set({ referenceReveal: null }),

        /**
         * 面板上换模型：既改当前会话下一轮要用的模型，也写进用户偏好当作以后新会话的默认。
         * 偏好走 updateConfig，跟着账号云端同步，换设备、换会话回来还是这个选择。
         */
        setModel: (model) => {
            set({ model });
            useConfigStore.getState().updateConfig("agentModel", model);
        },

        /**
         * 由画布页在挂载、切换项目以及登录态就绪时调用。绑定即拉一次会话与增量，
         * 面板没打开也照常挂流，这样 agent 在后台改画布时画面能实时刷新。
         * 首次调用时服务端配置可能还没拉到，这里不算绑定成功，等就绪后的下一次调用补上。
         */
        bindProject: (projectId, channel = "account") => {
            const nextBindingKey = projectId ? bindingKey(projectId, channel) : "";
            if (get().bindingKey !== nextBindingKey) {
                detach();
                loadedBindingKey = "";
                pendingSend = null;
                set({
                    channel,
                    bindingKey: nextBindingKey,
                    anonymous: Boolean(anonymousScope(channel)),
                    projectId,
                    sessions: [],
                    sessionId: "",
                    model: "",
                    messages: [],
                    status: "idle",
                    pendingAction: null,
                    resolving: false,
                    error: "",
                    prompt: "",
                    draftReferences: [],
                    attachments: [],
                    sending: false,
                    ...clearedHighlight,
                });
            }
            if (!projectId || loadedBindingKey === nextBindingKey || !channelReady(projectId, channel) || !useServerStore.getState().settings?.agent.enabled) return;
            loadedBindingKey = nextBindingKey;
            void loadSessions(true);
        },

        refreshSessions: () => loadSessions(false),

        openSession: async (sessionId) => {
            if (!sessionId) return;
            detach();
            const { channel, bindingKey: currentBindingKey } = get();
            const scope = anonymousScope(channel);
            const cachedPromise = scope ? readAnonymousShareAgentHistory(scope).catch(() => null) : Promise.resolve(null);
            if (!scope) localStorage.setItem(sessionStorageKey(channel), sessionId);
            set({ sessionId, model: "", messages: [], status: "idle", pendingAction: null, resolving: false, error: "", loading: true, ...clearedHighlight });
            try {
                // 先补齐历史再挂流：服务端循环不依赖前端连接，断线期间跑完的结果都已经落库。
                const api = agentApi(channel);
                const [session, { items }] = await Promise.all([api.session(sessionId), api.messages(sessionId, 0)]);
                if (get().sessionId !== sessionId || get().bindingKey !== currentBindingKey) return;
                // 每个会话记着自己用的模型，切回来还是当初那个，不会被别的会话的选择带跑。
                // 待确认请求落在会话行上，所以刷新页面、换设备重新打开会话时那张卡片还在。
                set({ model: session.model, messages: items, status: session.status, pendingAction: session.pendingAction || null, error: session.error, loading: false });
                persistAnonymous();
                if (session.status === "running" || session.status === "awaiting") void attach(sessionId);
            } catch (error) {
                if (get().sessionId !== sessionId || get().bindingKey !== currentBindingKey) return;
                const cached = await cachedPromise;
                const session = cached?.sessions.find((item) => item.id === sessionId);
                const messages = cached?.messagesBySession[sessionId];
                if (session && messages) {
                    set({
                        model: session.model,
                        messages,
                        status: session.status === "running" || session.status === "awaiting" ? "failed" : session.status,
                        pendingAction: null,
                        error: "暂时无法连接服务端，当前显示此浏览器保存的匿名历史",
                        loading: false,
                    });
                } else set({ loading: false, error: errorText(error) });
            }
        },

        /** 只清空界面，真正的会话行等第一次发消息时再建，避免留下一堆空会话。 */
        newSession: () => {
            detach();
            if (!get().anonymous) localStorage.removeItem(sessionStorageKey(get().channel));
            // 模型清空，新会话按用户偏好（没设过就按管理员默认）起头。
            set({ sessionId: "", model: "", messages: [], status: "idle", pendingAction: null, resolving: false, error: "", prompt: "", draftReferences: [], attachments: [], ...clearedHighlight });
            persistAnonymous();
        },

        deleteSession: async (sessionId) => {
            const { channel, bindingKey: currentBindingKey } = get();
            try {
                await agentApi(channel).deleteSession(sessionId);
            } catch (error) {
                return set({ error: errorText(error) });
            }
            if (get().bindingKey !== currentBindingKey) return;
            if (get().sessionId === sessionId) {
                detach();
                if (!get().anonymous) localStorage.removeItem(sessionStorageKey(channel));
                set({ sessionId: "", model: "", messages: [], status: "idle", pendingAction: null, resolving: false, error: "", ...clearedHighlight });
            }
            set((state) => ({ sessions: state.sessions.filter((item) => item.id !== sessionId) }));
            const scope = anonymousScope(channel);
            if (scope) {
                const state = get();
                void removeAnonymousShareAgentSession(scope, sessionId, state.sessions, state.sessionId).catch(() => undefined);
            }
        },

        send: async () => {
            const draft = get().prompt.trim();
            const attachments = get().attachments;
            const { channel, bindingKey: currentBindingKey, projectId } = get();
            // awaiting 时循环还没结束，这时候发新消息服务端会拒绝，先让用户把待确认的那条请求处理掉。
            if ((!draft && !attachments.length) || get().sending || get().status === "running" || get().status === "awaiting" || !channelReady(projectId, channel)) return;
            let acceptSelfPay = false;
            try {
                acceptSelfPay = await ensureAgentBillingConsent(channel);
            } catch (error) {
                if (!(error instanceof DOMException && error.name === "AbortError")) set({ error: errorText(error) });
                return;
            }
            if (get().bindingKey !== currentBindingKey) return;
            // 行内标签在这一步才展开成服务端标记：位置与顺序原样保留，用户删掉的标签自然就不算引用了。
            const { content, references } = expandDraftReferences(draft, get().draftReferences);
            const attachmentIds = attachments.map((item) => item.id);
            const draftReferences = get().draftReferences;
            set({ sending: true, error: "", prompt: "", draftReferences: [], attachments: [] });
            // 幂等键跟着「正文 + 附件」走：内容没变的重发复用同一个键，服务端不会重复执行、重复扣点。
            const key = `${content}|${attachmentIds.join(",")}`;
            const clientMessageId = pendingSend?.key === key ? pendingSend.clientMessageId : nanoid();
            pendingSend = { clientMessageId, key };
            // 模型在发送这一刻定下来：会话已选的优先，其次用户偏好，最后回落管理员默认。
            const model = resolveAgentModel(get().model);
            try {
                const api = agentApi(channel);
                let sessionId = get().sessionId;
                if (!sessionId) {
                    const created = await api.createSession({ sessionId: "", projectId, title: content.slice(0, 30), model }, acceptSelfPay);
                    if (get().bindingKey !== currentBindingKey) return;
                    sessionId = created.id;
                    set((state) => ({ sessions: [created, ...state.sessions.filter((item) => item.id !== created.id)] }));
                }
                if (get().bindingKey !== currentBindingKey) return;
                if (sessionId !== get().sessionId) {
                    if (!get().anonymous) localStorage.setItem(sessionStorageKey(channel), sessionId);
                    set({ sessionId, messages: [] });
                }
                const message = await api.send(sessionId, { clientMessageId, content, model, attachmentIds, references }, acceptSelfPay);
                if (get().bindingKey !== currentBindingKey) return;
                pendingSend = null;
                set((state) => ({ sending: false, status: "running", messages: mergeMessages(state.messages, [message]) }));
                persistAnonymous();
                void attach(sessionId);
                // 服务端可能因为模型被下线而回落到别的模型，按服务端记录回填，面板显示的就是真正在跑、真正计费的那个。
                void loadSessions(false).then(() => {
                    const current = get().sessions.find((item) => item.id === sessionId);
                    if (current && get().sessionId === sessionId) set({ model: current.model });
                });
            } catch (error) {
                if (get().bindingKey !== currentBindingKey) return;
                // 团队积分被扣光时光把红字塞进面板没用：用户既不能自己充值，也不知道还有回落这条路。
                if (channel === "account") notifyTeamCreditsExhausted(error);
                // 团队云空间满同理：面板里一句红字会让用户跑去删自己的个人画布，而占满的根本不是他那本账。
                if (channel === "account") notifyTeamQuotaExceeded(error);
                // 发送失败把草稿、引用和图片都还回输入框，用户可以直接重发；幂等键留着复用。
                set((state) => ({
                    sending: false,
                    error: errorText(error),
                    prompt: state.prompt || draft,
                    draftReferences: state.draftReferences.length ? state.draftReferences : draftReferences,
                    attachments: state.attachments.length ? state.attachments : attachments,
                }));
            }
        },

        abort: async () => {
            const sessionId = get().sessionId;
            if (!sessionId) return;
            // 中止结果由服务端循环写回「已中止本次执行」并推 status，这里不抢先改状态。
            await agentApi(get().channel).abort(sessionId).catch((error: unknown) => set({ error: errorText(error) }));
        },

        /**
         * 回应服务端挂起的那条请求。批准 / 拒绝之后的状态一律以服务端推回来的 status 为准，
         * 这里只把卡片收掉：批准后循环要接着跑，得先确保 SSE 挂着，否则后续进度要等重连才看得到。
         */
        resolvePending: async (approved) => {
            const sessionId = get().sessionId;
            const pendingAction = get().pendingAction;
            const { channel, bindingKey: currentBindingKey } = get();
            if (!sessionId || !pendingAction || get().resolving) return;
            let acceptSelfPay = false;
            if (approved && pendingAction.type === "continue") {
                try {
                    acceptSelfPay = await ensureAgentBillingConsent(channel);
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === "AbortError")) set({ error: errorText(error) });
                    return;
                }
            }
            if (get().bindingKey !== currentBindingKey) return;
            set({ resolving: true, error: "" });
            try {
                const session = await agentApi(channel).resolve(sessionId, approved, acceptSelfPay);
                if (get().sessionId !== sessionId || get().bindingKey !== currentBindingKey) return;
                set((state) => ({
                    status: session.status,
                    pendingAction: session.pendingAction || null,
                    error: session.error,
                    resolving: false,
                    sessions: state.sessions.map((item) => (item.id === sessionId ? session : item)),
                }));
                persistAnonymous();
                if (session.status === "running" || session.status === "awaiting") void attach(sessionId);
            } catch (error) {
                if (get().bindingKey !== currentBindingKey) return;
                set({ resolving: false, error: errorText(error) });
            }
        },
    };
});
