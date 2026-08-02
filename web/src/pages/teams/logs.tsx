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
    // 只有管理员看得到全员流水，普通成员的开关本来就只有一档，默认也只能是自己那一档。
    const [scope, setScope] = useState<"mine" | "all">(all ? "all" : "mine");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const { data, isPending, error } = useQuery({
        queryKey: ["team-logs", team.id, scope, page, pageSize],
        queryFn: () => (scope === "all" ? teamApi.creditLogs(team.id, { page, pageSize }) : teamApi.myCreditLogs(team.id, { page, pageSize })),
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
                        value={scope}
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
                    { title: "时间", dataIndex: "createdAt", width: 170, render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
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
