import { Like } from "typeorm";

import { repo } from "../db/data-source";
import { Asset } from "../db/entities";
import { newId, now } from "../lib/errors";
import type { Query } from "../lib/response";

function isActiveOption(value: string) {
    return Boolean(value) && value !== "全部" && value !== "all";
}

function assetWhere(query: Query, withTags: boolean) {
    const base: Record<string, unknown> = {};
    if (isActiveOption(query.type)) base.type = query.type;
    if (isActiveOption(query.category)) base.category = query.category;

    let variants: Array<Record<string, unknown>> = [{}];
    if (query.keyword) variants = ["title", "description", "content"].map((field) => ({ [field]: Like(`%${query.keyword}%`) }));
    if (withTags && query.tags.length) variants = variants.flatMap((variant) => query.tags.map((tag) => ({ ...variant, tags: Like(`%"${tag}"%`) })));
    return variants.map((variant) => ({ ...base, ...variant }));
}

export async function listAssets(query: Query) {
    const assets = repo(Asset);
    const [items, total] = await assets.findAndCount({ where: assetWhere(query, true), order: { updatedAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const tagRows = await assets.find({ where: assetWhere(query, false), select: { id: true, tags: true } as never, take: 2000 });
    const tags = Array.from(new Set(tagRows.flatMap((row) => row.tags || []).filter(Boolean)));
    return { items, tags, total };
}

export async function saveAsset(input: Partial<Asset>) {
    const assets = repo(Asset);
    const saved = input.id ? await assets.findOneBy({ id: input.id }) : null;
    const type = input.type?.trim() || saved?.type || "text";
    return assets.save({
        ...saved,
        ...input,
        id: input.id || newId("asset"),
        type,
        tags: input.tags || saved?.tags || [],
        coverUrl: input.coverUrl || saved?.coverUrl || (type === "image" ? input.url || "" : ""),
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as Asset);
}

export async function deleteAsset(id: string) {
    await repo(Asset).delete({ id });
}
