export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/*
 * 画布上的按钮不能只定义静态色。它们的底色是内联写上去的（要跟着画布主题走，Tailwind 类名给不了），
 * 而内联样式的优先级高于 antd 自己的 hover 规则——结果是 antd 的 hover 背景永远不生效，
 * 鼠标放上去毫无反馈。所以每一种「表面色」都必须在这里配一个 hover 色，
 * 由 CanvasSurfaceButton 统一取用，界面上才有「这里能点」的提示。
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: "#f4f2ed",
            dot: "rgba(68,64,60,.28)",
            line: "rgba(68,64,60,.12)",
            selectionStroke: "#1c1917",
            selectionFill: "rgba(28,25,23,.06)",
        },
        node: {
            label: "#57534e",
            fill: "#e7e5df",
            /** node.fill 的 hover 态，比底色再深一档。 */
            fillHover: "#dcd9cf",
            panel: "#fbfaf7",
            stroke: "#d6d3ca",
            activeStroke: "#1c1917",
            placeholder: "#8a8479",
            text: "#292524",
            muted: "#78716c",
            faint: "#a8a29e",
        },
        toolbar: {
            panel: "rgba(251,250,247,.96)",
            /** toolbar.panel 的 hover 态，取 itemHover 同一档色并保持同样的半透明度。 */
            panelHover: "rgba(231,229,223,.96)",
            border: "#d6d3ca",
            item: "#57534e",
            itemHover: "#e7e5df",
            activeBg: "#e7e5df",
            /** 选中态自己的 hover：已经选中的按钮摸上去也要有反馈，否则会被当成点不动了。 */
            activeBgHover: "#dcd9cf",
            activeText: "#292524",
        },
    },
    dark: {
        canvas: {
            background: "#181715",
            dot: "rgba(245,245,244,.24)",
            line: "rgba(245,245,244,.10)",
            selectionStroke: "#fafaf9",
            selectionFill: "rgba(250,250,249,.10)",
        },
        node: {
            label: "#d6d3d1",
            fill: "#292524",
            /** 深色下往「更亮」的方向走，与 activeBg 同一档，不会和画布底色糊在一起。 */
            fillHover: "#3a3631",
            panel: "#1f1d1a",
            stroke: "#44403c",
            activeStroke: "#fafaf9",
            placeholder: "#a8a29e",
            text: "#f5f5f4",
            muted: "#d6d3d1",
            faint: "#78716c",
        },
        toolbar: {
            panel: "rgba(31,29,26,.96)",
            panelHover: "rgba(58,54,49,.96)",
            border: "#44403c",
            item: "#d6d3d1",
            itemHover: "#292524",
            activeBg: "#3a3631",
            activeBgHover: "#4a453f",
            activeText: "#f5f5f4",
        },
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
