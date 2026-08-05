import { In, Like, type FindOptionsWhere } from "typeorm";

import { repo } from "../db/data-source";
import { Job, Project, StoredFile, User, type JobKind, type JobStatus } from "../db/entities";
import { fail } from "../lib/errors";
import type { Query } from "../lib/response";
import { generationOutputViews } from "./generation-history";

export type JobFilter = { userId: string; status: string; kind: string };
export type FileFilter = { userId: string; kind: string };

type Owner = { username: string; displayName: string };
type CanvasData = { nodes?: Array<{ type?: string; metadata?: Record<string, unknown> }> };

function parseJson<T>(value: string, fallback: T): T {
    try {
        return (JSON.parse(value || "null") as T) ?? fallback;
    } catch {
        return fallback;
    }
}

function toFileView(file: StoredFile) {
    return { id: file.id, kind: file.kind, mimeType: file.mimeType, bytes: Number(file.bytes), width: file.width, height: file.height, durationMs: file.durationMs, createdAt: file.createdAt };
}

/** 批量补齐 userId → 用户名，避免列表逐条回查用户表。 */
async function loadOwners(userIds: string[]) {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (!ids.length) return new Map<string, Owner>();
    const users = await repo(User).find({ where: { id: In(ids) }, select: { id: true, username: true, displayName: true } });
    return new Map(users.map((user) => [user.id, { username: user.username, displayName: user.displayName || "" }]));
}

function ownerOf(owners: Map<string, Owner>, userId: string) {
    const owner = owners.get(userId);
    return { userId, username: owner?.username || "", displayName: owner?.displayName || "" };
}

async function loadFiles(ids: string[]) {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (!unique.length) return new Map<string, ReturnType<typeof toFileView>>();
    const files = await repo(StoredFile).findBy({ id: In(unique) });
    return new Map(files.map((file) => [file.id, toFileView(file)]));
}

function pickFiles(ids: string[], files: Map<string, ReturnType<typeof toFileView>>) {
    return ids.map((id) => files.get(id)).filter((file): file is ReturnType<typeof toFileView> => Boolean(file));
}

async function toJobRow(job: Job, owners: Map<string, Owner>) {
    return {
        id: job.id,
        ...ownerOf(owners, job.userId),
        kind: job.kind,
        status: job.status,
        model: job.model,
        prompt: job.prompt || "",
        credits: job.credits,
        progress: job.progress,
        error: job.error || "",
        outputs: await generationOutputViews(job),
        createdAt: job.createdAt,
        finishedAt: job.finishedAt || "",
    };
}

/** 跨用户列出生成任务，按创建时间倒序。 */
export async function listReviewJobs(query: Query, filter: JobFilter) {
    const base: FindOptionsWhere<Job> = {};
    if (filter.userId) base.userId = filter.userId;
    if (filter.status) base.status = filter.status as JobStatus;
    if (filter.kind) base.kind = filter.kind as JobKind;
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ ...base, prompt: like }, { ...base, model: like }, { ...base, id: like }] : base;
    const [rows, total] = await repo(Job).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const owners = await loadOwners(rows.map((row) => row.userId));
    return { items: await Promise.all(rows.map((row) => toJobRow(row, owners))), total };
}

export async function getReviewJob(id: string) {
    const job = await repo(Job).findOneBy({ id });
    if (!job) throw fail("任务不存在");
    const owners = await loadOwners([job.userId]);
    const files = await loadFiles(job.inputFileIds || []);
    return {
        ...(await toJobRow(job, owners)),
        clientJobId: job.clientJobId,
        params: parseJson<Record<string, unknown>>(job.params, {}),
        context: job.context || {},
        inputs: pickFiles(job.inputFileIds || [], files),
        updatedAt: job.updatedAt,
    };
}

/** 列出画布。节点数需要解析画布 JSON，所以这里不额外返回画布内容，避免列表响应过大。 */
export async function listReviewProjects(query: Query, userId: string) {
    const base: FindOptionsWhere<Project> = {};
    if (userId) base.userId = userId;
    const like = query.keyword ? Like(`%${query.keyword}%`) : undefined;
    const where = like ? [{ ...base, title: like }, { ...base, projectId: like }] : base;
    const [rows, total] = await repo(Project).findAndCount({ where, order: { updatedAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const owners = await loadOwners(rows.map((row) => row.userId));
    return {
        items: rows.map((row) => ({
            ...ownerOf(owners, row.userId),
            projectId: row.projectId,
            title: row.title,
            nodeCount: parseJson<CanvasData>(row.data, {}).nodes?.length || 0,
            revision: row.revision,
            deleted: row.deleted,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        })),
        total,
    };
}

export async function getReviewProject(userId: string, projectId: string) {
    const row = await repo(Project).findOneBy({ userId, projectId });
    if (!row) throw fail("画布项目不存在");
    const owners = await loadOwners([row.userId]);
    const data = parseJson<CanvasData>(row.data, {});
    return {
        ...ownerOf(owners, row.userId),
        projectId: row.projectId,
        title: row.title,
        nodeCount: data.nodes?.length || 0,
        revision: row.revision,
        deleted: row.deleted,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        data,
    };
}

export async function listReviewFiles(query: Query, filter: FileFilter) {
    const where: FindOptionsWhere<StoredFile> = {};
    if (filter.userId) where.userId = filter.userId;
    if (filter.kind) where.kind = filter.kind;
    const [rows, total] = await repo(StoredFile).findAndCount({ where, order: { createdAt: "DESC" }, skip: query.offset, take: query.pageSize });
    const owners = await loadOwners(rows.map((row) => row.userId));
    return { items: rows.map((row) => ({ ...toFileView(row), ...ownerOf(owners, row.userId) })), total };
}
