import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useIsServerEnabled, useIsServerMode, useServerStore } from "@/stores/use-server-store";

/** 这些页面的数据全部来自服务端，未登录进去只会看到空白。 */
const REQUIRE_LOGIN = ["/canvas", "/image", "/video", "/assets", "/prompts", "/config"];

/**
 * 未登录时挡下需要数据的二级页面，退回首页并唤起登录。
 * 必须挂在路由内部：它依赖 useNavigate / useLocation。
 */
export function LoginGuard() {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const isServerMode = useIsServerMode();
    const isServerEnabled = useIsServerEnabled();
    const status = useServerStore((state) => state.status);
    const token = useServerStore((state) => state.token);
    const setLoginOpen = useServerStore((state) => state.setLoginOpen);

    useEffect(() => {
        if (!isServerEnabled || isServerMode || status === "connecting") return;
        // 只有令牌被持久化，刷新后用户信息要等 connectServer 拉回来。
        // 这期间不能判定为未登录，否则刷新画布页会被直接踢回首页。
        if (token) return;
        if (!REQUIRE_LOGIN.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return;
        navigate("/", { replace: true });
        setLoginOpen(true);
    }, [isServerEnabled, isServerMode, navigate, pathname, setLoginOpen, status, token]);

    return null;
}
