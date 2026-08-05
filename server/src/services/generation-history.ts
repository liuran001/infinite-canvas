import { In, Not, type EntityManager } from "typeorm";

import { repo, serialTransaction } from "../db/data-source";
import { GenerationOutput, Job, PhysicalBlob, StoredFile, type JobStatus } from "../db/entities";
import { fail, now } from "../lib/errors";
import { reconcileBlobReferences } from "./blob-gc";
import { withBlobLock } from "./files";
import { getSettings, type GenerationHistorySetting } from "./settings";

export type GenerationHistoryFileView = {
    id: string;
    kind: string;
    mimeType: string;
    bytes: number;
    width: number;
    height: number;
    durationMs: number;
    /** true 时历史任务仍在，但媒体文件已经按保留策略清除。 */
    cleared: boolean;
};

const TERMINAL_STATUSES: JobStatus[] = ["succeeded", "failed", "canceled"];
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function fileView(file: Pick<StoredFile, "id" | "kind" | "mimeType" | "bytes" | "width" | "height" | "durationMs">, cleared = false): GenerationHistoryFileView {
    return { id: file.id, kind: file.kind, mimeType: file.mimeType, bytes: Number(file.bytes), width: file.width, height: file.height, durationMs: file.durationMs, cleared };
}

function outputView(output: GenerationOutput): GenerationHistoryFileView {
    return { id: output.fileId, kind: output.kind, mimeType: output.mimeType, bytes: Number(output.bytes), width: output.width, height: output.height, durationMs: output.durationMs, cleared: Boolean(output.clearedAt) };
}

/**
 * 任务完成后给每个产出加一条“不计配额”的历史引用。物理字节仍由 checksum 全局去重，
 * 同图被多个用户、画布克隆或多条任务引用时只会增加逻辑引用，不会再写一份对象。
 */
export async function archiveJobOutputsWithManager(manager: EntityManager, job: Job, strict = false) {
    const ids = [...new Set(job.outputFileIds || [])];
    if (!ids.length) return [];
    const files = await manager.getRepository(StoredFile).findBy({ id: In(ids) });
    if (strict && files.length !== ids.length) throw new Error(`任务 ${job.id} 的生成文件在归档前丢失`);
    const existing = new Set((await manager.getRepository(GenerationOutput).findBy({ jobId: job.id })).map((output) => output.fileId));
    const rows = files
        .filter((file) => !existing.has(file.id))
        .map((file) => ({
            jobId: job.id,
            fileId: file.id,
            checksum: file.checksum,
            kind: file.kind,
            mimeType: file.mimeType,
            bytes: Number(file.bytes),
            width: file.width,
            height: file.height,
            durationMs: file.durationMs,
            clearedAt: "",
            createdAt: job.finishedAt || job.createdAt || now(),
        }));
    if (!rows.length) return [];
    // Postgres 一旦撞唯一约束，哪怕 catch 住事务也已失败；orIgnore 才能安全处理多实例 backfill 竞争。
    await manager.createQueryBuilder().insert().into(GenerationOutput).values(rows).orIgnore().execute();
    const checksums = new Set(rows.map((row) => row.checksum));
    for (const checksum of checksums) {
        const attached = await manager
            .getRepository(PhysicalBlob)
            .createQueryBuilder()
            .update()
            .set({ state: "active", deleteToken: "", pendingSince: "" })
            .where("checksum = :checksum", { checksum })
            .andWhere("state IN (:...states)", { states: ["active", "pending_delete"] })
            .execute();
        if (!attached.affected) throw new Error(`任务 ${job.id} 的物理文件正在回收`);
    }
    return [...checksums];
}

export async function archiveJobOutputs(job: Job) {
    const checksums = await serialTransaction(async (manager) => {
        const current = await manager.getRepository(Job).findOneBy({ id: job.id });
        if (!current || !TERMINAL_STATUSES.includes(current.status)) return [];
        return archiveJobOutputsWithManager(manager, current);
    });
    for (const checksum of checksums) await withBlobLock(checksum, () => reconcileBlobReferences(checksum));
}

/** 存量任务启动时补建历史引用，保证升级前已经生成的媒体也遵循新规则。 */
export async function backfillGenerationOutputs() {
    const rows = await repo(Job).find({ where: { status: In(TERMINAL_STATUSES) }, order: { createdAt: "ASC" } });
    for (const row of rows) {
        if (row.outputFileIds?.length) await archiveJobOutputs(row);
    }
}

/**
 * 生成历史里的文件视图。优先使用仍在云空间的 StoredFile；用户已经删除时退回历史引用；
 * 两边都没有媒体引用则返回 cleared 占位，任务本身与提示词、参数仍然保留。
 */
export async function generationOutputViews(job: Job) {
    const ids = job.outputFileIds || [];
    if (!ids.length) return [];
    const [files, history] = await Promise.all([repo(StoredFile).findBy({ id: In(ids) }), repo(GenerationOutput).findBy({ jobId: job.id })]);
    const byFile = new Map(files.map((file) => [file.id, file]));
    const byHistory = new Map(history.map((output) => [output.fileId, output]));
    return ids.map((id) => {
        const file = byFile.get(id);
        if (file) return fileView(file);
        const output = byHistory.get(id);
        if (output) return outputView(output);
        return { id, kind: job.kind, mimeType: "", bytes: 0, width: 0, height: 0, durationMs: 0, cleared: true } satisfies GenerationHistoryFileView;
    });
}

/** 文件直链在 StoredFile 已删除时从仍有效的历史引用读取同一物理对象。 */
export async function generationOutputObject(fileId: string) {
    const output = await repo(GenerationOutput).findOne({ where: { fileId, clearedAt: "" }, order: { createdAt: "DESC" } });
    if (!output) return null;
    const blob = await repo(PhysicalBlob).findOneBy({ checksum: output.checksum });
    if (!blob || blob.state !== "active") return null;
    return {
        id: output.fileId,
        kind: output.kind,
        mimeType: output.mimeType,
        bytes: Number(output.bytes),
        width: output.width,
        height: output.height,
        durationMs: output.durationMs,
        storage: blob.storage,
        path: blob.path,
    };
}

async function clearOutput(output: GenerationOutput, clearedAt: string) {
    if (output.clearedAt) return;
    await withBlobLock(output.checksum, async () => {
        const updated = await repo(GenerationOutput).update({ jobId: output.jobId, fileId: output.fileId, clearedAt: "" }, { clearedAt });
        if (updated.affected) await reconcileBlobReferences(output.checksum);
    });
}

/** 删除一条总历史只动 Job 与历史引用，仍在云空间中的 StoredFile 永远不受影响。 */
export async function deleteGenerationHistoryJob(jobId: string) {
    const outputs = await serialTransaction(async (manager) => {
        const rows = await manager.getRepository(GenerationOutput).findBy({ jobId });
        await manager.getRepository(GenerationOutput).delete({ jobId });
        await manager.getRepository(Job).delete({ id: jobId });
        return rows;
    });
    for (const checksum of new Set(outputs.filter((output) => !output.clearedAt).map((output) => output.checksum))) {
        await withBlobLock(checksum, () => reconcileBlobReferences(checksum));
    }
}

/** 账号历史页只能删除本人账号任务，或写入本人云空间的分享任务；运行中的任务必须先取消。 */
export async function deleteUserGenerationHistoryJob(userId: string, jobId: string) {
    const job = await repo(Job).findOne({
        where: [
            { id: jobId, userId, shareId: "" },
            { id: jobId, storageUserId: userId, shareId: Not("") },
        ],
    });
    if (!job) throw fail("任务不存在");
    if (!TERMINAL_STATUSES.includes(job.status)) throw fail("任务仍在执行中，请先取消任务", 409, "JOB_NOT_TERMINAL");
    await deleteGenerationHistoryJob(job.id);
}

function imageExpired(setting: GenerationHistorySetting, job: Job, imageRank: number, at: Date) {
    const conditions: boolean[] = [];
    if (setting.imageRetentionDays > 0) {
        const timestamp = Date.parse(job.finishedAt || job.createdAt);
        conditions.push(Number.isFinite(timestamp) && timestamp <= at.getTime() - setting.imageRetentionDays * 24 * 60 * 60 * 1000);
    }
    if (setting.imageRetentionCount > 0) conditions.push(imageRank > setting.imageRetentionCount);
    if (!conditions.length) return false;
    return setting.imageRetentionStrategy === "max" ? conditions.every(Boolean) : conditions.some(Boolean);
}

function historyOwner(job: Job) {
    return job.storageUserId || job.userId;
}

/**
 * 清理顺序：先按总历史上限删除整条任务，再只处理仍保留任务里的图片媒体。
 * 图片即使超时/超条数，只要对应 StoredFile 仍在用户云空间就绝不清理。
 */
export async function cleanupGenerationHistory(override?: GenerationHistorySetting, at = new Date()) {
    const setting = override || (await getSettings()).private.generationHistory;
    const terminal = await repo(Job).find({ where: { status: In(TERMINAL_STATUSES) }, order: { createdAt: "DESC" } });

    if (setting.totalLimit > 0) {
        const counts = new Map<string, number>();
        for (const job of terminal) {
            const owner = historyOwner(job);
            const count = (counts.get(owner) || 0) + 1;
            counts.set(owner, count);
            if (count > setting.totalLimit) await deleteGenerationHistoryJob(job.id);
        }
    }

    const remaining = (await repo(Job).find({ where: { status: In(TERMINAL_STATUSES), kind: "image" }, order: { createdAt: "DESC" } }));
    const allOutputs = remaining.length ? await repo(GenerationOutput).findBy({ jobId: In(remaining.map((job) => job.id)) }) : [];
    if (!allOutputs.length) return;
    const outputs = allOutputs.filter((output) => !output.clearedAt);
    if (!outputs.length) return;
    const retainedKeys = new Set(outputs.map((output) => `${output.jobId}\0${output.fileId}`));
    const ownerRanks = new Map<string, number>();
    const outputRanks = new Map<string, number>();
    for (const job of remaining) {
        const owner = historyOwner(job);
        for (const fileId of [...new Set(job.outputFileIds || [])]) {
            const key = `${job.id}\0${fileId}`;
            if (!retainedKeys.has(key)) continue;
            const rank = (ownerRanks.get(owner) || 0) + 1;
            ownerRanks.set(owner, rank);
            outputRanks.set(key, rank);
        }
    }
    const jobById = new Map(remaining.map((job) => [job.id, job]));
    const owners = [...new Set(remaining.map(historyOwner).filter(Boolean))];
    const checksums = [...new Set(outputs.map((output) => output.checksum).filter(Boolean))];
    const stored = owners.length && checksums.length ? await repo(StoredFile).findBy({ userId: In(owners), checksum: In(checksums) }) : [];
    const storedContent = new Set(stored.map((file) => `${file.userId}\0${file.checksum}`));
    const clearedAt = at.toISOString();
    for (const output of outputs) {
        const job = jobById.get(output.jobId);
        // 用户删除原 fileId 后可能又上传了完全相同的内容；云空间是否仍持有图片应按
        // 「历史归属人 + checksum」判断，不能把新的 fileId 当成已经彻底删除。
        if (job && output.checksum && storedContent.has(`${historyOwner(job)}\0${output.checksum}`)) continue;
        if (!job || !imageExpired(setting, job, outputRanks.get(`${output.jobId}\0${output.fileId}`) || 0, at)) continue;
        await clearOutput(output, clearedAt);
    }
}

export async function startGenerationHistoryCleanup() {
    await backfillGenerationOutputs();
    await cleanupGenerationHistory();
    const timer = setInterval(() => void cleanupGenerationHistory().catch((error) => console.error("generation history cleanup failed:", error)), CLEANUP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

export async function requireGenerationOutputObject(fileId: string) {
    const output = await generationOutputObject(fileId);
    if (!output) throw fail("文件不存在", 404);
    return output;
}
