import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Modal, Select, Switch, Table, Tag } from "antd";
import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { teamApi, type TeamInvite, type TeamInviteCreated, type TeamRole } from "@/services/api/teams";
import { canManageInvites } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

/** 邀请链接的完整地址由前端拼：服务端只发 token，落到哪个域名它并不知道。 */
const inviteLink = (token: string) => `${window.location.origin}/join/${token}`;

export default function TeamInvitesPage() {
    const { team } = useTeamContext();
    const { message, modal } = App.useApp();
    const { t, i18n } = useTranslation();
    const copyText = useCopyText();
    const [role, setRole] = useState<TeamRole>("member");
    const [creating, setCreating] = useState(false);
    // 刚创建的链接单独留一份：token 明文只在这一次响应里出现，服务端之后只剩哈希，
    // 关掉这个弹窗就再也拿不回来，所以必须当场给用户复制走的机会。
    const [created, setCreated] = useState<TeamInviteCreated | null>(null);
    const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ["team-invites", team.id], queryFn: () => teamApi.invites(team.id), enabled: canManageInvites(team.myRole) });
    const roleOptions: Array<{ value: TeamRole; label: string }> = ["admin", "member", "viewer"].map((value) => ({ value: value as TeamRole, label: t(`teams.roles.${value}`) }));

    if (!canManageInvites(team.myRole)) return <div className="py-16 text-center text-sm text-stone-500">{t("teams.invites.accessDenied")}</div>;

    const create = async (kind: "link" | "code") => {
        setCreating(true);
        try {
            const invite = await teamApi.createInvite(team.id, { kind, role });
            await refetch();
            if (kind === "link") setCreated(invite);
            else message.success(t("teams.invites.codeCreated"));
        } catch (createError) {
            message.error(createError instanceof Error ? createError.message : t("teams.invites.createFailed"));
        } finally {
            setCreating(false);
        }
    };

    const toggle = async (invite: TeamInvite, enabled: boolean) => {
        try {
            await teamApi.updateInvite(team.id, invite.id, { enabled });
            message.success(t(enabled ? "teams.invites.enabled" : "teams.invites.disabled"));
            await refetch();
        } catch (toggleError) {
            message.error(toggleError instanceof Error ? toggleError.message : t("teams.invites.saveFailed"));
        }
    };

    const confirmDelete = (invite: TeamInvite) =>
        modal.confirm({
            title: t("teams.invites.deleteTitle"),
            content: t("teams.invites.deleteDescription"),
            okText: t("teams.invites.deleteConfirm"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                try {
                    await teamApi.deleteInvite(team.id, invite.id);
                    message.success(t("teams.invites.deleted"));
                    await refetch();
                } catch (deleteError) {
                    message.error(deleteError instanceof Error ? deleteError.message : t("teams.invites.deleteFailed"));
                }
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("teams.invites.title")}</h2>
                    <p className="mt-0.5 text-xs text-stone-500">{t("teams.invites.description")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select className="w-32" value={role} options={roleOptions} onChange={setRole} aria-label={t("teams.invites.selectRole")} />
                    <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()}>
                        {t("teams.common.refresh")}
                    </Button>
                    <Button loading={creating} onClick={() => void create("code")}>
                        {t("teams.invites.createCode")}
                    </Button>
                    <Button type="primary" loading={creating} onClick={() => void create("link")}>
                        {t("teams.invites.createLink")}
                    </Button>
                </div>
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : t("teams.invites.loadFailed")}</div> : null}

            <Table<TeamInvite>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isPending}
                pagination={false}
                locale={{ emptyText: t("teams.invites.empty") }}
                dataSource={data || []}
                columns={[
                    {
                        title: t("teams.invites.columns.credential"),
                        dataIndex: "kind",
                        render: (kind: string, item) =>
                            kind === "code" ? (
                                <div className="flex items-center gap-1">
                                    <span className="font-mono text-sm" data-testid="team-invite-code">
                                        {item.code}
                                    </span>
                                    <Button size="small" type="text" title={t("teams.invites.copyCode")} aria-label={t("teams.invites.copyCode")} icon={<Copy className="size-3.5" />} onClick={() => copyText(item.code)} />
                                </div>
                            ) : (
                                <span className="text-sm text-stone-500">{t("teams.invites.linkSummary", { prefix: item.tokenPrefix })}</span>
                            ),
                    },
                    { title: t("teams.invites.columns.role"), dataIndex: "role", width: 90, render: (value: TeamRole) => t(`teams.roles.${value}`, { defaultValue: value }) },
                    {
                        title: t("teams.invites.columns.usedLimit"),
                        dataIndex: "usedCount",
                        width: 110,
                        render: (usedCount: number, item) => (
                            <span className="tabular-nums">
                                {usedCount} / {item.maxUses ? item.maxUses : t("teams.common.unlimited")}
                            </span>
                        ),
                    },
                    {
                        title: t("teams.invites.columns.status"),
                        dataIndex: "enabled",
                        width: 130,
                        render: (enabled: boolean, item) => (
                            <div className="flex items-center gap-2">
                                <Switch size="small" checked={enabled} aria-label={t("teams.invites.toggleAria")} onChange={(checked) => void toggle(item, checked)} />
                                {item.maxUses > 0 && item.usedCount >= item.maxUses ? <Tag className="m-0">{t("teams.invites.exhausted")}</Tag> : null}
                            </div>
                        ),
                    },
                    {
                        title: t("teams.invites.columns.createdAt"),
                        dataIndex: "createdAt",
                        width: 180,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : "-"}</span>,
                    },
                    {
                        title: t("teams.invites.columns.actions"),
                        width: 90,
                        align: "right",
                        render: (_, item) => (
                            <Button size="small" type="text" danger onClick={() => confirmDelete(item)}>
                                {t("teams.invites.deleteConfirm")}
                            </Button>
                        ),
                    },
                ]}
            />

            <Modal
                open={Boolean(created)}
                title={t("teams.invites.generatedTitle")}
                onCancel={() => setCreated(null)}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => setCreated(null)}>{t("teams.invites.close")}</Button>
                        <Button type="primary" icon={<Copy className="size-4" />} onClick={() => copyText(inviteLink(created?.token || ""), t("teams.invites.copiedLink"))}>
                            {t("teams.invites.copyLink")}
                        </Button>
                    </div>
                }
            >
                <p className="mt-4 text-sm text-stone-500">{t("teams.invites.onceDescription")}</p>
                <Input className="mt-3" readOnly value={created ? inviteLink(created.token) : ""} aria-label={t("teams.invites.linkAria")} />
            </Modal>
        </div>
    );
}
