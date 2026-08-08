import { useQuery } from "@tanstack/react-query";
import { App, Button, Form, InputNumber, Modal, Select, Table, Tag } from "antd";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { teamApi, type TeamLimitWindow, type TeamMemberView, type TeamRole } from "@/services/api/teams";
import { canManageMembers } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

type MemberEdit = { role: TeamRole; creditLimit: number; limitWindow: TeamLimitWindow; status: "active" | "suspended" };

export default function TeamMembersPage() {
    const { team } = useTeamContext();
    const { message, modal } = App.useApp();
    const { t, i18n } = useTranslation();
    const [form] = Form.useForm<MemberEdit>();
    const [editing, setEditing] = useState<TeamMemberView | null>(null);
    const [saving, setSaving] = useState(false);
    const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ["team-members", team.id], queryFn: () => teamApi.members(team.id) });
    const manageable = canManageMembers(team.myRole);
    const roleOptions: Array<{ value: TeamRole; label: string }> = ["admin", "member", "viewer"].map((value) => ({ value: value as TeamRole, label: t(`teams.roles.${value}`) }));

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
            message.success(t("teams.members.saved"));
            await refetch();
        } catch (saveError) {
            // 校验失败由表单自己在字段下面标红，再弹一句「保存失败」只会让人以为是服务端出了问题。
            if (saveError && typeof saveError === "object" && "errorFields" in saveError) return;
            message.error(saveError instanceof Error ? saveError.message : t("teams.members.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const confirmRemove = (member: TeamMemberView) =>
        modal.confirm({
            title: t("teams.members.removeTitle", { name: member.displayName || member.username }),
            content: t("teams.members.removeDescription"),
            okText: t("teams.members.removeConfirm"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                try {
                    await teamApi.removeMember(team.id, member.userId);
                    message.success(t("teams.members.removed"));
                    await refetch();
                } catch (removeError) {
                    message.error(removeError instanceof Error ? removeError.message : t("teams.members.removeFailed"));
                }
            },
        });

    return (
        <div>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("teams.members.title")}</h2>
                    <p className="mt-0.5 text-xs text-stone-500">{t("teams.members.description")}</p>
                </div>
                <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()}>
                    {t("teams.common.refresh")}
                </Button>
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : t("teams.members.loadFailed")}</div> : null}

            <Table<TeamMemberView>
                className="mt-4"
                rowKey="userId"
                size="small"
                loading={isPending}
                pagination={false}
                locale={{ emptyText: t("teams.members.empty") }}
                dataSource={data || []}
                columns={[
                    {
                        title: t("teams.members.columns.member"),
                        dataIndex: "displayName",
                        render: (displayName: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate text-sm">{displayName || item.username || item.userId}</div>
                                {item.username ? <div className="mt-0.5 truncate text-xs text-stone-500">{item.username}</div> : null}
                            </div>
                        ),
                    },
                    { title: t("teams.members.columns.role"), dataIndex: "role", width: 110, render: (role: TeamRole) => <span>{t(`teams.roles.${role}`, { defaultValue: role })}</span> },
                    {
                        title: t("teams.members.columns.limit"),
                        dataIndex: "creditLimit",
                        width: 170,
                        render: (creditLimit: number, item) => (
                            <span className="tabular-nums">{t(creditLimit ? "teams.members.limitUsage" : "teams.members.unlimitedUsage", { used: item.usedCredits, limit: creditLimit, window: t(`teams.windows.${item.limitWindow}`) })}</span>
                        ),
                    },
                    { title: t("teams.members.columns.status"), dataIndex: "status", width: 90, render: (status: string) => (status === "active" ? <Tag color="success">{t("teams.statuses.active")}</Tag> : <Tag>{t("teams.statuses.suspended")}</Tag>) },
                    {
                        title: t("teams.members.columns.joinedAt"),
                        dataIndex: "joinedAt",
                        width: 160,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : "-"}</span>,
                    },
                    ...(manageable
                        ? [
                              {
                                  title: t("teams.members.columns.actions"),
                                  width: 150,
                                  align: "right" as const,
                                  render: (_: unknown, item: TeamMemberView) => (
                                      <div className="flex justify-end gap-1">
                                          <Button size="small" type="text" onClick={() => setEditing(item)}>
                                              {t("teams.members.settings")}
                                          </Button>
                                          {item.role === "owner" ? null : (
                                              <Button size="small" type="text" danger onClick={() => confirmRemove(item)}>
                                                  {t("teams.members.remove")}
                                              </Button>
                                          )}
                                      </div>
                                  ),
                              },
                          ]
                        : []),
                ]}
            />

            <Modal
                open={Boolean(editing)}
                title={t("teams.members.modalTitle", { name: editing?.displayName || editing?.username || "" })}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                confirmLoading={saving}
                onOk={() => void save()}
                onCancel={() => setEditing(null)}
                destroyOnHidden
            >
                <Form form={form} layout="vertical" className="mt-4">
                    <Form.Item name="role" label={t("teams.members.columns.role")} extra={t(editing?.role === "owner" ? "teams.members.ownerRoleHint" : "teams.members.adminRoleHint")}>
                        <Select options={roleOptions} disabled={editing?.role === "owner"} aria-label={t("teams.members.selectRole")} />
                    </Form.Item>
                    <Form.Item name="creditLimit" label={t("teams.members.limitLabel")} extra={t("teams.members.unlimitedHint")}>
                        <InputNumber className="w-full" min={0} precision={0} suffix={t("teams.members.creditsUnit")} />
                    </Form.Item>
                    <Form.Item name="limitWindow" label={t("teams.members.windowLabel")}>
                        <Select
                            aria-label={t("teams.members.selectWindow")}
                            options={[
                                { value: "day", label: t("teams.windows.day") },
                                { value: "month", label: t("teams.windows.month") },
                                { value: "total", label: t("teams.windows.total") },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="status" label={t("teams.members.statusLabel")} extra={t(editing?.role === "owner" ? "teams.members.ownerStatusHint" : "teams.members.statusHint")}>
                        <Select
                            aria-label={t("teams.members.selectStatus")}
                            disabled={editing?.role === "owner"}
                            options={[
                                { value: "active", label: t("teams.statuses.active") },
                                { value: "suspended", label: t("teams.statuses.suspended") },
                            ]}
                        />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
