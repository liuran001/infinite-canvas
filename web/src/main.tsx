import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { connectServer } from "@/services/api/server";
import { useServerStore } from "@/stores/use-server-store";

initAnalytics();

// 默认自动探测同源后端：部署了服务端就直接可用，纯前端部署探测不到会静默留在本地模式。
// 用户信息也没有持久化，刷新后同样要靠这次连接恢复，否则会被判定成未登录。
if (useServerStore.getState().mode !== "off") void connectServer();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
