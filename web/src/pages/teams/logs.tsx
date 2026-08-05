import { useQuery } from "@tanstack/react-query";
import { Segmented, Table, Tag } from "antd";
import { useState } from "react";

import { teamApi, type TeamCreditLog, type TeamCreditLogType } from "@/services/api/teams";
import { canReadAllLogs } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

const typeLabels: Record<TeamCreditLogType, string> = {
    topup: "充值",
    admin_adjust: "管理员调整",
    ai_consume: "生成消耗",
    ai_refund: "退款",
    insufficient: "余额不足",
};

export default function TeamLogsPage() {
    const { team } = useTeamContext();
    const all = canReadAllLogs(team.myRole);
    const [scope, setScope] = useState<"mine" | "all">("all");
    // 范围每次渲染都按当前角色重算，而不是只在初始化时判一次：
    // 被降级成 member 的人如果 scope 还停在 all，这一页会一直打一个必然 403 的接口。
    const effectiveScope = all ? scope : "mine";
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const { data, isPending, error } = useQuery({
        queryKey: ["team-logs", team.id, effectiveScope, page, pageSize],
        queryFn: () => (effectiveScope === "all" ? teamApi.creditLogs(team.id, { page, pageSize }) : teamApi.myCreditLogs(team.id, { page, pageSize })),
    });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">团队积分流水</h2>
                    <p className="mt-0.5 text-xs text-stone-500">「余额不足」是一条留痕，不改变余额，用来解释某次生成为什么被拒。</p>
                </div>
                {all ? (
                    <Segmented
                        value={effectiveScope}
                        aria-label="切换流水范围"
                        onChange={(value) => {
                            setScope(value as "mine" | "all");
                            setPage(1);
                        }}
                        options={[
                            { label: "全团队", value: "all" },
                            { label: "只看我的", value: "mine" },
                        ]}
                    />
                ) : null}
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : "读取团队流水失败"}</div> : null}

            <Table<TeamCreditLog>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isPending}
                locale={{ emptyText: "还没有流水记录" }}
                dataSource={data?.items || []}
                pagination={{
                    current: page,
                    pageSize,
                    total: data?.total || 0,
                    size: "small",
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条`,
                    onChange: (nextPage, nextSize) => {
                        setPage(nextPage);
                        setPageSize(nextSize);
                    },
                }}
                columns={[
                    { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => <span className="text-xs text-stone-500">{value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-"}</span> },
                    { title: "类型", dataIndex: "type", width: 110, render: (value: TeamCreditLogType) => <Tag className="m-0">{typeLabels[value] || value}</Tag> },
                    { title: "成员", dataIndex: "userId", width: 160, render: (value: string) => <span className="truncate text-xs text-stone-500">{value || "-"}</span> },
                    { title: "模型", dataIndex: "model", render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                    { title: "变动", dataIndex: "amount", width: 90, render: (value: number) => <span className="tabular-nums">{value > 0 ? `+${value}` : value}</span> },
                    { title: "变动后余额", dataIndex: "balance", width: 110, render: (value: number) => <span className="tabular-nums">{value}</span> },
                    { title: "备注", dataIndex: "remark", render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                ]}
            />
        </div>
    );
}
