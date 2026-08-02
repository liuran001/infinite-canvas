import { LessThanOrEqual } from "typeorm";

import { repo } from "../db/data-source";
import { PhysicalBlob, StoredFile } from "../db/entities";
import { now } from "../lib/errors";
import { withBlobLock } from "./files";
import { deleteObject } from "./storage";

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

export async function collectPendingBlobs({ graceMs = DEFAULT_GRACE_MS } = {}) {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const blobs = repo(PhysicalBlob);
    const pending = await blobs.findBy({ state: "pending_delete", pendingSince: LessThanOrEqual(cutoff) });
    for (const candidate of pending) {
        await withBlobLock(candidate.checksum, async () => {
            const blob = await blobs.findOneBy({ checksum: candidate.checksum });
            if (!blob || blob.state !== "pending_delete") return;
            const actual = await repo(StoredFile).countBy({ checksum: blob.checksum });
            if (actual > 0) {
                await blobs.update({ checksum: blob.checksum }, { refCount: actual, state: "active", pendingSince: "" });
                return;
            }
            try {
                await deleteObject(blob.path, blob.storage);
            } catch (error) {
                console.warn(`物理文件回收失败 ${blob.checksum}:`, error);
                return;
            }
            await blobs.delete({ checksum: blob.checksum, state: "pending_delete", refCount: 0 });
        });
    }
}

export function startBlobGarbageCollector() {
    void collectPendingBlobs();
    const timer = setInterval(() => void collectPendingBlobs(), 60_000);
    timer.unref();
    return () => clearInterval(timer);
}

export async function markBlobPending(checksum: string) {
    await repo(PhysicalBlob).update({ checksum, refCount: 0, state: "active" }, { state: "pending_delete", pendingSince: now() });
}
