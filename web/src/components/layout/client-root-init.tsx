import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { syncAll } from "@/services/remote-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useIsServerMode, useServerStore } from "@/stores/use-server-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const syncedUserId = useRef("");
    const isServerMode = useIsServerMode();
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
