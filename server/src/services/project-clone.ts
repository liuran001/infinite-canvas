import type { EntityManager } from "typeorm";

import { dataSource, repo } from "../db/data-source";
import { DEFAULT_STORAGE_QUOTA, PhysicalBlob, Project, ProjectShare, StoredFile, User } from "../db/entities";
import { CLONE_DISABLED, fail, FORBIDDEN, newId, now, QUOTA_EXCEEDED } from "../lib/errors";
import { withBlobLock } from "./files";
import { logShareAccess, shareUsable } from "./project-share";

/** 画布与素材里的文件引用一律是 server:<fileId>，克隆时按同一套规则扫描并重写。 */
const FILE_REFERENCE = /server:(file-[\w-]+)/g;
const column = (name: string) => dataSource.driver.escape(name);

function mb(bytes: number) {
    return `${(bytes / (1 << 20)).toFixed(1)}MB`;
}

async function usedBytesIn(manager: EntityManager, userId: string) {
    const row = await manager.getRepository(StoredFile).createQueryBuilder("file").select("SUM(file.bytes)", "total").where("file.userId = :userId", { userId }).getRawOne<{ total: string | number | null }>();
    return Number(row?.total || 0);
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

    const cloned = await dataSource.transaction(async (manager) => {
        const source = await manager.getRepository(Project).findOneBy({ userId: share.ownerId, projectId: share.projectId });
        if (!source || source.deleted) throw fail("画布项目不存在", 404, "PROJECT_NOT_FOUND");

        const sourceIds = [...new Set(Array.from((source.data || "").matchAll(FILE_REFERENCE), (matched) => matched[1]))];
        const files = manager.getRepository(StoredFile);
        const mapping = new Map<string, string>();
        const created: StoredFile[] = [];
        let incoming = 0;
        for (const sourceId of sourceIds) {
            // 只认属于画布所有者的文件：画布数据是 editor 访客能改的，
            // 不限归属的话，往里塞一个别人的 fileId 就能在自己账号下建出指向他人文件的引用。
            const file = await files.findOneBy({ id: sourceId, userId: share.ownerId });
            if (!file) continue;
            // 克隆者已经有同一份内容时直接复用自己的引用，不给同一内容再记一次账。
            const owned = file.checksum ? await files.findOneBy({ userId: clonerId, checksum: file.checksum }) : null;
            if (owned) {
                mapping.set(sourceId, owned.id);
                continue;
            }
            const copy = files.create({ ...file, id: newId("file"), userId: clonerId, bytes: Number(file.bytes), createdAt: now() });
            mapping.set(sourceId, copy.id);
            created.push(copy);
            incoming += Number(file.bytes);
        }

        // 副本按克隆者的配额计费，不足就整体回滚，不能把半份画布留在他账号里。
        const used = await usedBytesIn(manager, clonerId);
        const quota = Number((await manager.getRepository(User).findOneBy({ id: clonerId }))?.storageQuota ?? DEFAULT_STORAGE_QUOTA);
        if (used + incoming > quota) throw fail(`云空间不足：已用 ${mb(used)} / ${mb(quota)}，本次需要 ${mb(incoming)}`, 403, QUOTA_EXCEEDED);

        for (const copy of created) {
            await files.insert(copy);
            if (!copy.checksum) continue;
            await manager
                .getRepository(PhysicalBlob)
                .createQueryBuilder()
                .update()
                .set({ refCount: () => `${column("refCount")} + 1`, state: "active", pendingSince: "" })
                .where("checksum = :checksum", { checksum: copy.checksum })
                .execute();
        }

        const project = manager.getRepository(Project).create({
            userId: clonerId,
            projectId: newId("project"),
            // 标题列是 varchar(255)，拼完后必须裁一刀，否则 MySQL/Postgres 上一个长标题就能让整次克隆失败。
            title: `${source.title || "未命名画布"}的副本`.slice(0, 255),
            data: (source.data || "").replace(FILE_REFERENCE, (matched, id: string) => (mapping.has(id) ? `server:${mapping.get(id)}` : matched)),
            revision: 1,
            deleted: false,
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
            const actual = await repo(StoredFile).countBy({ checksum });
            if (actual > 0) await repo(PhysicalBlob).update({ checksum }, { refCount: actual, state: "active", pendingSince: "" });
        });
    }

    await logShareAccess(share, { actorId: clonerId, isAnonymous: false, event: "clone", ip: meta.ip, userAgent: meta.userAgent });
    return { id: cloned.project.projectId, title: cloned.project.title, revision: cloned.project.revision };
}
