import { repo } from "../db/data-source";
import { Project, ProjectShare } from "../db/entities";
import { fail, SHARE_READ_ONLY } from "../lib/errors";
import { shareUsable, type GuestSession } from "./project-share";

export type ProjectPermission = "read" | "write";
export type ProjectActor = { id: string; displayName: string; avatarUrl: string };
export type ProjectRole = "owner" | "editor" | "viewer";
/** 请求身份：要么是账号，要么是一枚分享 guest 令牌，两者不会同时生效。 */
export type AccessContext = { user: ProjectActor | null; guest: GuestSession | null };
export type ProjectAccess = {
    project: Project;
    /** 项目真实所有者，配额、文件归属与写入目标都以它为准，绝不能用访客自己的 id。 */
    ownerId: string;
    role: ProjectRole;
    share: ProjectShare | null;
    actor: ProjectActor;
    actorId: string;
    anonymous: boolean;
};

// 不区分「不存在」和「存在但无权」，避免拿项目 ID 或分享 token 探测别人的画布。
function notFound() {
    return fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
}

async function liveProject(ownerId: string, projectId: string) {
    const project = await repo(Project).findOneBy({ userId: ownerId, projectId });
    if (!project || project.deleted) throw notFound();
    return project;
}

/**
 * 分享访客的判定。guest 令牌里的 role 与 ownerId 只是建连接前的快速提示，
 * 这里一律回库重新核对：链接可能在令牌有效期内被撤销、降级或改成不允许匿名。
 */
async function shareAccess(guest: GuestSession, projectId: string, permission: ProjectPermission): Promise<ProjectAccess> {
    if (guest.projectId !== projectId) throw notFound();
    const share = await repo(ProjectShare).findOneBy({ id: guest.shareId });
    if (!share || share.projectId !== projectId || !shareUsable(share)) throw notFound();
    if (guest.anonymous && !share.allowAnonymous) throw notFound();
    const project = await liveProject(share.ownerId, projectId);
    const role = share.role === "editor" && guest.anonymous && (!share.ownerPays || !share.allowAnonymousEdit) ? "viewer" : share.role;
    if (permission === "write" && role !== "editor") throw fail("这条分享链接是只读的", 403, SHARE_READ_ONLY);
    return {
        project,
        ownerId: share.ownerId,
        role,
        share,
        actor: { id: guest.actorId, displayName: guest.displayName, avatarUrl: guest.avatarUrl },
        actorId: guest.actorId,
        anonymous: guest.anonymous,
    };
}

/**
 * 所有单画布访问都从这里解析：项目读写、SSE、Presence、上传与克隆一个不落。
 * 只要还有第二处自己去比 ownerId，分享一接进来就会出现绕过权限的缺口。
 */
export async function resolveProjectAccess(context: AccessContext, projectId: string, permission: ProjectPermission): Promise<ProjectAccess> {
    if (context.guest) return shareAccess(context.guest, projectId, permission);
    const actor = context.user;
    if (!actor?.id) throw notFound();
    const project = await liveProject(actor.id, projectId);
    return { project, ownerId: project.userId, role: "owner", share: null, actor, actorId: actor.id, anonymous: false };
}
