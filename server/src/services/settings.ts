import { config } from "../config";
import { repo } from "../db/data-source";
import { DEFAULT_STORAGE_QUOTA, Setting } from "../db/entities";
import { fail, now } from "../lib/errors";

export type ApiFormat = "openai" | "gemini" | "ark";
export type ModelCapability = "image" | "video" | "text" | "audio";

export type ChannelModel = {
    name: string;
    /** 前端展示名，留空时用 name。用来把 gemini-3.1-flash-image 这类内部名展示成 Nano Banana 2。 */
    label?: string;
    capability: ModelCapability;
    /**
     * 是否支持视觉输入（能直接读图）。模型名看不出来这件事，只能由管理员标注。
     * 没标注的模型收到图片会直接报错，所以 Agent 的看图工具与图片附件都以这个标注为准。
     */
    vision?: boolean;
};

/**
 * 模型算力点成本。qualityCredits 按画质档位在基础价上叠加，
 * 用于 2K / 4K 这类同一模型但成本不同的情况，例如 { medium: 2, high: 5 }。
 */
export type ModelCost = { model: string; credits: number; qualityCredits?: Record<string, number> };

export type ModelChannel = {
    apiFormat: ApiFormat;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: ChannelModel[];
    weight: number;
    enabled: boolean;
    remark: string;
};


/** 前端在服务器模式下靠 apiFormat 决定文本请求走哪条代理，靠 capability 过滤模型选择器。 */
export type PublicModel = { name: string; label: string; apiFormat: ApiFormat; capability: ModelCapability; vision: boolean };

export type SearchProviderName = "exa" | "tavily";

/**
 * 一条联网搜索服务。刻意做成和模型渠道同构：多条 + enabled + weight + 留空用默认地址，
 * 管理员的心智模型和后台交互都不用再学一套。
 * baseUrl 留空表示用服务商官方地址，填了就走自建代理或镜像。
 */
export type SearchService = {
    provider: SearchProviderName;
    /** 后台列表里的显示名，同一家配多把 key 时用来区分。 */
    name: string;
    baseUrl: string;
    apiKey: string;
    /** 优先级，数字大的先用。搜索要的是「这家挂了换下一家」，不是按权重分流，所以是排序而不是随机。 */
    weight: number;
    enabled: boolean;
};

export type PublicSetting = {
    modelChannel: {
        models: PublicModel[];
        modelCosts: ModelCost[];
        defaultModel: string;
        defaultImageModel: string;
        defaultVideoModel: string;
        defaultTextModel: string;
        defaultAudioModel: string;
        systemPrompt: string;
        allowCustomChannel: boolean;
    };
    /** requireInvite 打开后，密码注册与第三方登录建号都必须带有效邀请码；前端据此决定要不要显示邀请码输入框。 */
    auth: { allowRegister: boolean; requireInvite: boolean; linuxDo: { enabled: boolean } };
    /** defaultQuota 是新账号的云空间上限（字节），已有账号不受影响。 */
    storage: { remoteEnabled: boolean; defaultQuota: number };
    /** 各类功能入口的总开关。配了模型也可以先不对外开放，关掉后所有用户都看不到对应入口。 */
    capabilities: Record<ModelCapability, boolean>;
    /**
     * 画布 Agent。model 留空表示用 defaultTextModel；
     * titleModel 是专门用来生成会话标题的模型，和 model 分开配：标题只有十来个字，
     * 用主模型跑一次纯属浪费，留空则回落到「截断用户第一句话」，不影响发消息。
     * searchEnabled 由「开关 + 至少有一条可用的搜索服务」推导，前端据此决定要不要展示联网搜索能力，
     * 没有可用服务时后端也不会把 web_search、read_webpage 工具下发给模型。
     */
    agent: { enabled: boolean; model: string; titleModel: string; maxRounds: number; searchEnabled: boolean };
};

export type PrivateSetting = {
    channels: ModelChannel[];
    promptSync: { enabled: boolean; cron: string };
    auth: { linuxDo: { clientId: string; clientSecret: string } };
    /** 联网搜索配置，只有管理员能看；services 里的 apiKey 与渠道密钥一样读取时脱敏、留空表示保持不变。 */
    search: { enabled: boolean; maxResults: number; services: SearchService[] };
};

export type Settings = { public: PublicSetting; private: PrivateSetting };

const VIDEO_KEYWORDS = ["seedance", "video", "sora", "veo", "kling", "wan", "hailuo"];
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

const isVideoModel = (name: string) => VIDEO_KEYWORDS.some((keyword) => name.toLowerCase().includes(keyword));
const isAudioModel = (name: string) => AUDIO_KEYWORDS.some((keyword) => name.toLowerCase().includes(keyword));
const isImageModel = (name: string) => IMAGE_KEYWORDS.some((keyword) => name.toLowerCase().includes(keyword));

/** 新加模型时按名称猜一个默认能力，管理员可在后台改。 */
export function guessCapability(name: string): ModelCapability {
    if (isVideoModel(name)) return "video";
    if (isAudioModel(name)) return "audio";
    if (isImageModel(name)) return "image";
    return "text";
}

function normalizeApiFormat(value: unknown): ApiFormat {
    return value === "gemini" || value === "ark" ? value : "openai";
}

function normalizeChannelModels(models: Array<string | Partial<ChannelModel>> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const label = typeof item === "string" ? "" : (item.label || "").trim();
        const vision = typeof item === "string" ? false : item.vision === true;
        result.push({ name, capability, ...(label ? { label } : {}), ...(vision ? { vision: true } : {}) });
    }
    return result;
}

function normalizeChannel(channel: Partial<ModelChannel>): ModelChannel {
    return {
        apiFormat: normalizeApiFormat(channel.apiFormat),
        name: (channel.name || "").trim(),
        baseUrl: (channel.baseUrl || "").trim(),
        apiKey: channel.apiKey || "",
        models: normalizeChannelModels(channel.models),
        weight: channel.weight && channel.weight > 0 ? channel.weight : 1,
        enabled: channel.enabled !== false,
        remark: channel.remark || "",
    };
}

/** 当前选择仍然有效就保留，否则按能力回落到第一个匹配模型。 */
function repairDefaultModel(current: string, models: PublicModel[], capability: ModelCapability) {
    const value = (current || "").trim();
    if (models.some((model) => model.name === value)) return value;
    return models.find((model) => model.capability === capability)?.name || models[0]?.name || "";
}

function normalizeSearchService(service: Partial<SearchService>): SearchService {
    return {
        provider: service.provider === "tavily" ? "tavily" : "exa",
        name: (service.name || "").trim(),
        baseUrl: (service.baseUrl || "").trim().replace(/\/+$/, ""),
        apiKey: service.apiKey || "",
        weight: service.weight && service.weight > 0 ? service.weight : 1,
        enabled: service.enabled !== false,
    };
}

function normalizePrivate(setting: Partial<PrivateSetting> | undefined): PrivateSetting {
    return {
        channels: (setting?.channels || []).map(normalizeChannel),
        promptSync: { enabled: setting?.promptSync?.enabled !== false, cron: setting?.promptSync?.cron?.trim() || "0 4 * * *" },
        auth: { linuxDo: { clientId: setting?.auth?.linuxDo?.clientId?.trim() || "", clientSecret: setting?.auth?.linuxDo?.clientSecret || "" } },
        search: {
            enabled: setting?.search?.enabled !== false,
            maxResults: Math.min(20, Math.max(1, Number(setting?.search?.maxResults) || 5)),
            services: (setting?.search?.services || []).map(normalizeSearchService),
        },
    };
}

function normalizePublic(setting: Partial<PublicSetting> | undefined, privateSetting: PrivateSetting): PublicSetting {
    const channel = setting?.modelChannel;
    const seen = new Set<string>();
    const models: PublicModel[] = [];
    for (const item of privateSetting.channels.filter((entry) => entry.enabled)) {
        for (const model of item.models) {
            if (seen.has(model.name)) continue;
            seen.add(model.name);
            models.push({ name: model.name, label: model.label || model.name, apiFormat: item.apiFormat, capability: model.capability, vision: model.vision === true });
        }
    }
    return {
        modelChannel: {
            models,
            modelCosts: (channel?.modelCosts || [])
                .map((cost) => ({
                    model: String(cost.model || "").trim(),
                    credits: Math.max(0, Number(cost.credits) || 0),
                    qualityCredits: Object.fromEntries(Object.entries(cost.qualityCredits || {}).map(([quality, value]) => [quality, Math.max(0, Number(value) || 0)])),
                }))
                .filter((cost) => cost.model),
            defaultModel: repairDefaultModel(channel?.defaultModel || "", models, "text"),
            defaultImageModel: repairDefaultModel(channel?.defaultImageModel || "", models, "image"),
            defaultVideoModel: repairDefaultModel(channel?.defaultVideoModel || "", models, "video"),
            defaultTextModel: repairDefaultModel(channel?.defaultTextModel || "", models, "text"),
            defaultAudioModel: repairDefaultModel(channel?.defaultAudioModel || "", models, "audio"),
            systemPrompt: channel?.systemPrompt || "",
            allowCustomChannel: channel?.allowCustomChannel !== false,
        },
        auth: {
            allowRegister: setting?.auth?.allowRegister !== false,
            // 默认关闭：这是给「先攒一批码再放开」准备的开关，默认打开会让全新部署直接注册不进来。
            requireInvite: setting?.auth?.requireInvite === true,
            linuxDo: { enabled: Boolean(setting?.auth?.linuxDo?.enabled) },
        },
        storage: {
            remoteEnabled: setting?.storage?.remoteEnabled !== false,
            defaultQuota: Math.max(0, Number(setting?.storage?.defaultQuota) || DEFAULT_STORAGE_QUOTA),
        },
        capabilities: {
            image: setting?.capabilities?.image !== false,
            text: setting?.capabilities?.text !== false,
            video: setting?.capabilities?.video !== false,
            audio: setting?.capabilities?.audio !== false,
        },
        agent: {
            enabled: setting?.agent?.enabled !== false,
            // 只认 text 能力的模型，否则会把生图模型误当成 agent 主模型。
            model: models.some((model) => model.name === setting?.agent?.model && model.capability === "text") ? String(setting?.agent?.model).trim() : "",
            // 标题模型同样只认 text；配了个已下线的模型时留空回落到截断，而不是让每次发消息都去撞一个不存在的渠道。
            titleModel: models.some((model) => model.name === setting?.agent?.titleModel && model.capability === "text") ? String(setting?.agent?.titleModel).trim() : "",
            maxRounds: Math.min(50, Math.max(1, Number(setting?.agent?.maxRounds) || 25)),
            searchEnabled: privateSetting.search.enabled && privateSetting.search.services.some((service) => service.enabled && service.apiKey.trim()),
        },
    };
}

function normalizeSettings(settings: Partial<Settings>): Settings {
    const privateSetting = normalizePrivate(settings.private);
    return { private: privateSetting, public: normalizePublic(settings.public, privateSetting) };
}

async function readSettings(): Promise<Settings> {
    const rows = await repo(Setting).find();
    const parse = <T>(key: string): T | undefined => {
        const value = rows.find((row) => row.key === key)?.value;
        if (!value) return undefined;
        try {
            return JSON.parse(value) as T;
        } catch {
            return undefined;
        }
    };
    return normalizeSettings({ public: parse<PublicSetting>("public"), private: parse<PrivateSetting>("private") });
}

export async function getSettings() {
    return readSettings();
}

export async function publicSettings() {
    return (await readSettings()).public;
}

/** 后台读取时抹掉密钥，避免明文回传前端。 */
function hideSecrets(settings: Settings): Settings {
    return {
        public: settings.public,
        private: {
            ...settings.private,
            channels: settings.private.channels.map((channel) => ({ ...channel, apiKey: "" })),
            auth: { linuxDo: { ...settings.private.auth.linuxDo, clientSecret: "" } },
            search: { ...settings.private.search, services: settings.private.search.services.map((service) => ({ ...service, apiKey: "" })) },
        },
    };
}

export async function adminSettings() {
    return hideSecrets(await readSettings());
}

/** 前端回传空密钥表示「保持不变」，按名称+地址匹配旧记录补回。 */
function keepSecrets(next: Settings, saved: Settings): Settings {
    const channels = next.private.channels.map((channel, index) => {
        if (channel.apiKey.trim()) return channel;
        const matched = saved.private.channels.find((item) => item.name === channel.name && item.baseUrl === channel.baseUrl) || saved.private.channels[index];
        return { ...channel, apiKey: matched?.apiKey || "" };
    });
    const clientSecret = next.private.auth.linuxDo.clientSecret.trim() || saved.private.auth.linuxDo.clientSecret;
    // 多条搜索服务要按条目对应补密钥：先按「服务商+显示名」认人，认不出来再退回同一位置，否则调整顺序就会把 key 串到别人身上。
    const services = next.private.search.services.map((service, index) => {
        if (service.apiKey.trim()) return service;
        const matched = saved.private.search.services.find((item) => item.provider === service.provider && item.name === service.name) || saved.private.search.services[index];
        return { ...service, apiKey: matched?.apiKey || "" };
    });
    return {
        public: next.public,
        private: { ...next.private, channels, auth: { linuxDo: { ...next.private.auth.linuxDo, clientSecret } }, search: { ...next.private.search, services } },
    };
}

/**
 * 深合并：只有传进来的字段才覆盖已存配置。
 * 数组整体替换而不是逐项合并 —— 渠道、搜索服务这类列表要能删条目，合并的话删不掉。
 */
function mergeDeep<T>(base: T, patch: unknown): T {
    if (patch === undefined) return base;
    if (patch === null || Array.isArray(patch) || typeof patch !== "object") return patch as T;
    if (base === null || Array.isArray(base) || typeof base !== "object") return patch as T;
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        result[key] = mergeDeep((base as Record<string, unknown>)[key], value);
    }
    return result as T;
}

export async function saveSettings(input: Partial<Settings>) {
    const saved = await readSettings();
    // 先合到已存配置上再归一化：直接归一化 input 会把没传的字段填成默认值，
    // 于是「只改一个开关」的请求会把渠道、密钥等其余配置一起清空。
    const patched = mergeDeep(saved, input) as Partial<Settings>;
    // 补回「留空表示不变」的密钥后要再归一化一次：
    // agent.searchEnabled 是从搜索 key 推导出来的，先补 key 再算才不会被误判成未配置。
    const merged = normalizeSettings(keepSecrets(normalizeSettings(patched), saved));
    const table = repo(Setting);
    await table.save([
        { key: "public", value: JSON.stringify(merged.public), updatedAt: now() },
        { key: "private", value: JSON.stringify(merged.private), updatedAt: now() },
    ]);
    return hideSecrets(merged);
}

/**
 * 单次调用的算力点成本。quality 命中 qualityCredits 时在基础价上叠加，
 * 用来给 2K / 4K 这种同模型不同成本的档位单独定价。
 */
export async function modelCost(model: string, quality?: string) {
    const settings = await publicSettings();
    const cost = settings.modelChannel.modelCosts.find((item) => item.model === model.trim());
    if (!cost) return 0;
    return cost.credits + (quality ? cost.qualityCredits?.[quality.trim()] || 0 : 0);
}

/**
 * 该模型是否被管理员标注为「支持视觉」。
 * 服务端所有和图片进上下文相关的门禁都以它为准：没标注的模型既拿不到看图工具，也不允许接收图片附件，
 * 否则一发图上游就直接报错，用户看到的是一串看不懂的上游错误。
 */
export function modelSupportsVision(settings: PublicSetting, model: string) {
    const name = model.trim();
    return settings.modelChannel.models.some((item) => item.name === name && item.vision);
}

/** 按权重随机挑一个支持该模型的可用渠道。 */
export async function selectModelChannel(model: string) {
    const settings = await getSettings();
    const name = model.trim();
    const channels = settings.private.channels.filter((channel) => channel.enabled && channel.baseUrl && channel.apiKey && channel.models.some((item) => item.name === name));
    if (!channels.length) throw fail(`没有可用的模型渠道：${name}`);
    const total = channels.reduce((sum, channel) => sum + channel.weight, 0);
    let hit = Math.floor(Math.random() * total);
    for (const channel of channels) {
        hit -= channel.weight;
        if (hit < 0) return channel;
    }
    return channels[0];
}

/** 火山方舟 Agent Plan 的 base url 需要裁到 /api/plan/v3 为止。 */
function normalizeBaseUrl(baseUrl: string) {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.replace(/\/+$/, "");
        const index = pathname.toLowerCase().indexOf("/api/plan/v3");
        if (index < 0) return trimmed;
        const end = index + "/api/plan/v3".length;
        if (pathname.length !== end && pathname[end] !== "/") return trimmed;
        url.pathname = pathname.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return trimmed;
    }
}

export function buildChannelUrl(channel: Pick<ModelChannel, "baseUrl">, path: string) {
    const baseUrl = normalizeBaseUrl(channel.baseUrl);
    const lower = baseUrl.toLowerCase();
    const withVersion = lower.endsWith("/v1") || lower.endsWith("/api/v3") || lower.endsWith("/api/plan/v3") ? baseUrl : `${baseUrl}/v1`;
    return withVersion + path;
}

export function isArkPlanChannel(channel: Pick<ModelChannel, "baseUrl">) {
    return normalizeBaseUrl(channel.baseUrl).toLowerCase().endsWith("/api/plan/v3");
}

export function isSeedanceModel(model: string) {
    return model.toLowerCase().includes("seedance");
}

/** 后台编辑渠道时密钥可能为空，用已保存的记录补齐后再对外请求。 */
async function resolveAdminChannel(index: number | undefined, input: Partial<ModelChannel>) {
    const channel = normalizeChannel(input);
    if (!channel.apiKey.trim()) {
        const saved = (await getSettings()).private.channels;
        const matched = (typeof index === "number" && saved[index]) || saved.find((item) => item.name === channel.name && item.baseUrl === channel.baseUrl);
        if (matched) {
            channel.apiKey = matched.apiKey;
            channel.baseUrl = channel.baseUrl || matched.baseUrl;
            channel.name = channel.name || matched.name;
        }
    }
    if (!channel.baseUrl.trim()) throw fail("缺少接口地址");
    if (!channel.apiKey.trim()) throw fail("缺少 API Key");
    return channel;
}

async function readUpstreamError(response: Response, fallback: string) {
    const body = await response.text().catch(() => "");
    try {
        const payload = JSON.parse(body) as { error?: { message?: string }; msg?: string; message?: string };
        const detail = payload.error?.message || payload.msg || payload.message;
        if (detail) return fail(detail);
    } catch {
        /* 上游返回的不是 JSON，退回状态码文案 */
    }
    if (response.status === 401 || response.status === 403) return fail(`上游接口鉴权失败（${response.status}），请检查 API Key、套餐权限或模型权限`);
    if (response.status === 429) return fail("上游接口限流或额度不足（429），请稍后重试或检查额度");
    return fail(`${fallback}：${response.status}`);
}

export async function fetchChannelModels(index: number | undefined, input: Partial<ModelChannel>) {
    const channel = await resolveAdminChannel(index, input);
    const response = await fetch(buildChannelUrl(channel, "/models"), { headers: { Authorization: `Bearer ${channel.apiKey}` }, signal: AbortSignal.timeout(30000) }).catch(() => {
        throw fail("读取模型失败：上游接口无响应或网络不可达");
    });
    if (!response.ok) {
        if (response.status === 404 && isArkPlanChannel(channel)) throw fail("火山方舟 Agent Plan 未提供 OpenAI /models 接口，请手动填写模型名称，例如 doubao-seedance-2.0。");
        throw await readUpstreamError(response, "读取模型失败");
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    return (payload.data || [])
        .map((item) => (item.id || "").trim())
        .filter(Boolean)
        .sort();
}

export async function testChannelModel(index: number | undefined, input: Partial<ModelChannel>, model: string) {
    const channel = await resolveAdminChannel(index, input);
    if (!model.trim()) throw fail("缺少模型名称");
    if (isArkPlanChannel(channel) || isSeedanceModel(model)) {
        return "视频模型不会发送文本测试请求。已检查接口地址、API Key 与模型名称非空，但未验证套餐额度或模型权限，请在画布中实际生成一次确认。";
    }
    const response = await fetch(buildChannelUrl(channel, "/chat/completions"), {
        method: "POST",
        headers: { Authorization: `Bearer ${channel.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(30000),
    }).catch(() => {
        throw fail("测试失败：上游接口无响应或网络不可达");
    });
    if (!response.ok) throw await readUpstreamError(response, "测试失败");
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content?.trim() || "ok";
}

export function linuxDoConfig() {
    return config.linuxDo;
}
