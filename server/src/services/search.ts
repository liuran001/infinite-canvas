import { fail, SafeError } from "../lib/errors";
import { upstreamJson } from "../lib/upstream";
import { getSettings, type SearchProviderName, type SearchService } from "./settings";

export type SearchResult = { title: string; url: string; publishedDate: string; text: string };

/** 读回来的网页正文字段和搜索结果一致，不另开一套结构。 */
export type WebPage = SearchResult;

/** 换搜索服务只要再实现一对 provider 并注册到 PROVIDERS，agent 那边不用改。 */
export type SearchProvider = (service: SearchService, query: string, limit: number, signal: AbortSignal) => Promise<SearchResult[]>;

/** 读网页走同一套 provider 抽象：agent 只认「给个网址拿回正文」，换服务商同样不用改 agent。 */
export type WebPageProvider = (service: SearchService, url: string, maxChars: number, signal: AbortSignal) => Promise<WebPage>;

/** 搜索结果的摘要正文按字符截断，避免一次搜索就把模型上下文吃满。读全文有自己的上限，见 agent-tools 的 MAX_PAGE_CHARS。 */
const MAX_TEXT_CHARS = 1200;

const EXA_BASE_URL = "https://api.exa.ai";
const TAVILY_BASE_URL = "https://api.tavily.com";

/** baseUrl 留空就回落到服务商官方地址。各家端点路径不同（Exa 是 /contents、Tavily 是 /extract），所以路径由各自的 provider 自己拼。 */
const endpoint = (service: SearchService, fallback: string, path: string) => `${(service.baseUrl || fallback).replace(/\/+$/, "")}${path}`;

type ExaResult = { title?: string; url?: string; publishedDate?: string; text?: string; summary?: string; highlights?: string[] };

/**
 * Exa 搜索。官方文档（https://exa.ai/docs/reference/search）的请求格式是
 * POST https://api.exa.ai/search，密钥放 x-api-key 头（文档同时说明 Authorization: Bearer 也可用），
 * 请求体里 contents.text 打开才会返回正文。
 */
const exaSearch: SearchProvider = async (service, query, limit, signal) => {
    const payload = await upstreamJson<{ results?: ExaResult[] }>(
        endpoint(service, EXA_BASE_URL, "/search"),
        {
            method: "POST",
            headers: { "x-api-key": service.apiKey, "Content-Type": "application/json" },
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

/**
 * Exa 读网页。官方文档（https://exa.ai/docs/reference/get-contents）的请求格式是
 * POST https://api.exa.ai/contents，密钥同样放 x-api-key 头；
 * urls 是网址数组（1~100 条），text 传对象时用 maxCharacters 限制正文长度，
 * 响应和 /search 一样是 { requestId, results: [...], statuses, costDollars }。
 * 不传 livecrawl（官方文档已标为 deprecated）也不传 maxAgeHours：两个都省略时的默认行为
 * 正好是「缓存里有就直接给，没有再现抓」，正是读网页要的。
 */
const exaContents: WebPageProvider = async (service, url, maxChars, signal) => {
    const payload = await upstreamJson<{ results?: ExaResult[] }>(
        endpoint(service, EXA_BASE_URL, "/contents"),
        {
            method: "POST",
            headers: { "x-api-key": service.apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ urls: [url], text: { maxCharacters: maxChars } }),
            signal,
        },
        "读取网页失败",
    );
    const item = (payload.results || [])[0];
    const text = (item?.text || "").trim();
    // 抓不到正文（付费墙、纯图片页、上游只回了 statuses）不能返回空字符串糊弄模型，抛出去还能换下一家试试。
    if (!text) throw fail("没能读取到这个网页的正文");
    return { title: (item?.title || "").trim(), url: (item?.url || url).trim(), publishedDate: (item?.publishedDate || "").trim(), text: text.slice(0, maxChars) };
};

type TavilyResult = { title?: string; url?: string; content?: string; published_date?: string };
type TavilyExtractResult = { title?: string; url?: string; raw_content?: string };

/**
 * Tavily 搜索。官方文档（https://docs.tavily.com/documentation/api-reference/endpoint/search）的请求格式是
 * POST https://api.tavily.com/search，密钥走 Authorization: Bearer 头，条数参数是 max_results。
 * 每条的摘要正文在 content 字段；raw_content 默认是 null，要额外参数才给全文，
 * 读全文统一交给 read_webpage 走 /extract，搜索这里不去要，免得一次搜索就把上下文吃满。
 * 也不取 Tavily 独有的 answer：那是它自己生成的答案，取了会让不同服务商的返回结构不一致。
 */
const tavilySearch: SearchProvider = async (service, query, limit, signal) => {
    const payload = await upstreamJson<{ results?: TavilyResult[] }>(
        endpoint(service, TAVILY_BASE_URL, "/search"),
        {
            method: "POST",
            headers: { Authorization: `Bearer ${service.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ query, max_results: limit }),
            signal,
        },
        "联网搜索失败",
    );
    return (payload.results || []).map((item) => ({
        title: (item.title || "").trim(),
        url: (item.url || "").trim(),
        publishedDate: (item.published_date || "").trim(),
        text: (item.content || "").slice(0, MAX_TEXT_CHARS).trim(),
    }));
};

/**
 * Tavily 读网页。官方文档（https://docs.tavily.com/documentation/api-reference/endpoint/extract）的请求格式是
 * POST https://api.tavily.com/extract，同样是 Authorization: Bearer 头，urls 是网址数组，正文在 raw_content。
 * 它没有长度参数，整篇原文都会回来，所以必须由我们自己按 maxChars 切。
 * 抓取失败的网址不会返回 HTTP 错误，而是落进 failed_results、results 为空，所以这里按失败处理好换下一家。
 */
const tavilyExtract: WebPageProvider = async (service, url, maxChars, signal) => {
    const payload = await upstreamJson<{ results?: TavilyExtractResult[] }>(
        endpoint(service, TAVILY_BASE_URL, "/extract"),
        {
            method: "POST",
            headers: { Authorization: `Bearer ${service.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ urls: [url] }),
            signal,
        },
        "读取网页失败",
    );
    const item = (payload.results || [])[0];
    const text = (item?.raw_content || "").trim();
    if (!text) throw fail("没能读取到这个网页的正文");
    return { title: (item?.title || "").trim(), url: (item?.url || url).trim(), publishedDate: "", text: text.slice(0, maxChars) };
};

const PROVIDERS: Record<SearchProviderName, { search: SearchProvider; fetch: WebPageProvider }> = {
    exa: { search: exaSearch, fetch: exaContents },
    tavily: { search: tavilySearch, fetch: tavilyExtract },
};

/**
 * 只允许 http/https，并挡掉本机与内网地址。
 * 网址是模型给的，而模型会被网页内容、用户输入里的提示词带偏，必须假定它可能被诱导去探测部署环境——
 * 容器网关（172.17.x）、云厂商元数据（169.254.169.254）、同机上没鉴权的服务都在这条路径的射程内。
 * provider 换成「服务端自己抓」的实现时这层就是唯一防线，所以拦截放在这里，对所有 provider 生效。
 * 只做字面量判断、不解析 DNS：域名指向内网这种情况挡不住，交给部署侧的出网策略。
 * （服务商 baseUrl 不走这里：那是管理员配的，和渠道 baseUrl 一样属于可信配置，模型控制不了。）
 */
function safeWebUrl(raw: string) {
    const value = raw.trim();
    if (!value) throw fail("缺少要读取的网址");
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw fail("网址格式不正确，需要以 http:// 或 https:// 开头");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("只能读取 http/https 网址");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const parts = host.split(".").map(Number);
    const isIpv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
    const internal =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host === "::1" ||
        host === "::" ||
        // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
        /^f[cd][0-9a-f]{2}:/.test(host) ||
        /^fe[89ab][0-9a-f]:/.test(host) ||
        (isIpv4 &&
            (parts[0] === 0 ||
                parts[0] === 10 ||
                parts[0] === 127 ||
                (parts[0] === 169 && parts[1] === 254) ||
                (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                (parts[0] === 192 && parts[1] === 168) ||
                (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)));
    if (internal) throw fail("不能读取本机或内网地址");
    return url.toString();
}

/**
 * 可用的搜索服务，按优先级从高到低排好。一条都没有时返回 null，
 * 调用方据此不下发 web_search / read_webpage 工具，而不是等模型调用了再报错。
 */
export async function searchConfig() {
    const { search } = (await getSettings()).private;
    if (!search.enabled) return null;
    const services = search.services.filter((service) => service.enabled && service.apiKey.trim() && PROVIDERS[service.provider]).sort((a, b) => b.weight - a.weight);
    return services.length ? { maxResults: search.maxResults, services } : null;
}

/**
 * 按优先级依次调用，某一家挂了（网络不通、鉴权失败、额度耗尽、返回结构不对）就自动换下一家，
 * 全都失败才把最后一条错误抛给用户：一家服务商出问题不该让整个联网能力不可用。
 * 用户中止时立刻停手，否则一次中止会被当成失败，把剩下的服务商挨个再试一遍。
 */
async function tryServices<T>(services: SearchService[], signal: AbortSignal, fallback: string, run: (service: SearchService) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const service of services) {
        if (signal.aborted) break;
        try {
            return await run(service);
        } catch (error) {
            // 换下一家之前留一条日志：不然第一家一直悄悄失败、全靠后面的兜底，运维根本发现不了。
            console.error(`搜索服务调用失败：${service.provider}`, error);
            last = error;
        }
    }
    throw last instanceof SafeError ? last : fail(fallback);
}

export async function webSearch(query: string, limit: number, signal: AbortSignal) {
    const text = query.trim();
    if (!text) throw fail("缺少搜索关键词");
    const config = await searchConfig();
    if (!config) throw fail("未配置联网搜索");
    const count = Math.min(config.maxResults, Math.max(1, limit || config.maxResults));
    return tryServices(config.services, signal, "联网搜索失败", (service) => PROVIDERS[service.provider].search(service, text, count, signal));
}

export async function webFetch(url: string, maxChars: number, signal: AbortSignal) {
    const target = safeWebUrl(url);
    const config = await searchConfig();
    if (!config) throw fail("未配置联网搜索");
    return tryServices(config.services, signal, "读取网页失败", (service) => PROVIDERS[service.provider].fetch(service, target, maxChars, signal));
}
