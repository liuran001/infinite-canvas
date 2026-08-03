import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Drawer, Empty, Modal, Segmented, Switch, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Copy, Link2, Link2Off, Loader2, Plus, RefreshCw } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { shareAdminApi, type ShareAccessLog, type ShareCreated, type ShareRecord, type ShareRole } from "@/services/api/share";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 所有者侧的分享管理面板。
 *
 * 三条与设计文档对齐的约束体现在交互上：
 * 1. 完整链接随时可复制——服务端额外存了一份明文，不再是「只在创建那一次显示」。
 *    但存量记录建于「只存哈希」的年代，明文再也取不回来，这类记录退回旧行为：
 *    只显示前缀、不给复制入口，并当场说明为什么，绝不能渲染出一条残缺链接让人复制了发出去。
 *    有没有明文一律看服务端给的 copyable，不拿 token 是否为空串去猜；
 * 2. 停用是软删除语义，列表仍能看到已停用的链接与它的访问记录；
 * 3. 访问日志是服务端节流后的结果，这里如实展示，不再二次聚合。
 */
export function SharePanel({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const [loading, setLoading] = useState(false);
    const [shares, setShares] = useState<ShareRecord[]>([]);
    const [created, setCreated] = useState<ShareCreated | null>(null);
    const [creating, setCreating] = useState(false);
    const [role, setRole] = useState<ShareRole>("viewer");
    const [allowAnonymous, setAllowAnonymous] = useState(true);
    const [allowClone, setAllowClone] = useState(false);
    const [expiresAt, setExpiresAt] = useState<Dayjs | null>(null);
    const [logShareId, setLogShareId] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setShares(await shareAdminApi.list(projectId));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取分享链接失败");
        } finally {
            setLoading(false);
        }
    }, [message, projectId]);

    useEffect(() => {
        if (open) void load();
    }, [load, open]);

    const create = async () => {
        setCreating(true);
        try {
            const share = await shareAdminApi.create(projectId, { role, allowAnonymous, allowClone, expiresAt: expiresAt ? expiresAt.toISOString() : null });
            setCreated(share);
            setShares((prev) => [share, ...prev]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "创建分享链接失败");
        } finally {
            setCreating(false);
        }
    };

    const patch = async (share: ShareRecord, input: Parameters<typeof shareAdminApi.update>[2]) => {
        try {
            const next = await shareAdminApi.update(projectId, share.id, input);
            setShares((prev) => prev.map((item) => (item.id === share.id ? next : item)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新分享链接失败");
        }
    };

    const revoke = (share: ShareRecord) => {
        Modal.confirm({
            title: "停用这条分享链接？",
            content: "停用后正在浏览的访客会立即断开，链接不能再被打开。已保存到副本的内容不受影响。",
            okText: "停用",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                await shareAdminApi.revoke(projectId, share.id);
                setShares((prev) => prev.map((item) => (item.id === share.id ? { ...item, enabled: false } : item)));
                message.success("已停用分享链接");
            },
        });
    };

    return (
        <>
            <Drawer
                title="分享这张画布"
                open={open}
                onClose={onClose}
                width={520}
                extra={
                    <Tooltip title="刷新">
                        <Button type="text" icon={<RefreshCw className="size-4" />} onClick={() => void load()} aria-label="刷新分享列表" />
                    </Tooltip>
                }
            >
                <section className="space-y-4 rounded-2xl border p-4" style={{ borderColor: theme.node.stroke }}>
                    <h3 className="text-sm font-semibold">新建链接</h3>
                    <Field label="权限" hint={role === "editor" ? "访客可以直接编辑这张画布，改动会写回你的画布本体。" : "访客只能查看与平移缩放，无法改动任何内容。"}>
                        <Segmented
                            value={role}
                            onChange={(value) => setRole(value as ShareRole)}
                            options={[
                                { label: "只读", value: "viewer" },
                                { label: "可编辑", value: "editor" },
                            ]}
                        />
                    </Field>
                    <Field label="允许匿名访问" hint={allowAnonymous ? "任何拿到链接的人都能打开。" : "访客必须先登录才能打开这条链接。"}>
                        <Switch checked={allowAnonymous} onChange={setAllowAnonymous} />
                    </Field>
                    <Field label="允许保存到自己账号" hint={allowClone ? "访客可以克隆一份独立副本，副本与这张画布互不影响。" : "访客不能把这张画布克隆走。"}>
                        <Switch checked={allowClone} onChange={setAllowClone} />
                    </Field>
                    <Field label="过期时间" hint={expiresAt ? `到 ${expiresAt.format("YYYY-MM-DD HH:mm")} 后链接自动失效。` : "留空表示永不过期。"}>
                        <DatePicker showTime value={expiresAt} onChange={setExpiresAt} placeholder="永不过期" disabledDate={(date) => date.isBefore(dayjs(), "day")} />
                    </Field>
                    <Button type="primary" block icon={<Plus className="size-4" />} loading={creating} onClick={() => void create()}>
                        创建分享链接
                    </Button>
                </section>

                <section className="mt-6 space-y-3">
                    <h3 className="text-sm font-semibold">
                        已有链接
                        {loading ? <Loader2 className="ml-2 inline size-3.5 animate-spin" /> : null}
                    </h3>
                    {!loading && !shares.length ? <Empty description="还没有分享链接" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
                    {shares.map((share) => (
                        <ShareRow key={share.id} share={share} theme={theme} onPatch={patch} onRevoke={revoke} onViewLogs={() => setLogShareId(share.id)} />
                    ))}
                </section>
            </Drawer>

            <Modal
                title="链接已创建"
                open={Boolean(created)}
                centered
                onCancel={() => setCreated(null)}
                footer={
                    <Button type="primary" onClick={() => setCreated(null)}>
                        知道了
                    </Button>
                }
            >
                <p className="text-sm opacity-70">这条链接随时可以在下面的列表里再复制，不必现在就存下来。</p>
                <div className="mt-3 flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <Link2 className="size-4 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{created ? shareUrl(created) : ""}</span>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => created && copyText(shareUrl(created), "已复制分享链接")}>
                        复制
                    </Button>
                </div>
            </Modal>

            <ShareLogsModal projectId={projectId} shareId={logShareId} onClose={() => setLogShareId("")} />
        </>
    );
}

/** 服务端可能直接给完整链接；没给时按当前站点域名拼，避免在反代下拼出错误的主机名。 */
function shareUrl(share: { url?: string; token?: string }) {
    return share.url || `${window.location.origin}/s/${share.token || ""}`;
}

function ShareRow({
    share,
    theme,
    onPatch,
    onRevoke,
    onViewLogs,
}: {
    share: ShareRecord;
    theme: CanvasTheme;
    onPatch: (share: ShareRecord, input: { role?: ShareRole; allowAnonymous?: boolean; allowClone?: boolean; enabled?: boolean; expiresAt?: string | null }) => Promise<void>;
    onRevoke: (share: ShareRecord) => void;
    onViewLogs: () => void;
}) {
    const copyText = useCopyText();
    const expired = Boolean(share.expiresAt && Date.parse(share.expiresAt) < Date.now());
    const dead = !share.enabled || expired;
    return (
        <div className="space-y-3 rounded-2xl border p-3" style={{ borderColor: theme.node.stroke, opacity: dead ? 0.6 : 1 }}>
            <div className="flex items-center justify-between gap-2">
                {/* 能复制时就把完整链接摆出来，不再只给一截前缀——前缀本身对用户没有任何用处。 */}
                <span className="min-w-0 flex-1 truncate font-mono text-xs opacity-70">{share.copyable ? shareUrl(share) : `/s/${share.tokenPrefix}…`}</span>
                {share.copyable ? (
                    <Tooltip title="复制完整链接">
                        <Button size="small" type="text" aria-label="复制完整链接" icon={<Copy className="size-3.5" />} onClick={() => copyText(shareUrl(share), "已复制分享链接")} />
                    </Tooltip>
                ) : null}
                {dead ? <Tag color="default">{expired ? "已过期" : "已停用"}</Tag> : <Tag color={share.role === "editor" ? "green" : "blue"}>{share.role === "editor" ? "可编辑" : "只读"}</Tag>}
            </div>
            {/*
             * 老链接建于「只存哈希」的年代，服务端手里也只有不可逆的哈希，没法再还原出完整链接。
             * 这时候必须把原因说清楚：不解释的话，用户只会觉得「别的链接都能复制，就这条按钮不见了」，
             * 然后反复刷新等它出现。给的出路也要具体——重建一条，而不是让他自己琢磨。
             */}
            {share.copyable ? null : <p className="!mb-0 text-[11px] opacity-55">这是早期创建的链接，服务端只留了不可逆的摘要，没法再还原出完整地址。需要发给别人的话，新建一条链接即可。</p>}

            <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">匿名访问</span>
                    <Switch size="small" disabled={dead} checked={share.allowAnonymous} onChange={(checked) => void onPatch(share, { allowAnonymous: checked })} />
                </label>
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">允许克隆</span>
                    <Switch size="small" disabled={dead} checked={share.allowClone} onChange={(checked) => void onPatch(share, { allowClone: checked })} />
                </label>
            </div>

            <div className="flex items-center justify-between gap-2">
                <Segmented
                    size="small"
                    disabled={dead}
                    value={share.role}
                    onChange={(value) => void onPatch(share, { role: value as ShareRole })}
                    options={[
                        { label: "只读", value: "viewer" },
                        { label: "可编辑", value: "editor" },
                    ]}
                />
                <div className="flex items-center gap-1">
                    <Button size="small" type="text" onClick={onViewLogs}>
                        访问记录
                    </Button>
                    {dead ? null : (
                        <Button size="small" type="text" danger icon={<Link2Off className="size-3.5" />} onClick={() => onRevoke(share)}>
                            停用
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-between gap-2 text-[11px] opacity-55">
                <span>创建于 {dayjs(share.createdAt).format("YYYY-MM-DD HH:mm")}</span>
                <DatePicker
                    size="small"
                    showTime
                    variant="borderless"
                    disabled={dead}
                    value={share.expiresAt ? dayjs(share.expiresAt) : null}
                    placeholder="永不过期"
                    onChange={(value) => void onPatch(share, { expiresAt: value ? value.toISOString() : null })}
                />
            </div>
        </div>
    );
}

const LOG_EVENT_LABEL: Record<ShareAccessLog["event"], string> = { open: "打开", edit: "编辑", clone: "克隆" };

function ShareLogsModal({ projectId, shareId, onClose }: { projectId: string; shareId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [logs, setLogs] = useState<ShareAccessLog[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!shareId) return;
        setLoading(true);
        shareAdminApi
            .logs(projectId, shareId)
            .then((result) => setLogs(result.items))
            .catch((error: Error) => message.error(error.message || "读取访问日志失败"))
            .finally(() => setLoading(false));
    }, [message, projectId, shareId]);

    const rows = useMemo(() => logs.slice(0, 200), [logs]);

    return (
        <Modal title="访问记录" open={Boolean(shareId)} onCancel={onClose} footer={null} centered width={560}>
            <p className="mb-3 text-xs opacity-55">同一访客的连续访问会被服务端合并，因此这里看到的是访问次数的下界，而不是逐次请求。</p>
            {loading ? <Loader2 className="mx-auto my-8 size-5 animate-spin" /> : null}
            {!loading && !rows.length ? <Empty description="还没有访问记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
            <div className="max-h-[50vh] space-y-1.5 overflow-auto">
                {rows.map((log) => (
                    <div key={log.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-xs odd:bg-black/[.03] dark:odd:bg-white/[.04]">
                        <span className="w-14 shrink-0 font-medium">{LOG_EVENT_LABEL[log.event] || log.event}</span>
                        <span className="min-w-0 flex-1 truncate opacity-70">{log.isAnonymous ? `匿名访客 ${log.actorId.slice(-6)}` : log.actorId}</span>
                        <span className="shrink-0 opacity-50">{dayjs(log.createdAt).format("MM-DD HH:mm")}</span>
                    </div>
                ))}
            </div>
        </Modal>
    );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <div className="text-sm">{label}</div>
                <div className="mt-0.5 text-xs opacity-55">{hint}</div>
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}
