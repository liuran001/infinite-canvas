import { repo } from "../db/data-source";
import { Team, TeamMember, type TeamRole } from "../db/entities";
import { fail } from "../lib/errors";

export type { TeamRole };
export type TeamAction = "team.read" | "team.update" | "team.disband" | "team.transfer" | "invite.manage" | "member.manage" | "member.promoteAdmin" | "credits.spend" | "logs.readAll" | "logs.readMine";

/** 权限矩阵的唯一定义。路由与服务一律查这张表，不允许自己比较 role。 */
const MATRIX: Record<TeamAction, TeamRole[]> = {
    "team.read": ["owner", "admin", "member", "viewer"],
    "team.update": ["owner", "admin"],
    "team.disband": ["owner"],
    "team.transfer": ["owner"],
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

export async function requireTeamRole(userId: string, teamId: string, allow: TeamRole[], options: { write?: boolean } = {}) {
    const team = await repo(Team).findOneBy({ id: teamId });
    const member = team ? await repo(TeamMember).findOneBy({ teamId, userId }) : null;
    // 不存在与非成员都返回 404，避免用团队 id 探测别人的团队是否存在。
    if (!team || !member) throw fail("团队不存在", 404, "TEAM_NOT_FOUND");
    if (member.status !== "active") throw fail("你在该团队中的状态已被挂起", 403, "TEAM_MEMBER_SUSPENDED");
    // 停用只掐写入：成员还得能把自己的历史流水查出来对账，否则停用等于销毁证据。
    if (options.write && team.status !== "active") throw fail("团队已被平台停用", 403, "TEAM_DISABLED");
    if (!allow.includes(member.role)) throw fail("团队内权限不足", 403, "TEAM_FORBIDDEN");
    return { team, member, role: member.role };
}
