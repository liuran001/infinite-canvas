import { serverRequest } from "@/services/api/server";
import type { ServerApiFormat, ServerCapability, ServerRole, ServerSettings, ServerUser } from "@/stores/use-server-store";
import type { CanvasNodeData } from "@/types/canvas";

export type AdminUserStatus = "active" | "ban";

export type AdminUser = {
    id: string;
    username: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    role: ServerRole;
    credits: number;
    storageQuota: number;
    storageUsed: number;
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

/** vision 表示模型能直接读图，模型名看不出来这件事，只能管理员标注；服务端据此决定要不要给 Agent 下发看图工具。 */
export type AdminChannelModel = { name: string; label?: string; capability: ServerCapability; vision?: boolean };

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

/** 模型算力点成本，qualityCredits 按画质档位在基础价上叠加。 */
export type ModelCost = ServerSettings["modelChannel"]["modelCosts"][number];

/** 联网搜索服务商，与服务端 search 服务里注册的 PROVIDERS 一一对应。 */
export type AdminSearchProvider = "exa" | "tavily";

/** 一条联网搜索服务，结构与模型渠道对齐：可以配多条，按 weight 从高到低依次尝试，前面的失败就自动换下一条。 */
export type AdminSearchService = {
    provider: AdminSearchProvider;
    name: string;
    /** 留空表示用服务商官方地址，填了走自建代理或镜像。 */
    baseUrl: string;
    apiKey: string;
    weight: number;
    enabled: boolean;
};

/** public 与前端公开配置同构；private 只有管理后台可见，密钥字段读取时被服务端抹成空串。 */
export type AdminSettings = {
    public: ServerSettings;
    private: {
        channels: AdminChannel[];
        promptSync: { enabled: boolean; cron: string };
        auth: { linuxDo: { clientId: string; clientSecret: string } };
        /** 联网搜索配置，services 里的 apiKey 与渠道密钥一样：读取时被服务端抹空，回传空串表示保持不变。 */
        search: { enabled: boolean; maxResults: number; services: AdminSearchService[] };
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

/**
 * 平台后台视角的团队。与团队前台的 Team 刻意不共用类型：那边有 myRole（「我在这个团队里的角色」），
 * 而平台管理员一个团队都不在，借用过来就得给他编一个角色出来，编出来的角色迟早会被别处当成真的成员身份。
 * storageUsed 由服务端按文件对象实时聚合，storageQuota 是这个团队的上限，都是字节。
 */
export type AdminTeam = {
    id: string;
    name: string;
    description: string;
    avatarUrl: string;
    ownerId: string;
    credits: number;
    storageQuota: number;
    storageUsed: number;
    memberLimit: number;
    memberCount: number;
    status: "active" | "disabled" | "disbanded";
    createdAt: string;
    updatedAt: string;
};

export type AdminQuery = { keyword?: string; category?: string; type?: string; tag?: string[]; page?: number; pageSize?: number };

/** 内容审查列表的额外筛选项，`search()` 会一并拼进查询串。 */
export type AdminReviewQuery = AdminQuery & { userId?: string; status?: string; kind?: string };

export type AdminOwner = { userId: string; username: string; displayName: string };

export type AdminFile = { id: string; kind: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number; createdAt: string };

export type AdminJob = AdminOwner & {
    id: string;
    kind: "image" | "video" | "audio";
    status: "pending" | "running" | "succeeded" | "failed" | "canceled";
    model: string;
    prompt: string;
    credits: number;
    progress: number;
    error: string;
    outputs: AdminFile[];
    createdAt: string;
    finishedAt: string;
};

export type AdminJobDetail = AdminJob & { clientJobId: string; params: Record<string, unknown>; context: Record<string, unknown>; inputs: AdminFile[]; updatedAt: string };

export type AdminProject = AdminOwner & { projectId: string; title: string; nodeCount: number; revision: number; deleted: boolean; createdAt: string; updatedAt: string };

/** 注册邀请码。usedCount 到 maxUses 就自动作废，credits 是兑换成功后额外赠送的算力点。 */
export type AdminInvite = {
    code: string;
    maxUses: number;
    usedCount: number;
    credits: number;
    enabled: boolean;
    note: string;
    createdAt: string;
};

/** 一次兑换记录。usedAt 就是用掉的时刻；credits 是当时实际送出去的点数，码上的 credits 后来改过也不影响这份留档。 */
export type AdminInviteUse = { code: string; userId: string; username: string; displayName: string; credits: number; usedAt: string };

/**
 * 批量生成的入参，count 是这次要生成几个码，其余字段所有新码共用。
 * code 是可选的「指定码值」：填了就只生成这一个码，服务端会校验字母表、长度并拒绝与已有码重复；留空维持随机生成。
 */
export type AdminInviteBatch = { count: number; maxUses: number; credits: number; note: string; code?: string };

export type AdminProjectDetail = AdminProject & { data: { nodes?: CanvasNodeData[] } };

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
    setUserQuota: (id: string, quota: number) => serverRequest<AdminUser>(`/admin/users/${id}/quota`, post({ quota }), "调整云空间配额失败"),
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

    jobs: (query: AdminReviewQuery) => serverRequest<{ items: AdminJob[]; total: number }>(`/admin/jobs${search(query)}`, {}, "读取生成记录失败"),
    job: (id: string) => serverRequest<AdminJobDetail>(`/admin/jobs/${id}`, {}, "读取生成详情失败"),
    projects: (query: AdminReviewQuery) => serverRequest<{ items: AdminProject[]; total: number }>(`/admin/projects${search(query)}`, {}, "读取画布列表失败"),
    project: (userId: string, projectId: string) => serverRequest<AdminProjectDetail>(`/admin/projects/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}`, {}, "读取画布详情失败"),
    files: (query: AdminReviewQuery) => serverRequest<{ items: Array<AdminFile & AdminOwner>; total: number }>(`/admin/files${search(query)}`, {}, "读取用户文件失败"),

    invites: (query: AdminQuery) => serverRequest<{ items: AdminInvite[]; total: number }>(`/admin/invites${search(query)}`, {}, "读取邀请码失败"),
    /** 一次生成多个码，返回的就是这批新码，前端拿去给管理员复制。 */
    createInvites: (batch: AdminInviteBatch) => serverRequest<AdminInvite[]>("/admin/invites", post(batch), "生成邀请码失败"),
    /** 只改传进来的字段，PATCH 语义：没传的保持原样。 */
    saveInvite: (code: string, patch: Partial<Pick<AdminInvite, "enabled" | "maxUses" | "credits" | "note">>) =>
        serverRequest<AdminInvite>(`/admin/invites/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify(patch) }, "保存邀请码失败"),
    deleteInvite: (code: string) => serverRequest<boolean>(`/admin/invites/${encodeURIComponent(code)}`, remove, "删除邀请码失败"),
    inviteUses: (code: string) => serverRequest<{ items: AdminInviteUse[]; total: number }>(`/admin/invites/${encodeURIComponent(code)}/uses`, {}, "读取邀请码使用记录失败"),

    teams: (query: AdminQuery) => serverRequest<{ items: AdminTeam[]; total: number }>(`/admin/teams${search(query)}`, {}, "读取团队列表失败"),
    setTeamCredits: (id: string, credits: number, remark = "") => serverRequest<unknown>(`/admin/teams/${id}/credits`, post({ credits, remark }), "调整团队积分失败"),
    /**
     * 单团队配额。走 PATCH /admin/teams/:id 而不是像用户那样一个独立的 /quota 端点：
     * 服务端把配额和成员上限、状态放在同一个 patch 里校验，独立端点会多出一条绕过那套校验的路径。
     * 单位是字节，传绝对值。
     */
    setTeamQuota: (id: string, storageQuota: number) => serverRequest<AdminTeam>(`/admin/teams/${id}`, { method: "PATCH", body: JSON.stringify({ storageQuota }) }, "调整团队云空间配额失败"),
    updateTeam: (id: string, patch: { status?: string; memberLimit?: number; name?: string }) => serverRequest<AdminTeam>(`/admin/teams/${id}`, { method: "PATCH", body: JSON.stringify(patch) }, "保存团队失败"),
};
