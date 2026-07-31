import cron from "node-cron";
import { In, Like } from "typeorm";

import { repo } from "../db/data-source";
import { Prompt, PromptCategory } from "../db/entities";
import { fail, now } from "../lib/errors";
import type { Query } from "../lib/response";
import { getSettings } from "./settings";

const REGISTRY_BASE = "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources";
const ALL_OPTION = "全部";

/** 与前端 DEFAULT_PROMPT_SOURCES 保持一致的内置来源。 */
const BUILT_IN_CATEGORIES = [
    { category: "banana-prompt-quicker", name: "Banana Prompt Quicker", githubUrl: "https://glidea.github.io/banana-prompt-quicker/" },
    { category: "davidwu-gpt-image2-prompts", name: "DavidWu GPT Image 2", githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts" },
    { category: "awesome-gpt-image", name: "Awesome GPT Image", githubUrl: "https://github.com/ZeroLu/awesome-gpt-image" },
    { category: "awesome-gpt4o-image-prompts", name: "Awesome GPT-4o", githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts" },
    { category: "youmind-gpt-image-2", name: "YouMind GPT Image 2", githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2" },
    { category: "youmind-nano-banana-pro", name: "YouMind Nano Banana Pro", githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts" },
];

let syncTask: cron.ScheduledTask | null = null;

export async function ensurePromptCategories() {
    const categories = repo(PromptCategory);
    for (const item of BUILT_IN_CATEGORIES) {
        if (await categories.findOneBy({ category: item.category })) continue;
        await categories.save({
            ...item,
            description: "",
            sourceUrl: `${REGISTRY_BASE}/${item.category}.json`,
            remote: true,
            enabled: true,
            lastSyncedAt: "",
            lastError: "",
            updatedAt: now(),
        } as PromptCategory);
    }
}

export async function listPromptCategories() {
    return repo(PromptCategory).find({ order: { name: "ASC" } });
}

export async function savePromptCategory(input: Partial<PromptCategory>) {
    const category = (input.category || "").trim();
    if (!category) throw fail("缺少分类编码");
    const categories = repo(PromptCategory);
    const saved = await categories.findOneBy({ category });
    return categories.save({
        ...saved,
        category,
        name: input.name?.trim() || saved?.name || category,
        description: input.description ?? saved?.description ?? "",
        githubUrl: input.githubUrl ?? saved?.githubUrl ?? "",
        sourceUrl: input.sourceUrl ?? saved?.sourceUrl ?? "",
        remote: input.remote ?? saved?.remote ?? false,
        enabled: input.enabled ?? saved?.enabled ?? true,
        lastSyncedAt: saved?.lastSyncedAt || "",
        lastError: saved?.lastError || "",
        updatedAt: now(),
    } as PromptCategory);
}

export async function deletePromptCategory(category: string) {
    await repo(Prompt).delete({ category });
    await repo(PromptCategory).delete({ category });
}

function isActiveOption(value: string) {
    return Boolean(value) && value !== ALL_OPTION && value !== "all";
}

/** tags 以 JSON 数组文本存储，用 LIKE 匹配序列化后的 "tag" 片段，跨方言一致。 */
function tagConditions(tags: string[]) {
    return tags.map((tag) => Like(`%"${tag}"%`));
}

function promptWhere(query: Query, withTags: boolean) {
    const base: Record<string, unknown> = {};
    if (isActiveOption(query.category)) base.category = query.category;
    const keywordFields = query.keyword ? ["title", "prompt", "description"] : [];
    const tags = withTags ? query.tags : [];

    const variants: Array<Record<string, unknown>> = [{}];
    if (keywordFields.length) variants.splice(0, 1, ...keywordFields.map((field) => ({ [field]: Like(`%${query.keyword}%`) })));
    if (tags.length) {
        const withTagVariants = variants.flatMap((variant) => tagConditions(tags).map((tag) => ({ ...variant, tags: tag })));
        return withTagVariants.map((variant) => ({ ...base, ...variant }));
    }
    return variants.map((variant) => ({ ...base, ...variant }));
}

export async function listPrompts(query: Query) {
    const prompts = repo(Prompt);
    const [items, total] = await prompts.findAndCount({ where: promptWhere(query, true), order: { updatedAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const tagRows = await prompts.find({ where: promptWhere(query, false), select: { id: true, tags: true } as never, take: 2000 });
    const tags = Array.from(new Set(tagRows.flatMap((row) => row.tags || []).filter(Boolean)));
    const categories = (await listPromptCategories()).map((item) => item.category);
    return { items, tags, categories, total };
}

export async function savePrompt(input: Partial<Prompt>) {
    const prompts = repo(Prompt);
    const saved = input.id ? await prompts.findOneBy({ id: input.id }) : null;
    return prompts.save({
        ...saved,
        ...input,
        id: input.id || `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        title: input.title?.trim() || saved?.title || "",
        prompt: input.prompt ?? saved?.prompt ?? "",
        tags: input.tags || saved?.tags || [],
        category: input.category?.trim() || saved?.category || "",
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as Prompt);
}

export async function deletePrompt(id: string) {
    await repo(Prompt).delete({ id });
}

export async function deletePrompts(ids: string[]) {
    if (!ids.length) return;
    await repo(Prompt).delete({ id: In(ids) });
}

type RegistryPrompt = Record<string, unknown>;

function stringValue(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(stringValue).map((item) => item.trim()).filter(Boolean) : [];
}

function absoluteUrl(baseUrl: string, path: string) {
    if (!path) return "";
    try {
        return new URL(path, baseUrl).toString();
    } catch {
        return path;
    }
}

/**
 * 从提示词 registry 拉取整个分类并整体替换。
 * 与前端 prompt-source-runtime 使用同一份 JSON 结构，保证两种模式看到的内容一致。
 */
export async function syncPromptCategory(category: string) {
    const categories = repo(PromptCategory);
    const record = await categories.findOneBy({ category });
    if (!record) throw fail("未知提示词分类");
    if (!record.sourceUrl?.trim()) throw fail("该分类没有配置来源地址");

    try {
        const response = await fetch(record.sourceUrl, { cache: "no-store", signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw fail(`拉取失败（${response.status}）`);
        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) throw fail("来源格式错误：根节点必须是数组");

        const seen = new Set<string>();
        const items = (payload as RegistryPrompt[])
            .map((raw, index) => {
                const title = stringValue(raw.title).trim();
                const prompt = stringValue(raw.prompt).trim();
                if (!title || !prompt) return null;
                const id = `${category}:${stringValue(raw.id).trim() || String(index + 1).padStart(4, "0")}`;
                if (seen.has(id)) return null;
                seen.add(id);
                const referenceImageUrls = stringArray(raw.referenceImageUrls).map((url) => absoluteUrl(record.sourceUrl, url));
                return {
                    id,
                    title,
                    prompt,
                    description: stringValue(raw.description),
                    coverUrl: absoluteUrl(record.sourceUrl, stringValue(raw.coverUrl)) || referenceImageUrls[0] || "",
                    referenceImageUrls,
                    tags: stringArray(raw.tags),
                    category,
                    preview: stringValue(raw.preview),
                    author: stringValue(raw.author),
                    sourceUrl: absoluteUrl(record.sourceUrl, stringValue(raw.sourceUrl)) || record.githubUrl,
                    options: { imageMode: raw.imageMode, imageModel: raw.imageModel, imageSize: raw.imageSize, imageCount: raw.imageCount },
                    createdAt: stringValue(raw.createdAt) || now(),
                    updatedAt: stringValue(raw.updatedAt) || now(),
                } as Prompt;
            })
            .filter((item): item is Prompt => Boolean(item));
        if (!items.length) throw fail("未解析到有效提示词");

        await repo(Prompt).delete({ category });
        await repo(Prompt).save(items, { chunk: 200 });
        await categories.save({ ...record, lastSyncedAt: now(), lastError: "", updatedAt: now() });
        return { category, count: items.length };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await categories.save({ ...record, lastError: message, updatedAt: now() });
        throw fail(`「${record.name}」同步失败：${message}`);
    }
}

export async function syncRemotePromptCategories() {
    const categories = (await listPromptCategories()).filter((item) => item.remote && item.enabled && item.sourceUrl);
    const results = [];
    for (const item of categories) {
        try {
            results.push({ ...(await syncPromptCategory(item.category)), success: true, error: "" });
        } catch (error) {
            results.push({ category: item.category, count: 0, success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

/** 按系统设置里的 cron 表达式重建定时同步任务，设置变更后需要重新调用。 */
export async function refreshPromptSyncScheduler() {
    syncTask?.stop();
    syncTask = null;
    const { promptSync } = (await getSettings()).private;
    if (!promptSync.enabled) return;
    if (!cron.validate(promptSync.cron)) {
        console.warn(`prompt sync cron 表达式无效，已跳过：${promptSync.cron}`);
        return;
    }
    syncTask = cron.schedule(promptSync.cron, () => {
        void syncRemotePromptCategories().catch((error) => console.error("scheduled prompt sync failed:", error));
    });
}
