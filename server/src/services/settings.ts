import { config } from "../config";
import { repo } from "../db/data-source";
import { Setting } from "../db/entities";
import { fail, now } from "../lib/errors";

export type ApiFormat = "openai" | "gemini" | "ark";
export type ModelCapability = "image" | "video" | "text" | "audio";

export type ChannelModel = { name: string; capability: ModelCapability };

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

export type ModelCost = { model: string; credits: number };

/** 前端在服务器模式下靠 apiFormat 决定文本请求走哪条代理，靠 capability 过滤模型选择器。 */
export type PublicModel = { name: string; apiFormat: ApiFormat; capability: ModelCapability };

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
    auth: { allowRegister: boolean; linuxDo: { enabled: boolean } };
    storage: { remoteEnabled: boolean };
};

export type PrivateSetting = {
    channels: ModelChannel[];
    promptSync: { enabled: boolean; cron: string };
    auth: { linuxDo: { clientId: string; clientSecret: string } };
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
        result.push({ name, capability });
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

function normalizePrivate(setting: Partial<PrivateSetting> | undefined): PrivateSetting {
    return {
        channels: (setting?.channels || []).map(normalizeChannel),
        promptSync: { enabled: setting?.promptSync?.enabled !== false, cron: setting?.promptSync?.cron?.trim() || "0 4 * * *" },
        auth: { linuxDo: { clientId: setting?.auth?.linuxDo?.clientId?.trim() || "", clientSecret: setting?.auth?.linuxDo?.clientSecret || "" } },
    };
}

function normalizePublic(setting: Partial<PublicSetting> | undefined, channels: ModelChannel[]): PublicSetting {
    const channel = setting?.modelChannel;
    const seen = new Set<string>();
    const models: PublicModel[] = [];
    for (const item of channels.filter((entry) => entry.enabled)) {
        for (const model of item.models) {
            if (seen.has(model.name)) continue;
            seen.add(model.name);
            models.push({ name: model.name, apiFormat: item.apiFormat, capability: model.capability });
        }
    }
    return {
        modelChannel: {
            models,
            modelCosts: (channel?.modelCosts || []).map((cost) => ({ model: String(cost.model || "").trim(), credits: Math.max(0, Number(cost.credits) || 0) })).filter((cost) => cost.model),
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
            linuxDo: { enabled: Boolean(setting?.auth?.linuxDo?.enabled) },
        },
        storage: { remoteEnabled: setting?.storage?.remoteEnabled !== false },
    };
}

function normalizeSettings(settings: Partial<Settings>): Settings {
    const privateSetting = normalizePrivate(settings.private);
    return { private: privateSetting, public: normalizePublic(settings.public, privateSetting.channels) };
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
    return { public: next.public, private: { ...next.private, channels, auth: { linuxDo: { ...next.private.auth.linuxDo, clientSecret } } } };
}

export async function saveSettings(input: Partial<Settings>) {
    const saved = await readSettings();
    const merged = keepSecrets(normalizeSettings(input), saved);
    const table = repo(Setting);
    await table.save([
        { key: "public", value: JSON.stringify(merged.public), updatedAt: now() },
        { key: "private", value: JSON.stringify(merged.private), updatedAt: now() },
    ]);
    return hideSecrets(merged);
}

export async function modelCost(model: string) {
    const settings = await publicSettings();
    return settings.modelChannel.modelCosts.find((cost) => cost.model === model.trim())?.credits || 0;
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
