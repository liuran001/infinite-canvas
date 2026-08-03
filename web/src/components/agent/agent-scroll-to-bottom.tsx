import { Tooltip } from "antd";
import { ChevronDown } from "lucide-react";

import { CanvasSurfaceButton } from "@/components/canvas/canvas-surface-button";
import { canvasThemes } from "@/lib/canvas-theme";

export function AgentScrollToBottom({
    theme,
    title,
    ariaLabel = title,
    className = "",
    onClick,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    title: string;
    ariaLabel?: string;
    className?: string;
    onClick: () => void;
}) {
    return (
        <Tooltip title={title} placement="top">
            <CanvasSurfaceButton
                theme={theme}
                shape="circle"
                aria-label={ariaLabel}
                className={`!absolute bottom-6 left-1/2 z-10 !h-8 !w-8 !min-w-8 -translate-x-1/2 backdrop-blur transition hover:-translate-y-0.5 ${className}`}
                style={{ border: `1px solid ${theme.node.stroke}` }}
                icon={<ChevronDown className="size-4" />}
                onClick={onClick}
            />
        </Tooltip>
    );
}
