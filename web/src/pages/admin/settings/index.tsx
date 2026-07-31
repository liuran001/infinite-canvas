import { useQuery } from "@tanstack/react-query";
import { App, AutoComplete, Button, Input, InputNumber, Select, Switch } from "antd";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminChannel, type AdminSettings } from "@/services/api/admin";
import type { ServerCapability, ServerSettings } from "@/stores/use-server-store";
import { ChannelEditorModal } from "./components/channel-editor-modal";

const newChannel = (): AdminChannel => ({ apiFormat: "openai", name: "", baseUrl: "", apiKey: "", models: [], weight: 1, enabled: true, remark: "" });

const sectionClass = "mt-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800";

/** 默认模型选项按启用渠道的模型现算，这样新增渠道后不用先保存也能选。 */
function channelModels(channels: AdminChannel[]) {
    const seen = new Map<string, ServerCapability>();
    for (const channel of channels) {
        if (!channel.enabled) continue;
        for (const model of channel.models) if (!seen.has(model.name)) seen.set(model.name, model.capability);
    }
    return [...seen].map(([name, capability]) => ({ name, capability }));
}

export default function AdminSettingsPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-settings"], queryFn: adminApi.settings });
    const [draft, setDraft] = useState<AdminSettings | null>(null);
    const [editingChannel, setEditingChannel] = useState<AdminChannel | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (data) setDraft(data);
    }, [data]);

    if (!draft) return <div className="py-20 text-center text-sm text-stone-500">{isFetching ? "加载中…" : "读取系统设置失败"}</div>;

    const patchModelChannel = (value: Partial<ServerSettings["modelChannel"]>) => setDraft((current) => current && { ...current, public: { ...current.public, modelChannel: { ...current.public.modelChannel, ...value } } });
    const patchAuth = (value: Partial<ServerSettings["auth"]>) => setDraft((current) => current && { ...current, public: { ...current.public, auth: { ...current.public.auth, ...value } } });
    const patchStorage = (remoteEnabled: boolean) => setDraft((current) => current && { ...current, public: { ...current.public, storage: { remoteEnabled } } });
    const patchPrivate = (value: Partial<AdminSettings["private"]>) => setDraft((current) => current && { ...current, private: { ...current.private, ...value } });

    const { channels, promptSync } = draft.private;
    const { modelChannel, auth, storage } = draft.public;
    const models = channelModels(channels);
    const optionsFor = (capability: ServerCapability) => models.filter((model) => model.capability === capability).map((model) => ({ label: model.name, value: model.name }));
    const allOptions = models.map((model) => ({ label: model.name, value: model.name }));

    const openChannel = (channel: AdminChannel, index?: number) => {
        setEditingIndex(index);
        setEditingChannel(channel);
    };

    const saveChannel = (channel: AdminChannel) => {
        patchPrivate({ channels: editingIndex === undefined ? [...channels, channel] : channels.map((item, index) => (index === editingIndex ? channel : item)) });
    };

    const confirmRemoveChannel = (channel: AdminChannel, index: number) =>
        modal.confirm({
            title: `删除渠道「${channel.name || "未命名渠道"}」？`,
            content: "保存设置后生效，使用该渠道的模型将不可用。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: () => patchPrivate({ channels: channels.filter((_, current) => current !== index) }),
        });

    const save = async () => {
        setSaving(true);
        if (await runAction(() => adminApi.saveSettings(draft), "设置已保存")) await refetch();
        setSaving(false);
    };

    return (
        <div className="max-w-4xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">系统设置</h1>
                    <p className="mt-0.5 text-xs text-stone-500">模型渠道、算力点成本、登录方式与提示词同步等服务端配置。</p>
                </div>
                <Button type="primary" loading={saving} onClick={() => void save()}>
                    保存设置
                </Button>
            </div>

            <section className={sectionClass}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">模型渠道</h2>
                        <p className="mt-0.5 text-xs text-stone-500">按权重随机挑选可用渠道；密钥保存后不会回传，留空表示保持不变。</p>
                    </div>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => openChannel(newChannel())}>
                        新增渠道
                    </Button>
                </div>
                <div className="mt-3 space-y-2">
                    {channels.length ? (
                        channels.map((channel, index) => (
                            <div key={`${channel.name}-${index}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                                <Switch size="small" checked={channel.enabled} onChange={(enabled) => patchPrivate({ channels: channels.map((item, current) => (current === index ? { ...item, enabled } : item)) })} />
                                <div className="min-w-[200px] flex-1">
                                    <div className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-stone-500">
                                        <span className="truncate">{channel.baseUrl || "未填写接口地址"}</span>
                                        <span>{channel.models.length} 个模型</span>
                                        <span>权重 {channel.weight}</span>
                                        {channel.remark ? <span className="truncate">{channel.remark}</span> : null}
                                    </div>
                                </div>
                                <div className="ml-auto flex gap-2">
                                    <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => openChannel(channel, index)}>
                                        编辑
                                    </Button>
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => confirmRemoveChannel(channel, index)}>
                                        删除
                                    </Button>
                                </div>
                            </div>
                        ))
                    ) : (
                        <div className="py-6 text-center text-sm text-stone-500">还没有渠道，先新增一个再配置模型。</div>
                    )}
                </div>
            </section>

            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">默认模型与生成</h2>
                <p className="mt-0.5 text-xs text-stone-500">可选模型来自已启用渠道，保存后同步给所有客户端。</p>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">默认模型</span>
                        <Select className="w-full" allowClear showSearch value={modelChannel.defaultModel || undefined} options={allOptions} onChange={(value) => patchModelChannel({ defaultModel: value || "" })} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">默认生图模型</span>
                        <Select className="w-full" allowClear showSearch value={modelChannel.defaultImageModel || undefined} options={optionsFor("image")} onChange={(value) => patchModelChannel({ defaultImageModel: value || "" })} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">默认视频模型</span>
                        <Select className="w-full" allowClear showSearch value={modelChannel.defaultVideoModel || undefined} options={optionsFor("video")} onChange={(value) => patchModelChannel({ defaultVideoModel: value || "" })} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">默认文本模型</span>
                        <Select className="w-full" allowClear showSearch value={modelChannel.defaultTextModel || undefined} options={optionsFor("text")} onChange={(value) => patchModelChannel({ defaultTextModel: value || "" })} />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">默认音频模型</span>
                        <Select className="w-full" allowClear showSearch value={modelChannel.defaultAudioModel || undefined} options={optionsFor("audio")} onChange={(value) => patchModelChannel({ defaultAudioModel: value || "" })} />
                    </label>
                    <div className="flex items-center gap-2 md:pt-6">
                        <Switch checked={modelChannel.allowCustomChannel} onChange={(allowCustomChannel) => patchModelChannel({ allowCustomChannel })} />
                        <span className="text-sm">允许用户使用自己的渠道</span>
                    </div>
                </div>
                <label className="mt-4 block">
                    <span className="mb-1 block text-sm font-medium">系统提示词</span>
                    <Input.TextArea rows={4} value={modelChannel.systemPrompt} onChange={(event) => patchModelChannel({ systemPrompt: event.target.value })} placeholder="附加在文本对话最前面的系统提示词，可留空" />
                </label>
            </section>

            <section className={sectionClass}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">模型算力点成本</h2>
                        <p className="mt-0.5 text-xs text-stone-500">未配置的模型按 0 算力点计费。</p>
                    </div>
                    <Button icon={<Plus className="size-4" />} onClick={() => patchModelChannel({ modelCosts: [...modelChannel.modelCosts, { model: "", credits: 0 }] })}>
                        新增
                    </Button>
                </div>
                <div className="mt-3 space-y-2">
                    {modelChannel.modelCosts.length ? (
                        modelChannel.modelCosts.map((cost, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <AutoComplete
                                    className="min-w-0 flex-1"
                                    value={cost.model}
                                    options={allOptions}
                                    placeholder="模型名称"
                                    filterOption={(input, option) =>
                                        String(option?.value || "")
                                            .toLowerCase()
                                            .includes(input.toLowerCase())
                                    }
                                    onChange={(value) => patchModelChannel({ modelCosts: modelChannel.modelCosts.map((item, current) => (current === index ? { ...item, model: value || "" } : item)) })}
                                />
                                <InputNumber
                                    className="w-32"
                                    min={0}
                                    precision={0}
                                    value={cost.credits}
                                    addonAfter="点"
                                    onChange={(value) => patchModelChannel({ modelCosts: modelChannel.modelCosts.map((item, current) => (current === index ? { ...item, credits: value || 0 } : item)) })}
                                />
                                <Button danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => patchModelChannel({ modelCosts: modelChannel.modelCosts.filter((_, current) => current !== index) })} />
                            </div>
                        ))
                    ) : (
                        <div className="py-4 text-center text-sm text-stone-500">还没有配置模型成本。</div>
                    )}
                </div>
            </section>

            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">注册与登录</h2>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Switch checked={auth.allowRegister} onChange={(allowRegister) => patchAuth({ allowRegister })} />
                        <span className="text-sm">开放注册</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Switch checked={auth.linuxDo.enabled} onChange={(enabled) => patchAuth({ linuxDo: { enabled } })} />
                        <span className="text-sm">启用 Linux.do 登录</span>
                    </div>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">Linux.do Client ID</span>
                        <Input value={draft.private.auth.linuxDo.clientId} onChange={(event) => patchPrivate({ auth: { linuxDo: { ...draft.private.auth.linuxDo, clientId: event.target.value } } })} placeholder="OAuth 应用的 Client ID" />
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">Linux.do Client Secret</span>
                        <Input.Password value={draft.private.auth.linuxDo.clientSecret} onChange={(event) => patchPrivate({ auth: { linuxDo: { ...draft.private.auth.linuxDo, clientSecret: event.target.value } } })} placeholder="留空表示不修改" />
                    </label>
                </div>
            </section>

            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">存储与提示词同步</h2>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Switch checked={storage.remoteEnabled} onChange={patchStorage} />
                        <span className="text-sm">启用云端存储</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Switch checked={promptSync.enabled} onChange={(enabled) => patchPrivate({ promptSync: { ...promptSync, enabled } })} />
                        <span className="text-sm">定时同步远程提示词</span>
                    </div>
                </div>
                <label className="mt-4 block max-w-xs">
                    <span className="mb-1 block text-sm font-medium">同步 cron 表达式</span>
                    <Input value={promptSync.cron} onChange={(event) => patchPrivate({ promptSync: { ...promptSync, cron: event.target.value } })} placeholder="0 4 * * *" />
                    <span className="mt-1 block text-xs text-stone-500">格式为「分 时 日 月 周」，默认每天 4 点同步一次。</span>
                </label>
            </section>

            <ChannelEditorModal channel={editingChannel} index={editingIndex} onSave={saveChannel} onClose={() => setEditingChannel(null)} />
        </div>
    );
}
