import { MoreThan } from "typeorm";

import { repo } from "../db/data-source";
import { Project, UserAsset } from "../db/entities";
import { fail, now } from "../lib/errors";

export type ProjectInput = { id: string; title: string; data: unknown; revision?: number };
export type UserAssetInput = { id: string; kind: string; title: string; data: unknown; revision?: number };

const MAX_SYNC_ITEMS = 500;

function parseData(value: string) {
    try {
        return JSON.parse(value || "null") as unknown;
    } catch {
        return null;
    }
}

function toProjectView(row: Project) {
    return { id: row.projectId, title: row.title, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function toAssetView(row: UserAsset) {
    return { id: row.assetId, kind: row.kind, title: row.title, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** since 为空时返回全量，否则只返回该时间点之后变更的记录，含软删除标记。 */
export async function listProjects(userId: string, since: string) {
    const rows = await repo(Project).find({
        where: since ? { userId, updatedAt: MoreThan(since) } : { userId },
        order: { updatedAt: "DESC" },
        take: MAX_SYNC_ITEMS,
    });
    return rows.map(toProjectView);
}

export async function getProject(userId: string, id: string) {
    const row = await repo(Project).findOneBy({ userId, projectId: id });
    if (!row || row.deleted) throw fail("画布项目不存在");
    return toProjectView(row);
}

/**
 * 保存画布项目。带上客户端已知的 revision 时做乐观锁校验，
 * 服务端版本更新则拒绝写入，由客户端决定合并策略。
 */
export async function saveProject(userId: string, input: ProjectInput) {
    const id = input.id?.trim();
    if (!id) throw fail("缺少画布项目 ID");
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (saved && input.revision !== undefined && input.revision < saved.revision) throw fail("画布项目在其他设备上已更新，请先同步");
    const row = await projects.save({
        projectId: id,
        userId,
        title: input.title || saved?.title || "未命名画布",
        data: JSON.stringify(input.data ?? {}),
        revision: (saved?.revision || 0) + 1,
        deleted: false,
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as Project);
    return toProjectView(row);
}

/** 软删除，让其他设备也能同步到删除动作。 */
export async function deleteProject(userId: string, id: string) {
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (!saved) return;
    await projects.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() });
}

export async function listUserAssets(userId: string, since: string) {
    const rows = await repo(UserAsset).find({
        where: since ? { userId, updatedAt: MoreThan(since) } : { userId },
        order: { updatedAt: "DESC" },
        take: MAX_SYNC_ITEMS,
    });
    return rows.map(toAssetView);
}

export async function saveUserAsset(userId: string, input: UserAssetInput) {
    const id = input.id?.trim();
    if (!id) throw fail("缺少素材 ID");
    const assets = repo(UserAsset);
    const saved = await assets.findOneBy({ userId, assetId: id });
    if (saved && input.revision !== undefined && input.revision < saved.revision) throw fail("素材在其他设备上已更新，请先同步");
    const row = await assets.save({
        assetId: id,
        userId,
        kind: input.kind || saved?.kind || "image",
        title: input.title || saved?.title || "",
        data: JSON.stringify(input.data ?? {}),
        revision: (saved?.revision || 0) + 1,
        deleted: false,
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as UserAsset);
    return toAssetView(row);
}

export async function deleteUserAsset(userId: string, id: string) {
    const assets = repo(UserAsset);
    const saved = await assets.findOneBy({ userId, assetId: id });
    if (!saved) return;
    await assets.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() });
}
