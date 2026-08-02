import { useEffect } from "react";

/**
 * 分享页的运行时 noindex：向 document.head 注入 robots meta，离开时清理。
 *
 * 这是三重兜底里的第三层——另外两层是 robots.txt 的 `Disallow: /s/` 与部署层对 `/s/*`
 * 下发的 `X-Robots-Tag`。三层覆盖的抓取路径不同：robots.txt 在抓取前生效，响应头对代理与
 * 非 HTML 资源生效，meta 对已经抓下来的页面生效。SPA 的 index.html 是全站共用的，
 * 不能静态写死 noindex，只能进分享路由时注入、离开时移除。
 */
export function useNoIndexMeta(enabled = true) {
    useEffect(() => {
        if (!enabled) return;
        const meta = document.createElement("meta");
        meta.name = "robots";
        meta.content = "noindex, nofollow";
        meta.dataset.shareNoindex = "1";
        document.head.appendChild(meta);
        return () => {
            meta.remove();
        };
    }, [enabled]);
}
