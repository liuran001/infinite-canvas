import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { App, Button, Empty, Input, List, Modal, Spin } from "antd";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { serverApi, type ServerPasskey } from "@/services/api/server";

export function PasskeyManager() {
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
            await serverApi.passkeyRegisterVerify(response, `Passkey ${items.length + 1}`);
            message.success("Passkey 添加成功");
            await load();
        } catch (error) {
            // 用户主动取消系统弹窗也会抛错，这里不当成失败提示。
            const text = error instanceof Error ? error.message : "添加 Passkey 失败";
            if (!/NotAllowed|abort|cancel/i.test(text)) message.error(text);
        } finally {
            setAdding(false);
        }
    };

    const remove = (item: ServerPasskey) =>
        modal.confirm({
            title: "删除 Passkey",
            content: `确定删除「${item.name}」吗？删除后该设备将无法用它登录。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await serverApi.deletePasskey(item.id);
                    message.success("已删除");
                    await load();
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "删除 Passkey 失败");
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
            message.error(error instanceof Error ? error.message : "重命名 Passkey 失败");
        }
    };

    if (!browserSupportsWebAuthn()) return <div className="text-sm text-stone-500">当前浏览器不支持 Passkey</div>;

    return (
        <div>
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-sm font-medium">Passkey</div>
                    <div className="mt-0.5 text-xs text-stone-500">用指纹、面容或设备密码登录，无需输入密码</div>
                </div>
                <Button icon={<Plus className="size-4" />} loading={adding} onClick={add}>
                    添加
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
                            <List.Item.Meta avatar={<KeyRound className="size-4 text-stone-400" />} title={item.name} description={new Date(item.createdAt).toLocaleString()} />
                        </List.Item>
                    )}
                />
            ) : (
                <Empty className="my-4" image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有添加 Passkey" />
            )}

            <Modal open={Boolean(renaming)} title="重命名 Passkey" okText="保存" cancelText="取消" onOk={rename} onCancel={() => setRenaming(null)}>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Passkey 名称" onPressEnter={rename} />
            </Modal>
        </div>
    );
}
