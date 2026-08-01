import { useQuery } from "@tanstack/react-query";
import { Button, Descriptions, Drawer, Empty, Spin, Tag } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";

import { AdminFileThumbs } from "@/pages/admin/components/file-thumbs";
import { adminApi, type AdminProject } from "@/services/api/admin";
import { serverFileIdOf } from "@/services/image-storage";

const nodeTypeLabels: Record<string, string> = { image: "图片", text: "文本", config: "生成配置", video: "视频", audio: "音频", group: "分组" };

/** 一个画布可能有几十上百张图，先只渲染这么多缩略图，其余按需展开。 */
const FIRST_SCREEN = 60;

/** 画布内容概览：结构统计 + 图片缩略图墙，不还原成可交互画布。 */
export function AdminProjectDetail({ project, onClose }: { project: AdminProject | null; onClose: () => void }) {
    const [showAll, setShowAll] = useState(false);
    const { data, isFetching } = useQuery({
        queryKey: ["admin-project", project?.userId, project?.projectId],
        queryFn: () => adminApi.project(project?.userId || "", project?.projectId || ""),
        enabled: Boolean(project),
    });

    useEffect(() => setShowAll(false), [project?.projectId]);

    const nodes = useMemo(() => data?.data?.nodes || [], [data]);

    const stats = useMemo(() => {
        const counts = new Map<string, number>();
        for (const node of nodes) counts.set(String(node.type), (counts.get(String(node.type)) || 0) + 1);
        return Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    }, [nodes]);

    // 同一个文件可能被多个节点引用，按文件 ID 去重。
    const media = useMemo(() => {
        const found = new Map<string, { id: string; kind: string }>();
        for (const node of nodes) {
            const id = serverFileIdOf(node.metadata?.storageKey);
            if (id) found.set(id, { id, kind: String(node.type) });
        }
        return Array.from(found.values());
    }, [nodes]);

    return (
        <Drawer size={720} open={Boolean(project)} title={project?.title || "画布详情"} onClose={onClose}>
            <Spin spinning={isFetching}>
                {data ? (
                    <div className="flex flex-col gap-4">
                        <Descriptions
                            size="small"
                            column={2}
                            items={[
                                { key: "user", label: "用户", children: `${data.username || "已删除用户"}（${data.userId}）` },
                                { key: "nodeCount", label: "节点数", children: data.nodeCount },
                                { key: "revision", label: "版本", children: data.revision },
                                { key: "deleted", label: "状态", children: data.deleted ? "已删除" : "正常" },
                                { key: "createdAt", label: "创建时间", children: data.createdAt ? dayjs(data.createdAt).format("YYYY-MM-DD HH:mm") : "-" },
                                { key: "updatedAt", label: "更新时间", children: data.updatedAt ? dayjs(data.updatedAt).format("YYYY-MM-DD HH:mm") : "-" },
                                { key: "projectId", label: "画布 ID", span: 2, children: data.projectId },
                            ]}
                        />

                        <div>
                            <div className="mb-1.5 text-xs font-medium text-stone-500">节点构成</div>
                            {stats.length ? (
                                <div className="flex flex-wrap gap-1">
                                    {stats.map((item) => (
                                        <Tag key={item.type} className="m-0">
                                            {nodeTypeLabels[item.type] || item.type} × {item.count}
                                        </Tag>
                                    ))}
                                </div>
                            ) : (
                                <Empty className="my-2" image={Empty.PRESENTED_IMAGE_SIMPLE} description="画布为空" />
                            )}
                        </div>

                        <div>
                            <div className="mb-1.5 text-xs font-medium text-stone-500">画布素材（{media.length}）</div>
                            <AdminFileThumbs files={showAll ? media : media.slice(0, FIRST_SCREEN)} size={96} />
                            {!showAll && media.length > FIRST_SCREEN ? (
                                <Button className="mt-2" size="small" onClick={() => setShowAll(true)}>
                                    显示全部 {media.length} 项
                                </Button>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </Spin>
        </Drawer>
    );
}
