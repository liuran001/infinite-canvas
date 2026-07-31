import { App, Button, Form, Input, Switch, Tag } from "antd";
import { Cloud, LogOut, RefreshCw, Shield, Wifi } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { connectServer } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

export function ConfigServer() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [testing, setTesting] = useState(false);
    const [draftBaseUrl, setDraftBaseUrl] = useState(() => useServerStore.getState().baseUrl);
    const enabled = useServerStore((state) => state.enabled);
    const baseUrl = useServerStore((state) => state.baseUrl);
    const user = useServerStore((state) => state.user);
    const settings = useServerStore((state) => state.settings);
    const status = useServerStore((state) => state.status);
    const error = useServerStore((state) => state.error);
    const setEnabled = useServerStore((state) => state.setEnabled);
    const setBaseUrl = useServerStore((state) => state.setBaseUrl);
    const clearSession = useServerStore((state) => state.clearSession);

    const connect = async () => {
        setTesting(true);
        if (draftBaseUrl.trim().replace(/\/+$/, "") !== baseUrl) setBaseUrl(draftBaseUrl);
        const success = await connectServer();
        setTesting(false);
        if (success) message.success("已连接服务器");
        else message.error(useServerStore.getState().error || "连接服务器失败");
    };

    return (
        <Form layout="vertical" requiredMark={false}>
            <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Cloud className="size-4" />
                            服务器模式
                        </div>
                        <div className="mt-1 text-xs text-stone-500">
                            开启后画布、素材、图片保存在服务器，生成任务也在服务器执行；断网或换设备重新进入即可继续，不会重复生成。关闭则完全使用本地存储与浏览器直连。
                        </div>
                    </div>
                    <Switch checked={enabled} onChange={setEnabled} />
                </div>

                {enabled ? (
                    <>
                        <Form.Item label="服务器地址" extra="留空表示与当前站点同源，适用于用官方镜像一体化部署的场景。" className="mb-4">
                            <Input value={draftBaseUrl} placeholder="https://canvas.example.com" onChange={(event) => setDraftBaseUrl(event.target.value)} onBlur={() => setBaseUrl(draftBaseUrl)} />
                        </Form.Item>

                        <div className="flex flex-wrap items-center gap-2">
                            <Button icon={<Wifi className="size-4" />} loading={testing} onClick={() => void connect()}>
                                测试连接
                            </Button>
                            {user ? (
                                <Button
                                    icon={<LogOut className="size-4" />}
                                    onClick={() => {
                                        clearSession();
                                        message.success("已退出登录");
                                    }}
                                >
                                    退出登录
                                </Button>
                            ) : (
                                <Button type="primary" onClick={() => navigate("/login")}>
                                    登录 / 注册
                                </Button>
                            )}
                            {user?.role === "admin" ? (
                                <Button icon={<Shield className="size-4" />} onClick={() => navigate("/admin")}>
                                    管理后台
                                </Button>
                            ) : null}
                            {status === "connecting" ? <RefreshCw className="size-4 animate-spin text-stone-400" /> : null}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                            {user ? (
                                <>
                                    <Tag color="green">{user.displayName || user.username}</Tag>
                                    <Tag>{user.role === "admin" ? "管理员" : "普通用户"}</Tag>
                                    <span>剩余算力点 {user.credits}</span>
                                </>
                            ) : (
                                <span>尚未登录，当前仍在使用本地模式</span>
                            )}
                            {settings ? <span>服务端可用模型 {settings.modelChannel.models.length} 个</span> : null}
                            {status === "error" && error ? <span className="text-red-500">{error}</span> : null}
                        </div>
                    </>
                ) : null}
            </section>
        </Form>
    );
}
