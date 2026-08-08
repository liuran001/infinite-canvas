import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { Alert, App, Button, Divider, Form, Input, Modal } from "antd";
import { Fingerprint, KeyRound, Loader2, Ticket, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Turnstile } from "@/components/auth/turnstile";
import { serverApi, ServerApiError, type AccountDeletionPending } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

type Mode = "login" | "register";

type LoginForm = { username: string; password: string; inviteCode?: string };

/**
 * 全站的登录入口。数据都在服务端，未登录时由它引导登录，
 * 做成弹窗而不是独立页面，用户关掉后仍能浏览已有界面。
 */
export function LoginModal() {
    const { message, modal } = App.useApp();
    const { t, i18n } = useTranslation();
    const resolvedLanguage = i18n.resolvedLanguage || i18n.language;
    const [form] = Form.useForm<LoginForm>();
    const [mode, setMode] = useState<Mode>("login");
    const [submitting, setSubmitting] = useState(false);
    const [passkeyLoading, setPasskeyLoading] = useState(false);
    const [captchaToken, setCaptchaToken] = useState("");
    const [captchaNonce, setCaptchaNonce] = useState(0);
    const open = useServerStore((state) => state.loginOpen);
    const settings = useServerStore((state) => state.settings);
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const setSession = useServerStore((state) => state.setSession);
    const loginError = useServerStore((state) => state.loginError);
    const canRegister = settings?.auth.allowRegister !== false;
    const isRegister = mode === "register";
    // 只有服务端确实要求邀请码时才多显示一个框，不然所有人都得对着一个用不上的输入框发呆。
    const needInvite = isRegister && Boolean(settings?.auth.requireInvite);
    const turnstile = settings?.auth.turnstile;
    const captchaEnabled = Boolean(turnstile?.siteKey && (isRegister ? turnstile.registerEnabled : turnstile.loginEnabled));

    // 服务端关闭注册后，若正停留在注册态要退回登录，避免提交必然失败的表单。
    useEffect(() => {
        if (!canRegister && isRegister) setMode("login");
    }, [canRegister, isRegister]);

    useEffect(() => {
        setCaptchaToken("");
        setCaptchaNonce((value) => value + 1);
    }, [isRegister, open]);

    const finish = (token: string, user: Parameters<typeof setSession>[1], text: string) => {
        setSession(token, user);
        form.resetFields();
        message.success(text);
    };

    const resetCaptcha = () => {
        setCaptchaToken("");
        setCaptchaNonce((value) => value + 1);
    };

    const handleDeletionPending = (error: unknown) => {
        if (!(error instanceof ServerApiError) || error.code !== "ACCOUNT_DELETION_PENDING" || !error.data) return false;
        const pending = error.data as AccountDeletionPending;
        modal.confirm({
            title: t("auth.deletion.title"),
            content: t("auth.deletion.content", { date: new Date(pending.deletesAt).toLocaleString(resolvedLanguage) }),
            okText: t("auth.deletion.confirmLogin"),
            cancelText: t("auth.deletion.cancelLogin"),
            onOk: async () => {
                const session = await serverApi.cancelAccountDeletion(pending.resumeToken);
                finish(session.token, session.user, t("auth.deletion.canceledAndSignedIn"));
            },
        });
        return true;
    };

    const submit = async (values: LoginForm) => {
        setSubmitting(true);
        try {
            const session = isRegister
                ? await serverApi.register(values.username, values.password, values.inviteCode, captchaToken)
                : await serverApi.login(values.username, values.password, captchaToken);
            finish(session.token, session.user, t(isRegister ? "auth.success.registered" : "auth.success.signedIn"));
        } catch (error) {
            // 邀请码不对、已用完、已停用这些原因都由服务端给中文文案，原样透出来才有指导意义。
            if (!handleDeletionPending(error)) message.error(error instanceof Error ? error.message : t("auth.errors.operationFailed"));
            resetCaptcha();
        } finally {
            setSubmitting(false);
        }
    };

    /** 不传用户名，由浏览器列出本机可用的 Passkey 让用户挑。 */
    const loginWithPasskey = async () => {
        setPasskeyLoading(true);
        try {
            const { flowId, options } = await serverApi.passkeyLoginOptions("", captchaToken);
            const session = await serverApi.passkeyLoginVerify(flowId, await startAuthentication({ optionsJSON: options }));
            finish(session.token, session.user, t("auth.success.signedIn"));
        } catch (error) {
            // 用户主动取消系统弹窗也会抛错，这种情况不提示。
            const text = error instanceof Error ? error.message : t("auth.errors.passkeyLoginFailed");
            if (!handleDeletionPending(error) && !/NotAllowed|abort|cancel/i.test(text)) message.error(text);
            resetCaptcha();
        } finally {
            setPasskeyLoading(false);
        }
    };

    const thirdParty = [
        browserSupportsWebAuthn() && { key: "passkey", icon: <Fingerprint className="size-4" />, label: "Passkey", loading: passkeyLoading, disabled: captchaEnabled && !captchaToken, onClick: () => void loginWithPasskey() },
        settings?.auth.linuxDo.enabled && {
            key: "linux-do",
            icon: <img src="/icons/linuxdo.svg" alt="" className="size-4" onError={(event) => (event.currentTarget.style.display = "none")} />,
            label: "Linux.do",
            loading: false,
            disabled: captchaEnabled && !captchaToken,
            onClick: () => (window.location.href = serverApi.linuxDoAuthorizeUrl(`${window.location.pathname}${window.location.search}`, captchaToken)),
        },
    ].filter(Boolean) as Array<{ key: string; icon: React.ReactNode; label: string; loading: boolean; disabled: boolean; onClick: () => void }>;

    return (
        <Modal open={open} onCancel={() => setLoginOpen(false)} footer={null} width={400} centered destroyOnHidden styles={{ body: { padding: "8px 4px 4px" } }}>
            <div className="flex flex-col items-center pb-5 pt-2">
                <span className="size-10 bg-stone-950 dark:bg-stone-100" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                <h2 className="mt-3 text-lg font-semibold text-stone-950 dark:text-stone-100">{t(isRegister ? "auth.form.createAccount" : "auth.form.signInTitle")}</h2>
                <p className="mt-1 text-xs text-stone-500">{t("auth.form.description")}</p>
            </div>

            {loginError ? <Alert type="error" showIcon className="!mb-4" title={loginError} /> : null}

            <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={submitting}>
                <Form.Item name="username" rules={[{ required: true, message: t("auth.form.usernameRequired") }]} className="mb-3">
                    <Input size="large" autoComplete="username" placeholder={t("auth.form.username")} prefix={<User className="size-4 text-stone-400" />} />
                </Form.Item>
                <Form.Item name="password" rules={[{ required: true, message: t("auth.form.passwordRequired") }]} className={needInvite ? "mb-3" : "mb-4"}>
                    <Input.Password size="large" autoComplete={isRegister ? "new-password" : "current-password"} placeholder={t("auth.form.password")} prefix={<KeyRound className="size-4 text-stone-400" />} />
                </Form.Item>
                {needInvite ? (
                    <Form.Item name="inviteCode" rules={[{ required: true, message: t("auth.form.inviteRequired") }]} className="mb-4">
                        <Input size="large" placeholder={t("auth.form.inviteCode")} prefix={<Ticket className="size-4 text-stone-400" />} />
                    </Form.Item>
                ) : null}
                {captchaEnabled ? <Turnstile key={`${isRegister ? "register" : "login"}-${captchaNonce}`} siteKey={turnstile?.siteKey || ""} action={isRegister ? "register" : "login"} onToken={setCaptchaToken} onError={(text) => message.error(text)} /> : null}
                <Button type="primary" size="large" htmlType="submit" block loading={submitting} disabled={captchaEnabled && !captchaToken}>
                    {t(isRegister ? "auth.form.registerAndSignIn" : "auth.form.signIn")}
                </Button>
            </Form>

            {!isRegister && thirdParty.length ? (
                <>
                    <Divider className="!my-5 !text-xs !text-stone-400">{t("auth.form.or")}</Divider>
                    <div className="flex gap-2">
                        {thirdParty.map((item) => (
                            <Button key={item.key} size="large" block loading={item.loading} disabled={item.disabled} onClick={item.onClick} className="!flex !items-center !justify-center !gap-2">
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
                        {t(isRegister ? "auth.form.hasAccount" : "auth.form.noAccount")}
                    </button>
                ) : (
                    <span>{t("auth.form.registrationClosed")}</span>
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
    const { message, modal } = App.useApp();
    const { t, i18n } = useTranslation();
    const resolvedLanguage = i18n.resolvedLanguage || i18n.language;
    const navigate = useNavigate();
    const setSession = useServerStore((state) => state.setSession);
    // loading 正在处理回调，invite 等用户补邀请码，done 已经处理完交给页面跳转。
    const [phase, setPhase] = useState<"loading" | "invite" | "done">("loading");
    const [inviteCode, setInviteCode] = useState("");
    const [inviteError, setInviteError] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [captchaToken, setCaptchaToken] = useState("");
    const [captchaNonce, setCaptchaNonce] = useState(0);
    const turnstile = useServerStore((state) => state.settings?.auth.turnstile);
    const captchaEnabled = Boolean(turnstile?.siteKey && turnstile.oauthCompleteEnabled);
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
        const deletionPending = params.get("deletionPending") === "1";
        const resumeToken = params.get("resumeToken") || "";
        const deletesAt = params.get("deletesAt") || "";

        if (bound) {
            message.success(t("auth.success.linuxDoBound"));
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
        if (deletionPending && resumeToken) {
            setPhase("done");
            modal.confirm({
                title: t("auth.deletion.title"),
                content: t("auth.deletion.content", { date: deletesAt ? new Date(deletesAt).toLocaleString(resolvedLanguage) : t("auth.deletion.later") }),
                okText: t("auth.deletion.confirmLogin"),
                cancelText: t("auth.deletion.cancelLogin"),
                onOk: async () => {
                    const session = await serverApi.cancelAccountDeletion(resumeToken);
                    setSession(session.token, session.user);
                    message.success(t("auth.deletion.canceledAndSignedIn"));
                    window.location.replace(redirect);
                },
                onCancel: () => window.location.replace(redirect),
            });
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
                message.success(t("auth.success.welcomeBack", { name: profile.displayName || profile.username }));
                window.location.replace(redirect);
            })
            .catch((failure: Error) => {
                useServerStore.getState().clearSession();
                message.error(failure.message);
                window.location.replace("/");
            });
    }, [message, modal, navigate, params, pendingToken, redirect, resolvedLanguage, setSession, t]);

    const completeInvite = async () => {
        const code = inviteCode.trim();
        if (!code) {
            setInviteError(t("auth.form.inviteRequired"));
            return;
        }
        if (captchaEnabled && !captchaToken) {
            setInviteError(t("auth.form.captchaRequired"));
            return;
        }
        setSubmitting(true);
        setInviteError("");
        try {
            const session = await serverApi.completeLinuxDo(pendingToken, code, captchaToken);
            setSession(session.token, session.user);
            message.success(t("auth.success.registered"));
            window.location.replace(redirect);
        } catch (failure) {
            // pendingToken 过期、邀请码不对或已用完，服务端都会给中文原因，原样展示，
            // 过期这种重填也没用的情况下面还留着「重新登录」重走一遍授权。
            setInviteError(failure instanceof Error ? failure.message : t("auth.errors.completeRegistrationFailed"));
            setCaptchaToken("");
            setCaptchaNonce((value) => value + 1);
            setSubmitting(false);
        }
    };

    if (phase === "done") return null;

    if (phase === "invite")
        return (
            <div className="flex h-dvh items-center justify-center bg-background px-4">
                <div className="w-full max-w-sm">
                    <h2 className="text-center text-lg font-semibold text-stone-950 dark:text-stone-100">{t("auth.oauth.inviteTitle")}</h2>
                    <p className="mt-1 text-center text-xs text-stone-500">{t("auth.oauth.inviteDescription")}</p>
                    {inviteError ? <Alert type="error" showIcon className="!mt-4" title={inviteError} /> : null}
                    <Input
                        size="large"
                        className="!mt-4"
                        autoFocus
                        placeholder={t("auth.form.inviteCode")}
                        value={inviteCode}
                        prefix={<Ticket className="size-4 text-stone-400" />}
                        onChange={(event) => setInviteCode(event.target.value)}
                        onPressEnter={() => void completeInvite()}
                    />
                    {captchaEnabled ? <div className="mt-3"><Turnstile key={`oauth-${captchaNonce}`} siteKey={turnstile?.siteKey || ""} action="oauth_complete" onToken={setCaptchaToken} onError={setInviteError} /></div> : null}
                    <Button type="primary" size="large" block className="!mt-3" loading={submitting} disabled={captchaEnabled && !captchaToken} onClick={() => void completeInvite()}>
                        {t("auth.oauth.completeRegistration")}
                    </Button>
                    <div className="mt-4 flex justify-center gap-5 text-xs text-stone-500">
                        <button
                            type="button"
                            className="cursor-pointer transition hover:text-stone-950 dark:hover:text-stone-100"
                            onClick={() => {
                                useServerStore.getState().setLoginOpen(true);
                                navigate(redirect, { replace: true });
                            }}
                        >
                            {t("auth.oauth.signInAgain")}
                        </button>
                        <button type="button" className="cursor-pointer transition hover:text-stone-950 dark:hover:text-stone-100" onClick={() => window.location.replace(redirect)}>
                            {t("auth.oauth.cancelAndReturn")}
                        </button>
                    </div>
                </div>
            </div>
        );

    return (
        <div className="flex h-dvh items-center justify-center gap-2 bg-background text-sm text-stone-500">
            <Loader2 className="size-4 animate-spin" />
            {t("auth.oauth.completing")}
        </div>
    );
}
