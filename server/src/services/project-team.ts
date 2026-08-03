import { repo } from "../db/data-source";
import { Project } from "../db/entities";
import { fail, now } from "../lib/errors";
import { requireTeamRole } from "./team-access";

/**
 * 画布的团队归属。这里是唯一允许写 Project.teamId 的地方，也是唯一允许读客户端传来的 teamId 的地方：
 * 它修改的是一份持久资源的归属（一次显式的、可审计的决定），而不是指定「这一次调用由谁付款」。
 * 普通保存与同步接口一律不碰这一列——否则一次夹带 teamId 的 PUT 就等于把账单转给了别人的团队。
 *
 * 两道门都必须过：调用者得是这张画布的所有者，同时是目标团队里能消费的活跃成员。
 * 少了前者，任何成员都能把别人的画布拖进团队；少了后者，非成员就能凭一个团队 id 蹭上团队的池子。
 */
export async function setProjectTeam(userId: string, projectId: string, teamId: string) {
    const projects = repo(Project);
    const project = await projects.findOneBy({ userId, projectId });
    if (!project || project.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    const next = String(teamId || "").trim();
    // 解绑不需要团队权限：画布是自己的，随时能把它收回个人名下。
    if (next) await requireTeamRole(userId, next, "credits.spend", { write: true });
    await projects.update({ userId, projectId }, { teamId: next, updatedAt: now() });
    return { id: projectId, teamId: next };
}

export async function getProjectTeam(userId: string, projectId: string) {
    const project = await repo(Project).findOneBy({ userId, projectId });
    if (!project || project.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    return { id: projectId, teamId: project.teamId || "" };
}

/**
 * 这张画布里产生的文件该记谁的云空间。查不到画布就回落到个人：
 * 抛错的话，一次画布刚被删掉的生成任务会连产出都存不下来，而它本来只需要记在发起人自己名下。
 * 与付费方解析刻意分开：付费方在团队池不足时可能回落到个人，而文件归属跟着画布走，
 * 两者纠缠在一起的话，一次回落就会让团队画布里的图悄悄挂到某个成员名下，他一退出就该被清掉。
 */
export async function storageTeamOfProject(userId: string, projectId: string) {
    if (!projectId) return "";
    const project = await repo(Project).findOneBy({ userId, projectId });
    return project && !project.deleted ? project.teamId || "" : "";
}
