import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 生成历史专项验证：历史媒体不计用户云空间、全局物理去重、保留策略只清理已从云空间删除的图片，
 * 以及最后一个云空间/历史引用消失后物理对象才进入回收。
 * 用法：cd server && npx tsx verify-generation-history.ts
 */
const env = prepareEnv("verify-generation-history");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { GenerationOutput, Job, PhysicalBlob, StoredFile, User } = await import("./src/db/entities");
    const { deleteFile, saveFile } = await import("./src/services/files");
    const { collectPendingBlobs, reconcileBlobReferences } = await import("./src/services/blob-gc");
    const { usedBytes } = await import("./src/services/quota");
    const { archiveJobOutputs, cleanupGenerationHistory, deleteGenerationHistoryJob, deleteUserGenerationHistoryJob, generationOutputObject, requireGenerationOutputObject } = await import("./src/services/generation-history");
    const { listJobsPage, toJobView } = await import("./src/services/jobs");
    const { newId, now } = await import("./src/lib/errors");

    await initDatabase();
    const users = repo(User);
    const jobs = repo(Job);
    const outputs = repo(GenerationOutput);
    const blobs = repo(PhysicalBlob);
    const statusOf = (work: () => Promise<unknown>) => work().then(() => 200, (error: { status?: number }) => error?.status || 500);

    const makeUser = (id: string) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits: 100, storageQuota: 1 << 30, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const makeJob = async (userId: string, fileId: string, createdAt: string) =>
        jobs.save({
            id: newId("job"),
            userId,
            storageUserId: userId,
            payerUserId: userId,
            shareId: "",
            clientJobId: newId("client"),
            kind: "image",
            status: "succeeded",
            model: "image-model",
            prompt: "test",
            params: "{}",
            inputFileIds: [],
            outputFileIds: [fileId],
            text: "",
            context: {},
            error: "",
            credits: 1,
            progress: 100,
            seq: 1,
            upstreamTaskId: "",
            payerKind: "user",
            payerTeamId: "",
            payerLogId: "",
            storageTeamId: "",
            createdAt,
            updatedAt: createdAt,
            finishedAt: createdAt,
        } as Job);

    await makeUser("owner-a");
    await makeUser("owner-b");
    const body = Buffer.from("same generated image bytes");
    const first = await saveFile("owner-a", body, "image/png");
    const duplicate = await saveFile("owner-a", body, "image/png");
    const cloned = await saveFile("owner-b", body, "image/png");
    check("同一用户相同图片复用同一文件记录", duplicate.id, first.id);
    check("跨用户相同图片只存一个物理对象", await blobs.count(), 1);
    check("跨用户仍保留各自独立的云空间引用", await repo(StoredFile).count(), 2);

    const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const firstJob = await makeJob("owner-a", first.id, oldAt);
    const clonedJob = await makeJob("owner-b", cloned.id, oldAt);
    await archiveJobOutputs(firstJob);
    await archiveJobOutputs(clonedJob);
    check("两个任务各自建立历史引用", await outputs.count(), 2);
    check("历史引用仍指向同一个 checksum", new Set((await outputs.find()).map((item) => item.checksum)).size, 1);

    const beforeDelete = await usedBytes("owner-a");
    await deleteFile(first.id, "owner-a");
    check("用户删除后个人云空间立即释放", await usedBytes("owner-a"), beforeDelete - body.length);
    check("删除云空间文件后历史图片仍可读取", Boolean(await generationOutputObject(first.id)), true);
    check("删除云空间文件后生成历史仍显示图片", (await toJobView(firstJob)).outputs[0]?.cleared, false);
    check("不存在的历史媒体返回 404", await statusOf(() => requireGenerationOutputObject("file-missing-history")), 404);

    await cleanupGenerationHistory(
        { totalLimit: 0, imageRetentionDays: 30, imageRetentionCount: 100, imageRetentionStrategy: "min" },
        new Date(),
    );
    check("超过保留期且云空间已删除时清理历史图片", (await outputs.findOneByOrFail({ jobId: firstJob.id, fileId: first.id })).clearedAt !== "", true);
    check("历史记录保留并标记图片已清除", (await toJobView(firstJob)).outputs[0]?.cleared, true);
    check("另一用户仍有云空间文件时绝不清理其历史图片", (await outputs.findOneByOrFail({ jobId: clonedJob.id, fileId: cloned.id })).clearedAt, "");
    check("另一用户引用存在时物理对象不会进入回收", (await blobs.findOneByOrFail({ checksum: cloned.checksum })).state, "active");

    console.log("同一存储所有者重传相同图片");
    await makeUser("reupload-owner");
    const reuploadBody = Buffer.from("same owner reuploaded image bytes");
    const originalUpload = await saveFile("reupload-owner", reuploadBody, "image/png");
    const reuploadJob = await makeJob("reupload-owner", originalUpload.id, oldAt);
    await archiveJobOutputs(reuploadJob);
    await deleteFile(originalUpload.id, "reupload-owner");
    const reuploaded = await saveFile("reupload-owner", reuploadBody, "image/png");
    check("删除后重传相同内容获得新的 fileId", reuploaded.id !== originalUpload.id, true);
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 30, imageRetentionCount: 100, imageRetentionStrategy: "min" }, new Date());
    check("同一所有者云空间仍有相同内容时不清历史媒体", (await outputs.findOneByOrFail({ jobId: reuploadJob.id, fileId: originalUpload.id })).clearedAt, "");

    await deleteFile(cloned.id, "owner-b");
    await cleanupGenerationHistory(
        { totalLimit: 0, imageRetentionDays: 30, imageRetentionCount: 100, imageRetentionStrategy: "min" },
        new Date(),
    );
    check("最后一个历史图片引用超期后也被清理", (await outputs.findOneByOrFail({ jobId: clonedJob.id, fileId: cloned.id })).clearedAt !== "", true);
    check("云空间与历史媒体引用都不存在后进入延迟回收", (await blobs.findOneByOrFail({ checksum: cloned.checksum })).state, "pending_delete");

    const fresh = await saveFile("owner-a", Buffer.from("fresh"), "image/png");
    const freshJob = await makeJob("owner-a", fresh.id, now());
    await archiveJobOutputs(freshJob);
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 1, imageRetentionCount: 1, imageRetentionStrategy: "min" }, new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));
    check("即使超过历史图片策略，云空间仍存在就不删除图片", (await outputs.findOneByOrFail({ jobId: freshJob.id, fileId: fresh.id })).clearedAt, "");

    await deleteGenerationHistoryJob(freshJob.id);
    check("删除总历史不会删除仍在用户云空间的文件", await repo(StoredFile).countBy({ id: fresh.id }), 1);
    check("删除总历史只移除对应历史引用", await outputs.countBy({ jobId: freshJob.id }), 0);

    console.log("总历史条数上限");
    await makeUser("history-limit");
    const limitAt = Date.now();
    const limitRows = [];
    for (const [label, offset] of [["oldest", 3], ["middle", 2], ["newest", 1]] as const) {
        const file = await saveFile("history-limit", Buffer.from(`history-limit-${label}`), "image/png");
        const job = await makeJob("history-limit", file.id, new Date(limitAt - offset * 60 * 60 * 1000).toISOString());
        await archiveJobOutputs(job);
        limitRows.push({ label, file, job });
    }
    await cleanupGenerationHistory({ totalLimit: 2, imageRetentionDays: 0, imageRetentionCount: 0, imageRetentionStrategy: "min" }, new Date(limitAt));
    check("总历史上限删除最旧任务", await jobs.countBy({ id: limitRows[0].job.id }), 0);
    check("总历史上限保留边界内两条", await jobs.countBy({ userId: "history-limit" }), 2);
    check("删除总历史同步移除对应媒体历史引用", await outputs.countBy({ jobId: limitRows[0].job.id }), 0);
    check("总历史超限不删除仍在云空间的图片", await repo(StoredFile).countBy({ id: limitRows[0].file.id }), 1);

    console.log("图片条数边界与 min/max 策略");
    await makeUser("count-boundary");
    const countRows = [];
    for (const [label, offset] of [["rank-3", 3], ["rank-2", 2], ["rank-1", 1]] as const) {
        const file = await saveFile("count-boundary", Buffer.from(`count-boundary-${label}`), "image/png");
        const job = await makeJob("count-boundary", file.id, new Date(limitAt - offset * 60 * 1000).toISOString());
        await archiveJobOutputs(job);
        await deleteFile(file.id, "count-boundary");
        countRows.push({ label, file, job });
    }
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 0, imageRetentionCount: 2, imageRetentionStrategy: "min" }, new Date(limitAt));
    check("图片条数第 1 条保留", (await outputs.findOneByOrFail({ jobId: countRows[2].job.id })).clearedAt, "");
    check("图片条数恰好等于上限时保留", (await outputs.findOneByOrFail({ jobId: countRows[1].job.id })).clearedAt, "");
    check("图片条数超过上限一条时清理", (await outputs.findOneByOrFail({ jobId: countRows[0].job.id })).clearedAt !== "", true);

    await makeUser("strategy-min");
    const minFile = await saveFile("strategy-min", Buffer.from("strategy-min-old"), "image/png");
    const minJob = await makeJob("strategy-min", minFile.id, new Date(limitAt - 40 * 24 * 60 * 60 * 1000).toISOString());
    await archiveJobOutputs(minJob);
    await deleteFile(minFile.id, "strategy-min");
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 30, imageRetentionCount: 100, imageRetentionStrategy: "min" }, new Date(limitAt));
    check("min 策略命中时间上限即可清理", (await outputs.findOneByOrFail({ jobId: minJob.id })).clearedAt !== "", true);

    await makeUser("strategy-max");
    const maxRows = [];
    for (const [label, offset] of [["older", 41], ["newer", 40]] as const) {
        const file = await saveFile("strategy-max", Buffer.from(`strategy-max-${label}`), "image/png");
        const job = await makeJob("strategy-max", file.id, new Date(limitAt - offset * 24 * 60 * 60 * 1000).toISOString());
        await archiveJobOutputs(job);
        await deleteFile(file.id, "strategy-max");
        maxRows.push({ file, job });
    }
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 30, imageRetentionCount: 1, imageRetentionStrategy: "max" }, new Date(limitAt));
    check("max 策略只超时间但未超条数时保留", (await outputs.findOneByOrFail({ jobId: maxRows[1].job.id })).clearedAt, "");
    check("max 策略同时超时间和条数时清理", (await outputs.findOneByOrFail({ jobId: maxRows[0].job.id })).clearedAt !== "", true);

    console.log("多图条数按图片而不是任务计算");
    await makeUser("multi-image-count");
    const multiRows = [];
    for (const [label, offset] of [["older", 2], ["newer", 1]] as const) {
        const files = await Promise.all([
            saveFile("multi-image-count", Buffer.from(`multi-image-${label}-a`), "image/png"),
            saveFile("multi-image-count", Buffer.from(`multi-image-${label}-b`), "image/png"),
        ]);
        const job = await makeJob("multi-image-count", files[0].id, new Date(limitAt - offset * 60 * 1000).toISOString());
        job.outputFileIds = files.map((file) => file.id);
        await jobs.update({ id: job.id }, { outputFileIds: job.outputFileIds });
        await archiveJobOutputs(job);
        for (const file of files) await deleteFile(file.id, "multi-image-count");
        multiRows.push({ files, job });
    }
    await cleanupGenerationHistory({ totalLimit: 0, imageRetentionDays: 0, imageRetentionCount: 2, imageRetentionStrategy: "min" }, new Date(limitAt));
    check("最新任务的两张图片占满两条保留名额", (await outputs.findBy({ jobId: multiRows[1].job.id })).every((output) => !output.clearedAt), true);
    check("更旧任务的两张图片都超过图片条数上限", (await outputs.findBy({ jobId: multiRows[0].job.id })).every((output) => Boolean(output.clearedAt)), true);

    console.log("任务与历史归档一致性");
    await makeUser("archive-consistency");
    const orphanFile = await saveFile("archive-consistency", Buffer.from("orphan-output"), "image/png");
    const deletedBeforeArchive = await makeJob("archive-consistency", orphanFile.id, now());
    await jobs.delete({ id: deletedBeforeArchive.id });
    await archiveJobOutputs(deletedBeforeArchive);
    check("任务已删除时归档不会创建永久孤儿", await outputs.countBy({ jobId: deletedBeforeArchive.id }), 0);

    const cascadeFile = await saveFile("archive-consistency", Buffer.from("cascade-output"), "image/png");
    const cascadeJob = await makeJob("archive-consistency", cascadeFile.id, now());
    await archiveJobOutputs(cascadeJob);
    await jobs.delete({ id: cascadeJob.id });
    check("任务删除会级联删除生成历史引用", await outputs.countBy({ jobId: cascadeJob.id }), 0);

    console.log("生成历史稳定分页");
    await makeUser("history-pagination");
    const pageAt = new Date(limitAt + 60_000).toISOString();
    const expectedIds: string[] = [];
    for (let index = 0; index < 205; index += 1) {
        const row = await makeJob("history-pagination", "", pageAt);
        expectedIds.push(row.id);
    }
    const seen: string[] = [];
    const pageSizes: number[] = [];
    let before = "";
    do {
        const page = await listJobsPage("history-pagination", ["succeeded"], before, 80);
        pageSizes.push(page.items.length);
        seen.push(...page.items.map((item) => item.id));
        before = page.nextBefore;
    } while (before);
    check("超过 200 条历史可循环拉完", seen.length, 205);
    check("分页边界没有重复任务", new Set(seen).size, 205);
    check("同毫秒任务按 id 稳定翻页", seen, [...expectedIds].sort().reverse());
    check("nextBefore 在最后一页归空", pageSizes, [80, 80, 45]);

    console.log("账号生成历史删除门禁");
    const deletingFile = await saveFile("history-pagination", Buffer.from("delete-history-file"), "image/png");
    const pendingHistory = await makeJob("history-pagination", deletingFile.id, now());
    await jobs.update({ id: pendingHistory.id }, { status: "running" });
    await rejects("运行中任务不能当历史删除", () => deleteUserGenerationHistoryJob("history-pagination", pendingHistory.id));
    await rejects("其他账号不能删除该历史", () => deleteUserGenerationHistoryJob("owner-a", pendingHistory.id));
    await jobs.update({ id: pendingHistory.id }, { status: "canceled" });
    await deleteUserGenerationHistoryJob("history-pagination", pendingHistory.id);
    check("终态账号任务可从历史删除", await jobs.countBy({ id: pendingHistory.id }), 0);
    check("删除历史不删除仍在云空间的文件", await repo(StoredFile).countBy({ id: deletingFile.id }), 1);

    console.log("跨实例引用对账收敛");
    await makeUser("reconcile-race");
    const reconcileFile = await saveFile("reconcile-race", Buffer.from("reconcile stale count"), "image/png");
    const fileRepo = repo(StoredFile);
    const originalCountBy = fileRepo.countBy;
    let firstCount = true;
    let markFirstRead!: () => void;
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => { markFirstRead = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    fileRepo.countBy = (async function (where) {
        const count = await originalCountBy.call(fileRepo, where);
        if (firstCount) {
            firstCount = false;
            markFirstRead();
            await firstRelease;
        }
        return count;
    }) as typeof fileRepo.countBy;
    const staleReconcile = reconcileBlobReferences(reconcileFile.checksum);
    await firstRead;
    try {
        await deleteFile(reconcileFile.id, "reconcile-race");
    } finally {
        releaseFirst();
    }
    await staleReconcile;
    fileRepo.countBy = originalCountBy;
    const reconciled = await blobs.findOneByOrFail({ checksum: reconcileFile.checksum });
    check("较旧的非零计数不能把零引用 blob 留在 active", reconciled.state, "pending_delete");
    check("交错对账后 refCount 收敛为零", reconciled.refCount, 0);
    await reconcileBlobReferences(reconcileFile.checksum);

    // GC 读到“还有 1 个引用”后，该引用可能在它写回 active 前被另一实例删掉。
    // 删除方看到 deleting 会放弃对账，因此 GC 自己必须在复活后再收敛一次，不能留下零引用 active。
    const collectRaceFile = await saveFile("reconcile-race", Buffer.from("collector stale count"), "image/png");
    await blobs.update({ state: "pending_delete" }, { pendingSince: new Date(Date.now() + 60_000).toISOString() });
    await blobs.update(
        { checksum: collectRaceFile.checksum },
        { refCount: 0, state: "pending_delete", deleteToken: "", pendingSince: new Date(Date.now() - 60_000).toISOString() },
    );
    let firstCollectCount = true;
    let markCollectRead!: () => void;
    let releaseCollectRead!: () => void;
    const collectRead = new Promise<void>((resolve) => { markCollectRead = resolve; });
    const collectRelease = new Promise<void>((resolve) => { releaseCollectRead = resolve; });
    fileRepo.countBy = (async function (where) {
        const count = await originalCountBy.call(fileRepo, where);
        if (firstCollectCount) {
            firstCollectCount = false;
            markCollectRead();
            await collectRelease;
        }
        return count;
    }) as typeof fileRepo.countBy;
    const collecting = collectPendingBlobs({ graceMs: 0 });
    await collectRead;
    await fileRepo.delete({ id: collectRaceFile.id });
    releaseCollectRead();
    await collecting;
    fileRepo.countBy = originalCountBy;
    const collectedRace = await blobs.findOneByOrFail({ checksum: collectRaceFile.checksum });
    check("GC 复活分支不会留下零引用 active blob", collectedRace.state, "pending_delete");
    check("GC 复活分支会把过期 refCount 收敛为零", collectedRace.refCount, 0);

    const sharedHistory = await makeJob("owner-a", "", now());
    await jobs.update({ id: sharedHistory.id }, { userId: "owner-a", storageUserId: "history-pagination", shareId: "history-share" });
    await deleteUserGenerationHistoryJob("history-pagination", sharedHistory.id);
    check("云空间所有者可删除协作者产生的分享历史", await jobs.countBy({ id: sharedHistory.id }), 0);

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
