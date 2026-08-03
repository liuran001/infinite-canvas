import { App, Button, Descriptions, Form, Input, Modal, Progress, Select } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { formatBytes } from "@/lib/image-utils";
import { teamApi } from "@/services/api/teams";
import { canManageTeam, isTeamOwner, useTeamStore } from "@/stores/use-team-store";
import { useTeamContext } from "./layout";
import { useQuery } from "@tanstack/react-query";

/** 团队概览：基本信息、我的角色能做什么，以及改名、转让、解散、退出这几个整体性操作。 */
export default function TeamDetailPage() {
    const { team, refresh } = useTeamContext();
    const { message, modal } = App.useApp();
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
            message.success("已保存");
            refresh();
        } catch (error) {
            // 校验失败表单自己已经标红，再弹一句「保存失败」会被当成服务端出错。
            if (error && typeof error === "object" && "errorFields" in error) return;
            message.error(error instanceof Error ? error.message : "保存团队失败");
        } finally {
            setSaving(false);
        }
    };

    const transfer = async () => {
        if (!transferTo) return message.warning("请选择要转让给谁");
        // 转让是不可逆的：没有这个开关，弹窗的确定按钮在请求飞行期间还能再点，
        // 第二次请求发出时自己已经不是 owner 了，用户看到的是一句莫名其妙的「无权限」。
        if (transferSubmitting) return;
        setTransferSubmitting(true);
        try {
            await teamApi.transferOwner(team.id, transferTo);
            setTransferring(false);
            setTransferTo("");
            message.success("已转让团队");
            refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "转让团队失败");
        } finally {
            setTransferSubmitting(false);
        }
    };

    const confirmLeave = () =>
        modal.confirm({
            title: "退出这个团队？",
            content: "退出后你不能再用团队积分生成内容，已经产生的流水仍然保留。",
            okText: "退出",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await teamApi.leaveTeam(team.id);
                    message.success("已退出团队");
                    navigate("/teams");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "退出团队失败");
                }
            },
        });

    const confirmDisband = () =>
        modal.confirm({
            title: `解散团队「${team.name}」？`,
            content: "解散后所有成员会被移出，团队名下的画布会退回各自主人的个人账号；历史流水保留供对账。",
            okText: "解散",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await teamApi.disbandTeam(team.id);
                    message.success("团队已解散");
                    navigate("/teams");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "解散团队失败");
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
                    { key: "name", label: "团队名称", children: team.name },
                    { key: "description", label: "团队简介", children: team.description || "-" },
                    { key: "memberLimit", label: "成员上限", children: team.memberLimit ? `${team.memberLimit} 人` : "不限" },
                    { key: "status", label: "状态", children: team.status === "active" ? "正常" : "已被平台停用" },
                    { key: "createdAt", label: "创建时间", children: team.createdAt || "-" },
                ]}
            />

            <div className="mt-4 rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">团队云空间</span>
                    <span className={`text-sm tabular-nums ${storageNearlyFull ? "font-medium text-red-500" : "text-stone-500"}`} data-testid="team-storage">
                        {formatBytes(storageUsed) || "0 B"} / {formatBytes(storageQuota) || "0 B"}
                    </span>
                </div>
                <Progress className="mt-2 mb-0" percent={storagePercent} showInfo={false} status={storageNearlyFull ? "exception" : "normal"} />
                {/* 说清是两本账：不写明的话，空间满了用户第一反应是去删自己的个人画布，删完一点用都没有。 */}
                <p className="mt-2 text-xs text-stone-500">团队画布上传的图片与生成结果都计入这里，与你的个人云空间是两本账，互不占用。配额只能由平台管理员调整。</p>
                {storageNearlyFull ? <p className="mt-1 text-xs text-red-500">团队空间快满了，建议清理团队里不再需要的画布与素材，或请平台管理员调大配额。</p> : null}
            </div>

            <p className="mt-4 text-xs text-stone-500">团队积分只能由平台管理员充值。团队积分用尽时是否改用你的个人积分，由「配置与用户偏好」里的开关决定，默认不改用。</p>

            <div className="mt-6 flex flex-wrap gap-2">
                {manageable ? <Button onClick={openEdit}>编辑团队信息</Button> : null}
                {owner ? <Button onClick={() => setTransferring(true)}>转让团队</Button> : null}
                {owner ? (
                    <Button danger onClick={confirmDisband}>
                        解散团队
                    </Button>
                ) : (
                    <Button danger onClick={confirmLeave}>
                        退出团队
                    </Button>
                )}
            </div>

            <Modal open={editing} title="编辑团队信息" okText="保存" cancelText="取消" confirmLoading={saving} onOk={() => void save()} onCancel={() => setEditing(false)} destroyOnHidden>
                <Form form={editForm} layout="vertical" className="mt-4">
                    <Form.Item name="name" label="团队名称" rules={[{ required: true, message: "请填写团队名称" }]}>
                        <Input maxLength={64} />
                    </Form.Item>
                    <Form.Item name="description" label="团队简介">
                        <Input.TextArea rows={2} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal open={transferring} title="转让团队" okText="确认转让" cancelText="取消" confirmLoading={transferSubmitting} onOk={() => void transfer()} onCancel={() => setTransferring(false)} destroyOnHidden>
                <p className="mt-4 text-sm text-stone-500">转让后你会变成管理员，新的所有者接管解散与转让的权限。</p>
                <Select
                    className="mt-3 w-full"
                    value={transferTo || undefined}
                    placeholder="选择团队成员"
                    aria-label="选择接手团队的成员"
                    loading={members.isFetching}
                    onChange={setTransferTo}
                    options={(members.data || []).filter((item) => item.role !== "owner" && item.status === "active").map((item) => ({ value: item.userId, label: item.displayName || item.username || item.userId }))}
                />
            </Modal>
        </div>
    );
}
