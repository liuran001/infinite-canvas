const PREFIX = "infinite-canvas:share-billing-consent:";
type Prompt = (shareId: string) => Promise<boolean>;
let prompt: Prompt | null = null;

export function registerShareBillingPrompt(next: Prompt | null) {
    prompt = next;
    return () => {
        if (prompt === next) prompt = null;
    };
}

export async function ensureShareBillingConsent(input: { shareId: string; selfPayRequired: boolean; userId?: string; anonymous?: boolean; ownerPays?: boolean }) {
    if (!input.selfPayRequired) return false;
    if (input.anonymous && input.ownerPays) return true;
    if (!input.userId) throw new Error("请先登录后再使用个人算力点");
    const key = `${PREFIX}${input.shareId}:${input.userId}`;
    if (localStorage.getItem(key) === "1") return true;
    if (!prompt || !(await prompt(input.shareId))) throw new DOMException("用户取消了本次操作", "AbortError");
    localStorage.setItem(key, "1");
    return true;
}
