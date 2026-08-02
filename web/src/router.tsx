import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { LoginModal } from "@/components/layout/login-modal";
import AdminLayout from "@/layouts/admin-layout";
import UserLayout from "@/layouts/user-layout";
import AdminAssetsPage from "@/pages/admin/assets";
import AdminContentsPage from "@/pages/admin/contents";
import AdminCreditLogsPage from "@/pages/admin/credit-logs";
import AdminGenerationsPage from "@/pages/admin/generations";
import AdminInvitesPage from "@/pages/admin/invites";
import AdminPromptsPage from "@/pages/admin/prompts";
import AdminSettingsPage from "@/pages/admin/settings";
import AdminUsersPage from "@/pages/admin/users";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import ShareCanvasPage from "@/pages/share/share-canvas";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "/login", element: <LoginPage /> },
    /*
     * 分享页刻意放在 UserLayout 与 LoginGuard 之外（与 /login 同级）：
     * 它允许匿名访问，挂在守卫里会被直接判成未登录踢回首页；也不该带上全站导航、
     * Agent 面板这些属于账号的入口。登录弹窗单独挂一份，供「登录后继续克隆」使用。
     */
    {
        path: "/s/:token",
        element: (
            <>
                <ShareCanvasPage />
                <LoginModal />
            </>
        ),
    },
    {
        path: "/admin",
        element: <AdminLayout />,
        children: [
            { index: true, element: <AdminUsersPage /> },
            { path: "users", element: <AdminUsersPage /> },
            { path: "invites", element: <AdminInvitesPage /> },
            { path: "credit-logs", element: <AdminCreditLogsPage /> },
            { path: "generations", element: <AdminGenerationsPage /> },
            { path: "contents", element: <AdminContentsPage /> },
            { path: "settings", element: <AdminSettingsPage /> },
            { path: "prompts", element: <AdminPromptsPage /> },
            { path: "assets", element: <AdminAssetsPage /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
