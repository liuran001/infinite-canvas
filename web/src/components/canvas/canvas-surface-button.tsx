import { Button, type ButtonProps } from "antd";
import type { CSSProperties } from "react";

import type { CanvasTheme } from "@/lib/canvas-theme";

/** 画布上的两种「表面」：浮在画布之上的工具栏面板，和节点内部控件那层底色。 */
export type CanvasSurface = "panel" | "node";

/**
 * 画布上所有自带主题底色的按钮都走这里。
 *
 * 为什么必须收口到一个组件：这些按钮的底色跟着画布主题走，只能内联写；而内联样式的优先级高于
 * antd 自己的 hover 规则，于是 antd 的 hover 背景永远不生效——鼠标放上去毫无反馈，用户看不出
 * 这里能点。以前每个按钮各写一份 `style={{ background, color }}`，也就各自漏掉了一次 hover，
 * 全站至少有七处一模一样的漏法。
 *
 * 收口之后只剩一条路径：底色与 hover 色都由主题给（见 canvas-theme.ts 的 fillHover / panelHover），
 * 组件把它们写成 CSS 变量，真正的着色交给 globals.css 里那条 `.canvas-surface-button` 规则——
 * 只有走样式表才能带 `!important` 压过 antd，也只有走 `:hover` 选择器才能有 hover 态。
 * 调用方不再有机会自己写背景色，也就不会再漏。
 */
export function CanvasSurfaceButton({
    theme,
    surface = "panel",
    active = false,
    className = "",
    style,
    ...rest
}: Omit<ButtonProps, "type"> & {
    theme: CanvasTheme;
    surface?: CanvasSurface;
    /** 选中态（比如 Agent 面板已经打开），用主题里那档更亮的 activeBg。 */
    active?: boolean;
}) {
    const base = surface === "node" ? theme.node.fill : theme.toolbar.panel;
    const hover = surface === "node" ? theme.node.fillHover : theme.toolbar.panelHover;
    return (
        <Button
            {...rest}
            type="text"
            className={`canvas-surface-button ${className}`.trim()}
            style={
                {
                    "--canvas-surface-bg": active ? theme.toolbar.activeBg : base,
                    // 选中态再 hover 时也得有反馈，否则「已打开」的按钮摸上去像是坏的。
                    "--canvas-surface-bg-hover": active ? theme.toolbar.activeBgHover : hover,
                    "--canvas-surface-text": active ? theme.toolbar.activeText : theme.node.text,
                    ...style,
                } as CSSProperties
            }
        />
    );
}
