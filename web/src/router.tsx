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
import TeamDetailPage from "@/pages/teams/detail";
import TeamsPage from "@/pages/teams";
import TeamInvitesPage from "@/pages/teams/invites";
import TeamJoinPage from "@/pages/teams/join";
import TeamLayout from "@/pages/teams/layout";
import TeamLogsPage from "@/pages/teams/logs";
import TeamMembersPage from "@/pages/teams/members";
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
            { path: "/teams", element: <TeamsPage /> },
            /*
             * 团队详情做成布局路由：概览、成员、邀请、流水共用同一个外壳，
             * 页签之间来回点时那条余额 SSE 不会被反复拆建（拆建一次余额就会闪回旧值再跳回来）。
             */
            {
                path: "/teams/:id",
                element: <TeamLayout />,
                children: [
                    { index: true, element: <TeamDetailPage /> },
                    { path: "members", element: <TeamMembersPage /> },
                    { path: "invites", element: <TeamInvitesPage /> },
                    { path: "logs", element: <TeamLogsPage /> },
                ],
            },
        ],
    },
    { path: "/login", element: <LoginPage /> },
    /*
     * 邀请落地页放在 UserLayout 与 LoginGuard 之外：拿到链接的人多半还没登录，
     * 挂在守卫里会被直接踢回首页，那条链接就等于失效了。登录弹窗单独挂一份，供「登录后继续加入」使用。
     */
    {
        path: "/join/:token",
        element: (
            <>
                <TeamJoinPage />
                <LoginModal />
            </>
        ),
    },
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
