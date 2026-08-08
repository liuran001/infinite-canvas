import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, DatePicker, Drawer, Empty, Modal, Segmented, Switch, Tag, Tooltip } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Copy, Link2, Link2Off, Loader2, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

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
    const { t } = useTranslation();
    const copyText = useCopyText();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    const [loading, setLoading] = useState(false);
    const [shares, setShares] = useState<ShareRecord[]>([]);
    const [created, setCreated] = useState<ShareCreated | null>(null);
    const [creating, setCreating] = useState(false);
    const [role, setRole] = useState<ShareRole>("viewer");
    const [allowAnonymous, setAllowAnonymous] = useState(true);
    const [allowClone, setAllowClone] = useState(false);
    const [ownerPays, setOwnerPays] = useState(false);
    const [allowAnonymousEdit, setAllowAnonymousEdit] = useState(false);
    const [expiresAt, setExpiresAt] = useState<Dayjs | null>(null);
    const [logShareId, setLogShareId] = useState("");
    const anonymousEditEnabled = role === "editor" && allowAnonymous && ownerPays;

    useEffect(() => {
        if (!anonymousEditEnabled) setAllowAnonymousEdit(false);
    }, [anonymousEditEnabled]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setShares(await shareAdminApi.list(projectId));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.share.errors.load"));
        } finally {
            setLoading(false);
        }
    }, [message, projectId, t]);

    useEffect(() => {
        if (open) void load();
    }, [load, open]);

    const create = async () => {
        setCreating(true);
        try {
            const share = await shareAdminApi.create(projectId, { role, allowAnonymous, allowClone, ownerPays, allowAnonymousEdit: anonymousEditEnabled && allowAnonymousEdit, expiresAt: expiresAt ? expiresAt.toISOString() : null });
            setCreated(share);
            setShares((prev) => [share, ...prev]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.share.errors.create"));
        } finally {
            setCreating(false);
        }
    };

    const patch = async (share: ShareRecord, input: Parameters<typeof shareAdminApi.update>[2]) => {
        try {
            const next = await shareAdminApi.update(projectId, share.id, input);
            setShares((prev) => prev.map((item) => (item.id === share.id ? next : item)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("canvas.share.errors.update"));
        }
    };

    const revoke = (share: ShareRecord) => {
        Modal.confirm({
            title: t("canvas.share.disableTitle"),
            content: t("canvas.share.disableDescription"),
            okText: t("canvas.share.disable"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                await shareAdminApi.revoke(projectId, share.id);
                setShares((prev) => prev.map((item) => (item.id === share.id ? { ...item, enabled: false } : item)));
                message.success(t("canvas.share.disabledSuccess"));
            },
        });
    };

    return (
        <>
            <Drawer
                title={t("canvas.share.panelTitle")}
                open={open}
                onClose={onClose}
                width={520}
                extra={
                    <Tooltip title={t("canvas.share.refresh")}>
                        <Button type="text" icon={<RefreshCw className="size-4" />} onClick={() => void load()} aria-label={t("canvas.share.refreshList")} />
                    </Tooltip>
                }
            >
                <section className="space-y-4 rounded-2xl border p-4" style={{ borderColor: theme.node.stroke }}>
                    <h3 className="text-sm font-semibold">{t("canvas.share.newLink")}</h3>
                    <Field label={t("canvas.share.permission")} hint={t(role === "editor" ? "canvas.share.editorHint" : "canvas.share.viewerHint")}>
                        <Segmented
                            value={role}
                            onChange={(value) => setRole(value as ShareRole)}
                            options={[
                                { label: t("canvas.share.readOnly"), value: "viewer" },
                                { label: t("canvas.share.editable"), value: "editor" },
                            ]}
                        />
                    </Field>
                    <Field label={t("canvas.share.allowAnonymous")} hint={t(allowAnonymous ? "canvas.share.anonymousOnHint" : "canvas.share.anonymousOffHint")}>
                        <Switch checked={allowAnonymous} onChange={setAllowAnonymous} />
                    </Field>
                    <Field label={t("canvas.share.allowClone")} hint={t(allowClone ? "canvas.share.cloneOnHint" : "canvas.share.cloneOffHint")}>
                        <Switch checked={allowClone} onChange={setAllowClone} />
                    </Field>
                    <Field label={t("canvas.share.ownerPays")} hint={t(ownerPays ? "canvas.share.ownerPaysOnHint" : "canvas.share.ownerPaysOffHint")}>
                        <Switch checked={ownerPays} onChange={setOwnerPays} />
                    </Field>
                    <Field label={t("canvas.share.allowAnonymousEdit")} hint={t("canvas.share.anonymousEditHint")}>
                        <Switch checked={allowAnonymousEdit} disabled={!anonymousEditEnabled} onChange={setAllowAnonymousEdit} />
                    </Field>
                    <Field label={t("canvas.share.expiration")} hint={expiresAt ? t("canvas.share.expirationHint", { date: expiresAt.format("YYYY-MM-DD HH:mm") }) : t("canvas.share.neverExpiresHint")}>
                        <DatePicker showTime value={expiresAt} onChange={setExpiresAt} placeholder={t("canvas.share.neverExpires")} disabledDate={(date) => date.isBefore(dayjs(), "day")} />
                    </Field>
                    <Button type="primary" block icon={<Plus className="size-4" />} loading={creating} onClick={() => void create()}>
                        {t("canvas.share.createLink")}
                    </Button>
                </section>

                <section className="mt-6 space-y-3">
                    <h3 className="text-sm font-semibold">
                        {t("canvas.share.existingLinks")}
                        {loading ? <Loader2 className="ml-2 inline size-3.5 animate-spin" /> : null}
                    </h3>
                    {!loading && !shares.length ? <Empty description={t("canvas.share.noLinks")} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
                    {shares.map((share) => (
                        <ShareRow key={share.id} share={share} theme={theme} onPatch={patch} onRevoke={revoke} onViewLogs={() => setLogShareId(share.id)} />
                    ))}
                </section>
            </Drawer>

            <Modal
                title={t("canvas.share.createdTitle")}
                open={Boolean(created)}
                centered
                onCancel={() => setCreated(null)}
                footer={
                    <Button type="primary" onClick={() => setCreated(null)}>
                        {t("canvas.share.gotIt")}
                    </Button>
                }
            >
                <p className="text-sm opacity-70">{t("canvas.share.createdHint")}</p>
                <div className="mt-3 flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                    <Link2 className="size-4 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{created ? shareUrl(created) : ""}</span>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => created && copyText(shareUrl(created), t("canvas.share.copySuccess"))}>
                        {t("common.copy")}
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
    onPatch: (share: ShareRecord, input: { role?: ShareRole; allowAnonymous?: boolean; allowClone?: boolean; ownerPays?: boolean; allowAnonymousEdit?: boolean; enabled?: boolean; expiresAt?: string | null }) => Promise<void>;
    onRevoke: (share: ShareRecord) => void;
    onViewLogs: () => void;
}) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const expired = Boolean(share.expiresAt && Date.parse(share.expiresAt) < Date.now());
    const dead = !share.enabled || expired;
    return (
        <div className="space-y-3 rounded-2xl border p-3" style={{ borderColor: theme.node.stroke, opacity: dead ? 0.6 : 1 }}>
            <div className="flex items-center justify-between gap-2">
                {/* 能复制时就把完整链接摆出来，不再只给一截前缀——前缀本身对用户没有任何用处。 */}
                <span className="min-w-0 flex-1 truncate font-mono text-xs opacity-70">{share.copyable ? shareUrl(share) : `/s/${share.tokenPrefix}…`}</span>
                {share.copyable ? (
                    <Tooltip title={t("canvas.share.copyFullLink")}>
                        <Button size="small" type="text" aria-label={t("canvas.share.copyFullLink")} icon={<Copy className="size-3.5" />} onClick={() => copyText(shareUrl(share), t("canvas.share.copySuccess"))} />
                    </Tooltip>
                ) : null}
                {dead ? <Tag color="default">{t(expired ? "canvas.share.expired" : "canvas.share.disabled")}</Tag> : <Tag color={share.role === "editor" ? "green" : "blue"}>{t(share.role === "editor" ? "canvas.share.editable" : "canvas.share.readOnly")}</Tag>}
            </div>
            {/*
             * 老链接建于「只存哈希」的年代，服务端手里也只有不可逆的哈希，没法再还原出完整链接。
             * 这时候必须把原因说清楚：不解释的话，用户只会觉得「别的链接都能复制，就这条按钮不见了」，
             * 然后反复刷新等它出现。给的出路也要具体——重建一条，而不是让他自己琢磨。
             */}
            {share.copyable ? null : <p className="!mb-0 text-[11px] opacity-55">{t("canvas.share.legacyUnavailable")}</p>}

            <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">{t("canvas.share.anonymousAccess")}</span>
                    <Switch size="small" disabled={dead} checked={share.allowAnonymous} onChange={(checked) => void onPatch(share, { allowAnonymous: checked, ...(checked ? {} : { allowAnonymousEdit: false }) })} />
                </label>
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">{t("canvas.share.cloneAllowed")}</span>
                    <Switch size="small" disabled={dead} checked={share.allowClone} onChange={(checked) => void onPatch(share, { allowClone: checked })} />
                </label>
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">{t("canvas.share.ownerPays")}</span>
                    <Switch size="small" disabled={dead} checked={share.ownerPays} onChange={(checked) => void onPatch(share, { ownerPays: checked, ...(checked ? {} : { allowAnonymousEdit: false }) })} />
                </label>
                <label className="flex items-center justify-between gap-2">
                    <span className="opacity-70">{t("canvas.share.anonymousEditing")}</span>
                    <Switch size="small" disabled={dead || share.role !== "editor" || !share.allowAnonymous || !share.ownerPays} checked={share.allowAnonymousEdit} onChange={(checked) => void onPatch(share, { allowAnonymousEdit: checked })} />
                </label>
            </div>

            <div className="flex items-center justify-between gap-2">
                <Segmented
                    size="small"
                    disabled={dead}
                    value={share.role}
                    onChange={(value) => void onPatch(share, { role: value as ShareRole, ...(value === "editor" ? {} : { allowAnonymousEdit: false }) })}
                    options={[
                        { label: t("canvas.share.readOnly"), value: "viewer" },
                        { label: t("canvas.share.editable"), value: "editor" },
                    ]}
                />
                <div className="flex items-center gap-1">
                    <Button size="small" type="text" onClick={onViewLogs}>
                        {t("canvas.share.accessLogs")}
                    </Button>
                    {dead ? null : (
                        <Button size="small" type="text" danger icon={<Link2Off className="size-3.5" />} onClick={() => onRevoke(share)}>
                            {t("canvas.share.disable")}
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-between gap-2 text-[11px] opacity-55">
                <span>{t("canvas.share.createdAt", { date: dayjs(share.createdAt).format("YYYY-MM-DD HH:mm") })}</span>
                <DatePicker
                    size="small"
                    showTime
                    variant="borderless"
                    disabled={dead}
                    value={share.expiresAt ? dayjs(share.expiresAt) : null}
                    placeholder={t("canvas.share.neverExpires")}
                    onChange={(value) => void onPatch(share, { expiresAt: value ? value.toISOString() : null })}
                />
            </div>
        </div>
    );
}

function ShareLogsModal({ projectId, shareId, onClose }: { projectId: string; shareId: string; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [logs, setLogs] = useState<ShareAccessLog[]>([]);
    const [loading, setLoading] = useState(false);
    const eventLabels: Record<ShareAccessLog["event"], string> = { open: t("canvas.share.events.open"), edit: t("canvas.share.events.edit"), clone: t("canvas.share.events.clone") };

    useEffect(() => {
        if (!shareId) return;
        setLoading(true);
        shareAdminApi
            .logs(projectId, shareId)
            .then((result) => setLogs(result.items))
            .catch((error: Error) => message.error(error.message || t("canvas.share.errors.loadLogs")))
            .finally(() => setLoading(false));
    }, [message, projectId, shareId, t]);

    const rows = useMemo(() => logs.slice(0, 200), [logs]);

    return (
        <Modal title={t("canvas.share.accessLogs")} open={Boolean(shareId)} onCancel={onClose} footer={null} centered width={560}>
            <p className="mb-3 text-xs opacity-55">{t("canvas.share.logsHint")}</p>
            {loading ? <Loader2 className="mx-auto my-8 size-5 animate-spin" /> : null}
            {!loading && !rows.length ? <Empty description={t("canvas.share.noLogs")} image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
            <div className="max-h-[50vh] space-y-1.5 overflow-auto">
                {rows.map((log) => (
                    <div key={log.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-xs odd:bg-black/[.03] dark:odd:bg-white/[.04]">
                        <span className="w-14 shrink-0 font-medium">{eventLabels[log.event] || log.event}</span>
                        <span className="min-w-0 flex-1 truncate opacity-70">{log.isAnonymous ? t("canvas.share.anonymousVisitor", { id: log.actorId.slice(-6) }) : log.actorId}</span>
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
