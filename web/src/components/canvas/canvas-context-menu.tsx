import { useEffect } from "react";
import type { ReactNode } from "react";
import { Download, Info, Plus, Trash2 } from "lucide-react";
import type { CanvasNodeData } from "@/types/canvas";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ContextMenuState } from "@/types/canvas";

export function CanvasNodeContextMenu({ menu, onClose, onDuplicate, onDelete, readOnly = false, node, onInfo, onDownload, onViewImage }: { menu: ContextMenuState; onClose: () => void; onDuplicate: () => void; onDelete: () => void; readOnly?: boolean; node?: CanvasNodeData; onInfo?: () => void; onDownload?: () => void; onViewImage?: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    useEffect(() => {
        const close = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".ant-popover")) return;
            onClose();
        };
        window.addEventListener("pointerdown", close);
        return () => window.removeEventListener("pointerdown", close);
    }, [onClose]);

    return (
        <div
            className="fixed z-[80] min-w-44 overflow-hidden rounded-xl border py-1 shadow-2xl"
            style={{ left: menu.x, top: menu.y, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {readOnly && menu.type === "node" ? <MenuButton icon={<Info className="size-4" />} label="信息" onClick={onInfo} /> : null}
            {readOnly && menu.type === "node" && node?.metadata?.content && ["image", "video", "audio"].includes(node.type) ? <MenuButton icon={<Download className="size-4" />} label="下载" onClick={onDownload} /> : null}
            {readOnly && menu.type === "node" && node?.type === "image" && node.metadata?.content ? <MenuButton icon={<Plus className="size-4" />} label="查看大图" onClick={onViewImage} /> : null}
            {!readOnly && menu.type === "node" ? <MenuButton icon={<Plus className="size-4" />} label="复制" onClick={onDuplicate} /> : null}
            {!readOnly ? <MenuButton icon={<Trash2 className="size-4" />} label="删除" onClick={onDelete} danger /> : null}
        </div>
    );
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: ReactNode; label: string; onClick?: () => void; danger?: boolean }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:opacity-80" style={{ color: danger ? "#f87171" : theme.node.text }} onClick={onClick}>
            {icon}
            <span>{label}</span>
        </button>
    );
}
