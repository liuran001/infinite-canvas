import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import { isServerMode } from "@/stores/use-server-store";

export type InstalledPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    url: string; // 安装来源,可用于更新
    source: string; // 缓存的插件源码,离线可用、版本固定
    enabled: boolean;
    local?: boolean; // 自动发现于 web/public/plugins 的本地插件(默认关闭,启用时按 url 重新拉取)
    official?: boolean; // 从官方注册表安装(用于在管理器里归类)
    installedAt: string;
    revision?: number; // 云端版本号,用于同步时的乐观锁
};

type PluginStore = {
    plugins: InstalledPlugin[];
    upsert: (plugin: Omit<InstalledPlugin, "installedAt"> & { installedAt?: string }) => void;
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
};

/** 服务器模式下把改动推到云端，动态导入避免与同步模块循环依赖。 */
function pushRemote(id: string) {
    if (!isServerMode()) return;
    void import("@/services/remote-sync").then((module) => module.pushUserPlugin(id));
}

function removeRemote(id: string) {
    if (!isServerMode()) return;
    void import("@/services/remote-sync").then((module) => module.removeRemoteUserPlugin(id));
}

export const usePluginStore = create<PluginStore>()(
    persist(
        (set) => ({
            plugins: [],
            upsert: (plugin) => {
                set((state) => {
                    const exists = state.plugins.find((item) => item.id === plugin.id);
                    // 保留已有的云端版本号，本地插件每次启动刷新元数据时才不会丢掉乐观锁。
                    const next = { ...exists, ...plugin, installedAt: plugin.installedAt || exists?.installedAt || new Date().toISOString() };
                    return { plugins: exists ? state.plugins.map((item) => (item.id === plugin.id ? next : item)) : [next, ...state.plugins] };
                });
                pushRemote(plugin.id);
            },
            setEnabled: (id, enabled) => {
                set((state) => ({ plugins: state.plugins.map((item) => (item.id === id ? { ...item, enabled } : item)) }));
                pushRemote(id);
            },
            remove: (id) => {
                set((state) => ({ plugins: state.plugins.filter((item) => item.id !== id) }));
                removeRemote(id);
            },
        }),
        {
            name: "infinite-canvas:plugin_store",
            storage: createJSONStorage(() => localForageStorage),
        },
    ),
);
