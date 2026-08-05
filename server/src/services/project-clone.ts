import { In, type EntityManager } from "typeorm";

import { dataSource, serialTransaction } from "../db/data-source";
import { DEFAULT_STORAGE_QUOTA, GenerationOutput, Job, PhysicalBlob, Project, ProjectShare, StoredFile, User } from "../db/entities";
import { CLONE_DISABLED, fail, FORBIDDEN, newId, now, QUOTA_EXCEEDED } from "../lib/errors";
import { reconcileBlobReferences } from "./blob-gc";
import { requireActiveAccounts } from "./account-fence";
import { withBlobLock } from "./files";
import { logShareAccess, shareUsable } from "./project-share";

/** 画布与素材里的文件引用一律是 server:<fileId>，克隆时按同一套规则扫描并重写。 */
const FILE_REFERENCE = /server:(file-[\w-]+)/g;
const column = (name: string) => dataSource.driver.escape(name);

function mb(bytes: number) {
    return `${(bytes / (1 << 20)).toFixed(1)}MB`;
}

/** 与 quota.usedBytesOf 同一套口径：团队文件占的是团队的空间，不能算进克隆者的个人用量。 */
async function usedBytesIn(manager: EntityManager, userId: string) {
    const rows = await manager
        .getRepository(StoredFile)
        .createQueryBuilder("file")
        .select("file.checksum", "checksum")
        .addSelect("MAX(file.bytes)", "bytes")
        .where("file.userId = :userId AND file.teamId = :teamId", { userId, teamId: "" })
        .groupBy("file.checksum")
        .getRawMany<{ checksum: string; bytes: string | number | null }>();
    return rows.reduce((total, row) => total + Number(row.bytes || 0), 0);
}

/**
 * 把分享的画布克隆成访客自己的一份。
 *
 * 整个流程必须在同一个事务里：先建文件记录再插画布，中途失败就会留下一堆没人引用的孤儿文件记录；
 * 反过来先插画布，失败时画布里指向的文件记录压根不存在，副本一打开就是一片破图。
 *
 * 底层对象一个字节都不复制，只给克隆者建新的 StoredFile 指向同一个 blob，靠引用计数保证
 * 源画布被删时不会把副本还在用的对象一起带走。
 */
export async function cloneSharedProject(share: ProjectShare, clonerId: string, meta: { ip?: string; userAgent?: string } = {}) {
    if (!clonerId) throw fail("请先登录再保存到自己的画布", 403, FORBIDDEN);
    if (!shareUsable(share)) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");
    if (!share.allowClone) throw fail("这条分享链接不允许保存副本", 403, CLONE_DISABLED);

    const cloned = await serialTransaction(async (manager) => {
        await requireActiveAccounts(manager, [clonerId, share.ownerId]);
        const source = await manager.getRepository(Project).findOneBy({ userId: share.ownerId, projectId: share.projectId });
        if (!source || source.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");

        const sourceIds = [...new Set(Array.from((source.data || "").matchAll(FILE_REFERENCE), (matched) => matched[1]))];
        const files = manager.getRepository(StoredFile);
        const sourceFiles = sourceIds.length ? await files.findBy({ id: In(sourceIds), userId: share.ownerId }) : [];
        const sources = new Map(sourceFiles.map((file) => [file.id, file]));
        const missingIds = sourceIds.filter((id) => !sources.has(id));
        if (missingIds.length) {
            const outputs = await manager.getRepository(GenerationOutput).findBy({ fileId: In(missingIds), clearedAt: "" });
            const jobs = outputs.length
                ? await manager.getRepository(Job).findBy({ id: In(outputs.map((output) => output.jobId)), storageUserId: share.ownerId })
                : [];
            const ownedJobIds = new Set(jobs.map((job) => job.id));
            const blobs = outputs.length
                ? await manager.getRepository(PhysicalBlob).findBy({ checksum: In([...new Set(outputs.map((output) => output.checksum))]) })
                : [];
            const blobsByChecksum = new Map(blobs.filter((blob) => blob.state !== "deleting").map((blob) => [blob.checksum, blob]));
            for (const output of outputs) {
                if (!ownedJobIds.has(output.jobId) || sources.has(output.fileId)) continue;
                const blob = blobsByChecksum.get(output.checksum);
                if (!blob) continue;
                sources.set(
                    output.fileId,
                    files.create({
                        id: output.fileId,
                        userId: share.ownerId,
                        teamId: "",
                        dedupeKey: "",
                        kind: output.kind,
                        mimeType: output.mimeType,
                        bytes: Number(output.bytes),
                        width: output.width,
                        height: output.height,
                        durationMs: output.durationMs,
                        storage: blob.storage,
                        path: blob.path,
                        checksum: output.checksum,
                        createdAt: output.createdAt,
                    }),
                );
            }
        }
        if (sourceIds.some((id) => !sources.has(id))) throw fail("画布包含已失效或无权访问的文件，无法保存副本");

        const mapping = new Map<string, string>();
        const created: StoredFile[] = [];
        const createdByChecksum = new Map<string, StoredFile>();
        let incoming = 0;
        for (const sourceId of sourceIds) {
            // 只认属于画布所有者的云文件，或由其生成历史仍持有的媒体；画布数据可由 editor 访客修改，
            // 外部账号的 fileId 和已经清除的历史都必须整次拒绝，不能原样留在副本里形成越权/延迟破图。
            const file = sources.get(sourceId)!;
            // 克隆者已经有同一份内容时直接复用自己的引用，不给同一内容再记一次账。
            // 只认克隆者个人名下的那一条：他在某个团队里有同一份内容，不代表这张个人副本能白用团队的空间。
            const owned = file.checksum ? await files.findOneBy({ userId: clonerId, dedupeKey: "", checksum: file.checksum }) : null;
            if (owned) {
                mapping.set(sourceId, owned.id);
                continue;
            }
            const pending = file.checksum ? createdByChecksum.get(file.checksum) : null;
            if (pending) {
                mapping.set(sourceId, pending.id);
                continue;
            }
            // teamId 显式清空：源文件可能挂在源画布的团队名下，照抄过来等于让访客往别人的团队空间里写东西，
            // 而副本本身是归个人的（下面建的 Project 也是 teamId: ""）。
            const copy = files.create({ ...file, id: newId("file"), userId: clonerId, teamId: "", dedupeKey: "", bytes: Number(file.bytes), createdAt: now() });
            mapping.set(sourceId, copy.id);
            created.push(copy);
            if (copy.checksum) createdByChecksum.set(copy.checksum, copy);
            incoming += Number(file.bytes);
        }

        // 副本按克隆者的配额计费，不足就整体回滚，不能把半份画布留在他账号里。
        const used = await usedBytesIn(manager, clonerId);
        const quota = Number((await manager.getRepository(User).findOneBy({ id: clonerId }))?.storageQuota ?? DEFAULT_STORAGE_QUOTA);
        if (used + incoming > quota) throw fail(`云空间不足：已用 ${mb(used)} / ${mb(quota)}，本次需要 ${mb(incoming)}`, 403, QUOTA_EXCEEDED);

        for (const copy of created) {
            await files.insert(copy);
            if (!copy.checksum) continue;
            const attached = await manager
                .getRepository(PhysicalBlob)
                .createQueryBuilder()
                .update()
                .set({ refCount: () => `${column("refCount")} + 1`, state: "active", deleteToken: "", pendingSince: "" })
                .where("checksum = :checksum", { checksum: copy.checksum })
                .andWhere("state IN (:...states)", { states: ["active", "pending_delete"] })
                .execute();
            if (!attached.affected) throw fail("文件正在回收，请稍后重试");
        }

        const project = manager.getRepository(Project).create({
            userId: clonerId,
            projectId: newId("project"),
            // 标题列是 varchar(255)，拼完后必须裁一刀，否则 MySQL/Postgres 上一个长标题就能让整次克隆失败。
            title: `${source.title || "未命名画布"}的副本`.slice(0, 255),
            data: (source.data || "").replace(FILE_REFERENCE, (matched, id: string) => (mapping.has(id) ? `server:${mapping.get(id)}` : matched)),
            revision: 1,
            deleted: false,
            // 副本归克隆者个人，绝不继承源画布的团队归属：访客不是那个团队的人，
            // 继承下来等于凭一条分享链接就在别人的团队池上开了个计费入口。
            teamId: "",
            createdAt: now(),
            updatedAt: now(),
        });
        await manager.getRepository(Project).insert(project);
        return { project, checksums: [...new Set(created.map((copy) => copy.checksum).filter(Boolean))] };
    });

    // 事务提交前，源用户删掉最后一个引用的话，deleteFile 的对账读不到我们这批未提交的副本，
    // 会把 blob 标成 pending_delete 等 GC 回收——副本刚建好就指向一个待删对象。
    // 提交后在同一把 checksum 锁里重新对账一次，把被误判的 blob 拉回 active。
    for (const checksum of cloned.checksums) {
        await withBlobLock(checksum, async () => {
            await reconcileBlobReferences(checksum);
        });
    }

    await logShareAccess(share, { actorId: clonerId, isAnonymous: false, event: "clone", ip: meta.ip, userAgent: meta.userAgent });
    return { id: cloned.project.projectId, title: cloned.project.title, revision: cloned.project.revision };
}
