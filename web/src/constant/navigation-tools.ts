import { FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";

import type { ModelCapability } from "@/stores/use-config-store";

/** capability 为空表示该入口与模型能力无关，始终显示。 */
export const navigationTools: ReadonlyArray<{ slug: string; label: string; icon: typeof Video; capability?: ModelCapability }> = [
    {
        slug: "canvas",
        label: "我的画布",
        icon: Maximize2,
    },
    {
        slug: "image",
        label: "生图工作台",
        icon: ImagePlus,
        capability: "image",
    },
    {
        slug: "video",
        label: "视频创作台",
        icon: Video,
        capability: "video",
    },
    {
        slug: "prompts",
        label: "提示词库",
        icon: FileText,
    },
    {
        slug: "assets",
        label: "我的资产",
        icon: Images,
    },
    {
        slug: "config",
        label: "配置",
        icon: Settings2,
    },
];

export type NavigationToolSlug = "canvas" | "image" | "video" | "prompts" | "assets" | "config";
