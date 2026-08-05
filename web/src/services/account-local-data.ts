import localforage from "localforage";

import { useAssetStore } from "@/stores/use-asset-store";
import { useCloudAgentStore } from "@/stores/use-cloud-agent-store";
import { useJobStore } from "@/stores/use-job-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { usePluginStore } from "@/stores/canvas/use-plugin-store";
import { useServerStore } from "@/stores/use-server-store";

const ACCOUNT_STORE_KEYS = [
    "infinite-canvas:canvas_store",
    "infinite-canvas:asset_store",
    "infinite-canvas:job_store",
    "infinite-canvas:plugin_store",
];

/**
 * 服务器才是账号数据权威源；本地只清当前账号的画布、素材、任务与有 ownerId 的生成历史缓存。
 * 不清整个 IndexedDB，避免把同一浏览器里匿名分享访客的本地 Agent 历史一起误删。
 */
async function clearOwnedGenerationLogs(storeName: string, ownerId: string) {
    if (!ownerId) return;
    const store = localforage.createInstance({ name: "infinite-canvas", storeName });
    const keys: string[] = [];
    await store.iterate<{ ownerId?: string }, void>((value, key) => {
        if (value?.ownerId === ownerId) keys.push(key);
    });
    await Promise.all(keys.map((key) => store.removeItem(key)));
}

export async function clearCurrentAccountLocalData(ownerId = useServerStore.getState().user?.id || "") {
    useCanvasStore.setState({ projects: [] });
    useAssetStore.setState({ assets: [] });
    useJobStore.setState({ jobs: {} });
    usePluginStore.setState({ plugins: [] });
    useCloudAgentStore.getState().bindProject("");
    localStorage.removeItem("canvas-agent-cloud-session");
    ACCOUNT_STORE_KEYS.forEach((key) => localStorage.removeItem(key));
    await Promise.all(ACCOUNT_STORE_KEYS.map((key) => localforage.removeItem(key)));
    await Promise.all(["image_generation_logs", "video_generation_logs"].map((storeName) => clearOwnedGenerationLogs(storeName, ownerId)));
}
