import { repo } from "../db/data-source";
import { Project } from "../db/entities";
import { fail } from "../lib/errors";

export type ProjectPermission = "read" | "write";
export type ProjectActor = { id: string; displayName: string; avatarUrl: string };

/**
 * 所有单画布访问都从这里解析。当前只有所有者能访问；分享功能接入时只扩展这里，
 * 实时流、Presence 与普通读写就不会各自长出一套容易漏检的权限判断。
 */
export async function resolveProjectAccess(actor: ProjectActor, projectId: string, _permission: ProjectPermission) {
    const project = await repo(Project).findOneBy({ userId: actor.id, projectId });
    // 不区分「不存在」和「存在但无权」，避免拿项目 ID 探测别人的画布。
    if (!project || project.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    return { ownerId: project.userId, project, permission: "owner" as const };
}
