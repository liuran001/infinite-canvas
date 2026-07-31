import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { connectServer } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

initAnalytics();

// 只有令牌持久化到本地，用户信息与服务端配置需要在启动时重新拉一次，
// 否则刷新页面后会被判定成未登录而静默退回本地模式。
if (useServerStore.getState().enabled) void connectServer();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
