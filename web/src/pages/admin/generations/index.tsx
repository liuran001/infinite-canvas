import { useQuery } from "@tanstack/react-query";
import { Button, Descriptions, Drawer, Input, Select, Spin, Table, Tag } from "antd";
import dayjs from "dayjs";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { AdminFileThumbs } from "@/pages/admin/components/file-thumbs";
import { AdminUserSelect } from "@/pages/admin/components/user-select";
import { adminApi, type AdminJob, type AdminReviewQuery } from "@/services/api/admin";

const statusOptions = [
    { label: "排队中", value: "pending", color: "default" },
    { label: "生成中", value: "running", color: "processing" },
    { label: "已完成", value: "succeeded", color: "success" },
    { label: "已失败", value: "failed", color: "error" },
    { label: "已取消", value: "canceled", color: "warning" },
];

const kindOptions = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
    { label: "文本", value: "text" },
];

const label = (options: Array<{ label: string; value: string }>, value: string) => options.find((item) => item.value === value)?.label || value;
const time = (value: string) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-");

export default function AdminGenerationsPage() {
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminReviewQuery>({ page: 1, pageSize: 20 });
    const [detailId, setDetailId] = useState("");
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-jobs", query], queryFn: () => adminApi.jobs(query) });
    const detail = useQuery({ queryKey: ["admin-job", detailId], queryFn: () => adminApi.job(detailId), enabled: Boolean(detailId) });
    const job = detail.data;

    const patch = (next: Partial<AdminReviewQuery>) => setQuery((current) => ({ ...current, ...next, page: 1 }));

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">生成记录</h1>
                    <p className="mt-0.5 text-xs text-stone-500">审查所有用户的生成任务，包含提示词、参数、产出与失败原因。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search className="w-56" allowClear value={keyword} placeholder="搜索提示词 / 模型 / 任务 ID" onChange={(event) => setKeyword(event.target.value)} onSearch={(value) => patch({ keyword: value })} />
                    <AdminUserSelect className="w-44" value={query.userId} onChange={(userId) => patch({ userId })} />
                    <Select className="w-28" value={query.status || ""} options={[{ label: "全部状态", value: "" }, ...statusOptions]} onChange={(status) => patch({ status })} />
                    <Select className="w-28" value={query.kind || ""} options={[{ label: "全部类型", value: "" }, ...kindOptions]} onChange={(kind) => patch({ kind })} />
                    <Button icon={<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />} onClick={() => void refetch()} title="刷新">
                        刷新
                    </Button>
                </div>
            </div>

            <Table<AdminJob>
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
                    showTotal: (total) => `共 ${total} 条生成记录`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    { title: "时间", dataIndex: "createdAt", width: 130, render: (value: string) => <span className="text-xs text-stone-500">{time(value)}</span> },
                    {
                        title: "用户",
                        dataIndex: "username",
                        width: 150,
                        render: (username: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate">{username || "已删除用户"}</div>
                                <div className="mt-0.5 truncate text-xs text-stone-500">{item.displayName || item.userId}</div>
                            </div>
                        ),
                    },
                    { title: "类型", dataIndex: "kind", width: 70, render: (value: string) => <Tag className="m-0">{label(kindOptions, value)}</Tag> },
                    {
                        title: "状态",
                        dataIndex: "status",
                        width: 80,
                        render: (value: string) => (
                            <Tag className="m-0" color={statusOptions.find((item) => item.value === value)?.color}>
                                {label(statusOptions, value)}
                            </Tag>
                        ),
                    },
                    { title: "模型", dataIndex: "model", width: 150, render: (value: string) => <span className="truncate text-xs">{value || "-"}</span> },
                    {
                        title: "提示词",
                        dataIndex: "prompt",
                        render: (prompt: string, item) => (
                            <div className="min-w-0">
                                <div className="line-clamp-2 text-xs">{prompt || "-"}</div>
                                {item.error ? <div className="mt-0.5 line-clamp-1 text-xs text-red-500">{item.error}</div> : null}
                            </div>
                        ),
                    },
                    { title: "算力点", dataIndex: "credits", width: 70, render: (value: number) => <span className="tabular-nums">{value}</span> },
                    { title: "产出", dataIndex: "outputs", width: 150, render: (_, item) => <AdminFileThumbs files={item.outputs} /> },
                    {
                        title: "操作",
                        width: 70,
                        align: "right",
                        render: (_, item) => (
                            <Button size="small" type="link" className="px-0" onClick={() => setDetailId(item.id)}>
                                详情
                            </Button>
                        ),
                    },
                ]}
            />

            <Drawer size={640} open={Boolean(detailId)} title="生成详情" onClose={() => setDetailId("")}>
                <Spin spinning={detail.isFetching}>
                    {job ? (
                        <div className="flex flex-col gap-4">
                            <Descriptions
                                size="small"
                                column={2}
                                items={[
                                    { key: "user", label: "用户", children: `${job.username || "已删除用户"}（${job.userId}）` },
                                    { key: "model", label: "模型", children: job.model || "-" },
                                    { key: "kind", label: "类型", children: label(kindOptions, job.kind) },
                                    { key: "status", label: "状态", children: label(statusOptions, job.status) },
                                    { key: "credits", label: "消耗算力点", children: job.credits },
                                    { key: "progress", label: "进度", children: `${job.progress}%` },
                                    { key: "createdAt", label: "创建时间", children: time(job.createdAt) },
                                    { key: "finishedAt", label: "完成时间", children: time(job.finishedAt) },
                                    { key: "id", label: "任务 ID", span: 2, children: job.id },
                                    { key: "clientJobId", label: "幂等键", span: 2, children: job.clientJobId || "-" },
                                ]}
                            />

                            <Section title="提示词">
                                <div className="whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-xs dark:bg-stone-900">{job.prompt || "（空）"}</div>
                            </Section>

                            {job.error ? (
                                <Section title="失败原因">
                                    <div className="whitespace-pre-wrap break-words rounded bg-stone-50 p-3 text-xs text-red-500 dark:bg-stone-900">{job.error}</div>
                                </Section>
                            ) : null}

                            <Section title="生成参数">
                                <pre className="overflow-x-auto rounded bg-stone-50 p-3 text-xs dark:bg-stone-900">{JSON.stringify({ params: job.params, context: job.context }, null, 2)}</pre>
                            </Section>

                            <Section title={`参考文件（${job.inputs.length}）`}>
                                <AdminFileThumbs files={job.inputs} size={72} />
                            </Section>

                            <Section title={`产出文件（${job.outputs.length}）`}>
                                <AdminFileThumbs files={job.outputs} size={96} />
                            </Section>
                        </div>
                    ) : null}
                </Spin>
            </Drawer>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-1.5 text-xs font-medium text-stone-500">{title}</div>
            {children}
        </div>
    );
}
