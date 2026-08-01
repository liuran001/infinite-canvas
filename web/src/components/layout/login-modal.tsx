import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Alert, App, Button, Divider, Form, Input, Modal } from "antd";
import { Fingerprint, KeyRound, Loader2, Ticket, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { serverApi } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

type Mode = "login" | "register";

type LoginForm = { username: string; password: string; inviteCode?: string };

/**
 * 全站的登录入口。数据都在服务端，未登录时由它引导登录，
 * 做成弹窗而不是独立页面，用户关掉后仍能浏览已有界面。
 */
export function LoginModal() {
    const { message } = App.useApp();
    const [form] = Form.useForm<LoginForm>();
    const [mode, setMode] = useState<Mode>("login");
    const [submitting, setSubmitting] = useState(false);
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    const open = useServerStore((state) => state.loginOpen);
    const settings = useServerStore((state) => state.settings);
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const setSession = useServerStore((state) => state.setSession);
    const loginError = useServerStore((state) => state.loginError);
    const canRegister = settings?.auth.allowRegister !== false;
    const isRegister = mode === "register";
    // 只有服务端确实要求邀请码时才多显示一个框，不然所有人都得对着一个用不上的输入框发呆。
    const needInvite = isRegister && Boolean(settings?.auth.requireInvite);

    // 服务端关闭注册后，若正停留在注册态要退回登录，避免提交必然失败的表单。
    useEffect(() => {
        if (!canRegister && isRegister) setMode("login");
    }, [canRegister, isRegister]);

    const finish = (token: string, user: Parameters<typeof setSession>[1], text: string) => {
        setSession(token, user);
        form.resetFields();
        message.success(text);
    };

    const submit = async (values: LoginForm) => {
        setSubmitting(true);
        try {
            const session = isRegister ? await serverApi.register(values.username, values.password, values.inviteCode) : await serverApi.login(values.username, values.password);
            finish(session.token, session.user, isRegister ? "注册成功" : "登录成功");
        } catch (error) {
            // 邀请码不对、已用完、已停用这些原因都由服务端给中文文案，原样透出来才有指导意义。
            message.error(error instanceof Error ? error.message : "操作失败");
        } finally {
            setSubmitting(false);
        }
    };

    /** 不传用户名，由浏览器列出本机可用的 Passkey 让用户挑。 */
    const loginWithPasskey = async () => {
        setPasskeyLoading(true);
        try {
            const { flowId, options } = await serverApi.passkeyLoginOptions();
            const session = await serverApi.passkeyLoginVerify(flowId, await startAuthentication({ optionsJSON: options }));
            finish(session.token, session.user, "登录成功");
        } catch (error) {
            // 用户主动取消系统弹窗也会抛错，这种情况不提示。
            const text = error instanceof Error ? error.message : "Passkey 登录失败";
            if (!/NotAllowed|abort|cancel/i.test(text)) message.error(text);
        } finally {
            setPasskeyLoading(false);
        }
    };

    const thirdParty = [
        browserSupportsWebAuthn() && { key: "passkey", icon: <Fingerprint className="size-4" />, label: "Passkey", loading: passkeyLoading, onClick: () => void loginWithPasskey() },
        settings?.auth.linuxDo.enabled && {
            key: "linux-do",
            icon: <img src="/icons/linuxdo.svg" alt="" className="size-4" onError={(event) => (event.currentTarget.style.display = "none")} />,
            label: "Linux.do",
            loading: false,
            onClick: () => (window.location.href = serverApi.linuxDoAuthorizeUrl(`${window.location.pathname}${window.location.search}`)),
        },
    ].filter(Boolean) as Array<{ key: string; icon: React.ReactNode; label: string; loading: boolean; onClick: () => void }>;

    return (
        <Modal open={open} onCancel={() => setLoginOpen(false)} footer={null} width={400} centered destroyOnHidden styles={{ body: { padding: "8px 4px 4px" } }}>
            <div className="flex flex-col items-center pb-5 pt-2">
                <span className="size-10 bg-stone-950 dark:bg-stone-100" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                <h2 className="mt-3 text-lg font-semibold text-stone-950 dark:text-stone-100">{isRegister ? "创建账号" : "登录无限画布"}</h2>
                <p className="mt-1 text-xs text-stone-500">画布、素材与生成记录都保存在服务器，可在多设备之间同步</p>
            </div>

            {loginError ? <Alert type="error" showIcon className="!mb-4" title={loginError} /> : null}

            <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={submitting}>
                <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]} className="mb-3">
                    <Input size="large" autoComplete="username" placeholder="用户名" prefix={<User className="size-4 text-stone-400" />} />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]} className={needInvite ? "mb-3" : "mb-4"}>
                    <Input.Password size="large" autoComplete={isRegister ? "new-password" : "current-password"} placeholder="密码" prefix={<KeyRound className="size-4 text-stone-400" />} />
                </Form.Item>
                {needInvite ? (
                    <Form.Item name="inviteCode" rules={[{ required: true, message: "请输入邀请码" }]} className="mb-4">
                        <Input size="large" placeholder="邀请码" prefix={<Ticket className="size-4 text-stone-400" />} />
                    </Form.Item>
                ) : null}
                <Button type="primary" size="large" htmlType="submit" block loading={submitting}>
                    {isRegister ? "注册并登录" : "登录"}
                </Button>
            </Form>

            {thirdParty.length ? (
                <>
                    <Divider className="!my-5 !text-xs !text-stone-400">或</Divider>
                    <div className="flex gap-2">
                        {thirdParty.map((item) => (
                            <Button key={item.key} size="large" block loading={item.loading} onClick={item.onClick} className="!flex !items-center !justify-center !gap-2">
                                {item.loading ? null : item.icon}
                                {item.label}
                            </Button>
                        ))}
                    </div>
                </>
            ) : null}

            <div className="mt-5 text-center text-xs text-stone-500">
                {canRegister ? (
                    <button type="button" className="cursor-pointer text-stone-500 transition hover:text-stone-950 dark:hover:text-stone-100" onClick={() => setMode(isRegister ? "login" : "register")}>
                        {isRegister ? "已有账号？去登录" : "还没有账号？立即注册"}
                    </button>
                ) : (
                    <span>当前服务器未开放注册</span>
                )}
            </div>
        </Modal>
    );
}

/**
 * OAuth 回调落地：把查询参数里的令牌换成本地会话，然后回到原页面。
 * 服务端要求邀请码时，新用户这一步只会拿到 pendingToken（身份已验证，账号还没建），
 * 得先补一个邀请码换回真正的登录令牌。
 */
export function OauthCallbackHandler() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const setSession = useServerStore((state) => state.setSession);
    // loading 正在处理回调，invite 等用户补邀请码，done 已经处理完交给页面跳转。
    const [phase, setPhase] = useState<"loading" | "invite" | "done">("loading");
    const [inviteCode, setInviteCode] = useState("");
    const [inviteError, setInviteError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    // 回调参数只在首次渲染时读一次：处理过程本身会改写地址，
    // 再去读实时地址会拿到已经被清空的参数，把结果误判成「没有令牌」。
    const [params] = useState(() => new URLSearchParams(window.location.search));
    const handledRef = useRef(false);
    const redirect = params.get("redirect") || "/";
    const pendingToken = params.get("pendingToken") || "";

    useEffect(() => {
        if (handledRef.current) return;
        handledRef.current = true;
        const token = params.get("token");
        const error = params.get("error");
        const bound = params.get("bound");

        if (bound) {
            message.success("已绑定 Linux.do");
            window.history.replaceState(null, "", redirect);
            setPhase("done");
            return;
        }
        if (error) {
            // 用 SPA 跳转而不是整页替换：整页替换会立刻卸载页面，提示来不及显示，
            // 用户只看到地址栏一闪。改成把原因留在登录弹窗里，直到用户主动关掉。
            useServerStore.getState().setLoginError(error);
            useServerStore.getState().setLoginOpen(true);
            navigate(redirect, { replace: true });
            setPhase("done");
            return;
        }
        // 只有 pendingToken 说明账号还没建出来。这条路径一个字节的登录态都不能写：
        // 用户放弃或直接关掉页面时必须仍是未登录，不能留下「有令牌却没有账号」的假登录。
        if (pendingToken) {
            setPhase("invite");
            return;
        }
        if (!token) {
            window.location.replace("/");
            return;
        }
        useServerStore.setState({ token });
        serverApi
            .me()
            .then((profile) => {
                setSession(token, profile);
                message.success(`欢迎回来，${profile.displayName || profile.username}`);
                window.location.replace(redirect);
            })
            .catch((failure: Error) => {
                useServerStore.getState().clearSession();
                message.error(failure.message);
                window.location.replace("/");
            });
    }, [navigate, params, pendingToken, redirect]);

    const completeInvite = async () => {
        const code = inviteCode.trim();
        if (!code) {
            setInviteError("请输入邀请码");
            return;
        }
        setSubmitting(true);
        setInviteError("");
        try {
            const session = await serverApi.completeLinuxDo(pendingToken, code);
            setSession(session.token, session.user);
            message.success("注册成功");
            window.location.replace(redirect);
        } catch (failure) {
            // pendingToken 过期、邀请码不对或已用完，服务端都会给中文原因，原样展示，
            // 过期这种重填也没用的情况下面还留着「重新登录」重走一遍授权。
            setInviteError(failure instanceof Error ? failure.message : "完成注册失败");
            setSubmitting(false);
        }
    };

    if (phase === "done") return null;

    if (phase === "invite")
        return (
            <div className="flex h-dvh items-center justify-center bg-background px-4">
                <div className="w-full max-w-sm">
                    <h2 className="text-center text-lg font-semibold text-stone-950 dark:text-stone-100">填写邀请码</h2>
                    <p className="mt-1 text-center text-xs text-stone-500">身份已经验证通过，当前服务器还需要一个邀请码才能创建账号。</p>
                    {inviteError ? <Alert type="error" showIcon className="!mt-4" title={inviteError} /> : null}
                    <Input
                        size="large"
                        className="!mt-4"
                        autoFocus
                        placeholder="邀请码"
                        value={inviteCode}
                        prefix={<Ticket className="size-4 text-stone-400" />}
                        onChange={(event) => setInviteCode(event.target.value)}
                        onPressEnter={() => void completeInvite()}
                    />
                    <Button type="primary" size="large" block className="!mt-3" loading={submitting} onClick={() => void completeInvite()}>
                        完成注册
                    </Button>
                    <div className="mt-4 flex justify-center gap-5 text-xs text-stone-500">
                        <button type="button" className="cursor-pointer transition hover:text-stone-950 dark:hover:text-stone-100" onClick={() => (window.location.href = serverApi.linuxDoAuthorizeUrl(redirect))}>
                            重新登录
                        </button>
                        <button type="button" className="cursor-pointer transition hover:text-stone-950 dark:hover:text-stone-100" onClick={() => window.location.replace(redirect)}>
                            放弃并返回
                        </button>
                    </div>
                </div>
            </div>
        );

    return (
        <div className="flex h-dvh items-center justify-center gap-2 bg-background text-sm text-stone-500">
            <Loader2 className="size-4 animate-spin" />
            正在完成登录…
        </div>
    );
}
