import { useQuery } from "@tanstack/react-query";
import { App, Button, Drawer, Empty, Form, Input, Modal, Switch, Tag } from "antd";
import dayjs from "dayjs";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminPromptCategory } from "@/services/api/admin";

export function PromptCategoryDrawer({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
    const { message, modal } = App.useApp();
    const runAction = useAdminAction();
    const [form] = Form.useForm<Partial<AdminPromptCategory>>();
    const [editing, setEditing] = useState<Partial<AdminPromptCategory> | null>(null);
    const [syncing, setSyncing] = useState("");
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-prompt-categories"], queryFn: adminApi.promptCategories, enabled: open });

    useEffect(() => {
        if (!editing) return;
        form.resetFields();
        form.setFieldsValue({ remote: true, enabled: true, ...editing });
    }, [editing, form]);

    const submit = async () => {
        const values = await form.validateFields();
        if (await runAction(() => adminApi.savePromptCategory({ ...editing, ...values }), "已保存")) {
            setEditing(null);
            await refetch();
            onChanged();
        }
    };

    // 不传 category 表示同步所有启用的远程分类，失败的分类会在结果里带 error。
    const sync = async (category?: string) => {
        setSyncing(category || "all");
        try {
            const results = await adminApi.syncPromptCategories(category);
            const failed = results.filter((item) => item.success === false);
            const count = results.reduce((sum, item) => sum + item.count, 0);
            if (failed.length) message.warning(`同步完成：${results.length - failed.length} 个成功，${failed.length} 个失败 · ${failed[0].error || ""}`);
            else message.success(`同步完成，共更新 ${count} 条提示词`);
            await refetch();
            onChanged();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "同步失败");
        } finally {
            setSyncing("");
        }
    };

    const confirmDelete = (item: AdminPromptCategory) =>
        modal.confirm({
            title: `删除分类「${item.name || item.category}」？`,
            content: "该分类下的提示词会一并删除，操作不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deletePromptCategory(item.category), "已删除")) {
                    await refetch();
                    onChanged();
                }
            },
        });

    return (
        <Drawer
            open={open}
            width={640}
            title="提示词分类"
            onClose={onClose}
            extra={
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="size-3.5" />} loading={syncing === "all"} onClick={() => void sync()}>
                        同步全部远程分类
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
                        新增分类
                    </Button>
                </div>
            }
        >
            {isFetching && !data ? <div className="py-10 text-center text-sm text-stone-500">加载中…</div> : null}
            {data && !data.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无分类" /> : null}

            <div className="space-y-2">
                {(data || []).map((item) => (
                    <div key={item.category} className="rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold">{item.name || item.category}</span>
                            <Tag className="m-0 text-[10px]">{item.category}</Tag>
                            {item.remote ? <Tag className="m-0 text-[10px]">远程</Tag> : null}
                            {!item.enabled ? (
                                <Tag className="m-0 text-[10px]" color="default">
                                    已停用
                                </Tag>
                            ) : null}
                            {item.lastError ? (
                                <Tag className="m-0 text-[10px]" color="error" title={item.lastError}>
                                    上次失败
                                </Tag>
                            ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                            {item.sourceUrl ? (
                                <a className="max-w-full truncate hover:underline" href={item.sourceUrl} target="_blank" rel="noreferrer">
                                    {item.sourceUrl}
                                </a>
                            ) : (
                                <span>手工维护，无来源地址</span>
                            )}
                            <span>{item.lastSyncedAt ? `上次同步 ${dayjs(item.lastSyncedAt).format("YYYY-MM-DD HH:mm")}` : "尚未同步"}</span>
                        </div>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                            {item.sourceUrl ? (
                                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={syncing === item.category} onClick={() => void sync(item.category)}>
                                    立即同步
                                </Button>
                            ) : null}
                            <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(item)}>
                                编辑
                            </Button>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)}>
                                删除
                            </Button>
                        </div>
                    </div>
                ))}
            </div>

            <Modal open={Boolean(editing)} title={editing?.category ? "编辑分类" : "新增分类"} okText="保存" cancelText="取消" onOk={submit} onCancel={() => setEditing(null)}>
                <Form form={form} layout="vertical" className="mt-4">
                    <Form.Item name="category" label="分类编码" rules={[{ required: true, message: "请输入分类编码" }]} extra="保存后作为唯一标识，不建议再修改">
                        <Input placeholder="例如 awesome-gpt-image" disabled={Boolean(editing?.category)} />
                    </Form.Item>
                    <Form.Item name="name" label="显示名称">
                        <Input placeholder="展示给管理员的名称" />
                    </Form.Item>
                    <Form.Item name="sourceUrl" label="来源地址" extra="提示词 registry 的 JSON 地址，留空表示纯手工维护">
                        <Input placeholder="https://.../xxx.json" />
                    </Form.Item>
                    <Form.Item name="githubUrl" label="主页地址">
                        <Input placeholder="可选" />
                    </Form.Item>
                    <Form.Item name="description" label="描述">
                        <Input.TextArea rows={2} placeholder="可选" />
                    </Form.Item>
                    <div className="flex gap-8">
                        <Form.Item name="remote" label="远程分类" valuePropName="checked" extra="开启后参与定时同步">
                            <Switch />
                        </Form.Item>
                        <Form.Item name="enabled" label="启用" valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </Drawer>
    );
}
