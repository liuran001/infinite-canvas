import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import mime from "mime-types";

import { dataSource, repo, serialTransaction } from "../db/data-source";
import { PhysicalBlob, StoredFile } from "../db/entities";
import { isBlobChecksumConflict, isUniqueViolation } from "../lib/db-errors";
import { fail, newId, now } from "../lib/errors";
import { reconcileBlobReferences, reviveBlob } from "./blob-gc";
import { requireActiveStorageOwner } from "./account-fence";
import { assertQuota, ownerOfUpload } from "./quota";
import { configuredFileStorage, deleteObject, putObject } from "./storage";

const IMAGE_MAX_BYTES = 30 << 20;
const VIDEO_MAX_BYTES = 200 << 20;
const AUDIO_MAX_BYTES = 30 << 20;
export type FileMeta = { width?: number; height?: number; durationMs?: number };
const checksumLocks = new Map<string, Promise<void>>();
const column = (name: string) => dataSource.driver.escape(name);
const ATTACHABLE_BLOB_STATES = ["active", "pending_delete"] as const;

class BlobBusyError extends Error {}

export function fileKind(mimeType: string) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "other";
}
function maxBytes(kind: string) { return kind === "video" ? VIDEO_MAX_BYTES : kind === "audio" ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES; }
function sizeMessage(kind: string) { return kind === "video" ? "视频超过大小限制，请使用 200MB 以内的文件" : kind === "audio" ? "音频超过大小限制，请使用 30MB 以内的文件" : "图片超过大小限制，请使用 30MB 以内的文件"; }
function objectKey(checksum: string, mimeType: string, suffix = "") {
    // checksum 让多实例首次上传同一内容时写到同一个 key；即使同时 PUT，也只是相同字节覆盖相同字节，
    // 不会像随机 key 那样产生一个数据库永远不知道的落选对象。
    return `blobs/${checksum.slice(0, 2)}/${checksum}${suffix}.${mime.extension(mimeType) || "bin"}`;
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

async function deleteIfUnreferenced(path: string, storage: PhysicalBlob["storage"]) {
    if (await repo(PhysicalBlob).exist({ where: { path, storage } })) return;
    await deleteObject(path, storage).catch((error) => console.warn(`未采用物理对象回收失败 ${storage}:${path}:`, error));
}

/**
 * 确保 checksum 对应的物理对象可安全挂新引用。deleting 已经被 GC 抢占，绝不能只把状态改回 active：
 * GC 可能正在删旧 path。恢复时改写到带删除令牌的新 key，再用同一令牌 CAS 换 path；旧 GC 即使完成，
 * 也只能删旧 key，删数据库行时会因令牌失效而失败。
 */
async function ensurePhysicalBlob(checksum: string, body: Buffer, type: string, kind: string, meta: FileMeta, imageMeta: FileMeta) {
    const blobs = repo(PhysicalBlob);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        let blob = await blobs.findOneBy({ checksum });
        if (blob?.state === "active") return blob;
        if (blob?.state === "pending_delete") {
            await reviveBlob(checksum);
            continue;
        }
        if (blob?.state === "deleting") {
            if (!blob.deleteToken) {
                const token = newId("gc");
                await blobs.update({ checksum, state: "deleting", deleteToken: "" }, { deleteToken: token, pendingSince: now() });
                continue;
            }
            const storage = configuredFileStorage();
            const previous = { path: blob.path, storage: blob.storage };
            const replacement = objectKey(checksum, blob.mimeType || type, `-${blob.deleteToken}`);
            await putObject(replacement, body, blob.mimeType || type, storage);
            const recovered = await blobs.update(
                { checksum, state: "deleting", deleteToken: blob.deleteToken },
                { path: replacement, storage, state: "active", deleteToken: "", pendingSince: "" },
            );
            if (recovered.affected) {
                if (previous.path !== replacement || previous.storage !== storage) await deleteIfUnreferenced(previous.path, previous.storage);
                return blobs.findOneByOrFail({ checksum, state: "active" });
            }
            await deleteIfUnreferenced(replacement, storage);
            continue;
        }

        const storage = configuredFileStorage();
        const path = objectKey(checksum, type);
        await putObject(path, body, type, storage);
        const candidate = blobs.create({
            checksum,
            bytes: body.length,
            kind,
            mimeType: type,
            width: meta.width || imageMeta.width || 0,
            height: meta.height || imageMeta.height || 0,
            durationMs: meta.durationMs || 0,
            storage,
            path,
            refCount: 0,
            state: "active",
            deleteToken: "",
            pendingSince: "",
            createdAt: now(),
        });
        try {
            await blobs.insert(candidate);
        } catch (error) {
            if (!isBlobChecksumConflict(error)) {
                await deleteIfUnreferenced(path, storage);
                throw error;
            }
        }
        blob = await blobs.findOneBy({ checksum });
        if (blob?.path !== path || blob.storage !== storage) await deleteIfUnreferenced(path, storage);
        if (blob?.state === "active") return blob;
    }
    throw fail("文件正在回收，请稍后重试");
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
    // 尽早挡住已经进入注销/团队停用流程的请求；真正插行时还会在同一事务内再验一次，
    // 这一层主要避免明知不可写还先创建一个零引用物理对象。
    await serialTransaction((manager) => requireActiveStorageOwner(manager, userId, teamId));
    return withBlobLock(checksum, async () => {
        const existing = await repo(StoredFile).findOneBy({ userId, dedupeKey: teamId, checksum });
        if (existing) {
            await ensurePhysicalBlob(checksum, body, type, kind, meta, readImageMeta(body, type));
            await reconcileBlobReferences(checksum);
            return existing;
        }
        await assertQuota(owner, body.length);
        const id = newId("file");
        const imageMeta = readImageMeta(body, type);
        let blob = await ensurePhysicalBlob(checksum, body, type, kind, meta, imageMeta);
        const file = repo(StoredFile).create({ id, userId, teamId, dedupeKey: teamId, kind: blob.kind, mimeType: blob.mimeType, bytes: Number(blob.bytes), width: blob.width, height: blob.height, durationMs: blob.durationMs, storage: blob.storage, path: blob.path, checksum, createdAt: now() });
        // 走全局串行队列而不是 dataSource.transaction：SQLite 全程只有一条连接，
        // 绕过队列直接 BEGIN 会撞上别人已经打开的事务（「cannot start a transaction within a transaction」），
        // 更糟的是落进别人的事务里，对方一回滚就把这次引用计数一起抹掉。
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                await serialTransaction(async (manager) => {
                    await requireActiveStorageOwner(manager, userId, teamId);
                    const attached = await manager
                        .getRepository(PhysicalBlob)
                        .createQueryBuilder()
                        .update()
                        .set({ refCount: () => `${column("refCount")} + 1`, state: "active", deleteToken: "", pendingSince: "" })
                        .where("checksum = :checksum", { checksum })
                        .andWhere(`state IN (:...states)`, { states: ATTACHABLE_BLOB_STATES })
                        .execute();
                    if (!attached.affected) throw new BlobBusyError();
                    await manager.getRepository(StoredFile).insert(file);
                });
                return file;
            } catch (error) {
                if (error instanceof BlobBusyError) {
                    blob = await ensurePhysicalBlob(checksum, body, type, kind, meta, imageMeta);
                    Object.assign(file, { kind: blob.kind, mimeType: blob.mimeType, bytes: Number(blob.bytes), width: blob.width, height: blob.height, durationMs: blob.durationMs, storage: blob.storage, path: blob.path });
                    continue;
                }
                // 多实例会各自持有进程内锁，数据库唯一约束才是最后一道去重门禁。
                if (!isUniqueViolation(error)) {
                    await reconcileBlobReferences(checksum).catch((reconcileError) => console.error(`回收未采用文件 ${checksum} 失败:`, reconcileError));
                    throw error;
                }
                const raced = await repo(StoredFile).findOneBy({ userId, dedupeKey: teamId, checksum });
                if (!raced) throw error;
                await ensurePhysicalBlob(checksum, body, type, kind, meta, imageMeta);
                await reconcileBlobReferences(checksum);
                return raced;
            }
        }
        throw fail("文件正在回收，请稍后重试");
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
    const file = await repo(StoredFile).findOneBy({ id }); if (!file) throw fail("文件不存在", 404);
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
        await reconcileBlobReferences(file.checksum);
    });
}
export async function listFiles(userId: string, ids: string[]) {
    if (!ids.length) return [];
    const files = await repo(StoredFile).find({ where: ids.map((id) => ({ id })) }); return files.filter((file) => !file.userId || file.userId === userId);
}
export function publicFileUrl(baseUrl: string, id: string) { return `${baseUrl}/api/files/${id}/content`; }
