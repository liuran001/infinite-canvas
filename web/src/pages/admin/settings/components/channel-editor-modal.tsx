import { App, Button, Input, InputNumber, Modal, Segmented, Select, Switch } from "antd";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { adminApi, type AdminChannel } from "@/services/api/admin";
import { defaultBaseUrlForApiFormat, guessCapability } from "@/stores/use-config-store";
import type { ServerApiFormat, ServerCapability } from "@/stores/use-server-store";

const apiFormatOptions: Array<{ label: string; value: ServerApiFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
    { label: "火山方舟", value: "ark" },
];

const capabilityOptions: Array<{ label: string; value: ServerCapability }> = [
    { label: "生图", value: "image" },
    { label: "视频", value: "video" },
    { label: "文本", value: "text" },
    { label: "音频", value: "audio" },
];

/** index 是渠道在设置数组里的下标，服务端靠它补回已保存但未回传的密钥。 */
export function ChannelEditorModal({ channel, index, onSave, onClose }: { channel: AdminChannel | null; index?: number; onSave: (channel: AdminChannel) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const [draft, setDraft] = useState<AdminChannel | null>(channel);
    const [options, setOptions] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [testModel, setTestModel] = useState("");
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState("");

    useEffect(() => {
        setDraft(channel);
        setOptions([]);
        setTestResult("");
        setTestModel(channel?.models[0]?.name || "");
    }, [channel]);

    if (!draft) return null;

    const patch = (value: Partial<AdminChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));

    const changeApiFormat = (apiFormat: ServerApiFormat) => {
        const isDefault = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat);
        patch({ apiFormat, baseUrl: isDefault ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl });
    };

    // 已选模型保留原有能力设置，新增的按名称猜一个默认能力。
    const applyNames = (names: string[]) => {
        const saved = new Map(draft.models.map((model) => [model.name, model]));
        patch({ models: names.map((name) => saved.get(name) || { name, capability: guessCapability(name) }) });
    };

    const setCapability = (name: string, capability: ServerCapability) => patch({ models: draft.models.map((model) => (model.name === name ? { ...model, capability } : model)) });

    const loadModels = async () => {
        setLoading(true);
        try {
            setOptions(await adminApi.channelModels(index, draft));
            message.success("已拉取模型列表");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "拉取模型失败");
        } finally {
            setLoading(false);
        }
    };

    const test = async () => {
        setTesting(true);
        setTestResult("");
        try {
            setTestResult(await adminApi.channelTest(index, draft, testModel));
        } catch (error) {
            setTestResult(error instanceof Error ? error.message : "测试失败");
        } finally {
            setTesting(false);
        }
    };

    const save = () => {
        onSave({ ...draft, name: draft.name.trim() || "未命名渠道" });
        onClose();
    };

    const modelNames = draft.models.map((model) => model.name);

    return (
        <Modal open width={720} title={index === undefined ? "新增渠道" : "编辑渠道"} okText="确定" cancelText="取消" onOk={save} onCancel={onClose}>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">渠道名称</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如 主力渠道" />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">协议</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">接口地址</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>
                <label className="block md:col-span-2">
                    <span className="mb-1 block text-sm font-medium">API Key</span>
                    <Input.Password value={draft.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} placeholder={index === undefined ? "sk-..." : "留空表示不修改"} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">权重</span>
                    <InputNumber className="w-full" min={1} precision={0} value={draft.weight} onChange={(value) => patch({ weight: value || 1 })} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">备注</span>
                    <Input value={draft.remark} onChange={(event) => patch({ remark: event.target.value })} placeholder="可选" />
                </label>
                <div className="flex items-center gap-2 md:col-span-2">
                    <Switch checked={draft.enabled} onChange={(enabled) => patch({ enabled })} />
                    <span className="text-sm">启用该渠道</span>
                </div>
            </div>

            <div className="mt-5 mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">渠道模型</div>
                    <div className="mt-0.5 text-xs text-stone-500">已选 {draft.models.length} 个；可直接输入模型名称，未提供 /models 的渠道需要手动填写。</div>
                </div>
                <Button loading={loading} onClick={() => void loadModels()}>
                    拉取模型列表
                </Button>
            </div>
            <Select className="w-full" mode="tags" value={modelNames} options={options.map((name) => ({ label: name, value: name }))} onChange={applyNames} placeholder="选择或输入模型名称" />

            <div className="mt-2 space-y-1 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <span className="min-w-0 flex-1 truncate text-sm" title={model.name}>
                                {model.name}
                            </span>
                            <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ServerCapability)} />
                            <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => applyNames(modelNames.filter((name) => name !== model.name))} />
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-6 text-center text-sm text-stone-500">还没有模型，先拉取或手动输入。</div>
                )}
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">连通性测试</span>
                <Select className="w-56" value={testModel || undefined} placeholder="选择模型" options={modelNames.map((name) => ({ label: name, value: name }))} onChange={setTestModel} />
                <Button loading={testing} disabled={!testModel} onClick={() => void test()}>
                    测试
                </Button>
            </div>
            {testResult ? <div className="mt-2 rounded-lg border border-stone-200 p-3 text-xs whitespace-pre-wrap text-stone-500 dark:border-stone-800">{testResult}</div> : null}
        </Modal>
    );
}
