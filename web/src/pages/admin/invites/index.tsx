import { useQuery } from "@tanstack/react-query";
import { App, Button, Drawer, Empty, Form, Input, InputNumber, Modal, Switch, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Copy, History, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminInvite, type AdminInviteBatch, type AdminQuery } from "@/services/api/admin";

/** 批量生成的默认值：一次 10 个、一码一用、不额外赠送算力点。 */
const defaultBatch: AdminInviteBatch = { count: 10, maxUses: 1, credits: 0, note: "" };

type InviteEdit = Pick<AdminInvite, "maxUses" | "credits" | "note">;

export default function AdminInvitesPage() {
    const { message, modal } = App.useApp();
    const runAction = useAdminAction();
    const copyText = useCopyText();
    const [batchForm] = Form.useForm<AdminInviteBatch>();
    const [editForm] = Form.useForm<InviteEdit>();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [batching, setBatching] = useState(false);
    const [generating, setGenerating] = useState(false);
    // 刚生成的这一批单独留一份：列表按创建时间分页，翻几页之后就再也凑不齐这一批，
    // 而邀请码是要发出去的，必须给管理员一次性复制走的机会。
    const [generated, setGenerated] = useState<AdminInvite[]>([]);
    const [editing, setEditing] = useState<AdminInvite | null>(null);
    const [usesCode, setUsesCode] = useState("");
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-invites", query], queryFn: () => adminApi.invites(query) });
    const uses = useQuery({ queryKey: ["admin-invite-uses", usesCode], queryFn: () => adminApi.inviteUses(usesCode), enabled: Boolean(usesCode) });

    useEffect(() => {
        if (batching) batchForm.setFieldsValue(defaultBatch);
    }, [batching, batchForm]);

    useEffect(() => {
        if (editing) editForm.setFieldsValue({ maxUses: editing.maxUses, credits: editing.credits, note: editing.note });
    }, [editing, editForm]);

    // 这里要拿到新生成的码本身，不能只知道成功与否，所以没走 runAction。
    const submitBatch = async () => {
        const values = await batchForm.validateFields();
        setGenerating(true);
        try {
            const items = await adminApi.createInvites(values);
            setBatching(false);
            setGenerated(items);
            message.success(`已生成 ${items.length} 个邀请码`);
            await refetch();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成邀请码失败");
        } finally {
            setGenerating(false);
        }
    };

    const submitEdit = async () => {
        if (!editing) return;
        const values = await editForm.validateFields();
        if (await runAction(() => adminApi.saveInvite(editing.code, values), "已保存")) {
            setEditing(null);
            await refetch();
        }
    };

    const toggle = async (invite: AdminInvite, enabled: boolean) => {
        if (await runAction(() => adminApi.saveInvite(invite.code, { enabled }), enabled ? "已启用" : "已禁用")) await refetch();
    };

    const confirmDelete = (invite: AdminInvite) =>
        modal.confirm({
            title: `删除邀请码「${invite.code}」？`,
            content: "删除后该码立即失效，已经用它注册的账号不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deleteInvite(invite.code), "已删除")) await refetch();
            },
        });

    const generatedText = generated.map((item) => item.code).join("\n");

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">邀请码</h1>
                    <p className="mt-0.5 text-xs text-stone-500">开启「注册需要邀请码」后，注册与第三方首次建号都要凭这里的码。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-64"
                        allowClear
                        value={keyword}
                        placeholder="搜索邀请码 / 备注"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()} title="刷新">
                        刷新
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setBatching(true)}>
                        批量生成
                    </Button>
                </div>
            </div>

            <Table<AdminInvite>
                className="mt-4"
                rowKey="code"
                size="small"
                loading={isFetching}
                dataSource={data?.items || []}
                pagination={{
                    current: query.page,
                    pageSize: query.pageSize,
                    total: data?.total || 0,
                    size: "small",
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 个邀请码`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "邀请码",
                        dataIndex: "code",
                        render: (code: string) => (
                            <div className="flex items-center gap-1">
                                <span className="font-mono text-sm">{code}</span>
                                <Button size="small" type="text" title="复制" icon={<Copy className="size-3.5" />} onClick={() => copyText(code)} />
                            </div>
                        ),
                    },
                    {
                        title: "已用 / 上限",
                        dataIndex: "usedCount",
                        width: 110,
                        render: (usedCount: number, item) => (
                            <span className="tabular-nums">
                                {usedCount} / {item.maxUses ? item.maxUses : "不限"}
                            </span>
                        ),
                    },
                    {
                        title: "赠送算力点",
                        dataIndex: "credits",
                        width: 100,
                        render: (value: number) => <span className="tabular-nums">{value || 0}</span>,
                    },
                    {
                        title: "状态",
                        dataIndex: "enabled",
                        width: 130,
                        render: (enabled: boolean, item) => (
                            <div className="flex items-center gap-2">
                                <Switch size="small" checked={enabled} onChange={(checked) => void toggle(item, checked)} />
                                {item.maxUses > 0 && item.usedCount >= item.maxUses ? (
                                    <Tag className="m-0" color="default">
                                        已用完
                                    </Tag>
                                ) : null}
                            </div>
                        ),
                    },
                    {
                        title: "备注",
                        dataIndex: "note",
                        render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span>,
                    },
                    {
                        title: "创建时间",
                        dataIndex: "createdAt",
                        width: 140,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 130,
                        align: "right",
                        render: (_, item) => (
                            <div className="flex justify-end gap-1">
                                <Button size="small" type="text" title="使用记录" icon={<History className="size-3.5" />} onClick={() => setUsesCode(item.code)} />
                                <Button size="small" type="text" title="编辑" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(item)} />
                                <Button size="small" type="text" danger title="删除" icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)} />
                            </div>
                        ),
                    },
                ]}
            />

            <Modal open={batching} title="批量生成邀请码" okText="生成" cancelText="取消" confirmLoading={generating} onOk={submitBatch} onCancel={() => setBatching(false)}>
                <div className="mt-4 text-sm text-stone-500">码值由服务端随机生成，这批码共用下面的次数、算力点与备注。</div>
                <Form form={batchForm} layout="vertical" className="mt-3" initialValues={defaultBatch}>
                    <div className="grid grid-cols-3 gap-4">
                        <Form.Item name="count" label="生成数量" rules={[{ required: true, message: "请输入数量" }]}>
                            <InputNumber className="w-full" min={1} max={200} precision={0} suffix="个" />
                        </Form.Item>
                        <Form.Item name="maxUses" label="每码可用次数" extra="填 0 表示不限次数">
                            <InputNumber className="w-full" min={0} precision={0} suffix="次" />
                        </Form.Item>
                        <Form.Item name="credits" label="赠送算力点">
                            <InputNumber className="w-full" min={0} precision={0} suffix="点" />
                        </Form.Item>
                    </div>
                    <Form.Item name="note" label="备注" extra="只给管理员看，用来记这批码发给了谁">
                        <Input placeholder="可选" />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={Boolean(generated.length)}
                title={`已生成 ${generated.length} 个邀请码`}
                onCancel={() => setGenerated([])}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => setGenerated([])}>关闭</Button>
                        <Button type="primary" icon={<Copy className="size-4" />} onClick={() => copyText(generatedText, `已复制 ${generated.length} 个邀请码`)}>
                            复制全部
                        </Button>
                    </div>
                }
            >
                <div className="mt-4 text-sm text-stone-500">每行一个码，关掉后可以在列表里逐个复制，但没法再一次性拿到这一批。</div>
                <Input.TextArea className="mt-3 !font-mono" readOnly rows={8} value={generatedText} />
            </Modal>

            <Modal open={Boolean(editing)} title={`编辑邀请码 · ${editing?.code || ""}`} okText="保存" cancelText="取消" onOk={submitEdit} onCancel={() => setEditing(null)}>
                <Form form={editForm} layout="vertical" className="mt-4">
                    <div className="grid grid-cols-2 gap-4">
                        {/* 服务端把 0 当作不限次，其余值不接受改到已用次数以下，这里同步限制，省得填了保存又被顶回来。 */}
                        <Form.Item
                            name="maxUses"
                            label="可用次数"
                            extra={`已用 ${editing?.usedCount || 0} 次，填 0 表示不限，其余值不能低于已用次数`}
                            rules={[
                                {
                                    validator: (_, value) => (value === 0 || value >= (editing?.usedCount || 0) ? Promise.resolve() : Promise.reject(new Error("填 0 表示不限，其余值不能低于已用次数"))),
                                },
                            ]}
                        >
                            <InputNumber className="w-full" min={0} precision={0} suffix="次" />
                        </Form.Item>
                        <Form.Item name="credits" label="赠送算力点" extra="只对之后的兑换生效">
                            <InputNumber className="w-full" min={0} precision={0} suffix="点" />
                        </Form.Item>
                    </div>
                    <Form.Item name="note" label="备注">
                        <Input placeholder="可选" />
                    </Form.Item>
                </Form>
            </Modal>

            <Drawer open={Boolean(usesCode)} size={520} title={`使用记录 · ${usesCode}`} onClose={() => setUsesCode("")}>
                {uses.isFetching && !uses.data ? <div className="py-10 text-center text-sm text-stone-500">加载中…</div> : null}
                {uses.data && !uses.data.items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个码还没有人用过" /> : null}
                {uses.data?.items.length ? (
                    <Table
                        rowKey={(item) => `${item.userId}-${item.usedAt}`}
                        size="small"
                        pagination={false}
                        dataSource={uses.data.items}
                        columns={[
                            {
                                title: "用户",
                                dataIndex: "username",
                                render: (username: string, item) => (
                                    <div className="min-w-0">
                                        <div className="truncate text-sm">{username || "-"}</div>
                                        {item.displayName ? <div className="mt-0.5 truncate text-xs text-stone-500">{item.displayName}</div> : null}
                                    </div>
                                ),
                            },
                            {
                                title: "赠送算力点",
                                dataIndex: "credits",
                                width: 90,
                                render: (value: number) => <span className="tabular-nums">{value || 0}</span>,
                            },
                            {
                                title: "使用时间",
                                dataIndex: "usedAt",
                                width: 150,
                                render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                            },
                        ]}
                    />
                ) : null}
            </Drawer>
        </div>
    );
}
