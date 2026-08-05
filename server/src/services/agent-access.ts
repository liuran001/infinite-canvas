import { repo } from "../db/data-source";
import { AgentSession, Project, ProjectShare, User } from "../db/entities";
import { fail, NOT_FOUND } from "../lib/errors";
import { resolveProjectAccess, type AccessContext, type ProjectPermission } from "./project-access";
import { type Payer } from "./billing";
import { shareUsable } from "./project-share";

export type AgentScope = {
    actorId: string;
    projectOwnerId: string;
    preferenceUserId: string;
    payerUserId: string;
    shareId: string;
    payer: Payer;
};

export async function resolveAgentScope(context: AccessContext, projectId: string, permission: ProjectPermission, acceptSelfPay: boolean): Promise<AgentScope> {
    const access = await resolveProjectAccess(context, projectId, permission);
    if (!access.share) return { actorId: access.actorId, projectOwnerId: access.ownerId, preferenceUserId: access.actorId, payerUserId: access.actorId, shareId: "", payer: { kind: "user", userId: access.actorId } };
    if (access.anonymous && !(access.share.ownerPays && access.role === "editor" && access.share.allowAnonymousEdit)) throw fail("匿名访客未获准使用 Agent", 403, "AGENT_GUEST_FORBIDDEN");
    const ownerUsesOwnCredits = context.guest?.accountId === access.ownerId;
    if (!access.share.ownerPays && !ownerUsesOwnCredits && !acceptSelfPay) throw fail("请先确认由本人支付", 403, "SELF_PAY_CONFIRM_REQUIRED");
    const payerUserId = access.share.ownerPays ? access.ownerId : (context.guest?.accountId || "");
    if (!payerUserId) throw fail("请先登录后再使用个人算力点", 401, "SELF_PAY_LOGIN_REQUIRED");
    return { actorId: access.actorId, projectOwnerId: access.ownerId, preferenceUserId: context.guest?.accountId || access.actorId, payerUserId, shareId: access.share.id, payer: { kind: "user", userId: payerUserId } };
}

function sessionNotFound() {
    return fail("会话不存在", 404, NOT_FOUND);
}

function shareAccessChanged() {
    return fail("分享权限或付款策略已变化，本次 Agent 已停止，请刷新后重试", 403, "AGENT_SHARE_ACCESS_CHANGED");
}

/**
 * 后台推理循环没有请求里的 guest JWT，不能复用 resolveProjectAccess；每个工具执行前改用会话里
 * 固化的 shareId / actorId 回库重验。角色、匿名编辑、房主状态或付款方任何一项变化都停止本轮，
 * 绝不能拿旧策略继续改房主画布或创建仍扣旧付款方的生成任务。
 */
export async function revalidateRunningAgentSession(session: AgentSession, requireSamePayer = true): Promise<AgentScope | null> {
    if (!session.shareId) return null;
    const ownerId = session.projectOwnerId || "";
    const [share, project, owner] = await Promise.all([
        repo(ProjectShare).findOneBy({ id: session.shareId }),
        ownerId ? repo(Project).findOneBy({ userId: ownerId, projectId: session.projectId, deleted: false }) : null,
        ownerId ? repo(User).findOneBy({ id: ownerId, status: "active" }) : null,
    ]);
    if (!share || !shareUsable(share) || share.ownerId !== ownerId || share.projectId !== session.projectId || !project || !owner || share.role !== "editor") {
        throw shareAccessChanged();
    }

    const anonymous = session.userId.startsWith(`guest:${share.id}:`);
    if (anonymous) {
        if (!share.allowAnonymous || !share.ownerPays || !share.allowAnonymousEdit) throw shareAccessChanged();
    } else {
        const actor = await repo(User).findOneBy({ id: session.userId, status: "active" });
        if (!actor) throw shareAccessChanged();
    }

    const payerUserId = share.ownerPays ? ownerId : session.userId;
    if (requireSamePayer && (session.payerKind !== "user" || session.payerTeamId || session.payerUserId !== payerUserId)) throw shareAccessChanged();
    return {
        actorId: session.userId,
        projectOwnerId: ownerId,
        preferenceUserId: session.userId,
        payerUserId,
        shareId: share.id,
        payer: { kind: "user", userId: payerUserId },
    };
}

/**
 * 已有会话不能只凭 actorId 继续使用：分享链接可能已经撤销、过期或降为只读。
 * 历史读取只复核 read 权限，不触发自费确认；会修改画布的入口再单独要求 write。
 */
export async function resolveExistingAgentSession(context: AccessContext, actorId: string, sessionId: string, permission: ProjectPermission) {
    const session = await repo(AgentSession).findOneBy({ userId: actorId, sessionId, deleted: false });
    if (!session) throw sessionNotFound();
    if (!session.shareId) return { session, access: null };
    const access = await resolveProjectAccess(context, session.projectId, permission);
    if (!access.share || access.share.id !== session.shareId || access.actorId !== actorId || access.ownerId !== (session.projectOwnerId || access.ownerId)) throw sessionNotFound();
    return { session, access };
}

/** 每条新消息/续跑都按分享当前计费策略重算；旧会话不能在房主关闭代付后继续扣房主。 */
export async function resolveExistingAgentBillingScope(context: AccessContext, actorId: string, sessionId: string, acceptSelfPay: boolean) {
    const current = await resolveExistingAgentSession(context, actorId, sessionId, "write");
    if (!current.session.shareId) return { ...current, scope: null };
    const scope = await resolveAgentScope(context, current.session.projectId, "write", acceptSelfPay);
    if (scope.actorId !== actorId || scope.shareId !== current.session.shareId) throw sessionNotFound();
    return { ...current, scope };
}
