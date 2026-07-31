import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Select, Table, Tag } from "antd";
import dayjs from "dayjs";
import { FolderCog, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { useAdminAction } from "@/pages/admin/use-admin-action";
import { adminApi, type AdminPrompt, type AdminQuery } from "@/services/api/admin";
import { PromptCategoryDrawer } from "./components/prompt-category-drawer";
import { PromptEditorModal } from "./components/prompt-editor-modal";

export default function AdminPromptsPage() {
    const { modal } = App.useApp();
    const runAction = useAdminAction();
    const [keyword, setKeyword] = useState("");
    const [query, setQuery] = useState<AdminQuery>({ page: 1, pageSize: 20 });
    const [editing, setEditing] = useState<Partial<AdminPrompt> | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [categoryOpen, setCategoryOpen] = useState(false);
    const { data, isFetching, refetch } = useQuery({ queryKey: ["admin-prompts", query], queryFn: () => adminApi.prompts(query) });

    const reload = async () => {
        setSelectedIds([]);
        await refetch();
    };

    const confirmDelete = (prompt: AdminPrompt) =>
        modal.confirm({
            title: `删除提示词「${prompt.title || prompt.id}」？`,
            content: "删除后无法恢复，远程分类会在下次同步时重新拉回。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deletePrompt(prompt.id), "已删除")) await reload();
            },
        });

    const confirmBatchDelete = () =>
        modal.confirm({
            title: `删除选中的 ${selectedIds.length} 条提示词？`,
            content: "删除后无法恢复，远程分类会在下次同步时重新拉回。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                if (await runAction(() => adminApi.deletePrompts(selectedIds), "已批量删除")) await reload();
            },
        });

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">提示词</h1>
                    <p className="mt-0.5 text-xs text-stone-500">维护提示词库，远程分类可手动或定时从来源同步。</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Input.Search
                        className="w-56"
                        allowClear
                        value={keyword}
                        placeholder="搜索标题 / 内容 / 描述"
                        onChange={(event) => setKeyword(event.target.value)}
                        onSearch={(value) => setQuery((current) => ({ ...current, keyword: value, page: 1 }))}
                    />
                    <Select
                        className="w-44"
                        showSearch
                        value={query.category || ""}
                        options={[{ label: "全部分类", value: "" }, ...(data?.categories || []).map((item) => ({ label: item, value: item }))]}
                        onChange={(value) => setQuery((current) => ({ ...current, category: value, page: 1 }))}
                    />
                    <Select
                        className="w-44"
                        mode="multiple"
                        allowClear
                        maxTagCount="responsive"
                        placeholder="全部标签"
                        value={query.tag || []}
                        options={(data?.tags || []).map((tag) => ({ label: tag, value: tag }))}
                        onChange={(value) => setQuery((current) => ({ ...current, tag: value, page: 1 }))}
                    />
                    <Button danger disabled={!selectedIds.length} icon={<Trash2 className="size-4" />} onClick={confirmBatchDelete}>
                        批量删除{selectedIds.length ? ` ${selectedIds.length}` : ""}
                    </Button>
                    <Button icon={<FolderCog className="size-4" />} onClick={() => setCategoryOpen(true)}>
                        分类管理
                    </Button>
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ category: query.category || data?.categories?.[0] || "" })}>
                        新建提示词
                    </Button>
                </div>
            </div>

            <Table<AdminPrompt>
                className="mt-4"
                rowKey="id"
                size="small"
                loading={isFetching}
                dataSource={data?.items || []}
                rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys.map(String)) }}
                pagination={{
                    current: query.page,
                    pageSize: query.pageSize,
                    total: data?.total || 0,
                    size: "small",
                    showSizeChanger: true,
                    showTotal: (total) => `共 ${total} 条提示词`,
                    onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
                }}
                columns={[
                    {
                        title: "封面",
                        dataIndex: "coverUrl",
                        width: 72,
                        render: (coverUrl: string) => (coverUrl ? <img src={coverUrl} alt="" className="size-12 rounded object-cover" /> : <div className="size-12 rounded bg-stone-100 dark:bg-stone-800" />),
                    },
                    {
                        title: "标题",
                        dataIndex: "title",
                        render: (title: string, item) => (
                            <div className="min-w-0">
                                <div className="truncate font-medium">{title || "未命名"}</div>
                                <div className="mt-0.5 line-clamp-2 text-xs text-stone-500">{item.description || item.prompt}</div>
                            </div>
                        ),
                    },
                    {
                        title: "分类",
                        dataIndex: "category",
                        width: 160,
                        render: (category: string) => <span className="text-xs text-stone-500">{category || "-"}</span>,
                    },
                    {
                        title: "标签",
                        dataIndex: "tags",
                        width: 180,
                        render: (tags: string[]) => (
                            <div className="flex flex-wrap gap-1">
                                {(tags || []).slice(0, 3).map((tag) => (
                                    <Tag key={tag} className="m-0">
                                        {tag}
                                    </Tag>
                                ))}
                            </div>
                        ),
                    },
                    {
                        title: "更新时间",
                        dataIndex: "updatedAt",
                        width: 140,
                        render: (value: string) => <span className="text-xs text-stone-500">{value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"}</span>,
                    },
                    {
                        title: "操作",
                        width: 100,
                        align: "right",
                        render: (_, item) => (
                            <div className="flex justify-end gap-1">
                                <Button size="small" type="text" title="编辑" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(item)} />
                                <Button size="small" type="text" danger title="删除" icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(item)} />
                            </div>
                        ),
                    },
                ]}
            />

            <PromptEditorModal prompt={editing} categories={data?.categories || []} onClose={() => setEditing(null)} onSaved={reload} />
            <PromptCategoryDrawer open={categoryOpen} onClose={() => setCategoryOpen(false)} onChanged={reload} />
        </div>
    );
}
