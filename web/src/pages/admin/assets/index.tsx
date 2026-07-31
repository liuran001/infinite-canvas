import { useQuery } from "@tanstack/react-query";
import { App, Button, Form, Input, Modal, Select, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminAsset, type AdminQuery } from "@/services/api/admin";

const typeOptions = [
    { label: "图片", value: "image" },
    { label: "文本", value: "text" },
];

export default function AdminAssetsPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const [form] = Form.useForm<Partial<AdminAsset>>();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [editing, setEditing] = useState<Partial<AdminAsset> | null>(null);
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-assets", query], queryFn: () => adminApi.assets(query) });
    const editingType = Form.useWatch("type", form);

    useEffect(() => {
        if (!editing) return;
        form.resetFields();
        form.setFieldsValue({ type: "image", tags: [], ...editing });
    }, [editing, form]);

    const submit = async () => {
        const values = await form.validateFields();
        if (await runAction(() => adminApi.saveAsset({ ...editing, ...values }), "已保存")) {
            setEditing(null);
            await refetch();
        }
    };

    const confirmDelete = (asset: AdminAsset) =>
        modal.confirm({
            title: `删除素材「${asset.title || asset.id}」？`,
            content: "所有用户都将不再看到该素材，操作不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deleteAsset(asset.id), "已删除")) await refetch();
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">素材</h1>
                    <p className="mt-0.5 text-xs text-stone-500">管理后台维护的公共素材，所有用户可见。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-56"
                        allowClear
                        value={keyword}
                        placeholder="搜索标题 / 描述 / 内容"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Select className="w-28" value={query.type || ""} options={[{ label: "全部类型", value: "" }, ...typeOptions]} onChange={(value) => setQuery((current) => ({ ...current, type: value, page: 1 }))} />
                    <Select
                        className="w-48"
                        mode="multiple"
                        allowClear
                        maxTagCount="responsive"
                        placeholder="全部标签"
                        value={query.tag || []}
                        options={(data?.tags || []).map((tag) => ({ label: tag, value: tag }))}
                        onChange={(value) => setQuery((current) => ({ ...current, tag: value, page: 1 }))}
                    />
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
                        新建素材
                    </Button>
                </div>
            </div>

            <Table<AdminAsset>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isFetching}
                dataSource={data?.items || []}
                pagination={{
                    current: query.page,
                    pageSize: query.pageSize,
                    total: data?.total || 0,
                    size: "small",
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 个素材`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "封面",
                        dataIndex: "coverUrl",
                        width: 72,
                        render: (coverUrl: string) => (coverUrl ? <img src={coverUrl} alt="" className="size-12 rounded object-cover" /> : <div className="size-12 rounded bg-stone-100 dark:bg-stone-800" />),
                    },
                    {
                        title: "标题",
                        dataIndex: "title",
                        render: (title: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate font-medium">{title || "未命名"}</div>
                                <div className="mt-0.5 line-clamp-2 text-xs text-stone-500">{item.description || item.content || item.url}</div>
                            </div>
                        ),
                    },
                    {
                        title: "类型",
                        dataIndex: "type",
                        width: 80,
                        render: (type: string) => <Tag className="m-0">{type === "image" ? "图片" : "文本"}</Tag>,
                    },
                    {
                        title: "分类",
                        dataIndex: "category",
                        width: 120,
                        render: (category: string) => <span className="text-xs text-stone-500">{category || "-"}</span>,
                    },
                    {
                        title: "标签",
                        dataIndex: "tags",
                        width: 180,
                        render: (tags: string[]) => (
                            <div className="flex flex-wrap gap-1">
                                {(tags || []).slice(0, 3).map((tag) => (
                                    <Tag key={tag} className="m-0">
                                        {tag}
                                    </Tag>
                                ))}
                            </div>
                        ),
                    },
                    {
                        title: "更新时间",
                        dataIndex: "updatedAt",
                        width: 140,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 100,
                        align: "right",
                        render: (_, item) => (
                            <div className="flex justify-end gap-1">
                                <Button size="small" type="text" title="编辑" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(item)} />
                                <Button size="small" type="text" danger title="删除" icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)} />
                            </div>
                        ),
                    },
                ]}
            />

            <Modal open={Boolean(editing)} width={640} title={editing?.id ? "编辑素材" : "新建素材"} okText="保存" cancelText="取消" onOk={submit} onCancel={() => setEditing(null)}>
                <Form form={form} layout="vertical" className="mt-4">
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入标题" }]}>
                            <Input placeholder="素材标题" />
                        </Form.Item>
                        <Form.Item name="type" label="类型">
                            <Select options={typeOptions} />
                        </Form.Item>
                    </div>
                    {editingType === "image" ? (
                        <Form.Item name="url" label="图片地址" rules={[{ required: true, message: "请输入图片地址" }]}>
                            <Input placeholder="https://..." />
                        </Form.Item>
                    ) : (
                        <Form.Item name="content" label="文本内容" rules={[{ required: true, message: "请输入文本内容" }]}>
                            <Input.TextArea rows={6} placeholder="素材正文" />
                        </Form.Item>
                    )}
                    <Form.Item name="coverUrl" label="封面地址" extra="留空时图片素材会自动使用图片地址">
                        <Input placeholder="https://..." />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name="category" label="分类">
                            <Input placeholder="可选" />
                        </Form.Item>
                        <Form.Item name="tags" label="标签">
                            <Select mode="tags" placeholder="回车添加标签" />
                        </Form.Item>
                    </div>
                    <Form.Item name="description" label="描述">
                        <Input.TextArea rows={2} placeholder="可选" />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
