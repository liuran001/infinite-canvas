import { createHash } from "node:crypto";

import { In, MoreThan } from "typeorm";

import { repo } from "../db/data-source";
import { PhysicalBlob, StoredFile } from "../db/entities";
import { now } from "../lib/errors";
import { getObject } from "./storage";

/** 分批大小。存量库可能有几十万行，全表 find() 会在启动时把整张表读进内存。 */
const PAGE_SIZE = 500;

async function objectBuffer(file: StoredFile) {
    const object = await getObject(file.path, undefined, file.storage);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

async function readable(file: StoredFile) {
    const object = await getObject(file.path, undefined, file.storage).catch(() => null);
    if (!object) return false;
    // getObject 会开着本地读流；只做可读性探测时必须显式销毁，否则大库迁移会耗尽 fd。
    object.stream.destroy();
    return true;
}

function unreadable(files: StoredFile[]) {
    const detail = files.map((file) => `${file.id}(${file.storage}:${file.path})`).join(", ");
    return new Error(`历史文件无法读取，迁移已停止：checksum=${files[0]?.checksum} 候选=${detail}`);
}

/** 稳定分页游标：createdAt 可能重复甚至为空，必须再带上主键才不会漏行或死循环。 */
function afterCursor(cursor: { createdAt: string; id: string } | null) {
    if (!cursor) return {};
    return [{ createdAt: MoreThan(cursor.createdAt) }, { createdAt: cursor.createdAt, id: MoreThan(cursor.id) }];
}

async function eachFilePage(work: (page: StoredFile[]) => Promise<void>) {
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
        const page: StoredFile[] = await repo(StoredFile).find({ where: afterCursor(cursor), order: { createdAt: "ASC", id: "ASC" }, take: PAGE_SIZE });
        if (!page.length) return;
        await work(page);
        const last = page[page.length - 1];
        cursor = { createdAt: last.createdAt, id: last.id };
    }
}

/** 已有 blob 只补齐空字段，绝不覆盖 path/storage：那两个字段指向真实存在的历史对象。 */
function missingFields(blob: PhysicalBlob, file: StoredFile) {
    const patch: Partial<PhysicalBlob> = {};
    if (!Number(blob.bytes) && Number(file.bytes)) patch.bytes = Number(file.bytes);
    if (!blob.mimeType || blob.mimeType === "application/octet-stream") if (file.mimeType) patch.mimeType = file.mimeType;
    if (!blob.kind || blob.kind === "other") if (file.kind) patch.kind = file.kind;
    if (!blob.width && file.width) patch.width = file.width;
    if (!blob.height && file.height) patch.height = file.height;
    if (!blob.durationMs && file.durationMs) patch.durationMs = file.durationMs;
    if (!blob.createdAt && file.createdAt) patch.createdAt = file.createdAt;
    return patch;
}

async function insertBlobFrom(file: StoredFile) {
    const blobs = repo(PhysicalBlob);
    await blobs
        .insert({
            checksum: file.checksum,
            bytes: Number(file.bytes),
            kind: file.kind,
            mimeType: file.mimeType,
            width: file.width,
            height: file.height,
            durationMs: file.durationMs,
            storage: file.storage,
            path: file.path,
            refCount: 0,
            state: "active",
            pendingSince: "",
            createdAt: file.createdAt || now(),
        } as PhysicalBlob)
        .catch(async () => {
            if (!(await blobs.exist({ where: { checksum: file.checksum } }))) throw new Error(`创建物理文件记录失败：${file.checksum}`);
        });
}

/** 同 checksum 的多行里选第一条真正可读的作为物理来源；一条坏 path 不该让整组逻辑引用失效。 */
async function createFromFirstReadable(candidates: StoredFile[]) {
    for (const candidate of candidates) {
        if (!(await readable(candidate))) continue;
        await insertBlobFrom(candidate);
        return true;
    }
    return false;
}

async function backfillChecksum(file: StoredFile) {
    const body = await objectBuffer(file).catch(() => {
        throw unreadable([file]);
    });
    file.checksum = createHash("sha256").update(body).digest("hex");
    await repo(StoredFile).update({ id: file.id }, { checksum: file.checksum });
}

/**
 * 旧 files 表到 file_blobs 的保数据迁移。只新增和回填，不改 fileId/path，也不删除落选对象。
 * refCount 每次都按实际引用绝对重算，因此中途退出后重跑不会重复累加。
 */
export async function migratePhysicalBlobs() {
    const blobs = repo(PhysicalBlob);
    // 本批内所有候选都不可读的 checksum，留到最后跨批重试，避免误判成「整组丢失」。
    const deferred = new Set<string>();

    await eachFilePage(async (page) => {
        for (const file of page) if (!file.checksum) await backfillChecksum(file);
        const checksums = [...new Set(page.map((file) => file.checksum))];
        // 一次查出本批已有的 blob，避免每行一次 exists 查询。
        const existing = new Map((await blobs.findBy({ checksum: In(checksums) })).map((blob) => [blob.checksum, blob]));
        const grouped = new Map<string, StoredFile[]>();
        for (const file of page) grouped.set(file.checksum, [...(grouped.get(file.checksum) || []), file]);

        for (const [checksum, candidates] of grouped) {
            const blob = existing.get(checksum);
            if (blob) {
                const patch = missingFields(blob, candidates[0]);
                if (Object.keys(patch).length) await blobs.update({ checksum }, patch);
                continue;
            }
            if (!(await createFromFirstReadable(candidates))) deferred.add(checksum);
        }
    });

    for (const checksum of deferred) {
        if (await blobs.exist({ where: { checksum } })) continue;
        const candidates = await repo(StoredFile).findBy({ checksum });
        if (!(await createFromFirstReadable(candidates))) throw unreadable(candidates);
    }

    await reconcileBlobRefCounts();

    await eachFilePage(async (page) => {
        const checksums = [...new Set(page.map((file) => file.checksum))];
        const covered = new Set((await blobs.findBy({ checksum: In(checksums) })).map((blob) => blob.checksum));
        const orphan = page.find((file) => !covered.has(file.checksum));
        if (orphan) throw new Error(`文件迁移校验失败：${orphan.id} 没有物理对象记录`);
    });
}

/** 按 files 的实际行数绝对重算 refCount，修正任何来源的漂移。 */
export async function reconcileBlobRefCounts() {
    const blobs = repo(PhysicalBlob);
    let cursor = "";
    for (;;) {
        const page: PhysicalBlob[] = await blobs.find({ where: cursor ? { checksum: MoreThan(cursor) } : {}, order: { checksum: "ASC" }, take: PAGE_SIZE });
        if (!page.length) return;
        const checksums = page.map((blob) => blob.checksum);
        const counted = await repo(StoredFile)
            .createQueryBuilder("file")
            .select("file.checksum", "checksum")
            .addSelect("COUNT(1)", "total")
            .where("file.checksum IN (:...checksums)", { checksums })
            .groupBy("file.checksum")
            .getRawMany<{ checksum: string; total: string | number }>();
        const counts = new Map(counted.map((row) => [row.checksum, Number(row.total) || 0]));
        for (const blob of page) {
            const count = counts.get(blob.checksum) || 0;
            const target = count
                ? { refCount: count, state: "active" as const, pendingSince: "" }
                : { refCount: 0, state: "pending_delete" as const, pendingSince: blob.pendingSince || now() };
            // 稳定态下绝大多数行无需写库，跳过可以让重启对账在大库上接近纯读。
            if (blob.refCount === target.refCount && blob.state === target.state && blob.pendingSince === target.pendingSince) continue;
            await blobs.update({ checksum: blob.checksum }, target);
        }
        cursor = checksums[checksums.length - 1];
    }
}
