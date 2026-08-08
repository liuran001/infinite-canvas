import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { App, Button, Empty, Input, List, Modal, Spin } from "antd";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { serverApi, type ServerPasskey } from "@/services/api/server";

export function PasskeyManager() {
    const { t, i18n } = useTranslation();
    const resolvedLanguage = i18n.resolvedLanguage || i18n.language;
    const { message, modal } = App.useApp();
    const [items, setItems] = useState<ServerPasskey[]>([]);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [renaming, setRenaming] = useState<ServerPasskey | null>(null);
    const [name, setName] = useState("");

    const load = () =>
        serverApi
            .passkeys()
            .then(setItems)
            .catch((error: Error) => message.error(error.message))
            .finally(() => setLoading(false));

    useEffect(() => {
        void load();
    }, []);

    const add = async () => {
        setAdding(true);
        try {
            const optionsJSON = await serverApi.passkeyRegisterOptions();
            const response = await startRegistration({ optionsJSON });
            await serverApi.passkeyRegisterVerify(response, t("account.passkey.defaultName", { index: items.length + 1 }));
            message.success(t("account.passkey.added"));
            await load();
        } catch (error) {
            // 用户主动取消系统弹窗也会抛错，这里不当成失败提示。
            const text = error instanceof Error ? error.message : t("account.passkey.addFailed");
            if (!/NotAllowed|abort|cancel/i.test(text)) message.error(text);
        } finally {
            setAdding(false);
        }
    };

    const remove = (item: ServerPasskey) =>
        modal.confirm({
            title: t("account.passkey.deleteTitle"),
            content: t("account.passkey.deleteContent", { name: item.name }),
            okText: t("account.passkey.delete"),
            okButtonProps: { danger: true },
            cancelText: t("account.passkey.cancel"),
            onOk: async () => {
                try {
                    await serverApi.deletePasskey(item.id);
                    message.success(t("account.passkey.deleted"));
                    await load();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : t("account.passkey.deleteFailed"));
                }
            },
        });

    const rename = async () => {
        if (!renaming) return;
        try {
            await serverApi.renamePasskey(renaming.id, name);
            setRenaming(null);
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("account.passkey.renameFailed"));
        }
    };

    if (!browserSupportsWebAuthn()) return <div className="text-sm text-stone-500">{t("account.passkey.unsupported")}</div>;

    return (
        <div>
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-sm font-medium">{t("account.passkey.title")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("account.passkey.description")}</div>
                </div>
                <Button icon={<Plus className="size-4" />} loading={adding} onClick={add}>
                    {t("account.passkey.add")}
                </Button>
            </div>

            {loading ? (
                <div className="flex justify-center py-6">
                    <Spin />
                </div>
            ) : items.length ? (
                <List
                    className="mt-3"
                    size="small"
                    dataSource={items}
                    renderItem={(item) => (
                        <List.Item
                            actions={[
                                <Button
                                    key="rename"
                                    type="text"
                                    size="small"
                                    icon={<Pencil className="size-4" />}
                                    onClick={() => {
                                        setRenaming(item);
                                        setName(item.name);
                                    }}
                                />,
                                <Button key="delete" type="text" size="small" danger icon={<Trash2 className="size-4" />} onClick={() => remove(item)} />,
                            ]}
                        >
                            <List.Item.Meta avatar={<KeyRound className="size-4 text-stone-400" />} title={item.name} description={new Date(item.createdAt).toLocaleString(resolvedLanguage)} />
                        </List.Item>
                    )}
                />
            ) : (
                <Empty className="my-4" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("account.passkey.empty")} />
            )}

            <Modal open={Boolean(renaming)} title={t("account.passkey.renameTitle")} okText={t("account.passkey.save")} cancelText={t("account.passkey.cancel")} onOk={rename} onCancel={() => setRenaming(null)}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("account.passkey.namePlaceholder")} onPressEnter={rename} />
            </Modal>
        </div>
    );
}
