import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { syncAll } from "@/services/remote-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useIsServerEnabled, useIsServerMode, useServerStore } from "@/stores/use-server-store";

const LOGIN_PROMPTED_KEY = "infinite-canvas:login-prompted";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const syncedUserId = useRef("");
    const isServerMode = useIsServerMode();
    const isServerEnabled = useIsServerEnabled();
    const status = useServerStore((state) => state.status);
    const token = useServerStore((state) => state.token);
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);

    // 数据都在服务端，未登录时页面是空的。首次进入自动唤起登录，
    // 每个浏览器会话只提示一次，用户关掉后可以继续浏览首页、从顶栏再进。
    useEffect(() => {
        if (!isServerEnabled || isServerMode || token || status === "connecting") return;
        if (sessionStorage.getItem(LOGIN_PROMPTED_KEY)) return;
        sessionStorage.setItem(LOGIN_PROMPTED_KEY, "1");
        setLoginOpen(true);
    }, [isServerEnabled, isServerMode, setLoginOpen, status, token]);

    const userId = useServerStore((state) => state.user?.id || "");
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);

    // 登录后同步一次云端画布与素材，本地缓存先加载完再合并。
    useEffect(() => {
        if (!isServerMode) {
            syncedUserId.current = "";
            return;
        }
        if (!canvasHydrated || !assetsHydrated || syncedUserId.current === userId) return;
        syncedUserId.current = userId;
        void syncAll();
    }, [assetsHydrated, canvasHydrated, isServerMode, userId]);

    return <>{children}</>;
}
