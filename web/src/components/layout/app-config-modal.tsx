import { App, Button, Form, Input, Modal, Select } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { useConfigStore, useEnabledCapabilities, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useServerStore } from "@/stores/use-server-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    defaultLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", defaultLabel: "默认生图模型" },
    { capability: "video", modelKey: "videoModel", defaultLabel: "默认视频模型" },
    { capability: "text", modelKey: "textModel", defaultLabel: "默认文本模型" },
    { capability: "audio", modelKey: "audioModel", defaultLabel: "默认音频模型" },
];

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Number(value) || 1))));
}

export function AppConfigPanel({ showDoneButton = false }: { showDoneButton?: boolean }) {
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
                        <div className="mb-2 text-sm font-semibold">默认模型</div>
                        <div className="mb-1 text-xs text-stone-500">可选模型由管理员在服务端配置，这里只决定各类生成默认用哪个。</div>
                        <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                            {visibleGroups.map((group) => (
                                <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                    <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                </Form.Item>
                            ))}
                            {/* 画布 Agent 的默认模型单列一项：它决定新会话起手用哪个模型，也决定按轮计费的单价，和一次性生成的默认模型不是一回事。 */}
                            {agentEnabled ? (
                                <Form.Item label="Agent 默认模型" extra="画布右侧「系统模型」新建会话时使用，留空跟随管理员配置。" className="mb-0">
                                    <ModelPicker config={config} value={config.agentModel} onChange={(model) => updateConfig("agentModel", model)} capability="text" ariaLabel="选择 Agent 默认模型" fullWidth />
                                </Form.Item>
                            ) : null}
                        </div>
                    </>
                ) : (
                    <div className="mb-4 rounded-lg border border-stone-200 p-3 text-xs text-stone-500 dark:border-stone-800">服务端还没有配置可用模型，请联系管理员在管理后台添加模型渠道。</div>
                )}

                <div className="mb-2 text-sm font-semibold">生成偏好</div>
                <div className="grid gap-4 md:grid-cols-4">
                    {capabilities.image ? (
                        <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
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
                            <Form.Item label="默认音频声音" className="mb-4">
                                <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                            </Form.Item>
                            <Form.Item label="默认音频格式" className="mb-4">
                                <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                            </Form.Item>
                            <Form.Item label="默认音频语速" className="mb-4">
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
                    <Form.Item label="默认音频指令" className="mb-4">
                        <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                    </Form.Item>
                ) : null}
                <Form.Item label="系统提示词" extra="会和管理员配置的全局提示词一起生效。" className="mb-0">
                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                </Form.Item>
            </Form>
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={() => setConfigDialogOpen(false)}>
                        完成
                    </Button>
                </div>
            ) : null}
        </>
    );
}

export function AppConfigModal() {
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">偏好设置</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">默认模型与生成偏好</div>
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
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    return () => {
        message.warning("服务端还没有配置可用模型，请联系管理员");
        openConfigDialog(true);
    };
}
