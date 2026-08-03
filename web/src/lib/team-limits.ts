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
 * limit 为 0 表示不限，语义跟着服务端走（teams.ts 里写的是 `limit > 0 && ...`，0 根本不参与判定）。
 * 这里必须和它一字不差：把 0 理解成「一个都不许建」的话，管理员填 0 想放开限制，
 * 前端反而会把所有人的创建入口锁死——而服务端那边其实是放行的，用户连报错都看不到，只看到按钮是灰的。
 *
 * 负数或 NaN（配置异常）同样按不限处理，不能因为一个坏配置就把创建入口锁死。
 */
export function teamCreateBlockedReason(teams: Team[], userId: string, limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) return "";
    const owned = ownedTeamCount(teams, userId);
    if (owned < limit) return "";
    return `每个用户最多创建 ${limit} 个团队，你已经创建了 ${owned} 个。解散不再需要的团队后可以再建，或通过邀请码加入别人的团队。`;
}
