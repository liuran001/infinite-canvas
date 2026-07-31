import { useMemo } from "react";

import { navigationTools } from "@/constant/navigation-tools";
import { useEnabledCapabilities } from "@/stores/use-config-store";

/** 顶部导航、移动端导航和首页共用：按当前可用的模型能力过滤入口。 */
export function useNavigationTools() {
    const capabilities = useEnabledCapabilities();
    return useMemo(() => navigationTools.filter((tool) => !tool.capability || capabilities[tool.capability]), [capabilities]);
}
