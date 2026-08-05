import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/** 分享 Agent 的身份、历史隔离、画布归属与付款方验证。 */
const env = prepareEnv("verify-share-agent");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { AgentSession, Project, User } = await import("./src/db/entities");
    const { createAgentSession, getAgentSession, listAgentMessages, listAgentSessions, resolveAgentSession, sendAgentMessage } = await import("./src/services/agent");
    const { resolveAgentScope, resolveExistingAgentBillingScope, resolveExistingAgentSession } = await import("./src/services/agent-access");
    const { payerOfSession } = await import("./src/services/billing");
    const { saveFile } = await import("./src/services/files");
    const { createShare, guestSessionOf, updateShare } = await import("./src/services/project-share");
    const { saveSettings } = await import("./src/services/settings");
    const { now } = await import("./src/lib/errors");

    await initDatabase();
    const makeUser = (id: string, credits = 100) =>
        repo(User).insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits, storageQuota: 1 << 30, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    await makeUser("owner");
    await makeUser("collaborator");
    await repo(Project).insert({ userId: "owner", projectId: "canvas", title: "共享画布", data: JSON.stringify({ nodes: [{ id: "ref-1", type: "text", title: "房主节点", metadata: { content: "共享内容" } }], connections: [] }), revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    await saveSettings({
        private: { channels: [{ apiFormat: "openai", name: "mock", baseUrl: "http://127.0.0.1", apiKey: "x", models: [{ name: "text-model", capability: "text", vision: true }], weight: 1, enabled: true, remark: "" }] },
        public: { modelChannel: { defaultTextModel: "text-model" }, agent: { enabled: true, model: "text-model" } },
    });

    const paidShare = await createShare("owner", "canvas", { role: "editor", allowAnonymous: true, allowClone: false, expiresAt: "", ownerPays: true, allowAnonymousEdit: true });
    const collaboratorGuest = guestSessionOf(paidShare.share, { accountId: "collaborator", actorId: "", displayName: "协作者", avatarUrl: "" });
    const collaboratorScope = await resolveAgentScope({ user: null, guest: collaboratorGuest }, "canvas", "write", false);
    check("登录协作者历史归属本人账号", collaboratorScope.actorId, "collaborator");
    check("分享 Agent 画布归属房主", collaboratorScope.projectOwnerId, "owner");
    check("房主代付时付款方是房主个人", collaboratorScope.payerUserId, "owner");
    check("登录协作者偏好仍归本人", collaboratorScope.preferenceUserId, "collaborator");

    const collaboratorSession = await createAgentSession(collaboratorScope.actorId, { sessionId: "agent-collab", projectId: "canvas", title: "协作会话", model: "text-model" }, collaboratorScope);
    check("协作者能创建分享 Agent 会话", collaboratorSession.id, "agent-collab");
    check("房主看不到协作者 Agent 历史", (await listAgentSessions("owner", "canvas")).length, 0);
    check("协作者能看到自己的 Agent 历史", (await listAgentSessions("collaborator", "canvas")).length, 1);
    const savedCollaborator = await repo(AgentSession).findOneByOrFail({ userId: "collaborator", sessionId: "agent-collab" });
    check("会话固化真实画布所有者", savedCollaborator.projectOwnerId, "owner");
    check("会话固化分享链接", savedCollaborator.shareId, paidShare.share.id);
    check("会话付款回执还原到房主", payerOfSession(savedCollaborator), { kind: "user", userId: "owner" });

    const attachment = await saveFile("owner", Buffer.from("share-agent-attachment"), "image/png");
    const originalFetch = globalThis.fetch;
    let requestSawOwnerAttachment = false;
    let requestSawOwnerNode = false;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}")) as { messages?: Array<{ content?: string | Array<{ type?: string; text?: string; image_url?: { url?: string } }> }> };
        const serialized = JSON.stringify(body.messages || []);
        requestSawOwnerAttachment ||= serialized.includes("data:image/png;base64,");
        requestSawOwnerNode ||= serialized.includes("canvas-node:ref-1#text");
        return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"已读取分享内容"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        });
    }) as typeof fetch;
    const sent = await sendAgentMessage("collaborator", "agent-collab", {
        clientMessageId: "share-message-1",
        content: "看看 @[房主节点](canvas-node:ref-1#text) 和附件",
        model: "text-model",
        attachmentIds: [attachment.id],
        references: [{ nodeId: "ref-1", type: "", title: "" }],
    });
    check("分享 Agent 接受房主空间里的附件", sent.attachments, [attachment.id]);
    check("分享 Agent 按房主画布解析节点引用", sent.references[0]?.nodeId, "ref-1");
    for (let index = 0; index < 100 && (await getAgentSession("collaborator", "agent-collab")).status === "running"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    check("分享附件以图片内容进入模型上下文", requestSawOwnerAttachment, true);
    check("分享节点引用以规范标记进入模型上下文", requestSawOwnerNode, true);
    check("分享消息仍只写入协作者自己的历史", (await listAgentMessages("collaborator", "agent-collab", 0)).some((message) => message.role === "user" && message.attachments.includes(attachment.id)), true);

    await repo(AgentSession).update(
        { userId: "collaborator", sessionId: "agent-collab" },
        { status: "awaiting", pendingAction: { type: "rename_canvas", title: "协作者改名", reason: "专项验证" } },
    );
    await resolveAgentSession("collaborator", "agent-collab", true);
    check("分享会话批准改名时修改房主画布", (await repo(Project).findOneByOrFail({ userId: "owner", projectId: "canvas" })).title, "协作者改名");
    for (let index = 0; index < 100 && (await getAgentSession("collaborator", "agent-collab")).status === "running"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    globalThis.fetch = originalFetch;

    const anonymousGuest = guestSessionOf(paidShare.share, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    const anonymousScope = await resolveAgentScope({ user: null, guest: anonymousGuest }, "canvas", "write", false);
    check("匿名历史使用稳定 guest actorId", anonymousScope.actorId.startsWith(`guest:${paidShare.share.id}:`), true);
    check("匿名 Agent 由房主支付", anonymousScope.payerUserId, "owner");
    await createAgentSession(anonymousScope.actorId, { sessionId: "agent-anon", projectId: "canvas", title: "匿名会话", model: "text-model" }, anonymousScope);
    check("房主仍看不到匿名 Agent 历史", (await listAgentSessions("owner", "canvas")).length, 0);
    check("匿名访客只看到自己的历史", (await listAgentSessions(anonymousScope.actorId, "canvas")).length, 1);

    check("有效分享会话读取时只复核 read 权限", (await resolveExistingAgentSession({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", "read")).session.sessionId, "agent-collab");
    const noOwnerPay = await updateShare(paidShare.share, { ownerPays: false, allowAnonymousEdit: false });
    await rejects("房主关闭代付后旧会话不能继续扣房主", () => resolveExistingAgentBillingScope({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", false));
    const refreshed = await resolveExistingAgentBillingScope({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", true);
    check("旧会话确认自费后重算为协作者付款", refreshed.scope?.payerUserId, "collaborator");

    globalThis.fetch = (async () => new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"已按新策略执行"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    })) as typeof fetch;
    await sendAgentMessage("collaborator", "agent-collab", {
        clientMessageId: "share-message-self-pay",
        content: "按新计费策略继续",
        model: "text-model",
        attachmentIds: [],
        references: [],
    }, refreshed.scope);
    for (let index = 0; index < 100 && (await getAgentSession("collaborator", "agent-collab")).status === "running"; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    globalThis.fetch = originalFetch;
    check("发送新消息后会话付款方已刷新", (await repo(AgentSession).findOneByOrFail({ userId: "collaborator", sessionId: "agent-collab" })).payerUserId, "collaborator");

    const viewerShare = await updateShare(noOwnerPay, { role: "viewer" });
    check("分享降为只读后仍能读取自己的历史", (await resolveExistingAgentSession({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", "read")).session.sessionId, "agent-collab");
    await rejects("分享降为只读后旧会话不能再发送或续跑", () => resolveExistingAgentBillingScope({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", true));
    await updateShare(viewerShare, { enabled: false });
    await rejects("分享撤销后旧 guest 不能再读取会话", () => resolveExistingAgentSession({ user: null, guest: collaboratorGuest }, "collaborator", "agent-collab", "read"));

    const selfPayShare = await createShare("owner", "canvas", { role: "editor", allowAnonymous: false, allowClone: false, expiresAt: "", ownerPays: false, allowAnonymousEdit: false });
    const ownerGuest = guestSessionOf(selfPayShare.share, { accountId: "owner", actorId: "", displayName: "房主", avatarUrl: "" });
    const ownerScope = await resolveAgentScope({ user: null, guest: ownerGuest }, "canvas", "write", false);
    check("房主打开自己的分享无需确认自费", ownerScope.payerUserId, "owner");
    const selfPayGuest = guestSessionOf(selfPayShare.share, { accountId: "collaborator", actorId: "", displayName: "协作者", avatarUrl: "" });
    await rejects("登录协作者未确认时不能自费使用 Agent", () => resolveAgentScope({ user: null, guest: selfPayGuest }, "canvas", "write", false));
    const selfPayScope = await resolveAgentScope({ user: null, guest: selfPayGuest }, "canvas", "write", true);
    check("同意自费后付款方是协作者本人", selfPayScope.payerUserId, "collaborator");

    console.log("运行中分享策略变化立即收权");
    await saveSettings({ public: { modelChannel: { modelCosts: [{ model: "text-model", credits: 1 }] } } });
    const toolResponse = () =>
        new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-race", type: "function", function: { name: "add_node", arguments: JSON.stringify({ type: "text", title: "不应写入", content: "权限已变化" }) } }] }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
    const runPolicyRace = async (name: string, patch: { role?: "viewer"; enabled?: false; ownerPays?: false }) => {
        const projectId = `race-${name}`;
        await repo(Project).insert({ userId: "owner", projectId, title: `竞态-${name}`, data: JSON.stringify({ nodes: [], connections: [] }), revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
        const created = await createShare("owner", projectId, { role: "editor", allowAnonymous: false, allowClone: false, expiresAt: "", ownerPays: true, allowAnonymousEdit: false });
        const guest = guestSessionOf(created.share, { accountId: "collaborator", actorId: "", displayName: "协作者", avatarUrl: "" });
        const scope = await resolveAgentScope({ user: null, guest }, projectId, "write", false);
        await createAgentSession("collaborator", { sessionId: `agent-race-${name}`, projectId, title: "策略竞态", model: "text-model" }, scope);
        const ownerCredits = (await repo(User).findOneByOrFail({ id: "owner" })).credits;
        globalThis.fetch = (async () => {
            await updateShare(created.share, patch);
            return toolResponse();
        }) as typeof fetch;
        await sendAgentMessage("collaborator", `agent-race-${name}`, { clientMessageId: `message-race-${name}`, content: "请新增节点", model: "text-model", attachmentIds: [], references: [] }, scope);
        for (let index = 0; index < 100 && (await getAgentSession("collaborator", `agent-race-${name}`)).status === "running"; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const session = await getAgentSession("collaborator", `agent-race-${name}`);
        check(`${name} 后运行中会话失败`, session.status, "failed");
        check(`${name} 后工具未修改房主画布`, JSON.parse((await repo(Project).findOneByOrFail({ userId: "owner", projectId })).data).nodes.length, 0);
        check(`${name} 后旧房主扣费已退回`, (await repo(User).findOneByOrFail({ id: "owner" })).credits, ownerCredits);
    };
    await runPolicyRace("降为只读", { role: "viewer" });
    await runPolicyRace("撤销分享", { enabled: false });
    await runPolicyRace("关闭代付", { ownerPays: false });
    globalThis.fetch = originalFetch;

    await repo(Project).insert({ userId: "owner", projectId: "rename-revoke", title: "撤权前标题", data: JSON.stringify({ nodes: [], connections: [] }), revision: 1, deleted: false, teamId: "", createdAt: now(), updatedAt: now() });
    const renameShare = await createShare("owner", "rename-revoke", { role: "editor", allowAnonymous: false, allowClone: false, expiresAt: "", ownerPays: true, allowAnonymousEdit: false });
    const renameGuest = guestSessionOf(renameShare.share, { accountId: "collaborator", actorId: "", displayName: "协作者", avatarUrl: "" });
    const renameScope = await resolveAgentScope({ user: null, guest: renameGuest }, "rename-revoke", "write", false);
    await createAgentSession("collaborator", { sessionId: "agent-rename-revoke", projectId: "rename-revoke", title: "撤权改名", model: "text-model" }, renameScope);
    await repo(AgentSession).update(
        { userId: "collaborator", sessionId: "agent-rename-revoke" },
        { status: "awaiting", pendingAction: { type: "rename_canvas", title: "不应改成这个标题", reason: "撤权回归" } },
    );
    await updateShare(renameShare.share, { role: "viewer" });
    await rejects("改名待确认期间撤权后批准被拒绝", () => resolveAgentSession("collaborator", "agent-rename-revoke", true));
    check("撤权后批准没有修改画布标题", (await repo(Project).findOneByOrFail({ userId: "owner", projectId: "rename-revoke" })).title, "撤权前标题");

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
