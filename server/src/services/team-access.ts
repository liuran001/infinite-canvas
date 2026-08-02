import { repo } from "../db/data-source";
import { Team, TeamMember, type TeamRole } from "../db/entities";
import { fail } from "../lib/errors";

export type { TeamRole };
export type TeamAction = "team.read" | "team.update" | "team.disband" | "team.transfer" | "team.leave" | "invite.manage" | "member.manage" | "member.promoteAdmin" | "credits.spend" | "logs.readAll" | "logs.readMine";

/** 权限矩阵的唯一定义。路由与服务一律查这张表，不允许自己比较 role。 */
const MATRIX: Record<TeamAction, TeamRole[]> = {
    "team.read": ["owner", "admin", "member", "viewer"],
    "team.update": ["owner", "admin"],
    "team.disband": ["owner"],
    "team.transfer": ["owner"],
    // 退出是「解除自己与团队的关系」，任何角色都该有；owner 的额外限制在 leaveTeam 里，理由是不变量而不是权限。
    "team.leave": ["owner", "admin", "member", "viewer"],
    "invite.manage": ["owner", "admin"],
    "member.manage": ["owner", "admin"],
    // 提升为 admin 只能由 owner 做：否则一个 admin 就能不断复制出同级账号，团队的权限边界会自己扩散开。
    "member.promoteAdmin": ["owner"],
    "credits.spend": ["owner", "admin", "member"],
    "logs.readAll": ["owner", "admin"],
    "logs.readMine": ["owner", "admin", "member", "viewer"],
};

export function canTeamAction(role: TeamRole, action: TeamAction) {
    return MATRIX[action]?.includes(role) ?? false;
}

/**
 * 同级 admin 保护。放在这里而不是各服务里现写 `actor.role === "admin" && target.role === "admin"`：
 * 散在调用处的话，哪天想改成「admin 可以互相移除」就得把每一处都找齐，漏一处就是一条静默的旁路。
 */
export function assertCanManageMember(actorRole: TeamRole, targetRole: TeamRole) {
    if (!canTeamAction(actorRole, "member.manage")) throw fail("团队内权限不足", 403, "TEAM_FORBIDDEN");
    if (actorRole === "admin" && targetRole === "admin") throw fail("admin 不能操作同级 admin", 403, "TEAM_FORBIDDEN");
}

/**
 * 团队内鉴权的唯一入口。参数是动作而不是角色数组：
 * 传数组等于把权限规则复制到调用处，改了 MATRIX 也不会生效，权限收紧会被静默丢弃。
 */
export async function requireTeamRole(userId: string, teamId: string, action: TeamAction, options: { write?: boolean } = {}) {
    const team = await repo(Team).findOneBy({ id: teamId });
    const member = team ? await repo(TeamMember).findOneBy({ teamId, userId }) : null;
    // 不存在与非成员都返回 404，避免用团队 id 探测别人的团队是否存在。
    if (!team || !member) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    if (member.status !== "active") throw fail("你在该团队中的状态已被挂起", 403, "TEAM_MEMBER_SUSPENDED");
    // 停用只掐写入：成员还得能把自己的历史流水查出来对账，否则停用等于销毁证据。
    if (options.write && team.status !== "active") throw fail("团队已被平台停用", 403, "TEAM_DISABLED");
    if (!canTeamAction(member.role, action)) throw fail("团队内权限不足", 403, "TEAM_FORBIDDEN");
    return { team, member, role: member.role };
}
