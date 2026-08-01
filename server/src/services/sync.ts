import { MoreThan } from "typeorm";

import { repo } from "../db/data-source";
import { Project, UserAsset, UserPlugin } from "../db/entities";
import { fail, now } from "../lib/errors";
import { releaseFiles } from "./cleanup";

export type ProjectInput = { id: string; title: string; data: unknown; revision?: number };
export type UserAssetInput = { id: string; kind: string; title: string; data: unknown; revision?: number };
export type UserPluginInput = { id: string; data: unknown; revision?: number };

/** 与 web/src/types/canvas.ts 对齐，只声明服务端会读写的字段，其余画布字段原样保留。 */
export type CanvasNodeData = { id: string; type: string; title: string; position: { x: number; y: number }; width: number; height: number; metadata?: Record<string, unknown> };
export type CanvasConnectionData = { id: string; fromNodeId: string; toNodeId: string };
export type CanvasProjectData = { nodes: CanvasNodeData[]; connections: CanvasConnectionData[] } & Record<string, unknown>;

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

/** 软删除，让其他设备也能同步到删除动作；引用的文件没人再用就真删，释放云空间。 */
export async function deleteProject(userId: string, id: string) {
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (!saved) return;
    await projects.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() });
    await releaseFiles(userId, saved.data);
}

function toCanvasData(value: string): CanvasProjectData {
    const data = (parseData(value) || {}) as Partial<CanvasProjectData>;
    return { ...data, nodes: Array.isArray(data.nodes) ? data.nodes : [], connections: Array.isArray(data.connections) ? data.connections : [] };
}

export async function readProjectCanvas(userId: string, id: string) {
    const row = await repo(Project).findOneBy({ userId, projectId: id });
    if (!row || row.deleted) throw fail("画布项目不存在");
    return { title: row.title, revision: row.revision, data: toCanvasData(row.data) };
}

/**
 * 服务端直接改画布（Agent 工具用）：读出当前数据就地修改再写回。
 * 这里不做乐观锁校验——服务端读到的就是最新版本，但 revision 照常递增，
 * 前端现有的增量同步才能拉到这次变更，客户端的过期写入也会被原有乐观锁挡下。
 */
export async function updateProjectCanvas<T>(userId: string, id: string, mutate: (data: CanvasProjectData) => T): Promise<T> {
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (!saved || saved.deleted) throw fail("画布项目不存在");
    const data = toCanvasData(saved.data);
    const result = mutate(data);
    data.updatedAt = now();
    await projects.save({ ...saved, data: JSON.stringify(data), revision: saved.revision + 1, updatedAt: now() });
    return result;
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
    await releaseFiles(userId, saved.data);
}

function toPluginView(row: UserPlugin) {
    return { id: row.pluginId, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** 已安装的画布节点插件，换设备登录后照样带着走。 */
export async function listUserPlugins(userId: string, since: string) {
    const rows = await repo(UserPlugin).find({
        where: since ? { userId, updatedAt: MoreThan(since) } : { userId },
        order: { updatedAt: "DESC" },
        take: MAX_SYNC_ITEMS,
    });
    return rows.map(toPluginView);
}

export async function saveUserPlugin(userId: string, input: UserPluginInput) {
    const id = input.id?.trim();
    if (!id) throw fail("缺少插件 ID");
    const plugins = repo(UserPlugin);
    const saved = await plugins.findOneBy({ userId, pluginId: id });
    if (saved && input.revision !== undefined && input.revision < saved.revision) throw fail("插件在其他设备上已更新，请先同步");
    const row = await plugins.save({
        pluginId: id,
        userId,
        data: JSON.stringify(input.data ?? {}),
        revision: (saved?.revision || 0) + 1,
        deleted: false,
        createdAt: saved?.createdAt || now(),
        updatedAt: now(),
    } as UserPlugin);
    return toPluginView(row);
}

export async function deleteUserPlugin(userId: string, id: string) {
    const plugins = repo(UserPlugin);
    const saved = await plugins.findOneBy({ userId, pluginId: id });
    if (!saved) return;
    await plugins.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() });
}
