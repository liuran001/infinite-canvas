import { serverRequest } from "./server";

/** 字段与服务端 Prompt 实体一致。 */
export type Prompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    description: string;
    referenceImageUrls: string[];
    tags: string[];
    /** 分类编码，如 awesome-gpt-image。 */
    category: string;
    preview: string;
    author: string;
    sourceUrl: string;
    /** registry 里的 imageMode / imageModel / imageSize / imageCount 等可选生成参数。 */
    options: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export const ALL_PROMPTS_OPTION = "全部";

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    total: number;
};

/** 关键词、分类、标签、分页全部交给服务端处理。 */
export function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; page?: number; pageSize?: number } = {}) {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (keyword.trim()) params.set("keyword", keyword.trim());
    if (category && category !== ALL_PROMPTS_OPTION) params.set("category", category);
    for (const item of tag) params.append("tag", item);
    return serverRequest<PromptListResponse>(`/prompts?${params}`, {}, "获取提示词失败");
}

export function formatPromptDate(value: string, locale?: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
