import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import mime from "mime-types";

import { dataSource, repo, serialTransaction } from "../db/data-source";
import { PhysicalBlob, StoredFile } from "../db/entities";
import { isBlobChecksumConflict } from "../lib/db-errors";
import { fail, newId, now } from "../lib/errors";
import { markBlobPending, reviveBlob } from "./blob-gc";
import { assertQuota, ownerOfUpload } from "./quota";
import { configuredFileStorage, deleteObject, putObject } from "./storage";

const IMAGE_MAX_BYTES = 30 << 20;
const VIDEO_MAX_BYTES = 200 << 20;
const AUDIO_MAX_BYTES = 30 << 20;
export type FileMeta = { width?: number; height?: number; durationMs?: number };
const checksumLocks = new Map<string, Promise<void>>();
const column = (name: string) => dataSource.driver.escape(name);

export function fileKind(mimeType: string) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "other";
}
function maxBytes(kind: string) { return kind === "video" ? VIDEO_MAX_BYTES : kind === "audio" ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES; }
function sizeMessage(kind: string) { return kind === "video" ? "视频超过大小限制，请使用 200MB 以内的文件" : kind === "audio" ? "音频超过大小限制，请使用 30MB 以内的文件" : "图片超过大小限制，请使用 30MB 以内的文件"; }
function objectKey(id: string, mimeType: string) {
    const date = new Date();
    return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}.${mime.extension(mimeType) || "bin"}`;
}
function readImageMeta(body: Buffer, mimeType: string): FileMeta {
    if (!mimeType.startsWith("image/")) return {};
    try { const size = imageSize(body); return { width: size.width, height: size.height }; } catch { return {}; }
}
export function imageTypeOf(body: Buffer) { try { return imageSize(body).type || ""; } catch { return ""; } }

export async function withBlobLock<T>(checksum: string, work: () => Promise<T>) {
    const previous = checksumLocks.get(checksum) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    checksumLocks.set(checksum, queued);
    await previous;
    try { return await work(); } finally { release(); if (checksumLocks.get(checksum) === queued) checksumLocks.delete(checksum); }
}

export async function physicalBlobOf(file: StoredFile) {
    return repo(PhysicalBlob).findOneBy({ checksum: file.checksum });
}
export async function storedObjectOf(file: StoredFile) {
    const blob = await physicalBlobOf(file);
    return blob ? { path: blob.path, storage: blob.storage } : { path: file.path, storage: file.storage };
}

/**
 * 全局物理去重；每个归属方仍获得独立 fileId 和逻辑配额引用。
 *
 * teamId 决定这份文件记谁的账。去重键是 (userId, teamId, checksum) 而不是只看 teamId：
 * 一行文件的可见性与删除权仍然由 userId 决定（getFile / deleteFile 都按它判），
 * 跨 userId 复用同一行的话，团队里另一个人的画布会引到一个他自己既读不到也删不掉的 fileId。
 * 于是同一份内容最多可能有「个人一条 + 每个画布所有者在该团队下一条」，物理对象始终只有一个，
 * refCount 按逻辑记录数算——个人那条绝不能顶替团队那条，否则团队画布里的图挂在个人名下，
 * 他一退出就该被清掉，而团队的空间从来没为它付过账。
 */
export async function saveFile(userId: string, body: Buffer, mimeType: string, meta: FileMeta = {}, teamId = "") {
    const type = (mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
    const kind = fileKind(type);
    if (!body.length) throw fail("上传文件为空");
    if (body.length > maxBytes(kind)) throw fail(sizeMessage(kind));
    const owner = ownerOfUpload(userId, teamId);
    const checksum = createHash("sha256").update(body).digest("hex");
    return withBlobLock(checksum, async () => {
        const existing = await repo(StoredFile).findOneBy({ userId, teamId, checksum });
        if (existing) {
            // 重复上传命中去重，但物理对象可能因为对账漂移或跨实例删除被标成待回收；
            // 直接返回会让这个引用等着被 GC 抽走底下的对象，所以先无条件复活。
            await reviveBlob(checksum);
            return existing;
        }
        await assertQuota(owner, body.length);
        const id = newId("file");
        const imageMeta = readImageMeta(body, type);
        let blob = await repo(PhysicalBlob).findOneBy({ checksum });
        if (!blob) {
            const storage = configuredFileStorage();
            const path = objectKey(id, type);
            await putObject(path, body, type, storage);
            const candidate = repo(PhysicalBlob).create({ checksum, bytes: body.length, kind, mimeType: type, width: meta.width || imageMeta.width || 0, height: meta.height || imageMeta.height || 0, durationMs: meta.durationMs || 0, storage, path, refCount: 0, state: "active", pendingSince: "", createdAt: now() });
            // 只吞「别人抢先按同一个 checksum 插进去了」这一种冲突：紧接着的 findOneByOrFail 会重新读一次。
            // 其余错误（列长度、连接断开）必须原样抛——吞掉的话，故障会被翻译成下一行那条
            // 毫无线索的「找不到记录」，排查时根本看不出真正坏在哪。
            await repo(PhysicalBlob)
                .insert(candidate)
                .catch((error) => {
                    if (!isBlobChecksumConflict(error)) throw error;
                });
            blob = await repo(PhysicalBlob).findOneByOrFail({ checksum });
            // 多实例同时首传时只有一个 insert 能赢。输家写出的对象没人引用，必须回收；
            // 但只允许删自己刚写的那个 key，胜出 blob 的 path 一个字节都不能碰。
            if (blob.path !== path || blob.storage !== storage) await deleteObject(path, storage).catch((error) => console.warn(`并发上传落选对象回收失败 ${storage}:${path}:`, error));
            if (blob.state === "pending_delete") await reviveBlob(checksum);
        } else if (blob.state === "pending_delete") {
            await reviveBlob(checksum);
        }
        const file = repo(StoredFile).create({ id, userId, teamId, kind: blob.kind, mimeType: blob.mimeType, bytes: Number(blob.bytes), width: blob.width, height: blob.height, durationMs: blob.durationMs, storage: blob.storage, path: blob.path, checksum, createdAt: now() });
        // 走全局串行队列而不是 dataSource.transaction：SQLite 全程只有一条连接，
        // 绕过队列直接 BEGIN 会撞上别人已经打开的事务（「cannot start a transaction within a transaction」），
        // 更糟的是落进别人的事务里，对方一回滚就把这次引用计数一起抹掉。
        await serialTransaction(async (manager) => {
            await manager.getRepository(StoredFile).insert(file);
            await manager.getRepository(PhysicalBlob).createQueryBuilder().update().set({ refCount: () => `${column("refCount")} + 1`, state: "active", pendingSince: "" }).where("checksum = :checksum", { checksum }).execute();
        });
        return file;
    });
}

export async function saveFileFromDataUrl(userId: string, dataUrl: string, meta?: FileMeta, teamId = "") {
    const matched = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl); if (!matched) throw fail("图片数据格式不正确");
    const payload = dataUrl.slice(matched[0].length); return saveFile(userId, matched[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8"), matched[1] || "image/png", meta, teamId);
}
export async function saveFileFromUrl(userId: string, url: string, meta?: FileMeta, teamId = "") {
    if (url.startsWith("data:")) return saveFileFromDataUrl(userId, url, meta, teamId);
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) }).catch(() => { throw fail("下载生成结果失败"); });
    if (!response.ok) throw fail(`下载生成结果失败：${response.status}`);
    return saveFile(userId, Buffer.from(await response.arrayBuffer()), response.headers.get("content-type") || "application/octet-stream", meta, teamId);
}
export async function getFile(id: string, userId?: string) {
    const file = await repo(StoredFile).findOneBy({ id }); if (!file) throw fail("文件不存在");
    if (userId !== undefined && file.userId && file.userId !== userId) throw fail("无权访问该文件"); return file;
}
export async function deleteFile(id: string, userId: string) {
    const file = await getFile(id, userId);
    await withBlobLock(file.checksum, async () => {
        await serialTransaction(async (manager) => {
            const deleted = await manager.getRepository(StoredFile).delete({ id, userId });
            if (!deleted.affected) return;
            await manager.getRepository(PhysicalBlob).createQueryBuilder().update().set({ refCount: () => `CASE WHEN ${column("refCount")} > 0 THEN ${column("refCount")} - 1 ELSE 0 END` }).where("checksum = :checksum", { checksum: file.checksum }).execute();
        });
        const actual = await repo(StoredFile).countBy({ checksum: file.checksum });
        await repo(PhysicalBlob).update({ checksum: file.checksum }, { refCount: actual });
        if (actual <= 0) await markBlobPending(file.checksum);
    });
}
export async function listFiles(userId: string, ids: string[]) {
    if (!ids.length) return [];
    const files = await repo(StoredFile).find({ where: ids.map((id) => ({ id })) }); return files.filter((file) => !file.userId || file.userId === userId);
}
export function publicFileUrl(baseUrl: string, id: string) { return `${baseUrl}/api/files/${id}/content`; }
