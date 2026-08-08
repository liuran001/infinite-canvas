import { App, Button, Descriptions, Form, Input, Modal, Progress, Select } from "antd";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { formatBytes } from "@/lib/image-utils";
import { teamApi } from "@/services/api/teams";
import { canManageTeam, isTeamOwner, useTeamStore } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";

/** 团队概览：基本信息、我的角色能做什么，以及改名、转让、解散、退出这几个整体性操作。 */
export default function TeamDetailPage() {
    const { team, refresh } = useTeamContext();
    const { message, modal } = App.useApp();
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [editForm] = Form.useForm<{ name: string; description?: string }>();
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [transferring, setTransferring] = useState(false);
    const [transferSubmitting, setTransferSubmitting] = useState(false);
    const [transferTo, setTransferTo] = useState("");
    const manageable = canManageTeam(team.myRole);
    const owner = isTeamOwner(team.myRole);
    /*
     * 用量读 store 而不是 outlet 里那份 REST 快照：store 里的值由团队 SSE 实时更新，
     * 队友刚上传完，这个页面上的数字就该跟着动。用快照的话，只有手动刷新才会变，
     * 用户会照着一个偏小的数字继续传，直到某一次上传突然失败才知道其实早就满了。
     * 两个字段分开订阅，不要合成对象返回——Zustand 5 用 useSyncExternalStore，
     * selector 每次返回新对象引用会无限重渲染并抛 React error #185。
     */
    const storageUsed = useTeamStore((state) => state.storageUsed);
    const storageQuota = useTeamStore((state) => state.storageQuota);
    const storagePercent = storageQuota ? Math.min(100, Number(((storageUsed / storageQuota) * 100).toFixed(1))) : 0;
    const storageNearlyFull = storagePercent >= 90;
    // 转让要在成员里选人，只有 owner 会打开这个弹窗，其余角色不必白拉一次成员列表。
    const members = useQuery({ queryKey: ["team-members", team.id], queryFn: () => teamApi.members(team.id), enabled: transferring });

    const openEdit = () => {
        editForm.setFieldsValue({ name: team.name, description: team.description });
        setEditing(true);
    };

    const save = async () => {
        setSaving(true);
        try {
            // 校验失败会 reject，放在 try 外面就是一条没人接的 promise rejection：
            // 名称留空时按钮不动、控制台报错，用户只当页面卡住了。
            const values = await editForm.validateFields();
            await teamApi.updateTeam(team.id, values);
            setEditing(false);
            message.success(t("teams.detail.saved"));
            refresh();
        } catch (error) {
            // 校验失败表单自己已经标红，再弹一句「保存失败」会被当成服务端出错。
            if (error && typeof error === "object" && "errorFields" in error) return;
            message.error(error instanceof Error ? error.message : t("teams.detail.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const transfer = async () => {
        if (!transferTo) return message.warning(t("teams.detail.selectTransferTarget"));
        // 转让是不可逆的：没有这个开关，弹窗的确定按钮在请求飞行期间还能再点，
        // 第二次请求发出时自己已经不是 owner 了，用户看到的是一句莫名其妙的「无权限」。
        if (transferSubmitting) return;
        setTransferSubmitting(true);
        try {
            await teamApi.transferOwner(team.id, transferTo);
            setTransferring(false);
            setTransferTo("");
            message.success(t("teams.detail.transferred"));
            refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("teams.detail.transferFailed"));
        } finally {
            setTransferSubmitting(false);
        }
    };

    const confirmLeave = () =>
        modal.confirm({
            title: t("teams.detail.leaveTitle"),
            content: t("teams.detail.leaveDescription"),
            okText: t("teams.detail.leaveConfirm"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                try {
                    await teamApi.leaveTeam(team.id);
                    message.success(t("teams.detail.left"));
                    navigate("/teams");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("teams.detail.leaveFailed"));
                }
            },
        });

    const confirmDisband = () =>
        modal.confirm({
            title: t("teams.detail.disbandTitle", { name: team.name }),
            content: t("teams.detail.disbandDescription"),
            okText: t("teams.detail.disbandConfirm"),
            okButtonProps: { danger: true },
            cancelText: t("common.cancel"),
            onOk: async () => {
                try {
                    await teamApi.disbandTeam(team.id);
                    message.success(t("teams.detail.disbanded"));
                    navigate("/teams");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("teams.detail.disbandFailed"));
                }
            },
        });

    return (
        <div>
            <Descriptions
                bordered
                size="small"
                column={1}
                items={[
                    { key: "name", label: t("teams.detail.fields.name"), children: team.name },
                    { key: "description", label: t("teams.detail.fields.description"), children: team.description || "-" },
                    { key: "memberLimit", label: t("teams.detail.fields.memberLimit"), children: team.memberLimit ? t("teams.detail.fields.people", { count: team.memberLimit }) : t("teams.common.unlimited") },
                    { key: "status", label: t("teams.detail.fields.status"), children: t(`teams.statuses.${team.status}`, { defaultValue: team.status }) },
                    { key: "createdAt", label: t("teams.detail.fields.createdAt"), children: team.createdAt ? new Date(team.createdAt).toLocaleString(i18n.language, { hour12: false }) : "-" },
                ]}
            />

            <div className="mt-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">{t("teams.detail.storageTitle")}</span>
                    <span className={`text-sm tabular-nums ${storageNearlyFull ? "font-medium text-red-500" : "text-stone-500"}`} data-testid="team-storage">
                        {formatBytes(storageUsed) || "0 B"} / {formatBytes(storageQuota) || "0 B"}
                    </span>
                </div>
                <Progress className="mt-2 mb-0" percent={storagePercent} showInfo={false} status={storageNearlyFull ? "exception" : "normal"} />
                {/* 说清是两本账：不写明的话，空间满了用户第一反应是去删自己的个人画布，删完一点用都没有。 */}
                <p className="mt-2 text-xs text-stone-500">{t("teams.detail.storageDescription")}</p>
                {storageNearlyFull ? <p className="mt-1 text-xs text-red-500">{t("teams.detail.storageNearlyFull")}</p> : null}
            </div>

            <p className="mt-4 text-xs text-stone-500">{t("teams.detail.creditsDescription")}</p>

            <div className="mt-6 flex flex-wrap gap-2">
                {manageable ? <Button onClick={openEdit}>{t("teams.detail.edit")}</Button> : null}
                {owner ? <Button onClick={() => setTransferring(true)}>{t("teams.detail.transfer")}</Button> : null}
                {owner ? (
                    <Button danger onClick={confirmDisband}>
                        {t("teams.detail.disband")}
                    </Button>
                ) : (
                    <Button danger onClick={confirmLeave}>
                        {t("teams.detail.leave")}
                    </Button>
                )}
            </div>

            <Modal open={editing} title={t("teams.detail.editTitle")} okText={t("common.save")} cancelText={t("common.cancel")} confirmLoading={saving} onOk={() => void save()} onCancel={() => setEditing(false)} destroyOnHidden>
                <Form form={editForm} layout="vertical" className="mt-4">
                    <Form.Item name="name" label={t("teams.detail.fields.name")} rules={[{ required: true, message: t("teams.detail.nameRequired") }]}>
                        <Input maxLength={64} />
                    </Form.Item>
                    <Form.Item name="description" label={t("teams.detail.fields.description")}>
                        <Input.TextArea rows={2} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={transferring}
                title={t("teams.detail.transferTitle")}
                okText={t("teams.detail.transferConfirm")}
                cancelText={t("common.cancel")}
                confirmLoading={transferSubmitting}
                onOk={() => void transfer()}
                onCancel={() => setTransferring(false)}
                destroyOnHidden
            >
                <p className="mt-4 text-sm text-stone-500">{t("teams.detail.transferDescription")}</p>
                <Select
                    className="mt-3 w-full"
                    value={transferTo || undefined}
                    placeholder={t("teams.detail.transferPlaceholder")}
                    aria-label={t("teams.detail.transferAria")}
                    loading={members.isFetching}
                    onChange={setTransferTo}
                    options={(members.data || []).filter((item) => item.role !== "owner" && item.status === "active").map((item) => ({ value: item.userId, label: item.displayName || item.username || item.userId }))}
                />
            </Modal>
        </div>
    );
}
