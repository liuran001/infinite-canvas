import { createHash } from "node:crypto";

import { repo } from "../db/data-source";
import { PhysicalBlob, StoredFile } from "../db/entities";
import { now } from "../lib/errors";
import { getObject } from "./storage";

async function objectBuffer(file: StoredFile) {
    const object = await getObject(file.path, undefined, file.storage);
    const chunks: Buffer[] = [];
    for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
}

/**
 * 旧 files 表到 file_blobs 的保数据迁移。只新增和回填，不改 fileId/path，也不删除落选对象。
 * refCount 每次都按实际引用绝对重算，因此中途退出后重跑不会重复累加。
 */
export async function migratePhysicalBlobs() {
    const files = await repo(StoredFile).find({ order: { createdAt: "ASC", id: "ASC" } });
    const blobs = repo(PhysicalBlob);
    for (const file of files) {
        if (!file.checksum) {
            const body = await objectBuffer(file).catch((error) => {
                throw new Error(`历史文件无法读取，迁移已停止：id=${file.id} storage=${file.storage} path=${file.path} cause=${String(error)}`);
            });
            file.checksum = createHash("sha256").update(body).digest("hex");
            await repo(StoredFile).update({ id: file.id }, { checksum: file.checksum });
        }
        if (await blobs.exist({ where: { checksum: file.checksum } })) continue;
        // checksum 早已有值也必须确认候选对象可读；否则一个坏 path 会让同 checksum 的全部逻辑引用一起失效。
        await getObject(file.path, undefined, file.storage).catch((error) => {
            throw new Error(`历史文件无法读取，迁移已停止：id=${file.id} storage=${file.storage} path=${file.path} cause=${String(error)}`);
        });
        await blobs.insert({
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
        } as PhysicalBlob).catch(async () => {
            if (!(await blobs.exist({ where: { checksum: file.checksum } }))) throw new Error(`创建物理文件记录失败：${file.checksum}`);
        });
    }
    await reconcileBlobRefCounts();
    for (const file of await repo(StoredFile).find()) {
        if (!(await blobs.exist({ where: { checksum: file.checksum } }))) throw new Error(`文件迁移校验失败：${file.id} 没有物理对象记录`);
    }
}

export async function reconcileBlobRefCounts() {
    const blobs = repo(PhysicalBlob);
    for (const blob of await blobs.find()) {
        const count = await repo(StoredFile).countBy({ checksum: blob.checksum });
        await blobs.update(
            { checksum: blob.checksum },
            count
                ? { refCount: count, state: "active", pendingSince: "" }
                : { refCount: 0, state: "pending_delete", pendingSince: blob.pendingSince || now() },
        );
    }
}
