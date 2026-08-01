import { useQuery } from "@tanstack/react-query";
import { Button, Empty, Input, Pagination, Select, Table, Tabs, Tag } from "antd";
import dayjs from "dayjs";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { AdminFileThumbs } from "@/pages/admin/components/file-thumbs";
import { AdminUserSelect } from "@/pages/admin/components/user-select";
import { AdminProjectDetail } from "@/pages/admin/contents/components/project-detail";
import { adminApi, type AdminProject } from "@/services/api/admin";

const kindOptions = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const FILE_PAGE_SIZE = 48;

export default function AdminContentsPage() {
    const [userId, setUserId] = useState("");
    const [keyword, setKeyword] = useState("");
    const [projectQuery, setProjectQuery] = useState({ keyword: "", page: 1, pageSize: 20 });
    const [fileQuery, setFileQuery] = useState({ kind: "image", page: 1 });
    const [detail, setDetail] = useState<AdminProject | null>(null);

    const projects = useQuery({ queryKey: ["admin-projects", userId, projectQuery], queryFn: () => adminApi.projects({ ...projectQuery, userId }) });
    const files = useQuery({ queryKey: ["admin-files", userId, fileQuery], queryFn: () => adminApi.files({ ...fileQuery, userId, pageSize: FILE_PAGE_SIZE }) });

    const refresh = () => void (projects.refetch(), files.refetch());
    const fetching = projects.isFetching || files.isFetching;

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">用户内容</h1>
                    <p className="mt-0.5 text-xs text-stone-500">按用户查看画布与生成的图片，画布只做结构统计与素材预览。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <AdminUserSelect className="w-48" value={userId} onChange={setUserId} />
                    <Button icon={<RefreshCw className={`size-4 ${fetching ? "animate-spin" : ""}`} />} onClick={refresh} title="刷新">
                        刷新
                    </Button>
                </div>
            </div>

            <Tabs
                className="mt-2"
                items={[
                    {
                        key: "projects",
                        label: `画布（${projects.data?.total || 0}）`,
                        children: (
                            <>
                                <Input.Search
                                    className="w-64"
                                    allowClear
                                    value={keyword}
                                    placeholder="搜索画布标题 / ID"
                                    onChange={(event) => setKeyword(event.target.value)}
                                    onSearch={(value) => setProjectQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                                />
                                <Table<AdminProject>
                                    className="mt-3"
                                    rowKey={(item) => `${item.userId}/${item.projectId}`}
                                    size="small"
                                    loading={projects.isFetching}
                                    dataSource={projects.data?.items || []}
                                    pagination={{
                                        current: projectQuery.page,
                                        pageSize: projectQuery.pageSize,
                                        total: projects.data?.total || 0,
                                        size: "small",
                                        showSizeChanger: true,
                                        showTotal: (total) => `共 ${total} 个画布`,
                                        onChange: (page, pageSize) => setProjectQuery((current) => ({ ...current, page, pageSize })),
                                    }}
                                    columns={[
                                        { title: "标题", dataIndex: "title", render: (title: string, item) => <div className="truncate">{title || item.projectId}</div> },
                                        {
                                            title: "用户",
                                            dataIndex: "username",
                                            width: 180,
                                            render: (username: string, item) => (
                                                <div className="min-w-0">
                                                    <div className="truncate">{username || "已删除用户"}</div>
                                                    <div className="mt-0.5 truncate text-xs text-stone-500">{item.displayName || item.userId}</div>
                                                </div>
                                            ),
                                        },
                                        { title: "节点数", dataIndex: "nodeCount", width: 80, render: (value: number) => <span className="tabular-nums">{value}</span> },
                                        { title: "版本", dataIndex: "revision", width: 70, render: (value: number) => <span className="tabular-nums">{value}</span> },
                                        {
                                            title: "状态",
                                            dataIndex: "deleted",
                                            width: 80,
                                            render: (deleted: boolean) => (
                                                <Tag className="m-0" color={deleted ? "error" : "success"}>
                                                    {deleted ? "已删除" : "正常"}
                                                </Tag>
                                            ),
                                        },
                                        { title: "更新时间", dataIndex: "updatedAt", width: 130, render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span> },
                                        {
                                            title: "操作",
                                            width: 70,
                                            align: "right",
                                            render: (_, item) => (
                                                <Button size="small" type="link" className="px-0" onClick={() => setDetail(item)}>
                                                    查看
                                                </Button>
                                            ),
                                        },
                                    ]}
                                />
                            </>
                        ),
                    },
                    {
                        key: "files",
                        label: `文件（${files.data?.total || 0}）`,
                        children: (
                            <>
                                <Select className="w-28" value={fileQuery.kind} options={kindOptions} onChange={(kind) => setFileQuery({ kind, page: 1 })} />
                                {files.data?.items.length ? (
                                    <div className="mt-3">
                                        <AdminFileThumbs files={files.data.items} size={112} />
                                        <Pagination
                                            className="mt-4"
                                            align="end"
                                            size="small"
                                            current={fileQuery.page}
                                            pageSize={FILE_PAGE_SIZE}
                                            total={files.data.total}
                                            showSizeChanger={false}
                                            showTotal={(total) => `共 ${total} 个文件`}
                                            onChange={(page) => setFileQuery((current) => ({ ...current, page }))}
                                        />
                                    </div>
                                ) : (
                                    <Empty className="my-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description={files.isFetching ? "加载中…" : "没有文件"} />
                                )}
                            </>
                        ),
                    },
                ]}
            />

            <AdminProjectDetail project={detail} onClose={() => setDetail(null)} />
        </div>
    );
}
