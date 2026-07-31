import { serverRequest } from "@/services/api/server";
import type { ServerApiFormat, ServerCapability, ServerRole, ServerSettings, ServerUser } from "@/stores/use-server-store";

export type AdminUserStatus = "active" | "ban";

export type AdminUser = {
    id: string;
    username: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    role: ServerRole;
    credits: number;
    affCode: string;
    affCount: number;
    linuxDoId: string;
    status: AdminUserStatus;
    lastLoginAt: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminCreditLogType = "admin_adjust" | "ai_consume" | "ai_refund";

export type AdminCreditLog = {
    id: string;
    userId: string;
    type: AdminCreditLogType;
    amount: number;
    balance: number;
    relatedId: string;
    remark: string;
    extra: string;
    createdAt: string;
};

export type AdminChannelModel = { name: string; capability: ServerCapability };

export type AdminChannel = {
    apiFormat: ServerApiFormat;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: AdminChannelModel[];
    weight: number;
    enabled: boolean;
    remark: string;
};

/** public 与前端公开配置同构；private 只有管理后台可见，密钥字段读取时被服务端抹成空串。 */
export type AdminSettings = {
    public: ServerSettings;
    private: {
        channels: AdminChannel[];
        promptSync: { enabled: boolean; cron: string };
        auth: { linuxDo: { clientId: string; clientSecret: string } };
    };
};

export type AdminPrompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    description: string;
    referenceImageUrls: string[];
    tags: string[];
    category: string;
    preview: string;
    author: string;
    sourceUrl: string;
    options: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export type AdminPromptCategory = {
    category: string;
    name: string;
    description: string;
    githubUrl: string;
    sourceUrl: string;
    remote: boolean;
    enabled: boolean;
    lastSyncedAt: string;
    lastError: string;
    updatedAt: string;
};

export type AdminSyncResult = { category: string; count: number; success?: boolean; error?: string };

export type AdminAsset = {
    id: string;
    title: string;
    type: "text" | "image";
    coverUrl: string;
    tags: string[];
    category: string;
    description: string;
    content: string;
    url: string;
    createdAt: string;
    updatedAt: string;
};

export type AdminQuery = { keyword?: string; category?: string; type?: string; tag?: string[]; page?: number; pageSize?: number };

function search(query: AdminQuery) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (Array.isArray(value)) value.filter(Boolean).forEach((item) => params.append(key, item));
        else if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
}

function post(body: unknown): RequestInit {
    return { method: "POST", body: JSON.stringify(body) };
}

const remove: RequestInit = { method: "DELETE" };

export const adminApi = {
    login: (username: string, password: string) => serverRequest<{ token: string; user: ServerUser }>("/admin/login", post({ username, password }), "管理员登录失败"),

    users: (query: AdminQuery) => serverRequest<{ items: AdminUser[]; total: number }>(`/admin/users${search(query)}`, {}, "读取用户列表失败"),
    saveUser: (user: Partial<AdminUser> & { password?: string }) => serverRequest<AdminUser>("/admin/users", post(user), "保存用户失败"),
    setUserCredits: (id: string, credits: number) => serverRequest<AdminUser>(`/admin/users/${id}/credits`, post({ credits }), "调整算力点失败"),
    deleteUser: (id: string) => serverRequest<boolean>(`/admin/users/${id}`, remove, "删除用户失败"),

    creditLogs: (query: AdminQuery) => serverRequest<{ items: AdminCreditLog[]; total: number }>(`/admin/credit-logs${search(query)}`, {}, "读取算力点流水失败"),
    saveCreditLog: (log: Partial<AdminCreditLog>) => serverRequest<AdminCreditLog>("/admin/credit-logs", post(log), "保存算力点流水失败"),
    deleteCreditLog: (id: string) => serverRequest<boolean>(`/admin/credit-logs/${id}`, remove, "删除算力点流水失败"),

    settings: () => serverRequest<AdminSettings>("/admin/settings", {}, "读取系统设置失败"),
    saveSettings: (settings: AdminSettings) => serverRequest<AdminSettings>("/admin/settings", post(settings), "保存系统设置失败"),
    channelModels: (index: number | undefined, channel: AdminChannel) => serverRequest<string[]>("/admin/settings/channel-models", post({ index, channel }), "拉取模型列表失败"),
    channelTest: (index: number | undefined, channel: AdminChannel, model: string) => serverRequest<string>("/admin/settings/channel-test", post({ index, channel, model }), "连通性测试失败"),

    prompts: (query: AdminQuery) => serverRequest<{ items: AdminPrompt[]; tags: string[]; categories: string[]; total: number }>(`/admin/prompts${search(query)}`, {}, "读取提示词失败"),
    savePrompt: (prompt: Partial<AdminPrompt>) => serverRequest<AdminPrompt>("/admin/prompts", post(prompt), "保存提示词失败"),
    deletePrompt: (id: string) => serverRequest<boolean>(`/admin/prompts/${id}`, remove, "删除提示词失败"),
    deletePrompts: (ids: string[]) => serverRequest<boolean>("/admin/prompts/batch-delete", post({ ids }), "批量删除提示词失败"),

    promptCategories: () => serverRequest<AdminPromptCategory[]>("/admin/prompt-categories", {}, "读取提示词分类失败"),
    savePromptCategory: (category: Partial<AdminPromptCategory>) => serverRequest<AdminPromptCategory>("/admin/prompt-categories", post(category), "保存提示词分类失败"),
    deletePromptCategory: (category: string) => serverRequest<boolean>(`/admin/prompt-categories/${encodeURIComponent(category)}`, remove, "删除提示词分类失败"),
    syncPromptCategories: (category?: string) => serverRequest<AdminSyncResult[]>("/admin/prompt-categories/sync", post({ category }), "同步提示词失败"),

    assets: (query: AdminQuery) => serverRequest<{ items: AdminAsset[]; tags: string[]; total: number }>(`/admin/assets${search(query)}`, {}, "读取素材失败"),
    saveAsset: (asset: Partial<AdminAsset>) => serverRequest<AdminAsset>("/admin/assets", post(asset), "保存素材失败"),
    deleteAsset: (id: string) => serverRequest<boolean>(`/admin/assets/${id}`, remove, "删除素材失败"),
};
