import { shareApi, isShareGone, type ShareSession } from "@/services/api/share";
import { useShareStore } from "@/stores/use-share-store";

/**
 * 访客会话：用明文 token 向服务端换取 guest 凭据。
 *
 * 前端不自报身份——昵称、actorId 一律由服务端在换取时给出。刷新页面时把上一枚 guest 令牌
 * 原样回传，服务端据此决定是否沿用同一个访客身份；沿用与否的判断权始终在服务端。
 * 令牌只存 sessionStorage：它是短期凭据，不该跨标签页、跨会话留存。
 */

const STORAGE_PREFIX = "infinite-canvas:share_session:";

type StoredSession = { token: string; expiresAt: string };

function storageKey(token: string) {
    return `${STORAGE_PREFIX}${token}`;
}

function readStored(token: string): StoredSession | null {
    try {
        const raw = sessionStorage.getItem(storageKey(token));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as StoredSession;
        // 过期的凭据没有回传价值，直接丢掉，让服务端重新分配。
        if (!parsed.token || (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now())) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeStored(token: string, session: ShareSession) {
    try {
        sessionStorage.setItem(storageKey(token), JSON.stringify({ token: session.token, expiresAt: session.expiresAt } satisfies StoredSession));
    } catch {
        // 隐私模式下 sessionStorage 可能不可写，退化成「每次刷新换一个访客身份」，功能不受影响。
    }
}

export function clearStoredSession(token: string) {
    try {
        sessionStorage.removeItem(storageKey(token));
    } catch {
        /* 同上，写不进去也就删不掉，忽略。 */
    }
}

/** 换取访客会话并写入 store。失效（404）时进入终态，不重试也不影响账号登录态。 */
export async function openShareSession(token: string) {
    const store = useShareStore.getState();
    store.begin(token);
    try {
        const session = await shareApi.createSession(token, readStored(token)?.token || "");
        writeStored(token, session);
        useShareStore.getState().applySession(session);
        return session;
    } catch (error) {
        clearStoredSession(token);
        if (isShareGone(error)) {
            useShareStore.getState().markGone("链接不存在或已失效");
            return null;
        }
        useShareStore.getState().setStatus("error", error instanceof Error ? error.message : "打开分享画布失败");
        return null;
    }
}

/** 续期：短期令牌到点前重新换一次，长时间停留在页面上也不会掉线。 */
export async function refreshShareSession() {
    const { token } = useShareStore.getState();
    if (!token) return null;
    try {
        const session = await shareApi.createSession(token, readStored(token)?.token || "");
        writeStored(token, session);
        useShareStore.setState({ guestToken: session.token, role: session.role, allowClone: session.allowClone });
        return session;
    } catch (error) {
        if (isShareGone(error)) {
            clearStoredSession(token);
            useShareStore.getState().markGone("链接已失效");
        }
        return null;
    }
}

/**
 * 登录后继续克隆的跳板。分享页本身不在登录守卫内，登录弹窗是全站共用的，
 * 因此把「登录后要接着做什么」记在 sessionStorage 里，登录成功回到分享页时再消费。
 */
const PENDING_CLONE_KEY = "infinite-canvas:share_pending_clone";

export function rememberPendingClone(token: string) {
    try {
        sessionStorage.setItem(PENDING_CLONE_KEY, token);
    } catch {
        /* 存不下就退化成「登录后需要再点一次」。 */
    }
}

export function takePendingClone(token: string) {
    try {
        const pending = sessionStorage.getItem(PENDING_CLONE_KEY);
        if (pending !== token) return false;
        sessionStorage.removeItem(PENDING_CLONE_KEY);
        return true;
    } catch {
        return false;
    }
}
