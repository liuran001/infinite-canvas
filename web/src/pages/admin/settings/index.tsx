import { useQuery } from "@tanstack/react-query";
import { App, AutoComplete, Button, Input, InputNumber, Select, Switch, Typography } from "antd";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminChannel, type AdminChannelModel, type AdminSearchProvider, type AdminSearchService, type AdminSettings, type ModelCost } from "@/services/api/admin";
import { imageQualityOptions } from "@/components/image-settings-panel";
import { useServerStore, type ServerCapability, type ServerSettings } from "@/stores/use-server-store";
import { ChannelEditorModal } from "./components/channel-editor-modal";

const newChannel = (): AdminChannel => ({ apiFormat: "openai", name: "", baseUrl: "", apiKey: "", models: [], weight: 1, enabled: true, remark: "" });
const newSearchService = (): AdminSearchService => ({ provider: "exa", name: "", baseUrl: "", apiKey: "", weight: 1, enabled: true });

const sectionClass = "mt-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800";

/** 与服务端 search 服务里注册的 PROVIDERS 一一对应，之后接新服务在这里补一项即可。 */
const searchProviderOptions: Array<{ label: string; value: AdminSearchProvider }> = [
    { label: "Exa", value: "exa" },
    { label: "Tavily", value: "tavily" },
];

const capabilityItems: Array<{ key: ServerCapability; label: string; hint: string }> = [
    { key: "image", label: "图片生成", hint: "图片页与画布生图节点" },
    { key: "text", label: "文本对话", hint: "文本节点与提示词扩写" },
    { key: "video", label: "视频生成", hint: "视频页与画布视频节点" },
    { key: "audio", label: "音频生成", hint: "画布音频节点" },
];

/** 默认模型选项按启用渠道的模型现算，这样新增渠道后不用先保存也能选。 */
function channelModels(channels: AdminChannel[]) {
    const seen = new Map<string, AdminChannelModel>();
    for (const channel of channels) {
        if (!channel.enabled) continue;
        for (const model of channel.models) if (!seen.has(model.name)) seen.set(model.name, model);
    }
    return [...seen.values()];
}

/** 下拉里显示展示名，存的仍然是真实模型名。 */
const toOption = (model: AdminChannelModel) => ({ label: model.label || model.name, value: model.name });

export default function AdminSettingsPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-settings"], queryFn: adminApi.settings });
    const [draft, setDraft] = useState<AdminSettings | null>(null);
    // 回调地址给管理员照抄到 Linux.do 的 OAuth 应用。baseUrl 留空表示与前端同源。
    const serverBaseUrl = useServerStore((state) => state.baseUrl);
    const oauthCallbackUrl = `${serverBaseUrl || window.location.origin}/api/auth/linux-do/callback`;
    const [editingChannel, setEditingChannel] = useState<AdminChannel | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | undefined>(undefined);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (data) setDraft(data);
    }, [data]);

    if (!draft) return <div className="py-20 text-center text-sm text-stone-500">{isFetching ? "加载中…" : "读取系统设置失败"}</div>;

    const patchModelChannel = (value: Partial<ServerSettings["modelChannel"]>) => setDraft((current) => current && { ...current, public: { ...current.public, modelChannel: { ...current.public.modelChannel, ...value } } });
    const patchAuth = (value: Partial<ServerSettings["auth"]>) => setDraft((current) => current && { ...current, public: { ...current.public, auth: { ...current.public.auth, ...value } } });
    const patchStorage = (remoteEnabled: boolean, defaultQuota?: number) => setDraft((current) => current && { ...current, public: { ...current.public, storage: { remoteEnabled, defaultQuota: defaultQuota ?? current.public.storage.defaultQuota } } });
    const patchCapabilities = (key: ServerCapability, enabled: boolean) => setDraft((current) => current && { ...current, public: { ...current.public, capabilities: { ...current.public.capabilities, [key]: enabled } } });
    const patchAgent = (value: Partial<ServerSettings["agent"]>) => setDraft((current) => current && { ...current, public: { ...current.public, agent: { ...current.public.agent, ...value } } });
    const patchPrivate = (value: Partial<AdminSettings["private"]>) => setDraft((current) => current && { ...current, private: { ...current.private, ...value } });
    const patchSearch = (value: Partial<AdminSettings["private"]["search"]>) => setDraft((current) => current && { ...current, private: { ...current.private, search: { ...current.private.search, ...value } } });

    const { channels, promptSync, search } = draft.private;
    const { modelChannel, auth, storage, capabilities, agent } = draft.public;
    const models = channelModels(channels);
    const optionsFor = (capability: ServerCapability) => models.filter((model) => model.capability === capability).map(toOption);
    const allOptions = models.map(toOption);
    const patchCost = (index: number, value: Partial<ModelCost>) => patchModelChannel({ modelCosts: modelChannel.modelCosts.map((item, current) => (current === index ? { ...item, ...value } : item)) });
    const patchSearchService = (index: number, value: Partial<AdminSearchService>) => patchSearch({ services: search.services.map((item, current) => (current === index ? { ...item, ...value } : item)) });

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
                <h2 className="text-sm font-semibold">功能入口</h2>
                <p className="mt-0.5 text-xs text-stone-500">关掉后所有用户都看不到对应入口；即使已经配好模型，也可以先不对外开放。</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                    {capabilityItems.map((item) => (
                        <div key={item.key} className="flex items-center gap-2">
                            <Switch checked={capabilities[item.key]} onChange={(enabled) => patchCapabilities(item.key, enabled)} />
                            <span className="text-sm">{item.label}</span>
                            <span className="text-xs text-stone-500">{item.hint}</span>
                        </div>
                    ))}
                </div>
            </section>

            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">画布 Agent</h2>
                <p className="mt-0.5 text-xs text-stone-500">画布里的对话式 Agent，会按需调用生图、生视频等工具替用户干活。</p>
                <div className="mt-3 flex items-center gap-2">
                    <Switch checked={agent.enabled} onChange={(enabled) => patchAgent({ enabled })} />
                    <span className="text-sm">启用画布 Agent</span>
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">Agent 主模型</span>
                        {/* 服务端只接受 capability 为 text 的模型，选到生图模型会被直接丢弃，所以这里也只列文本模型。 */}
                        <Select className="w-full" allowClear showSearch value={agent.model || undefined} options={optionsFor("text")} placeholder="留空表示用默认文本模型" onChange={(value) => patchAgent({ model: value || "" })} />
                        <span className="mt-1 block text-xs text-stone-500">只能选文本模型；留空时服务端回落到上面的「默认文本模型」。</span>
                    </label>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">最大工具调用轮数</span>
                        {/* 这里的钳位和服务端 normalizePublic 保持一致，免得填了越界值保存后被悄悄改掉。 */}
                        <InputNumber className="w-full" min={1} max={50} precision={0} suffix="轮" value={agent.maxRounds} onChange={(value) => patchAgent({ maxRounds: Math.min(50, Math.max(1, Number(value) || 25)) })} />
                        <span className="mt-1 block text-xs text-stone-500">单次对话最多让模型连续调用几轮工具，范围 1-50，默认 25；调大更能自己纠错，但也更慢、更费算力点。</span>
                    </label>
                </div>
            </section>

            <section className={sectionClass}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">联网搜索</h2>
                        <p className="mt-0.5 text-xs text-stone-500">给画布 Agent 提供联网搜索与读取网页正文的工具；密钥保存后不会回传，留空表示保持不变。</p>
                    </div>
                    <Button icon={<Plus className="size-4" />} onClick={() => patchSearch({ services: [...search.services, newSearchService()] })}>
                        新增服务
                    </Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Switch checked={search.enabled} onChange={(enabled) => patchSearch({ enabled })} />
                        <span className="text-sm">启用联网搜索</span>
                    </div>
                    <label className="flex items-center gap-2">
                        <span className="text-sm">结果条数上限</span>
                        {/* 同样按服务端的 1-20 钳位，默认 5。 */}
                        <InputNumber className="w-28" min={1} max={20} precision={0} suffix="条" value={search.maxResults} onChange={(value) => patchSearch({ maxResults: Math.min(20, Math.max(1, Number(value) || 5)) })} />
                        <span className="text-xs text-stone-500">每次搜索最多返回几条，条数越多上下文越长。</span>
                    </label>
                </div>
                {/* 可以配多家：权重高的先用，调用失败会自动换下一家，所以同时配两家等于给联网能力做了备份。 */}
                <div className="mt-3 space-y-2">
                    {search.services.length ? (
                        search.services.map((service, index) => (
                            <div key={index} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Switch size="small" checked={service.enabled} onChange={(enabled) => patchSearchService(index, { enabled })} />
                                    <Select className="w-28" value={service.provider} options={searchProviderOptions} onChange={(provider) => patchSearchService(index, { provider })} />
                                    <Input className="w-36" value={service.name} placeholder="备注名" onChange={(event) => patchSearchService(index, { name: event.target.value })} />
                                    <Input.Password className="min-w-[220px] flex-1" value={service.apiKey} placeholder="API Key，留空表示不修改" onChange={(event) => patchSearchService(index, { apiKey: event.target.value })} />
                                    <InputNumber className="w-28" min={1} precision={0} prefix={<span className="text-xs text-stone-500">权重</span>} value={service.weight} onChange={(value) => patchSearchService(index, { weight: Math.max(1, Number(value) || 1) })} />
                                    <Button danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => patchSearch({ services: search.services.filter((_, current) => current !== index) })} />
                                </div>
                                <Input className="mt-2" value={service.baseUrl} placeholder="接口地址，留空用服务商官方地址" onChange={(event) => patchSearchService(index, { baseUrl: event.target.value })} />
                            </div>
                        ))
                    ) : (
                        <div className="py-4 text-center text-sm text-stone-500">还没有配置搜索服务，新增一条并填好 API Key 后 Agent 才能联网。</div>
                    )}
                </div>
                {/*
                 * 服务端读取时会把 apiKey 抹成空串，前端没法直接判断「配没配 key」，
                 * 只能看公开配置里由「开关打开 + 至少一条可用服务」推导出来的 agent.searchEnabled。
                 * 它反映的是已保存的配置，所以文案统一说「当前」，避免和还没保存的草稿混淆。
                 */}
                <p className={`mt-3 text-xs ${agent.searchEnabled ? "text-stone-500" : "text-amber-600 dark:text-amber-500"}`}>
                    {agent.searchEnabled
                        ? "当前联网搜索已生效，Agent 可以调用搜索与读取网页工具。"
                        : "当前联网搜索不会生效：服务端只有在开关打开、且至少有一条启用并填了 API Key 的服务时，才会把联网工具下发给 Agent。填好后保存，这条提示会变为已生效。"}
                </p>
            </section>

            <section className={sectionClass}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">模型算力点成本</h2>
                        <p className="mt-0.5 text-xs text-stone-500">未配置的模型按 0 算力点计费；画质档位加价叠加在基础价上，不是替代。</p>
                    </div>
                    <Button icon={<Plus className="size-4" />} onClick={() => patchModelChannel({ modelCosts: [...modelChannel.modelCosts, { model: "", credits: 0 }] })}>
                        新增
                    </Button>
                </div>
                <div className="mt-3 space-y-2">
                    {modelChannel.modelCosts.length ? (
                        modelChannel.modelCosts.map((cost, index) => (
                            <div key={index} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                <div className="flex items-center gap-2">
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
                                        onChange={(value) => patchCost(index, { model: value || "" })}
                                    />
                                    <InputNumber className="w-32" min={0} precision={0} value={cost.credits} suffix="点" onChange={(value) => patchCost(index, { credits: value || 0 })} />
                                    <Button danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => patchModelChannel({ modelCosts: modelChannel.modelCosts.filter((_, current) => current !== index) })} />
                                </div>
                                {models.find((model) => model.name === cost.model)?.capability === "image" ? (
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <span className="text-xs text-stone-500">画质档位加价</span>
                                        {imageQualityOptions.map((option) => (
                                            <InputNumber
                                                key={option.value}
                                                size="small"
                                                className="w-32"
                                                min={0}
                                                precision={0}
                                                prefix={<span className="text-xs text-stone-500">{option.label}</span>}
                                                value={cost.qualityCredits?.[option.value] || 0}
                                                onChange={(value) => patchCost(index, { qualityCredits: { ...cost.qualityCredits, [option.value]: value || 0 } })}
                                            />
                                        ))}
                                    </div>
                                ) : null}
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
                <div className="mt-4 rounded-lg bg-stone-100 px-3 py-2.5 dark:bg-white/5">
                    <span className="block text-sm font-medium">回调地址</span>
                    <Typography.Paragraph className="!mb-1 !mt-1 !text-sm" copyable={{ text: oauthCallbackUrl }}>
                        <code className="break-all">{oauthCallbackUrl}</code>
                    </Typography.Paragraph>
                    <span className="block text-xs text-stone-500">
                        在 Linux.do 的 OAuth 应用里把回调地址填成这个。地址取自当前访问的域名，如果站点通过反向代理对外提供服务，请确认这里显示的就是用户实际访问的地址，并与服务端 <code>PUBLIC_BASE_URL</code> 保持一致。
                    </span>
                </div>
            </section>

            <section className={sectionClass}>
                <h2 className="text-sm font-semibold">存储与提示词同步</h2>
                <div className="mt-3 flex flex-wrap items-center gap-6">
                    <div className="flex items-center gap-2">
                        <Switch checked={storage.remoteEnabled} onChange={(checked) => patchStorage(checked)} />
                        <span className="text-sm">启用云端存储</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Switch checked={promptSync.enabled} onChange={(enabled) => patchPrivate({ promptSync: { ...promptSync, enabled } })} />
                        <span className="text-sm">定时同步远程提示词</span>
                    </div>
                </div>
                <label className="mt-4 block max-w-xs">
                    <span className="mb-1 block text-sm font-medium">新账号默认云空间</span>
                    <InputNumber className="w-full" min={1} precision={0} suffix="MB" value={Math.round(storage.defaultQuota / 1024 / 1024)} onChange={(value) => patchStorage(storage.remoteEnabled, Math.max(1, Number(value) || 1) * 1024 * 1024)} />
                    <span className="mt-1 block text-xs text-stone-500">只影响之后注册的账号；已有账号请到用户管理里单独调整。</span>
                </label>
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
