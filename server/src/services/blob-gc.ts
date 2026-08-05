import { In, LessThanOrEqual } from "typeorm";

import { repo } from "../db/data-source";
import { GenerationOutput, PhysicalBlob, StoredFile } from "../db/entities";
import { newId, now } from "../lib/errors";
import { withBlobLock } from "./files";
import { deleteObject } from "./storage";

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

export async function collectPendingBlobs({ graceMs = DEFAULT_GRACE_MS } = {}) {
    const cutoff = new Date(Date.now() - graceMs).toISOString();
    const blobs = repo(PhysicalBlob);
    // deleting 也要重试：进程可能已经删完对象、却在删数据库行之前退出。对象删除是幂等的，
    // 带同一个令牌重放后再删行，既不会留下永久卡住的墓碑，也不会碰后来恢复出来的新 path。
    const pending = await blobs.findBy({ state: In(["pending_delete", "deleting"]), pendingSince: LessThanOrEqual(cutoff) });
    for (const candidate of pending) {
        await withBlobLock(candidate.checksum, async () => {
            let blob = await blobs.findOneBy({ checksum: candidate.checksum });
            if (!blob || (blob.state !== "pending_delete" && blob.state !== "deleting")) return;
            let token = blob.deleteToken;
            if (blob.state === "pending_delete") {
                token = newId("gc");
                const claimed = await blobs.update(
                    { checksum: blob.checksum, state: "pending_delete", refCount: 0, pendingSince: LessThanOrEqual(cutoff) },
                    { state: "deleting", deleteToken: token, pendingSince: now() },
                );
                if (!claimed.affected) return;
                blob = (await blobs.findOneBy({ checksum: blob.checksum, state: "deleting", deleteToken: token }))!;
                if (!blob) return;
            } else if (!token) {
                // 旧版本可能留下没有令牌的 deleting；先认领再处理，后续恢复路径才能用 CAS 隔离。
                token = newId("gc");
                const claimed = await blobs.update({ checksum: blob.checksum, state: "deleting", deleteToken: "" }, { deleteToken: token, pendingSince: now() });
                if (!claimed.affected) return;
                blob.deleteToken = token;
            }
            const actual = await blobReferenceCount(blob.checksum);
            if (actual > 0) {
                const revived = await blobs.update({ checksum: blob.checksum, state: "deleting", deleteToken: token }, { refCount: actual, state: "active", deleteToken: "", pendingSince: "" });
                // 引用可能在上面的计数之后、写回 active 之前被另一实例删掉；删除方遇到 deleting 会停止对账，
                // 因此认领者复活成功后必须自己再按最新真实引用收敛一次，不能留下零引用 active 对象。
                if (revived.affected) await reconcileBlobReferences(blob.checksum);
                return;
            }
            try {
                await deleteObject(blob.path, blob.storage);
            } catch (error) {
                console.warn(`物理文件回收失败 ${blob.checksum}:`, error);
                await blobs.update({ checksum: blob.checksum, state: "deleting", deleteToken: token }, { state: "pending_delete", deleteToken: "", pendingSince: now() });
                return;
            }
            await blobs.delete({ checksum: blob.checksum, state: "deleting", deleteToken: token, refCount: 0 });
        });
    }
}

/**
 * 物理对象的真实引用数。云空间文件与仍可展示的生成历史共同持有引用；
 * 历史行即使保留，只要 clearedAt 非空就不再持有媒体对象。
 */
export async function blobReferenceCount(checksum: string) {
    const [files, history] = await Promise.all([repo(StoredFile).countBy({ checksum }), repo(GenerationOutput).countBy({ checksum, clearedAt: "" })]);
    return files + history;
}

/**
 * 每次引用增减后回库重算，避免跨用户去重、克隆与并发删除把 refCount 算漂。
 *
 * 进程内 checksum 锁挡不住另一个服务实例。若两个对账先后读到 1 和 0，较旧的 1 最后落库，
 * 就会把已经 pending_delete 的零引用对象重新留成 active。这里把读到的 state/refCount 当 CAS
 * 版本；引用或另一轮对账改过物理行时本轮重读，成功写入后再复核一次真实引用数。
 */
export async function reconcileBlobReferences(checksum: string) {
    const blobs = repo(PhysicalBlob);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const blob = await blobs.findOneBy({ checksum });
        const actual = await blobReferenceCount(checksum);
        // deleting 已拿到物理删除令牌，不能越过它改回 active；GC 会在真正删除前按同一口径复核。
        if (!blob || blob.state === "deleting") return actual;
        const target = actual > 0
            ? { refCount: actual, state: "active" as const, deleteToken: "", pendingSince: "" }
            : { refCount: 0, state: "pending_delete" as const, deleteToken: "", pendingSince: blob.state === "pending_delete" && blob.pendingSince ? blob.pendingSince : now() };
        if (blob.refCount === target.refCount && blob.state === target.state && blob.deleteToken === target.deleteToken && blob.pendingSince === target.pendingSince) return actual;
        const updated = await blobs.update({ checksum, state: blob.state, refCount: blob.refCount }, target);
        if (!updated.affected) continue;
        if ((await blobReferenceCount(checksum)) === actual) return actual;
    }
    // 极热内容持续变化时不无限占住当前请求；排到下一轮继续收敛，GC 自身仍会在物理删除前复核真实引用。
    const actual = await blobReferenceCount(checksum);
    const retry = setTimeout(() => void reconcileBlobReferences(checksum).catch((error) => console.error(`blob reference reconcile retry failed ${checksum}:`, error)), 0);
    retry.unref();
    return actual;
}

export function startBlobGarbageCollector() {
    void collectPendingBlobs();
    const timer = setInterval(() => void collectPendingBlobs(), 60_000);
    timer.unref();
    return () => clearInterval(timer);
}

export async function markBlobPending(checksum: string) {
    await repo(PhysicalBlob).update({ checksum, refCount: 0, state: "active" }, { state: "pending_delete", deleteToken: "", pendingSince: now() });
}

/** 有新引用要挂上来时把待回收 blob 拉回 active，GC 下一轮就不会再看它。 */
export async function reviveBlob(checksum: string) {
    return repo(PhysicalBlob).update({ checksum, state: "pending_delete" }, { state: "active", deleteToken: "", pendingSince: "" });
}
