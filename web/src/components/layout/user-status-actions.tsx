import { useEffect, useState, type CSSProperties } from "react";
import { App, Dropdown, Progress, Typography, type MenuProps } from "antd";
import { Keyboard, LogIn, LogOut, Puzzle, Settings2, Shield, UserRound } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { AccountSettingsModal } from "@/components/layout/account-settings-modal";
import { formatBytes } from "@/lib/image-utils";
import { serverApi } from "@/services/api/server";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useServerStore } from "@/stores/use-server-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [accountOpen, setAccountOpen] = useState(false);
    const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const user = useServerStore((state) => state.user);
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 items-center justify-center text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const bound = searchParams.get("bound");
    const authError = searchParams.get("error");

    // Linux.do 绑定回调会带着结果回到发起绑定的页面，提示后立刻清掉查询参数。
    useEffect(() => {
        if (!bound && !authError) return;
        if (bound) message.success("已绑定 Linux.do");
        else message.error(authError);
        const next = new URLSearchParams(searchParams);
        next.delete("bound");
        next.delete("error");
        setSearchParams(next, { replace: true });
    }, [bound, authError]);

    const storagePercent = storage && storage.quota ? Math.min(100, (storage.used / storage.quota) * 100) : 0;
    const storageNearlyFull = storagePercent >= 90;

    const menuItems: MenuProps["items"] = [
        {
            key: "profile",
            type: "group",
            label: (
                <div className="w-56 py-1">
                    <Typography.Text strong>{user?.displayName || user?.username}</Typography.Text>
                    <div className="mt-0.5 text-xs">剩余算力点 {user?.credits ?? 0}</div>
                    {storage ? (
                        <>
                            <Progress className="!mb-0 mt-2" percent={Number(storagePercent.toFixed(1))} showInfo={false} size="small" status={storageNearlyFull ? "exception" : "normal"} />
                            <div className={`text-xs ${storageNearlyFull ? "font-medium text-red-500" : ""}`}>
                                云空间 {formatBytes(storage.used)} / {formatBytes(storage.quota)}
                            </div>
                            {storageNearlyFull ? <div className="mt-1 text-xs text-red-500">空间快满了，建议清理不再需要的资产和过时画布</div> : null}
                        </>
                    ) : null}
                </div>
            ),
        },
        { type: "divider" },
        { key: "account", icon: <Settings2 className="size-4" />, label: "账号设置", onClick: () => setAccountOpen(true) },
        ...(user?.role === "admin" ? [{ key: "admin", icon: <Shield className="size-4" />, label: "管理后台", onClick: () => navigate("/admin") }] : []),
        { type: "divider" },
        { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", onClick: () => useServerStore.getState().clearSession() },
    ];

    // 云空间只在登录后拉一次，用户菜单展开时再刷新，避免频繁打接口。
    useEffect(() => {
        if (!user) {
            setStorage(null);
            return;
        }
        void serverApi
            .storage()
            .then(setStorage)
            .catch(() => undefined);
    }, [user?.id]);

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label="节点插件" title="节点插件">
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            {showConfig ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label="偏好设置" title="偏好设置">
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} />
            {variant === "canvas" ? null : (
                <>
                    <VersionReleaseModal style={iconStyle} />
                    <GitHubLink className="size-7 bg-transparent text-base hover:bg-transparent dark:hover:bg-transparent" style={iconStyle} />
                </>
            )}
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label="快捷键" title="快捷键">
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {user ? (
                <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: menuItems }}>
                    <button
                        type="button"
                        className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white"
                        style={iconStyle}
                        aria-label="账号"
                        title={user.displayName || user.username}
                    >
                        {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-5 rounded-full object-cover" /> : <UserRound className="size-4" />}
                        <span className="text-sm tabular-nums">{user.credits ?? 0}</span>
                    </button>
                </Dropdown>
            ) : (
                <button
                    type="button"
                    className="inline-flex h-7 shrink-0 items-center gap-1 px-1 text-sm text-stone-600 transition hover:text-stone-950 dark:text-stone-300 dark:hover:text-white"
                    style={iconStyle}
                    onClick={() => setLoginOpen(true)}
                    title="登录"
                >
                    <LogIn className="size-4" />
                    登录
                </button>
            )}
            <AccountSettingsModal open={accountOpen} onClose={() => setAccountOpen(false)} />
        </div>
    );
}
