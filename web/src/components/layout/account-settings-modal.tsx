import { App, Button, Form, Input, Modal, Progress } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
    const { t, i18n } = useTranslation();
    const resolvedLanguage = i18n.resolvedLanguage || i18n.language;
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
            message.success(t("account.profile.updated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("account.profile.updateFailed"));
        } finally {
            setSavingProfile(false);
        }
    };

    const submitPassword = async (values: PasswordForm) => {
        setSaving(true);
        try {
            await serverApi.changePassword(values.oldPassword || "", values.newPassword);
            form.resetFields();
            message.success(t("account.password.updated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("account.password.updateFailed"));
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
            message.error(error instanceof Error ? error.message : t("account.linuxDo.authUrlFailed"));
            setLinking(false);
        }
    };

    const unbindLinuxDo = async () => {
        setLinking(true);
        try {
            useServerStore.getState().setUser(await serverApi.unbindLinuxDo());
            message.success(t("account.linuxDo.unbound"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("account.linuxDo.unbindFailed"));
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
            message.success(t("account.deletion.requested", { date: new Date(result.deletesAt).toLocaleString(resolvedLanguage) }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("account.deletion.failed"));
        } finally {
            setDeleting(false);
        }
    };

    const percent = storage ? Math.min(100, Number((storage.quota ? (storage.used / storage.quota) * 100 : 100).toFixed(1))) : 0;
    const nearlyFull = percent >= 90;

    return (
        <Modal title={t("account.title")} open={open} onCancel={onClose} footer={null} width={480} destroyOnHidden>
            <div className="mt-1 text-xs text-stone-500" data-testid="account-current-name">
                {t("account.currentAccount", { name: user?.displayName || user?.username || t("account.signedOut") })}
            </div>

            {user ? (
                <Form form={profileForm} layout="vertical" className="mt-5" requiredMark={false} disabled={savingProfile} onFinish={submitProfile}>
                    {/*
                     * 用户名不给改：它是登录凭据，也是流水、邀请记录里定位到人的锚点，改掉之后那些历史记录会指向一个不存在的名字。
                     * 昵称允许留空——全站显示处都写成 displayName || username，空值会自然回落到用户名，不会出现无名氏。
                     */}
                    <Form.Item name="displayName" label={t("account.profile.displayName")} extra={t("account.profile.extra", { username: user.username })} className="mb-3">
                        <Input maxLength={DISPLAY_NAME_MAX} showCount placeholder={t("account.profile.placeholder")} />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" loading={savingProfile}>
                        {t("account.profile.save")}
                    </Button>
                </Form>
            ) : null}

            {storage ? (
                <>
                    <div className="mt-5 text-sm font-semibold">{t("account.storage.title")}</div>
                    <div className="mt-1 text-xs text-stone-500">{t("account.storage.description")}</div>
                    <Progress className="mt-2 mb-0" percent={percent} showInfo={false} status={nearlyFull ? "exception" : "normal"} />
                    <div className={`text-xs ${nearlyFull ? "font-medium text-red-500" : "text-stone-500"}`}>
                        {t("account.storage.usage", { used: formatBytes(storage.used) || "0 B", quota: formatBytes(storage.quota) || "0 B" })}
                    </div>
                </>
            ) : null}

            <PasskeyManager />

            <div className="mt-5 text-sm font-semibold">{t("account.password.title")}</div>
            <Form form={form} layout="vertical" className="mt-3" requiredMark={false} disabled={saving} onFinish={submitPassword}>
                <Form.Item name="oldPassword" label={t("account.password.oldPassword")} extra={t("account.password.oldPasswordExtra")} className="mb-4">
                    <Input.Password autoComplete="current-password" placeholder={t("account.password.oldPasswordPlaceholder")} />
                </Form.Item>
                <Form.Item
                    name="newPassword"
                    label={t("account.password.newPassword")}
                    rules={[
                        { required: true, message: t("account.password.required") },
                        { min: 6, message: t("account.password.minLength") },
                    ]}
                    className="mb-4"
                >
                    <Input.Password autoComplete="new-password" placeholder={t("account.password.newPasswordPlaceholder")} />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={saving}>
                    {t("account.password.save")}
                </Button>
            </Form>

            {linuxDoEnabled ? (
                <>
                    <div className="mt-6 text-sm font-semibold">{t("account.linuxDo.title")}</div>
                    <div className="mt-1 text-xs text-stone-500">{t(linuxDoBound ? "account.linuxDo.boundDescription" : "account.linuxDo.unboundDescription")}</div>
                    <div className="mt-3 flex gap-2">
                        {linuxDoBound ? (
                            <Button danger loading={linking} onClick={() => void unbindLinuxDo()}>
                                {t("account.linuxDo.unbind")}
                            </Button>
                        ) : (
                            <Button loading={linking} onClick={() => void bindLinuxDo()}>
                                {t("account.linuxDo.bind")}
                            </Button>
                        )}
                    </div>
                </>
            ) : null}

            {user ? (
                <div className="mt-7 border-t border-red-200 pt-5 dark:border-red-950">
                    <div className="text-sm font-semibold text-red-600 dark:text-red-400">{t("account.deletion.title")}</div>
                    <div className="mt-1 text-xs leading-5 text-stone-500">
                        {t("account.deletion.description")}
                    </div>
                    <Button danger className="mt-3" onClick={() => { setDeleteName(""); setDeleteOpen(true); }}>
                        {t("account.deletion.request")}
                    </Button>
                </div>
            ) : null}

            <Modal
                title={t("account.deletion.confirmTitle")}
                open={deleteOpen}
                okText={t("account.deletion.confirmSubmit")}
                cancelText={t("account.deletion.cancel")}
                okButtonProps={{ danger: true, disabled: deleteName.trim() !== user?.username, loading: deleting }}
                onOk={() => void requestDeletion()}
                onCancel={() => !deleting && setDeleteOpen(false)}
                closable={!deleting}
                maskClosable={!deleting}
            >
                <div className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
                    {t("account.deletion.coolingDescription")}
                </div>
                <div className="mt-4 text-sm">{t("account.deletion.enterUsername", { username: user?.username })}</div>
                <Input className="mt-2" value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder={t("account.deletion.placeholder")} disabled={deleting} />
            </Modal>
        </Modal>
    );
}
