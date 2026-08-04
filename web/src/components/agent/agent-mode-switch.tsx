import { Dropdown } from "antd";
import { Bot, Check, ChevronDown, Cloud, Laptop } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore, type AgentPanelMode } from "@/stores/use-agent-store";
import { useServerStore } from "@/stores/use-server-store";

const MODES: Array<{ value: AgentPanelMode; label: string; description: string; icon: typeof Cloud }> = [
    { value: "cloud", label: "系统模型", description: "由服务端执行，断网关页也不中断", icon: Cloud },
    { value: "local", label: "本地 Agent", description: "连接本机 Canvas Agent", icon: Laptop },
];

/**
 * 面板标题位置的模式切换。管理员关掉系统 Agent 时不展示「系统模型」这一项，
 * 只剩本地一种模式就退回原来的纯标题，不给用户一个点了没用的下拉。
 */
export function AgentModeSwitch({ theme, forceLocal = false }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; forceLocal?: boolean }) {
    const cloudEnabled = useServerStore((state) => !forceLocal && Boolean(state.settings?.agent.enabled));
    const panelMode = useAgentStore((state) => state.panelMode);
    const setPanelMode = useAgentStore((state) => state.setPanelMode);
    const mode = cloudEnabled ? panelMode : "local";
    const current = MODES.find((item) => item.value === mode) || MODES[1];
    const Icon = cloudEnabled ? current.icon : Bot;

    if (!cloudEnabled) {
        return (
            <div className="flex items-center gap-2 pr-1">
                <span className="grid size-8 place-items-center">
                    <Bot className="size-4" />
                </span>
                <div className="text-base font-semibold leading-5">Agent</div>
            </div>
        );
    }

    return (
        <Dropdown
            trigger={["click"]}
            menu={{
                selectable: false,
                items: MODES.map((item) => ({
                    key: item.value,
                    label: (
                        <div className="flex min-w-[190px] items-center gap-2 py-0.5">
                            <item.icon className="size-4 shrink-0" />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm leading-5">{item.label}</div>
                                <div className="text-[11px] leading-4 opacity-60">{item.description}</div>
                            </div>
                            {item.value === mode ? <Check className="size-3.5 shrink-0" /> : null}
                        </div>
                    ),
                    onClick: () => setPanelMode(item.value),
                })),
            }}
        >
            <button type="button" className="flex h-8 items-center gap-1.5 rounded-md px-1 transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="切换 Agent 模式">
                <Icon className="size-4 shrink-0" />
                <span className="text-base font-semibold leading-5">{current.label}</span>
                <ChevronDown className="size-3.5 shrink-0" style={{ color: theme.node.muted }} />
            </button>
        </Dropdown>
    );
}
