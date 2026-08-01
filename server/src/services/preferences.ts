import { repo } from "../db/data-source";
import { User } from "../db/entities";
import { fail, now } from "../lib/errors";

type Preferences = Record<string, unknown>;

/** 偏好内容由前端定义，服务端只负责整体存取，不解释具体字段。 */
export async function getPreferences(userId: string): Promise<Preferences> {
    const user = await repo(User).findOneBy({ id: userId });
    if (!user?.preferences) return {};
    try {
        return JSON.parse(user.preferences) as Preferences;
    } catch {
        return {};
    }
}

export async function savePreferences(userId: string, preferences: Preferences): Promise<Preferences> {
    const users = repo(User);
    const user = await users.findOneBy({ id: userId });
    if (!user) throw fail("用户不存在");
    user.preferences = JSON.stringify(preferences || {});
    user.updatedAt = now();
    await users.save(user);
    return preferences;
}

/**
 * 「Agent 生成默认设置」这几项是唯一由服务端也要读懂的偏好：agent 调生成工具时基本只想得起提示词，
 * 其余参数得按用户配好的规格补齐，不然用户在偏好里配的东西等于摆设。
 * 字段名与 web/src/stores/use-config-store.ts 的 AiConfig 一一对应，改名要两边一起改；
 * 除这几个键之外的偏好仍然只做整体存取，服务端不解释。
 */
export type AgentGenerationPreference = { imageModel: string; imageSize: string; imageQuality: string; imageCount: number; imageBackground: string; textModel: string };

/** 前端用空串和 "auto" 表示「跟随全站默认」，这里一律收敛成空串，免得把字面量 auto 当成真尺寸发给上游。 */
function preferredText(preferences: Preferences, key: string) {
    const value = typeof preferences[key] === "string" ? (preferences[key] as string).trim() : "";
    return value.toLowerCase() === "auto" ? "" : value;
}

export async function getAgentGenerationPreference(userId: string): Promise<AgentGenerationPreference> {
    const preferences = await getPreferences(userId);
    const count = Number(preferredText(preferences, "agentImageCount"));
    return {
        imageModel: preferredText(preferences, "agentImageModel"),
        imageSize: preferredText(preferences, "agentImageSize"),
        imageQuality: preferredText(preferences, "agentImageQuality"),
        // 张数在前端存的是字符串，解析不出正整数就当没配过，交给调用方按系统默认来。
        imageCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
        imageBackground: preferredText(preferences, "agentImageBackground"),
        textModel: preferredText(preferences, "agentTextModel"),
    };
}
