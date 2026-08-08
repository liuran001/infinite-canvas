import { App, Button, Form, Input, Modal, Progress } from "antd";
import { useEffect, useState } from "react";

import { clearCurrentAccountLocalData } from "@/services/account-local-data";
import { formatBytes } from "@/lib/image-utils";
import { serverApi, type ServerStorage } from "@/services/api/server";
import { PasskeyManager } from "@/components/layout/passkey-manager";
import { useServerStore } from "@/stores/use-server-store";

type PasswordForm = { oldPassword?: string; newPassword: string };
type ProfileForm = { displayName: string };

/** 与服务端 auth.ts 的 DISPLAY_NAME_MAX 保持一致：前端先挡住，用户就不会填了一长串再被服务端整条打回。 */
const DISPLAY_NAME_MAX = 64;

/** 账号设置：昵称、修改密码与 Linux.do 绑定，绑定状态由服务端校验，前端只负责发起并提示结果。 */
export function AccountSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const [form] = Form.useForm<PasswordForm>();
    const [profileForm] = Form.useForm<ProfileForm>();
    const [saving, setSaving] = useState(false);
    const [savingProfile, setSavingProfile] = useState(false);
    const [linking, setLinking] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteName, setDeleteName] = useState("");
    const [deleting, setDeleting] = useState(false);
    const user = useServerStore((state) => state.user);
    const linuxDoEnabled = useServerStore((state) => state.settings?.auth.linuxDo.enabled);
    const linuxDoBound = useServerStore((state) => state.user?.linuxDoBound);
    const [storage, setStorage] = useState<ServerStorage | null>(null);

    useEffect(() => {
        if (!open) return;
        void serverApi
            .storage()
            .then(setStorage)
            .catch(() => setStorage(null));
    }, [open]);

    // 每次打开都用当前昵称重置：弹窗不销毁表单，上次改了一半又关掉的草稿会一直留着，
    // 下次打开看到的就不是账号真正的昵称了。
    useEffect(() => {
        if (open) profileForm.setFieldsValue({ displayName: user?.displayName || "" });
    }, [open, profileForm, user?.displayName]);

    const submitProfile = async (values: ProfileForm) => {
        setSavingProfile(true);
        try {
            // 服务端回的是完整用户对象，必须写回 store：顶栏、团队成员列表、协作 presence 都读它，
            // 只提示一句「已保存」而不更新的话，界面会一直停在旧昵称上，用户以为没改成功又改一遍。
            useServerStore.getState().setUser(await serverApi.updateProfile(values.displayName || ""));
            message.success("昵称已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改昵称失败");
        } finally {
            setSavingProfile(false);
        }
    };

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

    const requestDeletion = async () => {
        if (!user || deleteName.trim() !== user.username) return;
        setDeleting(true);
        try {
            const result = await serverApi.requestAccountDeletion();
            await clearCurrentAccountLocalData();
            useServerStore.getState().clearSession();
            setDeleteOpen(false);
            onClose();
            message.success(`注销申请已提交，将于 ${new Date(result.deletesAt).toLocaleString()} 完成`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "申请注销失败");
        } finally {
            setDeleting(false);
        }
    };

    const percent = storage ? Math.min(100, Number((storage.quota ? (storage.used / storage.quota) * 100 : 100).toFixed(1))) : 0;
    const nearlyFull = percent >= 90;

    return (
        <Modal title="账号设置" open={open} onCancel={onClose} footer={null} width={480} destroyOnHidden>
            <div className="mt-1 text-xs text-stone-500" data-testid="account-current-name">
                当前账号：{user?.displayName || user?.username || "未登录"}
            </div>

            {user ? (
                <Form form={profileForm} layout="vertical" className="mt-5" requiredMark={false} disabled={savingProfile} onFinish={submitProfile}>
                    {/*
                     * 用户名不给改：它是登录凭据，也是流水、邀请记录里定位到人的锚点，改掉之后那些历史记录会指向一个不存在的名字。
                     * 昵称允许留空——全站显示处都写成 displayName || username，空值会自然回落到用户名，不会出现无名氏。
                     */}
                    <Form.Item name="displayName" label="昵称" extra={`留空则显示用户名「${user.username}」。用户名不可修改。`} className="mb-3">
                        <Input maxLength={DISPLAY_NAME_MAX} showCount placeholder="想让别人怎么称呼你" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={savingProfile}>
                        保存昵称
                    </Button>
                </Form>
            ) : null}

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

            <PasskeyManager />

            <div className="mt-5 text-sm font-semibold">修改密码</div>
            <Form form={form} layout="vertical" className="mt-3" requiredMark={false} disabled={saving} onFinish={submitPassword}>
                <Form.Item name="oldPassword" label="原密码" extra="第三方登录创建的账号没有原密码，留空即可。" className="mb-4">
                    <Input.Password autoComplete="current-password" placeholder="留空表示当前账号还没有密码" />
                </Form.Item>
                <Form.Item
                    name="newPassword"
                    label="新密码"
                    rules={[
                        { required: true, message: "请输入新密码" },
                        { min: 6, message: "新密码至少 6 位" },
                    ]}
                    className="mb-4"
                >
                    <Input.Password autoComplete="new-password" placeholder="至少 6 位" />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>
                    保存密码
                </Button>
            </Form>

            {linuxDoEnabled ? (
                <>
                    <div className="mt-6 text-sm font-semibold">Linux.do 账号</div>
                    <div className="mt-1 text-xs text-stone-500">{linuxDoBound ? "已绑定，可以直接用 Linux.do 登录；没有设置过密码的账号不能解绑，否则将无法登录。" : "绑定后可以直接用 Linux.do 登录。"}</div>
                    <div className="mt-3 flex gap-2">
                        {linuxDoBound ? (
                            <Button danger loading={linking} onClick={() => void unbindLinuxDo()}>
                                解绑 Linux.do
                            </Button>
                        ) : (
                            <Button loading={linking} onClick={() => void bindLinuxDo()}>
                                绑定 Linux.do
                            </Button>
                        )}
                    </div>
                </>
            ) : null}

            {user ? (
                <div className="mt-7 border-t border-red-200 pt-5 dark:border-red-950">
                    <div className="text-sm font-semibold text-red-600 dark:text-red-400">注销账号</div>
                    <div className="mt-1 text-xs leading-5 text-stone-500">
                        申请后所有设备会立即退出，24 小时内重新登录可取消注销。必须先退出或解散全部团队；到期后云端画布、素材、文件、插件、任务、分享、Passkey 与第三方绑定都会清除。
                    </div>
                    <Button danger className="mt-3" onClick={() => { setDeleteName(""); setDeleteOpen(true); }}>
                        申请注销账号
                    </Button>
                </div>
            ) : null}

            <Modal
                title="再次确认注销账号"
                open={deleteOpen}
                okText="确认提交注销申请"
                cancelText="取消"
                okButtonProps={{ danger: true, disabled: deleteName.trim() !== user?.username, loading: deleting }}
                onOk={() => void requestDeletion()}
                onCancel={() => !deleting && setDeleteOpen(false)}
                closable={!deleting}
                maskClosable={!deleting}
            >
                <div className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
                    此操作会进入 24 小时冷静期。若不再登录，账号最终只保留后台审计墓碑，原用户名会释放给其他人注册。
                </div>
                <div className="mt-4 text-sm">请输入用户名「{user?.username}」确认：</div>
                <Input className="mt-2" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder="输入当前用户名" disabled={deleting} />
            </Modal>
        </Modal>
    );
}
