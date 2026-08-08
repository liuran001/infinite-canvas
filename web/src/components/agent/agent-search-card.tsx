import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";

/** 联网搜索的单项记录，由 cloud-agent-format 从 toolResult 里解析好再交给这里渲染。 */
export type AgentSearchResult = { title: string; url: string; host: string; date: string; summary: string };

/** 只有联网搜索的 detail 会带 results；其余工具照旧走通用的 rows/output 卡片，这里返回空数组。 */
export function agentSearchResults(detail: unknown): AgentSearchResult[] {
    const list = detail && typeof detail === "object" ? (detail as { results?: unknown }).results : undefined;
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is AgentSearchResult => Boolean(item) && typeof item === "object" && typeof (item as AgentSearchResult).title === "string");
}

/**
 * 联网搜索结果卡片。通用工具卡把 toolResult 整块 JSON 摊出来，搜索场景下用户根本读不动，
 * 所以单独按「标题 / 来源 / 日期 / 摘要」排版，标题直接点开原文；原始 JSON 仍然折叠在末尾备查。
 */
export function AgentSearchCard({ title, text, results, output, theme }: { title: string; text: string; results: AgentSearchResult[]; output: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const { t } = useTranslation();
    return (
        <details className="group min-w-0 rounded-xl border px-3 py-2.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className="cursor-pointer list-none">
                <div className="flex min-w-0 items-center gap-2 text-sm leading-5">
                    <Search className="size-4 shrink-0" style={{ color: "#2563eb" }} />
                    <span className="min-w-0 truncate font-medium">{title}</span>
                    <span className="shrink-0 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{t("agent.cloud.search.resultCount", { count: results.length })}</span>
                    <ChevronDown className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} />
                </div>
                {text ? <div className="mt-1 truncate pl-6 text-sm leading-5" style={{ color: theme.node.muted }}>{text}</div> : null}
            </summary>
            <div className="ml-6 mt-3 space-y-3 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                {results.map((item, index) => (
                    <div key={`${index}-${item.url}`} className="min-w-0">
                        {item.url ? (
                            <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-start gap-1 text-sm font-medium leading-5 hover:underline" style={{ color: "#2563eb" }}>
                                <span className="min-w-0 break-words">{item.title}</span>
                                <ExternalLink className="mt-0.5 size-3 shrink-0" />
                            </a>
                        ) : (
                            <div className="text-sm font-medium leading-5">{item.title}</div>
                        )}
                        {item.host || item.date ? (
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                {item.host ? <span className="break-all">{item.host}</span> : null}
                                {item.date ? <span className="tabular-nums">{item.date}</span> : null}
                            </div>
                        ) : null}
                        {item.summary ? <div className="mt-1 break-words text-xs leading-5" style={{ color: theme.node.muted }}>{item.summary}</div> : null}
                    </div>
                ))}
                {output ? (
                    <details className="group/raw">
                        <summary className="cursor-pointer list-none">
                            <div className="flex items-center gap-1 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                <ChevronRight className="size-3 shrink-0 transition-transform group-open/raw:rotate-90" />
                                {t("agent.cloud.search.rawResults")}
                            </div>
                        </summary>
                        <pre className="thin-scrollbar mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[11px] leading-4" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{output}</pre>
                    </details>
                ) : null}
            </div>
        </details>
    );
}
