import { App, Button, Descriptions, Form, Input, Modal, Select } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { teamApi } from "@/services/api/teams";
import { canManageTeam, isTeamOwner } from "@/stores/use-team-store";
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
