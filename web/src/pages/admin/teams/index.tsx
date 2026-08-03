import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, InputNumber, Modal, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Coins, HardDrive, RefreshCw } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "@/lib/image-utils";
import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminQuery, type AdminTeam } from "@/services/api/admin";

const MB = 1 << 20;

const statusLabels: Record<AdminTeam["status"], { label: string; color: string }> = {
    active: { label: "正常", color: "success" },
    disabled: { label: "已停用", color: "warning" },
    disbanded: { label: "已解散", color: "default" },
};

/**
 * 平台后台的团队管理。和用户管理页对称：一行一个团队，右侧给「调整积分」「调整云空间配额」两个单独入口。
 *
 * 单独一页而不是塞进用户管理：团队的配额是团队自己那本账，跟成员的个人配额毫无关系，
 * 混在用户列表里管的话，管理员会以为调的是某个人的空间。
 */
export default function AdminTeamsPage() {
    const runAction = useAdminAction();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [creditTarget, setCreditTarget] = useState<AdminTeam | null>(null);
    const [credits, setCredits] = useState(0);
    const [quotaTarget, setQuotaTarget] = useState<AdminTeam | null>(null);
    const [quotaMb, setQuotaMb] = useState(0);
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-teams", query], queryFn: () => adminApi.teams(query) });

    const openCredits = (team: AdminTeam) => {
        setCredits(team.credits);
        setCreditTarget(team);
    };

    const submitCredits = async () => {
        if (!creditTarget) return;
        if (await runAction(() => adminApi.setTeamCredits(creditTarget.id, credits, "后台调整"), "团队积分已更新")) {
            setCreditTarget(null);
            await refetch();
        }
    };

    const openQuota = (team: AdminTeam) => {
        setQuotaMb(Math.round(team.storageQuota / MB));
        setQuotaTarget(team);
    };

    const submitQuota = async () => {
        if (!quotaTarget) return;
        if (await runAction(() => adminApi.setTeamQuota(quotaTarget.id, quotaMb * MB), "团队云空间配额已更新")) {
            setQuotaTarget(null);
            await refetch();
        }
    };

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">团队管理</h1>
                    <p className="mt-0.5 text-xs text-stone-500">管理团队积分池与团队云空间配额。团队的云空间独立计算，不占成员的个人配额。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-64"
                        allowClear
                        value={keyword}
                        placeholder="搜索团队名 / 团队 ID / 所有者"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()} title="刷新">
                        刷新
                    </Button>
                </div>
            </div>

            <Table<AdminTeam>
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
                    showTotal: (total) => `共 ${total} 个团队`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "团队",
                        dataIndex: "name",
                        render: (name: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate font-medium">{name}</div>
                                <div className="mt-0.5 truncate text-xs text-stone-500">{item.id}</div>
                            </div>
                        ),
                    },
                    {
                        title: "成员",
                        dataIndex: "memberCount",
                        width: 90,
                        render: (count: number, item) => (
                            <span className="tabular-nums">
                                {count} / {item.memberLimit ? item.memberLimit : "不限"}
                            </span>
                        ),
                    },
                    {
                        title: "状态",
                        dataIndex: "status",
                        width: 88,
                        render: (status: AdminTeam["status"]) => (
                            <Tag className="m-0" color={statusLabels[status]?.color || "default"}>
                                {statusLabels[status]?.label || status}
                            </Tag>
                        ),
                    },
                    {
                        title: "团队积分",
                        dataIndex: "credits",
                        width: 100,
                        render: (value: number) => <span className="tabular-nums">{value}</span>,
                    },
                    {
                        title: "团队云空间",
                        dataIndex: "storageUsed",
                        width: 140,
                        render: (used: number, item) => (
                            <span className="text-xs tabular-nums text-stone-500" data-testid="admin-team-storage">
                                {formatBytes(used) || "0 B"} / {formatBytes(item.storageQuota) || "0 B"}
                            </span>
                        ),
                    },
                    {
                        title: "创建时间",
                        dataIndex: "createdAt",
                        width: 140,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 100,
                        align: "right",
                        render: (_, item) => (
                            <div className="flex justify-end gap-1">
                                <Button size="small" type="text" title="调整团队积分" icon={<Coins className="size-3.5" />} onClick={() => openCredits(item)} />
                                <Button size="small" type="text" title="调整团队云空间配额" icon={<HardDrive className="size-3.5" />} onClick={() => openQuota(item)} />
                            </div>
                        ),
                    },
                ]}
            />

            <Modal open={Boolean(creditTarget)} title={`调整团队积分 · ${creditTarget?.name || ""}`} okText="保存" cancelText="取消" onOk={submitCredits} onCancel={() => setCreditTarget(null)}>
                <div className="mt-4 text-sm text-stone-500">直接设置团队积分池的绝对值，服务端会自动记录一条后台调整流水。</div>
                <InputNumber className="mt-3 w-full" min={0} precision={0} value={credits} onChange={(value) => setCredits(value || 0)} />
            </Modal>

            <Modal open={Boolean(quotaTarget)} title={`调整团队云空间配额 · ${quotaTarget?.name || ""}`} okText="保存" cancelText="取消" onOk={submitQuota} onCancel={() => setQuotaTarget(null)}>
                {/* 写明「只影响这个团队」：这里调的是团队那本账，成员的个人配额一动不动，不说清楚容易被当成给全队每个人加空间。 */}
                <div className="mt-4 text-sm text-stone-500">单位 MB，只影响这一个团队。团队画布上传的图片与生成结果计入团队用量，成员的个人配额不受影响。当前已用 {formatBytes(quotaTarget?.storageUsed || 0) || "0 B"}。</div>
                <InputNumber className="mt-3 w-full" min={0} precision={0} addonAfter="MB" value={quotaMb} onChange={(value) => setQuotaMb(value || 0)} />
            </Modal>
        </div>
    );
}
