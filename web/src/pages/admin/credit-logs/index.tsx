import { useQuery } from "@tanstack/react-query";
import { App, Button, Form, Input, InputNumber, Modal, Select, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminCreditLog, type AdminQuery } from "@/services/api/admin";

const typeOptions = [
    { label: "后台调整", value: "admin_adjust" },
    { label: "AI 消耗", value: "ai_consume" },
    { label: "失败返还", value: "ai_refund" },
];

const typeLabel = (type: string) => typeOptions.find((item) => item.value === type)?.label || type;

export default function AdminCreditLogsPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const [form] = Form.useForm<Partial<AdminCreditLog>>();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [creating, setCreating] = useState(false);
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-credit-logs", query], queryFn: () => adminApi.creditLogs(query) });

    useEffect(() => {
        if (!creating) return;
        form.resetFields();
        form.setFieldsValue({ type: "admin_adjust", amount: 0, balance: 0 });
    }, [creating, form]);

    const submit = async () => {
        const values = await form.validateFields();
        if (await runAction(() => adminApi.saveCreditLog(values), "已新增流水")) {
            setCreating(false);
            await refetch();
        }
    };

    const confirmDelete = (log: AdminCreditLog) =>
        modal.confirm({
            title: "删除这条算力点流水？",
            content: "删除后仅影响流水记录，不会回滚用户余额。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deleteCreditLog(log.id), "已删除")) await refetch();
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">算力点流水</h1>
                    <p className="mt-0.5 text-xs text-stone-500">记录后台调整、AI 消耗与失败返还，余额以用户表为准。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-64"
                        allowClear
                        value={keyword}
                        placeholder="搜索用户 ID / 类型 / 备注"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                        新增流水
                    </Button>
                </div>
            </div>

            <Table<AdminCreditLog>
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
                    showTotal: (total) => `共 ${total} 条流水`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "时间",
                        dataIndex: "createdAt",
                        width: 150,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "用户 ID",
                        dataIndex: "userId",
                        width: 190,
                        render: (value: string) => <span className="truncate text-xs">{value || "-"}</span>,
                    },
                    {
                        title: "类型",
                        dataIndex: "type",
                        width: 110,
                        render: (value: string) => <Tag className="m-0">{typeLabel(value)}</Tag>,
                    },
                    {
                        title: "变动",
                        dataIndex: "amount",
                        width: 90,
                        render: (value: number) => <span className={`tabular-nums ${value < 0 ? "text-red-500" : "text-emerald-600"}`}>{value > 0 ? `+${value}` : value}</span>,
                    },
                    {
                        title: "余额",
                        dataIndex: "balance",
                        width: 90,
                        render: (value: number) => <span className="tabular-nums">{value}</span>,
                    },
                    {
                        title: "备注",
                        dataIndex: "remark",
                        render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 70,
                        align: "right",
                        render: (_, item) => <Button size="small" type="text" danger title="删除" icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)} />,
                    },
                ]}
            />

            <Modal open={creating} title="新增算力点流水" okText="保存" cancelText="取消" onOk={submit} onCancel={() => setCreating(false)}>
                <div className="mt-4 text-sm text-stone-500">手动补录流水不会改变用户余额，需要改余额请到用户管理里调整算力点。</div>
                <Form form={form} layout="vertical" className="mt-3">
                    <Form.Item name="userId" label="用户 ID" rules={[{ required: true, message: "请输入用户 ID" }]}>
                        <Input placeholder="user-xxxx" />
                    </Form.Item>
                    <Form.Item name="type" label="类型">
                        <Select options={typeOptions} />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name="amount" label="变动值" extra="消耗填负数">
                            <InputNumber className="w-full" precision={0} />
                        </Form.Item>
                        <Form.Item name="balance" label="变动后余额">
                            <InputNumber className="w-full" min={0} precision={0} />
                        </Form.Item>
                    </div>
                    <Form.Item name="remark" label="备注">
                        <Input placeholder="可选" />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
