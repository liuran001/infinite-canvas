import { fail } from "../lib/errors";
import { upstreamJson } from "../lib/upstream";
import { getSettings, type SearchProviderName } from "./settings";

export type SearchResult = { title: string; url: string; publishedDate: string; text: string };

/** 换搜索服务只要再实现一个 provider 并注册到 PROVIDERS，agent 那边不用改。 */
export type SearchProvider = (apiKey: string, query: string, limit: number, signal: AbortSignal) => Promise<SearchResult[]>;

/** 摘要正文按字符截断，避免一次搜索就把模型上下文吃满。 */
const MAX_TEXT_CHARS = 1200;

type ExaResult = { title?: string; url?: string; publishedDate?: string; text?: string; summary?: string; highlights?: string[] };

/**
 * Exa。官方文档（https://exa.ai/docs/reference/search）的请求格式是
 * POST https://api.exa.ai/search，密钥放 x-api-key 头（文档同时说明 Authorization: Bearer 也可用），
 * 请求体里 contents.text 打开才会返回正文。
 */
const exaSearch: SearchProvider = async (apiKey, query, limit, signal) => {
    const payload = await upstreamJson<{ results?: ExaResult[] }>(
        "https://api.exa.ai/search",
        {
            method: "POST",
            headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ query, type: "auto", numResults: limit, contents: { text: { maxCharacters: MAX_TEXT_CHARS } } }),
            signal,
        },
        "联网搜索失败",
    );
    return (payload.results || []).map((item) => ({
        title: (item.title || "").trim(),
        url: (item.url || "").trim(),
        publishedDate: (item.publishedDate || "").trim(),
        text: (item.summary || item.text || (item.highlights || []).join("\n") || "").slice(0, MAX_TEXT_CHARS).trim(),
    }));
};

const PROVIDERS: Record<SearchProviderName, SearchProvider> = { exa: exaSearch };

/** 没配 key 时返回 null，调用方据此不下发 web_search 工具，而不是等模型调用了再报错。 */
export async function searchConfig() {
    const { search } = (await getSettings()).private;
    if (!search.enabled || !search.apiKey.trim() || !PROVIDERS[search.provider]) return null;
    return search;
}

export async function webSearch(query: string, limit: number, signal: AbortSignal) {
    const config = await searchConfig();
    if (!config) throw fail("未配置联网搜索");
    const text = query.trim();
    if (!text) throw fail("缺少搜索关键词");
    return PROVIDERS[config.provider](config.apiKey, text, Math.min(config.maxResults, Math.max(1, limit || config.maxResults)), signal);
}
