import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Modal, Select, Switch, Table, Tag } from "antd";
import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useCopyText } from "@/hooks/use-copy-text";
import { teamApi, type TeamInvite, type TeamInviteCreated, type TeamRole } from "@/services/api/teams";
import { canManageInvites } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

const roleOptions: Array<{ value: TeamRole; label: string }> = [
    { value: "admin", label: "管理员" },
    { value: "member", label: "成员" },
    { value: "viewer", label: "只读" },
];

/** 邀请链接的完整地址由前端拼：服务端只发 token，落到哪个域名它并不知道。 */
const inviteLink = (token: string) => `${window.location.origin}/join/${token}`;

export default function TeamInvitesPage() {
    const { team } = useTeamContext();
    const { message, modal } = App.useApp();
    const copyText = useCopyText();
    const [role, setRole] = useState<TeamRole>("member");
    const [creating, setCreating] = useState(false);
    // 刚创建的链接单独留一份：token 明文只在这一次响应里出现，服务端之后只剩哈希，
    // 关掉这个弹窗就再也拿不回来，所以必须当场给用户复制走的机会。
    const [created, setCreated] = useState<TeamInviteCreated | null>(null);
    const { data, isPending, isFetching, error, refetch } = useQuery({ queryKey: ["team-invites", team.id], queryFn: () => teamApi.invites(team.id), enabled: canManageInvites(team.myRole) });

    if (!canManageInvites(team.myRole)) return <div className="py-16 text-center text-sm text-stone-500">只有团队所有者和管理员可以管理邀请。</div>;

    const create = async (kind: "link" | "code") => {
        setCreating(true);
        try {
            const invite = await teamApi.createInvite(team.id, { kind, role });
            await refetch();
            if (kind === "link") setCreated(invite);
            else message.success("邀请码已生成");
        } catch (createError) {
            message.error(createError instanceof Error ? createError.message : "创建邀请失败");
        } finally {
            setCreating(false);
        }
    };

    const toggle = async (invite: TeamInvite, enabled: boolean) => {
        try {
            await teamApi.updateInvite(team.id, invite.id, { enabled });
            message.success(enabled ? "已启用" : "已停用");
            await refetch();
        } catch (toggleError) {
            message.error(toggleError instanceof Error ? toggleError.message : "保存邀请失败");
        }
    };

    const confirmDelete = (invite: TeamInvite) =>
        modal.confirm({
            title: "删除这条邀请？",
            content: "删除后这条链接或邀请码立即失效，已经加入的成员不受影响。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await teamApi.deleteInvite(team.id, invite.id);
                    message.success("已删除");
                    await refetch();
                } catch (deleteError) {
                    message.error(deleteError instanceof Error ? deleteError.message : "删除邀请失败");
                }
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">邀请</h2>
                    <p className="mt-0.5 text-xs text-stone-500">链接只在生成那一刻显示完整地址，之后服务端只保留哈希；邀请码可以随时在下面查看和复制。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select className="w-32" value={role} options={roleOptions} onChange={setRole} aria-label="选择邀请授予的角色" />
                    <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()}>
                        刷新
                    </Button>
                    <Button loading={creating} onClick={() => void create("code")}>
                        生成邀请码
                    </Button>
                    <Button type="primary" loading={creating} onClick={() => void create("link")}>
                        生成邀请链接
                    </Button>
                </div>
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : "读取邀请失败"}</div> : null}

            <Table<TeamInvite>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isPending}
                pagination={false}
                locale={{ emptyText: "还没有邀请，点右上角生成一条" }}
                dataSource={data || []}
                columns={[
                    {
                        title: "类型 / 凭据",
                        dataIndex: "kind",
                        render: (kind: string, item) =>
                            kind === "code" ? (
                                <div className="flex items-center gap-1">
                                    <span className="font-mono text-sm" data-testid="team-invite-code">
                                        {item.code}
                                    </span>
                                    <Button size="small" type="text" title="复制邀请码" aria-label="复制邀请码" icon={<Copy className="size-3.5" />} onClick={() => copyText(item.code)} />
                                </div>
                            ) : (
                                <span className="text-sm text-stone-500">邀请链接 · {item.tokenPrefix}…（完整地址只在生成时显示一次）</span>
                            ),
                    },
                    { title: "角色", dataIndex: "role", width: 90 },
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
                        title: "状态",
                        dataIndex: "enabled",
                        width: 130,
                        render: (enabled: boolean, item) => (
                            <div className="flex items-center gap-2">
                                <Switch size="small" checked={enabled} aria-label="启用或停用这条邀请" onChange={(checked) => void toggle(item, checked)} />
                                {item.maxUses > 0 && item.usedCount >= item.maxUses ? <Tag className="m-0">已用完</Tag> : null}
                            </div>
                        ),
                    },
                    { title: "创建时间", dataIndex: "createdAt", width: 160, render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                    {
                        title: "操作",
                        width: 90,
                        align: "right",
                        render: (_, item) => (
                            <Button size="small" type="text" danger onClick={() => confirmDelete(item)}>
                                删除
                            </Button>
                        ),
                    },
                ]}
            />

            <Modal
                open={Boolean(created)}
                title="邀请链接已生成"
                onCancel={() => setCreated(null)}
                footer={
                    <div className="flex justify-end gap-2">
                        <Button onClick={() => setCreated(null)}>关闭</Button>
                        <Button type="primary" icon={<Copy className="size-4" />} onClick={() => copyText(inviteLink(created?.token || ""), "已复制邀请链接")}>
                            复制链接
                        </Button>
                    </div>
                }
            >
                <p className="mt-4 text-sm text-stone-500">完整地址只显示这一次，关掉后服务端也拿不回来，列表里只剩前缀。</p>
                <Input className="mt-3" readOnly value={created ? inviteLink(created.token) : ""} aria-label="邀请链接" />
            </Modal>
        </div>
    );
}
