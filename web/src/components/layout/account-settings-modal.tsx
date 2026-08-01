import { App, Button, Form, Input, Modal, Progress } from "antd";
import { useEffect, useState } from "react";

import { formatBytes } from "@/lib/image-utils";
import { serverApi, type ServerStorage } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

type PasswordForm = { oldPassword?: string; newPassword: string };

/** 账号设置：修改密码与 Linux.do 绑定，绑定状态由服务端校验，前端只负责发起并提示结果。 */
export function AccountSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<PasswordForm>();
    const [saving, setSaving] = useState(false);
    const [linking, setLinking] = useState(false);
    const user = useServerStore((state) => state.user);
    const linuxDoEnabled = useServerStore((state) => state.settings?.auth.linuxDo.enabled);
    const [storage, setStorage] = useState<ServerStorage | null>(null);

    useEffect(() => {
        if (!open) return;
        void serverApi
            .storage()
            .then(setStorage)
            .catch(() => setStorage(null));
    }, [open]);

    const submitPassword = async (values: PasswordForm) => {
        setSaving(true);
        try {
            await serverApi.changePassword(values.oldPassword || "", values.newPassword);
            form.resetFields();
            message.success("密码已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改密码失败");
        } finally {
            setSaving(false);
        }
    };

    const bindLinuxDo = async () => {
        setLinking(true);
        try {
            const { url } = await serverApi.linuxDoBindUrl(`${window.location.pathname}${window.location.search}`);
            window.location.href = url;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "获取授权地址失败");
            setLinking(false);
        }
    };

    const unbindLinuxDo = async () => {
        setLinking(true);
        try {
            useServerStore.getState().setUser(await serverApi.unbindLinuxDo());
            message.success("已解绑 Linux.do");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "解绑 Linux.do 失败");
        } finally {
            setLinking(false);
        }
    };

    const percent = storage ? Math.min(100, Number((storage.quota ? (storage.used / storage.quota) * 100 : 100).toFixed(1))) : 0;
    const nearlyFull = percent >= 90;

    return (
        <Modal title="账号设置" open={open} onCancel={onClose} footer={null} width={480} destroyOnHidden>
            <div className="mt-1 text-xs text-stone-500">当前账号：{user?.displayName || user?.username || "未登录"}</div>

            {storage ? (
                <>
                    <div className="mt-5 text-sm font-semibold">云空间</div>
                    <div className="mt-1 text-xs text-stone-500">上传的图片与生成结果都存在云端，删除画布或素材后不再被引用的文件会自动回收。</div>
                    <Progress className="mt-2 mb-0" percent={percent} showInfo={false} status={nearlyFull ? "exception" : "normal"} />
                    <div className={`text-xs ${nearlyFull ? "font-medium text-red-500" : "text-stone-500"}`}>
                        已用 {formatBytes(storage.used) || "0 B"} / 共 {formatBytes(storage.quota) || "0 B"}
                    </div>
                </>
            ) : null}

            <div className="mt-5 text-sm font-semibold">修改密码</div>
            <Form form={form} layout="vertical" className="mt-3" requiredMark={false} disabled={saving} onFinish={submitPassword}>
                <Form.Item name="oldPassword" label="原密码" extra="第三方登录创建的账号没有原密码，留空即可。" className="mb-4">
                    <Input.Password autoComplete="current-password" placeholder="留空表示当前账号还没有密码" />
                </Form.Item>
                <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 6, message: "新密码至少 6 位" }]} className="mb-4">
                    <Input.Password autoComplete="new-password" placeholder="至少 6 位" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>
                    保存密码
                </Button>
            </Form>

            {linuxDoEnabled ? (
                <>
                    <div className="mt-6 text-sm font-semibold">Linux.do 账号</div>
                    <div className="mt-1 text-xs text-stone-500">绑定后可以直接用 Linux.do 登录；没有设置过密码的账号不能解绑，否则将无法登录。</div>
                    <div className="mt-3 flex gap-2">
                        <Button loading={linking} onClick={() => void bindLinuxDo()}>
                            绑定 Linux.do
                        </Button>
                        <Button danger loading={linking} onClick={() => void unbindLinuxDo()}>
                            解绑
                        </Button>
                    </div>
                </>
            ) : null}
        </Modal>
    );
}
