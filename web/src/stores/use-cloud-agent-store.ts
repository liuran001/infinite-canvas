import { nanoid } from "nanoid";
import { create } from "zustand";

import { serverAgentStream, serverApi, type ServerAgentEvent, type ServerAgentMessage, type ServerAgentSession, type ServerAgentSessionStatus } from "@/services/api/server";
import { resolveAgentModel, useConfigStore } from "@/stores/use-config-store";
import { isServerMode, useServerStore } from "@/stores/use-server-store";

/** 记住上次打开的会话，刷新页面或换设备回来能接回原来那条对话；只是一个会话 ID，放 localStorage 足够。 */
const SESSION_KEY = "canvas-agent-cloud-session";
/** 这些工具会直接改服务端画布，拿到结果就通知画布页重新拉一次远程数据，前端不重复实现一遍节点写入。 */
const CANVAS_WRITE_TOOLS = new Set(["create_node", "update_node", "delete_node", "connect_nodes", "disconnect_nodes", "generate_image"]);
const RETRY_BASE_MS = 800;
const RETRY_MAX_MS = 8000;
const RETRY_LIMIT = 6;

let streamAbort: AbortController | null = null;
let streamToken = 0;
/** 已经拉过会话列表的画布；登录态与服务端配置是异步就绪的，就绪前不算绑定成功，之后要补拉一次。 */
let loadedProjectId = "";
/** 发送失败时保留幂等键，用户原样重发时复用，服务端就不会把重试当成新消息重复执行、重复扣点。 */
let pendingSend: { clientMessageId: string; content: string } | null = null;

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

type CloudAgentStore = {
    projectId: string;
    sessions: ServerAgentSession[];
    sessionId: string;
    /** 当前会话正在用的模型。空表示还没有会话，面板按用户偏好 / 管理员默认展示。 */
    model: string;
    messages: ServerAgentMessage[];
    status: ServerAgentSessionStatus;
    error: string;
    loading: boolean;
    sending: boolean;
    prompt: string;
    /** 服务端改过画布的次数，画布页据此重新拉一次远程画布并刷新到界面上。 */
    canvasReload: number;
    requestCanvasReload: () => void;
    setPrompt: (prompt: string) => void;
    setModel: (model: string) => void;
    bindProject: (projectId: string) => void;
    refreshSessions: () => Promise<void>;
    openSession: (sessionId: string) => Promise<void>;
    newSession: () => void;
    deleteSession: (sessionId: string) => Promise<void>;
    send: () => Promise<void>;
    abort: () => Promise<void>;
};

export const useCloudAgentStore = create<CloudAgentStore>((set, get) => {
    const detach = () => {
        streamToken += 1;
        streamAbort?.abort();
        streamAbort = null;
    };

    const applyEvent = (sessionId: string, event: ServerAgentEvent) => {
        if (get().sessionId !== sessionId) return;
        if (event.type === "status") {
            set({ status: event.status, error: event.error });
            // 跑完再兜底刷一次画布，工具事件万一漏收也不会让界面停在旧数据上。
            if (event.status !== "running") set((state) => ({ canvasReload: state.canvasReload + 1 }));
            return;
        }
        set((state) => ({ messages: mergeMessages(state.messages, [event.message]) }));
        // 工具有结果才代表画布真的改完了，这时候再拉，避免拉到改了一半的数据。
        if (event.message.role === "tool" && event.message.toolResult && CANVAS_WRITE_TOOLS.has(event.message.toolName)) set((state) => ({ canvasReload: state.canvasReload + 1 }));
    };

    /** 挂 SSE 并在断线后自动重连：服务端循环不受前端连接影响，重连带 sinceSeq 就能续上。 */
    const attach = async (sessionId: string) => {
        detach();
        const token = ++streamToken;
        const abort = new AbortController();
        streamAbort = abort;
        for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
            try {
                await serverAgentStream(sessionId, resumeSeq(get().messages), (event) => applyEvent(sessionId, event), abort.signal);
                attempt = -1;
            } catch (error) {
                if (abort.signal.aborted) return;
                console.warn("Agent 事件流断开，准备重连", error);
            }
            if (abort.signal.aborted || token !== streamToken || get().sessionId !== sessionId) return;
            // 已经跑完就不用再连，服务端也不会再推事件。
            if (get().status !== "running") return;
            await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt))));
            if (abort.signal.aborted || token !== streamToken) return;
        }
        set({ error: "与服务端的事件连接中断，Agent 仍在后台执行，稍后重新打开会话即可看到结果" });
    };

    const loadSessions = async (autoOpen: boolean) => {
        const projectId = get().projectId;
        if (!projectId || !isServerMode()) return;
        set({ loading: true });
        try {
            const { items } = await serverApi.agentSessions(projectId);
            set({ sessions: items, loading: false });
            if (!autoOpen || get().sessionId) return;
            // 刷新页面 / 换设备回来时接回上次那条会话，接不上就用最近更新的一条。
            const target = items.find((item) => item.id === localStorage.getItem(SESSION_KEY)) || items[0];
            if (target) await get().openSession(target.id);
        } catch (error) {
            set({ loading: false, error: errorText(error) });
        }
    };

    return {
        projectId: "",
        sessions: [],
        sessionId: "",
        model: "",
        messages: [],
        status: "idle",
        error: "",
        loading: false,
        sending: false,
        prompt: "",
        canvasReload: 0,
        requestCanvasReload: () => set((state) => ({ canvasReload: state.canvasReload + 1 })),
        setPrompt: (prompt) => set({ prompt }),

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
        bindProject: (projectId) => {
            if (get().projectId !== projectId) {
                detach();
                loadedProjectId = "";
                set({ projectId, sessions: [], sessionId: "", model: "", messages: [], status: "idle", error: "", prompt: "", sending: false });
            }
            if (!projectId || loadedProjectId === projectId || !isServerMode() || !useServerStore.getState().settings?.agent.enabled) return;
            loadedProjectId = projectId;
            void loadSessions(true);
        },

        refreshSessions: () => loadSessions(false),

        openSession: async (sessionId) => {
            if (!sessionId) return;
            detach();
            localStorage.setItem(SESSION_KEY, sessionId);
            set({ sessionId, model: "", messages: [], status: "idle", error: "", loading: true });
            try {
                // 先补齐历史再挂流：服务端循环不依赖前端连接，断线期间跑完的结果都已经落库。
                const [session, { items }] = await Promise.all([serverApi.agentSession(sessionId), serverApi.agentMessages(sessionId, 0)]);
                if (get().sessionId !== sessionId) return;
                // 每个会话记着自己用的模型，切回来还是当初那个，不会被别的会话的选择带跑。
                set({ model: session.model, messages: items, status: session.status, error: session.error, loading: false });
                if (session.status === "running") void attach(sessionId);
            } catch (error) {
                if (get().sessionId !== sessionId) return;
                set({ loading: false, error: errorText(error) });
            }
        },

        /** 只清空界面，真正的会话行等第一次发消息时再建，避免留下一堆空会话。 */
        newSession: () => {
            detach();
            localStorage.removeItem(SESSION_KEY);
            // 模型清空，新会话按用户偏好（没设过就按管理员默认）起头。
            set({ sessionId: "", model: "", messages: [], status: "idle", error: "", prompt: "" });
        },

        deleteSession: async (sessionId) => {
            try {
                await serverApi.deleteAgentSession(sessionId);
            } catch (error) {
                return set({ error: errorText(error) });
            }
            if (get().sessionId === sessionId) {
                detach();
                localStorage.removeItem(SESSION_KEY);
                set({ sessionId: "", model: "", messages: [], status: "idle", error: "" });
            }
            set((state) => ({ sessions: state.sessions.filter((item) => item.id !== sessionId) }));
        },

        send: async () => {
            const content = get().prompt.trim();
            if (!content || get().sending || get().status === "running" || !get().projectId || !isServerMode()) return;
            set({ sending: true, error: "", prompt: "" });
            const clientMessageId = pendingSend?.content === content ? pendingSend.clientMessageId : nanoid();
            pendingSend = { clientMessageId, content };
            // 模型在发送这一刻定下来：会话已选的优先，其次用户偏好，最后回落管理员默认。
            const model = resolveAgentModel(get().model);
            try {
                const sessionId = get().sessionId || (await serverApi.createAgentSession({ sessionId: "", projectId: get().projectId, title: content.slice(0, 30), model })).id;
                if (sessionId !== get().sessionId) {
                    localStorage.setItem(SESSION_KEY, sessionId);
                    set({ sessionId, messages: [] });
                }
                const message = await serverApi.sendAgentMessage(sessionId, { clientMessageId, content, model });
                pendingSend = null;
                set((state) => ({ sending: false, status: "running", messages: mergeMessages(state.messages, [message]) }));
                void attach(sessionId);
                // 服务端可能因为模型被下线而回落到别的模型，按服务端记录回填，面板显示的就是真正在跑、真正计费的那个。
                void loadSessions(false).then(() => {
                    const current = get().sessions.find((item) => item.id === sessionId);
                    if (current && get().sessionId === sessionId) set({ model: current.model });
                });
            } catch (error) {
                // 发送失败把草稿还回输入框，用户可以直接重发；幂等键留着复用。
                set((state) => ({ sending: false, error: errorText(error), prompt: state.prompt || content }));
            }
        },

        abort: async () => {
            const sessionId = get().sessionId;
            if (!sessionId) return;
            // 中止结果由服务端循环写回「已中止本次执行」并推 status，这里不抢先改状态。
            await serverApi.abortAgentSession(sessionId).catch((error: unknown) => set({ error: errorText(error) }));
        },
    };
});
