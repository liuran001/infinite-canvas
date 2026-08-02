import { MoreThan } from "typeorm";

import { repo } from "../db/data-source";
import { Project, UserAsset, UserPlugin } from "../db/entities";
import { fail, now } from "../lib/errors";
import { releaseFiles } from "./cleanup";
import { publishProjectDeleted, publishProjectSaved } from "./project-realtime";

export type ProjectInput = { id: string; title: string; data: unknown; revision: number; clientId: string };
export type UserAssetInput = { id: string; kind: string; title: string; data: unknown; revision?: number };
export type UserPluginInput = { id: string; data: unknown; revision?: number };
export type CanvasNodeData = { id: string; type: string; title: string; position: { x: number; y: number }; width: number; height: number; metadata?: Record<string, unknown> };
export type CanvasConnectionData = { id: string; fromNodeId: string; toNodeId: string };
export type CanvasProjectData = { nodes: CanvasNodeData[]; connections: CanvasConnectionData[] } & Record<string, unknown>;

const MAX_SYNC_ITEMS = 500;
const PROJECT_UPDATE_RETRIES = 3;

function parseData(value: string) {
    try { return JSON.parse(value || "null") as unknown; } catch { return null; }
}

export function toProjectView(row: Project) {
    return { id: row.projectId, title: row.title, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function toAssetView(row: UserAsset) { return { id: row.assetId, kind: row.kind, title: row.title, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
function toPluginView(row: UserPlugin) { return { id: row.pluginId, data: parseData(row.data), revision: row.revision, deleted: row.deleted, createdAt: row.createdAt, updatedAt: row.updatedAt }; }

export async function listProjects(userId: string, since: string) {
    return (await repo(Project).find({ where: since ? { userId, updatedAt: MoreThan(since) } : { userId }, order: { updatedAt: "DESC" }, take: MAX_SYNC_ITEMS })).map(toProjectView);
}
function conflict(row: Project) { return fail("画布项目在其他设备上已更新，请先同步", 409, "REVISION_CONFLICT", toProjectView(row)); }

/** revision 是必填 CAS 基线；同版本并发保存只允许一个成功。 */
export async function saveProject(userId: string, input: ProjectInput) {
    const id = input.id?.trim();
    if (!id) throw fail("缺少画布项目 ID");
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (!saved) {
        if (input.revision !== 0) throw fail("画布项目在其他设备上已更新，请先同步", 409, "REVISION_CONFLICT");
        const row = projects.create({ projectId: id, userId, title: input.title || "未命名画布", data: JSON.stringify(input.data ?? {}), revision: 1, deleted: false, createdAt: now(), updatedAt: now() });
        try { await projects.insert(row); } catch {
            const current = await projects.findOneBy({ userId, projectId: id });
            if (current) throw conflict(current);
            throw fail("保存画布项目失败", 500);
        }
        publishProjectSaved(userId, id, 1, input.clientId);
        return toProjectView(row);
    }
    if (saved.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    if (input.revision !== saved.revision) throw conflict(saved);
    const updatedAt = now();
    const result = await projects.update({ userId, projectId: id, revision: input.revision, deleted: false }, { title: input.title || saved.title, data: JSON.stringify(input.data ?? {}), revision: input.revision + 1, updatedAt });
    if (result.affected !== 1) {
        const current = await projects.findOneBy({ userId, projectId: id });
        if (!current || current.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
        throw conflict(current);
    }
    const row = { ...saved, title: input.title || saved.title, data: JSON.stringify(input.data ?? {}), revision: input.revision + 1, updatedAt } as Project;
    publishProjectSaved(userId, id, row.revision, input.clientId);
    return toProjectView(row);
}

export async function deleteProject(userId: string, id: string, clientId = "") {
    const projects = repo(Project);
    const saved = await projects.findOneBy({ userId, projectId: id });
    if (!saved || saved.deleted) return;
    const revision = saved.revision + 1;
    const result = await projects.update({ userId, projectId: id, revision: saved.revision, deleted: false }, { deleted: true, data: "", revision, updatedAt: now() });
    if (result.affected !== 1) return;
    publishProjectDeleted(userId, id, revision, clientId);
    await releaseFiles(userId, saved.data);
}

function toCanvasData(value: string): CanvasProjectData {
    const data = (parseData(value) || {}) as Partial<CanvasProjectData>;
    return { ...data, nodes: Array.isArray(data.nodes) ? data.nodes : [], connections: Array.isArray(data.connections) ? data.connections : [] };
}
export async function readProjectCanvas(userId: string, id: string) {
    const row = await repo(Project).findOneBy({ userId, projectId: id });
    if (!row || row.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    return { title: row.title, revision: row.revision, data: toCanvasData(row.data) };
}

/** Agent 写画布也走 CAS；冲突时重新读最新 JSON 后重放 mutate。 */
export async function updateProjectCanvas<T>(userId: string, id: string, mutate: (data: CanvasProjectData) => T): Promise<T> {
    for (let attempt = 0; attempt < PROJECT_UPDATE_RETRIES; attempt += 1) {
        const projects = repo(Project);
        const saved = await projects.findOneBy({ userId, projectId: id });
        if (!saved || saved.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
        const data = toCanvasData(saved.data);
        const value = mutate(data);
        data.updatedAt = now();
        const result = await projects.update({ userId, projectId: id, revision: saved.revision, deleted: false }, { data: JSON.stringify(data), revision: saved.revision + 1, updatedAt: now() });
        if (result.affected === 1) {
            publishProjectSaved(userId, id, saved.revision + 1, "agent");
            return value;
        }
    }
    throw fail("画布正在被其他设备修改，请稍后重试", 409, "PROJECT_BUSY");
}
export async function renameProjectCanvas(userId: string, id: string, title: string) {
    for (let attempt = 0; attempt < PROJECT_UPDATE_RETRIES; attempt += 1) {
        const projects = repo(Project);
        const saved = await projects.findOneBy({ userId, projectId: id });
        if (!saved || saved.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
        const result = await projects.update({ userId, projectId: id, revision: saved.revision, deleted: false }, { title, revision: saved.revision + 1, updatedAt: now() });
        if (result.affected === 1) {
            publishProjectSaved(userId, id, saved.revision + 1, "agent");
            return { projectId: id, title, revision: saved.revision + 1 };
        }
    }
    throw fail("画布正在被其他设备修改，请稍后重试", 409, "PROJECT_BUSY");
}

export async function listUserAssets(userId: string, since: string) {
    return (await repo(UserAsset).find({ where: since ? { userId, updatedAt: MoreThan(since) } : { userId }, order: { updatedAt: "DESC" }, take: MAX_SYNC_ITEMS })).map(toAssetView);
}
export async function saveUserAsset(userId: string, input: UserAssetInput) {
    const id = input.id?.trim(); if (!id) throw fail("缺少素材 ID");
    const assets = repo(UserAsset); const saved = await assets.findOneBy({ userId, assetId: id });
    if (saved && input.revision !== undefined && input.revision < saved.revision) throw fail("素材在其他设备上已更新，请先同步");
    return toAssetView(await assets.save({ assetId: id, userId, kind: input.kind || saved?.kind || "image", title: input.title || saved?.title || "", data: JSON.stringify(input.data ?? {}), revision: (saved?.revision || 0) + 1, deleted: false, createdAt: saved?.createdAt || now(), updatedAt: now() } as UserAsset));
}
export async function deleteUserAsset(userId: string, id: string) {
    const assets = repo(UserAsset); const saved = await assets.findOneBy({ userId, assetId: id }); if (!saved) return;
    await assets.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() }); await releaseFiles(userId, saved.data);
}
export async function listUserPlugins(userId: string, since: string) {
    return (await repo(UserPlugin).find({ where: since ? { userId, updatedAt: MoreThan(since) } : { userId }, order: { updatedAt: "DESC" }, take: MAX_SYNC_ITEMS })).map(toPluginView);
}
export async function saveUserPlugin(userId: string, input: UserPluginInput) {
    const id = input.id?.trim(); if (!id) throw fail("缺少插件 ID");
    const plugins = repo(UserPlugin); const saved = await plugins.findOneBy({ userId, pluginId: id });
    if (saved && input.revision !== undefined && input.revision < saved.revision) throw fail("插件在其他设备上已更新，请先同步");
    return toPluginView(await plugins.save({ pluginId: id, userId, data: JSON.stringify(input.data ?? {}), revision: (saved?.revision || 0) + 1, deleted: false, createdAt: saved?.createdAt || now(), updatedAt: now() } as UserPlugin));
}
export async function deleteUserPlugin(userId: string, id: string) {
    const plugins = repo(UserPlugin); const saved = await plugins.findOneBy({ userId, pluginId: id }); if (!saved) return;
    await plugins.save({ ...saved, deleted: true, data: "", revision: saved.revision + 1, updatedAt: now() });
}
