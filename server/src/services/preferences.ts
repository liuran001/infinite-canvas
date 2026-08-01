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
