import { App, Button, Form, Input, Modal, Select, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { imageAspectOptions, imageQualityOptions } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { useConfigStore, useEnabledCapabilities, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useServerStore } from "@/stores/use-server-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.models.image" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.models.video" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.models.text" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.models.audio" },
];

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Number(value) || 1))));
}

/** 透明背景在生图里是个开关，但这里和其它偏好一样用下拉，免得一排下拉里夹一个开关显得突兀。 */
const agentBackgroundOptions = [
    { value: "", labelKey: "config.preferences.background.default" },
    { value: "transparent", labelKey: "config.preferences.background.transparent" },
];

export function AppConfigPanel({ showDoneButton = false }: { showDoneButton?: boolean }) {
    const { t } = useTranslation();
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const capabilities = useEnabledCapabilities();
    const visibleGroups = modelGroups.filter((group) => capabilities[group.capability]);
    // 画布 Agent 没开放时不显示它的默认模型，免得给出一个点了也用不上的设置。
    const agentEnabled = useServerStore((state) => state.settings?.agent.enabled !== false) && capabilities.text;

    return (
        <>
            <Form layout="vertical" requiredMark={false}>
                {visibleGroups.length ? (
                    <>
                        <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                        <div className="mb-1 text-xs text-stone-500">{t("config.preferences.defaultModelsDescription")}</div>
                        <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                            {visibleGroups.map((group) => (
                                <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                    <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                </Form.Item>
                            ))}
                            {/* 画布 Agent 的默认模型单列一项：它决定新会话起手用哪个模型，也决定按轮计费的单价，和一次性生成的默认模型不是一回事。 */}
                            {agentEnabled ? (
                                <Form.Item label={t("config.preferences.agent.model")} extra={t("config.preferences.agent.modelDescription")} className="mb-0">
                                    <ModelPicker config={config} value={config.agentModel} onChange={(model) => updateConfig("agentModel", model)} capability="text" ariaLabel={t("config.preferences.agent.selectModel")} fullWidth />
                                </Form.Item>
                            ) : null}
                        </div>
                    </>
                ) : (
                    <div className="mb-4 rounded-lg border border-stone-200 p-3 text-xs text-stone-500 dark:border-stone-800">{t("config.preferences.noModelsDetailed")}</div>
                )}
                {/*
                 * Agent 自己调生成工具时用的默认参数。模型多半只想得起写提示词，尺寸、画质、张数一概不传，
                 * 不给默认就只能吃服务端的通用值；在这里配一次，agent 生出来的图才一直是用户要的规格。
                 */}
                {agentEnabled ? (
                    <>
                        <div className="mb-2 text-sm font-semibold">{t("config.preferences.agent.generationDefaults")}</div>
                        <div className="mb-1 text-xs text-stone-500">{t("config.preferences.agent.generationDefaultsDescription")}</div>
                        <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                            {capabilities.image ? (
                                <>
                                    <Form.Item label={t("config.preferences.agent.imageModel")} className="mb-0">
                                        <ModelPicker config={config} value={config.agentImageModel} onChange={(model) => updateConfig("agentImageModel", model)} capability="image" ariaLabel={t("config.preferences.agent.selectImageModel")} fullWidth />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.agent.imageSize")} className="mb-0">
                                        <Select value={config.agentImageSize} options={imageAspectOptions} onChange={(value) => updateConfig("agentImageSize", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.agent.imageQuality")} className="mb-0">
                                        <Select value={config.agentImageQuality} options={imageQualityOptions} onChange={(value) => updateConfig("agentImageQuality", value)} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.agent.imageCount")} className="mb-0">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.agentImageCount}
                                            onChange={(event) => updateConfig("agentImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("agentImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.agent.imageBackground")} className="mb-0">
                                        <Select value={config.agentImageBackground} options={agentBackgroundOptions.map((option) => ({ value: option.value, label: t(option.labelKey) }))} onChange={(value) => updateConfig("agentImageBackground", value)} />
                                    </Form.Item>
                                </>
                            ) : null}
                            <Form.Item label={t("config.preferences.agent.textModel")} extra={t("config.preferences.agent.textModelDescription")} className="mb-0">
                                <ModelPicker config={config} value={config.agentTextModel} onChange={(model) => updateConfig("agentTextModel", model)} capability="text" ariaLabel={t("config.preferences.agent.selectTextModel")} fullWidth />
                            </Form.Item>
                        </div>
                    </>
                ) : null}
                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>{" "}
                <div className="grid gap-4 md:grid-cols-4">
                    {capabilities.image ? (
                        <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-4">
                            <Input
                                type="number"
                                min={1}
                                max={15}
                                value={config.canvasImageCount}
                                onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                            />
                        </Form.Item>
                    ) : null}
                    {capabilities.audio ? (
                        <>
                            <Form.Item label={t("config.preferences.audioVoice")} className="mb-4">
                                <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                            </Form.Item>
                            <Form.Item label={t("config.preferences.audioFormat")} className="mb-4">
                                <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                            </Form.Item>
                            <Form.Item label={t("config.preferences.audioSpeed")} className="mb-4">
                                <Input
                                    type="number"
                                    min={0.25}
                                    max={4}
                                    step={0.05}
                                    value={config.audioSpeed}
                                    onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                    onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                />
                            </Form.Item>
                        </>
                    ) : null}
                </div>
                {capabilities.audio ? (
                    <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                        <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                    </Form.Item>
                ) : null}
                <Form.Item label={t("config.preferences.systemPrompt")} extra={t("config.preferences.systemPromptDescription")} className="mb-0">
                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                </Form.Item>
                {/*
                 * 算力点归属。这个开关决定的是钱从谁的账上出，文案必须把两种结果都讲死：
                 * 只写「团队没钱时使用个人积分」的话，用户不会意识到关着的时候生成会直接失败，
                 * 开着的时候花的是他自己的钱。
                 */}
                <div className="mt-6 mb-2 text-sm font-semibold">{t("config.preferences.credits")}</div>
                <Form.Item label={t("config.preferences.billingFallback")} extra={t("config.preferences.billingFallbackDescription")} className="mb-0">
                    <Switch checked={config.billingFallbackToPersonal} aria-label={t("config.preferences.billingFallback")} onChange={(checked) => updateConfig("billingFallbackToPersonal", checked)} />
                </Form.Item>
            </Form>
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={() => setConfigDialogOpen(false)}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
        </>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.description")}</div>
                </div>
            }
            open={isConfigOpen}
            onCancel={() => setConfigDialogOpen(false)}
            footer={null}
            width={880}
            destroyOnHidden
        >
            <AppConfigPanel showDoneButton />
        </Modal>
    );
}

/** 供画布等场景在缺少可用模型时提示用户。 */
export function useConfigDialog() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    return () => {
        message.warning(t("config.preferences.noModels"));
        openConfigDialog(true);
    };
}
