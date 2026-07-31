import { App, Button, Form, Input, Segmented, Tag } from "antd";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { connectServer, serverApi } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

type Mode = "login" | "register";

export default function LoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [mode, setMode] = useState<Mode>("login");
    const [submitting, setSubmitting] = useState(false);
    const baseUrl = useServerStore((state) => state.baseUrl);
    const settings = useServerStore((state) => state.settings);
    const user = useServerStore((state) => state.user);
    const setSession = useServerStore((state) => state.setSession);
    const setEnabled = useServerStore((state) => state.setEnabled);

    const redirect = searchParams.get("redirect") || "/";
    const oauthToken = searchParams.get("token");
    const oauthError = searchParams.get("error");

    useEffect(() => {
        void connectServer();
    }, [baseUrl]);

    // Linux.do 登录回调把令牌放在查询参数里，这里换成本地会话后跳回原页面。
    useEffect(() => {
        if (oauthError) {
            message.error(oauthError);
            navigate("/login", { replace: true });
            return;
        }
        if (!oauthToken) return;
        setEnabled(true);
        useServerStore.setState({ token: oauthToken });
        serverApi
            .me()
            .then((profile) => {
                setSession(oauthToken, profile);
                message.success(`欢迎回来，${profile.displayName || profile.username}`);
                navigate(redirect, { replace: true });
            })
            .catch((error: Error) => {
                useServerStore.getState().clearSession();
                message.error(error.message);
                navigate("/login", { replace: true });
            });
    }, [oauthToken, oauthError]);

    useEffect(() => {
        if (user) navigate(redirect, { replace: true });
    }, [user]);

    const submit = async (values: { username: string; password: string }) => {
        setSubmitting(true);
        try {
            const session = mode === "login" ? await serverApi.login(values.username, values.password) : await serverApi.register(values.username, values.password);
            setEnabled(true);
            setSession(session.token, session.user);
            message.success(mode === "login" ? "登录成功" : "注册成功");
            navigate(redirect, { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="flex h-full items-center justify-center overflow-y-auto bg-background px-6 py-10">
            <div className="w-full max-w-sm">
                <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">连接服务器</h1>
                <p className="mt-1 text-sm text-stone-500">登录后画布、素材与生成记录会保存在服务器，可在多设备之间同步</p>
                <div className="mt-2 text-xs text-stone-400">服务器地址：{baseUrl || "与当前站点同源"}</div>

                <Segmented
                    className="mt-5"
                    block
                    value={mode}
                    onChange={(value) => setMode(value as Mode)}
                    options={[
                        { label: "登录", value: "login" },
                        { label: "注册", value: "register", disabled: settings ? !settings.auth.allowRegister : false },
                    ]}
                />
                {settings && !settings.auth.allowRegister ? <Tag className="mt-3">当前服务器未开放注册</Tag> : null}

                <Form layout="vertical" className="mt-4" onFinish={submit} disabled={submitting}>
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input autoComplete="username" placeholder="用户名" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="密码" />
                    </Form.Item>
                    <Button type="primary" htmlType="submit" block loading={submitting}>
                        {mode === "login" ? "登录" : "注册并登录"}
                    </Button>
                </Form>

                {settings?.auth.linuxDo.enabled ? (
                    <Button className="mt-3" block onClick={() => (window.location.href = serverApi.linuxDoAuthorizeUrl(redirect))}>
                        使用 Linux.do 登录
                    </Button>
                ) : null}

                <Button className="mt-3" type="link" block onClick={() => navigate("/")}>
                    先不登录，继续使用本地模式
                </Button>
            </div>
        </main>
    );
}
