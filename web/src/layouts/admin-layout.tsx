import { Button, Menu, Result } from "antd";
import { ArrowLeft, Coins, FolderOpen, Images, Settings, Sparkles, Users, Wand2 } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";

import { useServerStore } from "@/stores/use-server-store";

const navItems = [
    { key: "/admin/users", icon: <Users className="size-4" />, label: <Link to="/admin/users">用户管理</Link> },
    { key: "/admin/credit-logs", icon: <Coins className="size-4" />, label: <Link to="/admin/credit-logs">算力点流水</Link> },
    { key: "/admin/generations", icon: <Wand2 className="size-4" />, label: <Link to="/admin/generations">生成记录</Link> },
    { key: "/admin/contents", icon: <FolderOpen className="size-4" />, label: <Link to="/admin/contents">用户内容</Link> },
    { key: "/admin/prompts", icon: <Sparkles className="size-4" />, label: <Link to="/admin/prompts">提示词</Link> },
    { key: "/admin/assets", icon: <Images className="size-4" />, label: <Link to="/admin/assets">素材</Link> },
    { key: "/admin/settings", icon: <Settings className="size-4" />, label: <Link to="/admin/settings">系统设置</Link> },
];

export default function AdminLayout() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const user = useServerStore((state) => state.user);
    const status = useServerStore((state) => state.status);

    // 刷新页面时只有令牌被持久化，用户信息要等 connectServer 拉回来，期间先不要判定成无权限。
    if (status === "connecting") return <div className="flex h-dvh items-center justify-center bg-background text-sm text-stone-500">正在连接服务端…</div>;

    if (user?.role !== "admin") {
        return (
            <div className="flex h-dvh items-center justify-center bg-background text-foreground">
                <Result
                    status="403"
                    title="无权访问管理后台"
                    subTitle={user ? "当前账号不是管理员，请换用管理员账号登录。" : "请先使用管理员账号登录。"}
                    extra={
                        <Button type="primary" onClick={() => navigate("/login?redirect=/admin")}>
                            去登录
                        </Button>
                    }
                />
            </div>
        );
    }

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <aside className="flex w-52 shrink-0 flex-col border-r border-stone-200 dark:border-stone-800">
                <div className="flex h-14 shrink-0 items-center px-5 text-base font-medium">管理后台</div>
                <Menu mode="inline" className="min-h-0 flex-1 overflow-y-auto !border-e-0" selectedKeys={[pathname === "/admin" ? "/admin/users" : pathname]} items={navItems} />
            </aside>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b border-stone-200 px-6 dark:border-stone-800">
                    <span className="truncate text-sm text-stone-500">{user.displayName || user.username}</span>
                    <Button size="small" icon={<ArrowLeft className="size-3.5" />} onClick={() => navigate("/")}>
                        返回应用
                    </Button>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto p-6">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
