import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { useServerStore } from "@/stores/use-server-store";

export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

/**
 * 用户偏好。模型渠道与密钥都由管理员在服务端配置，这里只保留个人偏好，
 * 模型字段存的是服务端下发的模型名。
 */
export type AiConfig = {
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    /** 云端 Agent 的默认模型，新会话用它；留空表示跟随管理员配置的全站默认。 */
    agentModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
};

export type ConfigTabKey = "preferences";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

export const defaultConfig: AiConfig = {
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    agentModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
};

type ConfigStore = {
    config: AiConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

/** 服务端配好模型就算就绪，密钥不再由前端持有。 */
function isAiConfigReady(_config: AiConfig, model: string) {
    const models = useServerStore.getState().settings?.modelChannel.models || [];
    return Boolean(model.trim()) && models.some((item) => item.name === model.trim());
}

/** 动态引入避免与同步服务循环依赖，写法与画布、素材、插件保持一致。 */
function pushPreferences() {
    void import("@/services/remote-sync").then((module) => module.pushPreferences());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set) => ({
            config: defaultConfig,
            isConfigOpen: false,
            configTab: "preferences",
            shouldPromptContinue: false,
            updateConfig: (key, value) => {
                set((state) => ({ config: { ...state.config, [key]: value } }));
                pushPreferences();
            },
            isAiConfigReady,
            openConfigDialog: (shouldPromptContinue = false, configTab = "preferences") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config }),
            merge: (persisted, current) => ({ ...current, config: { ...defaultConfig, ...((persisted as { config?: Partial<AiConfig> })?.config || {}) } }),
        },
    ),
);

export function useEffectiveConfig() {
    return useConfigStore((state) => state.config);
}

/** 取值一律用服务端下发的原始模型名，展示走管理员配置的展示名。 */
export function modelOptionName(value: string) {
    return (value || "").trim();
}

export function modelOptionLabel(_config: AiConfig, value: string) {
    const name = modelOptionName(value);
    return serverModels().find((model) => model.name === name)?.label || name;
}

export function serverModels() {
    return useServerStore.getState().settings?.modelChannel.models || [];
}

export function modelCapabilityOf(_config: AiConfig, value: string): ModelCapability | undefined {
    return serverModels().find((model) => model.name === modelOptionName(value))?.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function selectableModelsByCapability(_config: AiConfig, capability?: ModelCapability) {
    const models = serverModels();
    return (capability ? models.filter((model) => model.capability === capability) : models).map((model) => model.name);
}

/** 当前选择仍然有效就保留，否则回落到服务端为该能力配置的默认模型。 */
export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const channel = useServerStore.getState().settings?.modelChannel;
    const name = modelOptionName(currentModel || "");
    if (name && channel?.models.some((model) => model.name === name && model.capability === capability)) return name;
    const preferred = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    if (preferred && channel?.models.some((model) => model.name === preferred && model.capability === capability)) return preferred;
    return (capability === "image" ? channel?.defaultImageModel : capability === "video" ? channel?.defaultVideoModel : capability === "audio" ? channel?.defaultAudioModel : channel?.defaultTextModel) || "";
}

export const modelCapabilities: ModelCapability[] = ["image", "text", "video", "audio"];

/**
 * 云端 Agent 该显示 / 使用哪个模型，三层依次回落：
 * 当前会话已经在用的 → 用户自己的「Agent 默认模型」偏好 → 管理员配的全站默认。
 * 每层都要求模型仍在服务端下发的 text 模型列表里，管理员下线某个模型后旧选择会自动跳到下一层，
 * 与服务端 resolveAgentModel() 保持同一套口径，面板上显示的模型才和实际计费的一致。
 */
export function resolveAgentModel(currentModel?: string) {
    const settings = useServerStore.getState().settings;
    const isText = (value: string) => Boolean(value) && Boolean(settings?.modelChannel.models.some((model) => model.name === value && model.capability === "text"));
    const current = modelOptionName(currentModel || "");
    if (isText(current)) return current;
    const preferred = modelOptionName(useConfigStore.getState().config.agentModel);
    if (isText(preferred)) return preferred;
    return settings?.agent.model || settings?.modelChannel.defaultTextModel || "";
}
/** 功能入口是否显示，由管理员在后台统一控制；没配对应模型时也自动隐藏。 */
export function isCapabilityEnabled(capability: ModelCapability) {
    const settings = useServerStore.getState().settings;
    if (!settings) return true;
    if (settings.capabilities?.[capability] === false) return false;
    return settings.modelChannel.models.some((model) => model.capability === capability);
}

export function useEnabledCapabilities() {
    const settings = useServerStore((state) => state.settings);
    return useMemo(() => Object.fromEntries(modelCapabilities.map((capability) => [capability, isCapabilityEnabled(capability)])) as Record<ModelCapability, boolean>, [settings]);
}

/**
 * 单次调用要消耗的算力点：基础价加上画质档位加价。
 * 与服务端 modelCost() 保持同一套算法，界面上给出的预估才不会和实际扣费对不上。
 */
export function modelCreditCost(model: string, quality?: string) {
    const cost = useServerStore.getState().settings?.modelChannel.modelCosts.find((item) => item.model === modelOptionName(model));
    if (!cost) return 0;
    return cost.credits + (quality ? cost.qualityCredits?.[quality.trim()] || 0 : 0);
}

/** 本次生成的总消耗，count 是张数。 */
export function generationCreditCost(model: string, quality?: string, count = 1) {
    return modelCreditCost(model, quality) * Math.max(1, count);
}
