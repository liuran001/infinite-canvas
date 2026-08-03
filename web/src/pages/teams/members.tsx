import { useQuery } from "@tanstack/react-query";
import { App, Button, Form, InputNumber, Modal, Select, Table, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { teamApi, type TeamLimitWindow, type TeamMemberView, type TeamRole } from "@/services/api/teams";
import { canManageMembers } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

const windowLabels: Record<TeamLimitWindow, string> = { day: "每天", month: "每月", total: "累计" };
const roleOptions: Array<{ value: TeamRole; label: string }> = [
    { value: "admin", label: "管理员" },
    { value: "member", label: "成员" },
    { value: "viewer", label: "只读" },
];

type MemberEdit = { role: TeamRole; creditLimit: number; limitWindow: TeamLimitWindow; status: "active" | "suspended" };

export default function TeamMembersPage() {
    const { team } = useTeamContext();
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<MemberEdit>();
    const [editing, setEditing] = useState<TeamMemberView | null>(null);
    const [saving, setSaving] = useState(false);
    const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ["team-members", team.id], queryFn: () => teamApi.members(team.id) });
    const manageable = canManageMembers(team.myRole);

    useEffect(() => {
        if (editing) form.setFieldsValue({ role: editing.role, creditLimit: editing.creditLimit, limitWindow: editing.limitWindow, status: editing.status });
    }, [editing, form]);

    const save = async () => {
        if (!editing) return;
        setSaving(true);
        try {
            // validateFields 失败会 reject。放在 try 外面的话，点「保存」时留了一个空必填项
            // 就是一条没人接的 promise rejection，控制台报错、按钮却毫无反应。
            const values = await form.validateFields();
            // InputNumber 清空后给的是 null，直接发出去会被服务端当成缺字段或坏类型。
            // 这里的 0 就是表单上写的「填 0 表示不限」，与清空的语义一致。
            const creditLimit = Number(values.creditLimit) || 0;
            // owner 的角色不能在这里改，服务端也会拒；表单里对 owner 直接禁掉角色项，这里原样不传。
            await teamApi.updateMember(team.id, editing.userId, editing.role === "owner" ? { creditLimit, limitWindow: values.limitWindow } : { ...values, creditLimit });
            setEditing(null);
            message.success("已保存");
            await refetch();
        } catch (saveError) {
            // 校验失败由表单自己在字段下面标红，再弹一句「保存失败」只会让人以为是服务端出了问题。
            if (saveError && typeof saveError === "object" && "errorFields" in saveError) return;
            message.error(saveError instanceof Error ? saveError.message : "保存成员设置失败");
        } finally {
            setSaving(false);
        }
    };

    const confirmRemove = (member: TeamMemberView) =>
        modal.confirm({
            title: `把「${member.displayName || member.username}」移出团队？`,
            content: "移出后他不能再用团队积分，已经产生的流水保留。",
            okText: "移出",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await teamApi.removeMember(team.id, member.userId);
                    message.success("已移出团队");
                    await refetch();
                } catch (removeError) {
                    message.error(removeError instanceof Error ? removeError.message : "移除成员失败");
                }
            },
        });

    return (
        <div>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">团队成员</h2>
                    <p className="mt-0.5 text-xs text-stone-500">额度按所选周期实时统计，与实际扣费用的是同一份流水。</p>
                </div>
                <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()}>
                    刷新
                </Button>
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : "读取成员失败"}</div> : null}

            <Table<TeamMemberView>
                className="mt-4"
                rowKey="userId"
                size="small"
                loading={isPending}
                pagination={false}
                locale={{ emptyText: "还没有其他成员，去「邀请」页生成一条邀请链接吧" }}
                dataSource={data || []}
                columns={[
                    {
                        title: "成员",
                        dataIndex: "displayName",
                        render: (displayName: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate text-sm">{displayName || item.username || item.userId}</div>
                                {item.username ? <div className="mt-0.5 truncate text-xs text-stone-500">{item.username}</div> : null}
                            </div>
                        ),
                    },
                    { title: "角色", dataIndex: "role", width: 110, render: (role: TeamRole) => <span>{role}</span> },
                    {
                        title: "额度",
                        dataIndex: "creditLimit",
                        width: 170,
                        render: (creditLimit: number, item) => <span className="tabular-nums">{creditLimit ? `${item.usedCredits} / ${creditLimit}（${windowLabels[item.limitWindow]}）` : `${item.usedCredits} / 不限`}</span>,
                    },
                    { title: "状态", dataIndex: "status", width: 90, render: (status: string) => (status === "active" ? <Tag color="success">正常</Tag> : <Tag>已挂起</Tag>) },
                    { title: "加入时间", dataIndex: "joinedAt", width: 160, render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                    ...(manageable
                        ? [
                              {
                                  title: "操作",
                                  width: 150,
                                  align: "right" as const,
                                  render: (_: unknown, item: TeamMemberView) => (
                                      <div className="flex justify-end gap-1">
                                          <Button size="small" type="text" onClick={() => setEditing(item)}>
                                              设置
                                          </Button>
                                          {item.role === "owner" ? null : (
                                              <Button size="small" type="text" danger onClick={() => confirmRemove(item)}>
                                                  移出
                                              </Button>
                                          )}
                                      </div>
                                  ),
                              },
                          ]
                        : []),
                ]}
            />

            <Modal open={Boolean(editing)} title={`成员设置 · ${editing?.displayName || editing?.username || ""}`} okText="保存" cancelText="取消" confirmLoading={saving} onOk={() => void save()} onCancel={() => setEditing(null)} destroyOnHidden>
                <Form form={form} layout="vertical" className="mt-4">
                    <Form.Item name="role" label="角色" extra={editing?.role === "owner" ? "所有者的角色只能通过转让变更。" : "只有所有者可以任命管理员。"}>
                        <Select options={roleOptions} disabled={editing?.role === "owner"} aria-label="选择成员角色" />
                    </Form.Item>
                    <Form.Item name="creditLimit" label="额度上限" extra="填 0 表示不限。">
                        <InputNumber className="w-full" min={0} precision={0} suffix="点" />
                    </Form.Item>
                    <Form.Item name="limitWindow" label="额度周期">
                        <Select
                            aria-label="选择额度周期"
                            options={[
                                { value: "day", label: "每天" },
                                { value: "month", label: "每月" },
                                { value: "total", label: "累计" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="status" label="成员状态" extra={editing?.role === "owner" ? "所有者不能被挂起。" : "挂起后该成员不能用团队积分，也读不到团队数据。"}>
                        <Select
                            aria-label="选择成员状态"
                            disabled={editing?.role === "owner"}
                            options={[
                                { value: "active", label: "正常" },
                                { value: "suspended", label: "挂起" },
                            ]}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
