import type { Team } from "@/services/api/teams";

/**
 * 「还能不能再建一个团队」的判定，与服务端创建接口的限制同源。
 *
 * 抽成纯函数是因为这条规则要同时决定三件事：创建按钮禁不禁用、按钮上挂什么提示、提交前拦不拦。
 * 写在组件里的话，三处早晚各说各话——最典型的是按钮还亮着，点下去却被服务端拒掉，
 * 用户只看到一句原始的接口错误，完全不知道自己撞的是「每人最多建几个」这条线。
 *
 * 只算自己创建的（ownerId 是自己），被别人邀请加入的不计入：那些团队不是这个用户占的名额。
 */
export function ownedTeamCount(teams: Team[], userId: string) {
    if (!userId) return 0;
    return teams.filter((team) => team.ownerId === userId && team.status !== "disbanded").length;
}

/**
 * 达到上限时返回可直接展示的中文原因，还能建就返回空串。
 *
 * limit 为 0 表示管理员把创建功能整个关掉了，文案要和「你建满了」区分开：
 * 前者再删团队也不会解锁，让用户去删团队腾名额是白费力气。
 * limit 为负数（配置异常）按不限处理，不能因为一个坏配置就把所有人的创建入口锁死。
 */
export function teamCreateBlockedReason(teams: Team[], userId: string, limit: number) {
    if (!Number.isFinite(limit) || limit < 0) return "";
    if (limit === 0) return "平台当前不允许自行创建团队，你仍然可以通过邀请码加入别人的团队。";
    const owned = ownedTeamCount(teams, userId);
    if (owned < limit) return "";
    return `每个用户最多创建 ${limit} 个团队，你已经创建了 ${owned} 个。解散不再需要的团队后可以再建，或通过邀请码加入别人的团队。`;
}
