import { useQuery } from "@tanstack/react-query";
import { Segmented, Table, Tag } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { teamApi, type TeamCreditLog, type TeamCreditLogType } from "@/services/api/teams";
import { canReadAllLogs } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

const typeKeys: Record<TeamCreditLogType, string> = {
    topup: "topup",
    admin_adjust: "adminAdjust",
    ai_consume: "aiConsume",
    ai_refund: "aiRefund",
    insufficient: "insufficient",
};

export default function TeamLogsPage() {
    const { team } = useTeamContext();
    const { t, i18n } = useTranslation();
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
                    <h2 className="text-base font-semibold">{t("teams.logs.title")}</h2>
                    <p className="mt-0.5 text-xs text-stone-500">{t("teams.logs.description")}</p>
                </div>
                {all ? (
                    <Segmented
                        value={effectiveScope}
                        aria-label={t("teams.logs.scopeAria")}
                        onChange={(value) => {
                            setScope(value as "mine" | "all");
                            setPage(1);
                        }}
                        options={[
                            { label: t("teams.logs.all"), value: "all" },
                            { label: t("teams.logs.mine"), value: "mine" },
                        ]}
                    />
                ) : null}
            </div>

            {error ? <div className="py-10 text-center text-sm text-red-500">{error instanceof Error ? error.message : t("teams.logs.loadFailed")}</div> : null}

            <Table<TeamCreditLog>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isPending}
                locale={{ emptyText: t("teams.logs.empty") }}
                dataSource={data?.items || []}
                pagination={{
                    current: page,
                    pageSize,
                    total: data?.total || 0,
                    size: "small",
                    showSizeChanger: true,
                    showTotal: (total) => t("teams.logs.total", { count: total }),
                    onChange: (nextPage, nextSize) => {
                        setPage(nextPage);
                        setPageSize(nextSize);
                    },
                }}
                columns={[
                    {
                        title: t("teams.logs.columns.createdAt"),
                        dataIndex: "createdAt",
                        width: 180,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? new Date(value).toLocaleString(i18n.language, { hour12: false }) : "-"}</span>,
                    },
                    { title: t("teams.logs.columns.type"), dataIndex: "type", width: 110, render: (value: TeamCreditLogType) => <Tag className="m-0">{t(`teams.logs.types.${typeKeys[value]}`, { defaultValue: value })}</Tag> },
                    { title: t("teams.logs.columns.member"), dataIndex: "userId", width: 160, render: (value: string) => <span className="truncate text-xs text-stone-500">{value || "-"}</span> },
                    { title: t("teams.logs.columns.model"), dataIndex: "model", render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                    { title: t("teams.logs.columns.amount"), dataIndex: "amount", width: 90, render: (value: number) => <span className="tabular-nums">{value > 0 ? `+${value}` : value}</span> },
                    { title: t("teams.logs.columns.balance"), dataIndex: "balance", width: 110, render: (value: number) => <span className="tabular-nums">{value}</span> },
                    { title: t("teams.logs.columns.remark"), dataIndex: "remark", render: (value: string) => <span className="text-xs text-stone-500">{value || "-"}</span> },
                ]}
            />
        </div>
    );
}
