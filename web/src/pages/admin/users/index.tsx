import { useQuery } from "@tanstack/react-query";
import { App, Button, Form, Input, InputNumber, Modal, Select, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Coins, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminQuery, type AdminUser } from "@/services/api/admin";

const roleOptions = [
    { label: "普通用户", value: "user" },
    { label: "管理员", value: "admin" },
];

const statusOptions = [
    { label: "正常", value: "active" },
    { label: "禁用", value: "ban" },
];

type UserForm = Partial<AdminUser> & { password?: string };

export default function AdminUsersPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const [form] = Form.useForm<UserForm>();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [editing, setEditing] = useState<UserForm | null>(null);
    const [creditTarget, setCreditTarget] = useState<AdminUser | null>(null);
    const [credits, setCredits] = useState(0);
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-users", query], queryFn: () => adminApi.users(query) });

    useEffect(() => {
        if (!editing) return;
        form.resetFields();
        form.setFieldsValue({ role: "user", status: "active", ...editing });
    }, [editing, form]);

    const submit = async () => {
        const values = await form.validateFields();
        if (await runAction(() => adminApi.saveUser({ ...editing, ...values }), "已保存")) {
            setEditing(null);
            await refetch();
        }
    };

    const openCredits = (user: AdminUser) => {
        setCredits(user.credits);
        setCreditTarget(user);
    };

    const submitCredits = async () => {
        if (!creditTarget) return;
        if (await runAction(() => adminApi.setUserCredits(creditTarget.id, credits), "算力点已更新")) {
            setCreditTarget(null);
            await refetch();
        }
    };

    const confirmDelete = (user: AdminUser) =>
        modal.confirm({
            title: `删除用户「${user.username}」？`,
            content: "该用户及其登录状态会被移除，操作不可恢复。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deleteUser(user.id), "已删除")) await refetch();
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">用户管理</h1>
                    <p className="mt-0.5 text-xs text-stone-500">管理账号、角色、状态与算力点余额。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-64"
                        allowClear
                        value={keyword}
                        placeholder="搜索用户名 / 昵称 / 邮箱"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>
                        新建用户
                    </Button>
                </div>
            </div>

            <Table<AdminUser>
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
                    showTotal: (total) => `共 ${total} 个用户`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "用户",
                        dataIndex: "username",
                        render: (username: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate font-medium">{username}</div>
                                <div className="mt-0.5 truncate text-xs text-stone-500">{item.displayName || item.email || item.id}</div>
                            </div>
                        ),
                    },
                    {
                        title: "角色",
                        dataIndex: "role",
                        width: 96,
                        render: (role: string) => <Tag className="m-0">{role === "admin" ? "管理员" : "普通用户"}</Tag>,
                    },
                    {
                        title: "状态",
                        dataIndex: "status",
                        width: 88,
                        render: (status: string) => (
                            <Tag className="m-0" color={status === "ban" ? "error" : "success"}>
                                {status === "ban" ? "禁用" : "正常"}
                            </Tag>
                        ),
                    },
                    {
                        title: "算力点",
                        dataIndex: "credits",
                        width: 90,
                        render: (value: number) => <span className="tabular-nums">{value}</span>,
                    },
                    {
                        title: "邀请码 / 邀请数",
                        dataIndex: "affCode",
                        width: 140,
                        render: (affCode: string, item) => (
                            <span className="text-xs text-stone-500">
                                {affCode || "-"} · {item.affCount}
                            </span>
                        ),
                    },
                    {
                        title: "最后登录",
                        dataIndex: "lastLoginAt",
                        width: 140,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 140,
                        align: "right",
                        render: (_, item) => (
                            <div className="flex justify-end gap-1">
                                <Button size="small" type="text" title="调整算力点" icon={<Coins className="size-3.5" />} onClick={() => openCredits(item)} />
                                <Button size="small" type="text" title="编辑" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(item)} />
                                <Button size="small" type="text" danger title="删除" icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)} />
                            </div>
                        ),
                    },
                ]}
            />

            <Modal open={Boolean(editing)} title={editing?.id ? "编辑用户" : "新建用户"} okText="保存" cancelText="取消" onOk={submit} onCancel={() => setEditing(null)}>
                <Form form={form} layout="vertical" className="mt-4">
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input placeholder="用户名，不能包含空格" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={editing?.id ? [] : [{ required: true, message: "请输入密码" }]} extra={editing?.id ? "留空表示不修改密码" : undefined}>
                        <Input.Password autoComplete="new-password" placeholder={editing?.id ? "留空表示不修改" : "初始密码"} />
                    </Form.Item>
                    <Form.Item name="displayName" label="昵称">
                        <Input placeholder="展示名称" />
                    </Form.Item>
                    <Form.Item name="email" label="邮箱">
                        <Input placeholder="可选" />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name="role" label="角色">
                            <Select options={roleOptions} />
                        </Form.Item>
                        <Form.Item name="status" label="状态">
                            <Select options={statusOptions} />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>

            <Modal open={Boolean(creditTarget)} title={`调整算力点 · ${creditTarget?.username || ""}`} okText="保存" cancelText="取消" onOk={submitCredits} onCancel={() => setCreditTarget(null)}>
                <div className="mt-4 text-sm text-stone-500">直接设置余额的绝对值，服务端会自动记录一条后台调整流水。</div>
                <InputNumber className="mt-3 w-full" min={0} precision={0} value={credits} onChange={(value) => setCredits(value || 0)} />
            </Modal>
        </div>
    );
}
