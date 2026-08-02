import { repo } from "../db/data-source";
import { AgentMessage, Job, Project, UserAsset } from "../db/entities";
import { deleteFile } from "./files";

/** 画布与素材里的文件引用一律是 server:<fileId>，直接从 JSON 文本里扫出来比对。 */
const FILE_REFERENCE = /server:(file-[\w-]+)/g;

function fileIdsIn(data: string) {
    return new Set(Array.from(data.matchAll(FILE_REFERENCE), (matched) => matched[1]));
}

/**
 * 回收一份被删数据引用的文件：仍被该用户其它画布或素材引用的留下，
 * 彻底没人用的连记录带对象一起删掉，云空间用量随之下降。
 */
export async function releaseFiles(userId: string, data: string) {
    const ids = fileIdsIn(data || "");
    if (!ids.size) return;
    const [projects, assets, jobs, messages] = await Promise.all([
        repo(Project).findBy({ userId, deleted: false }),
        repo(UserAsset).findBy({ userId, deleted: false }),
        repo(Job).findBy({ userId }),
        repo(AgentMessage).findBy({ userId }),
    ]);
    const kept = fileIdsIn([
        ...projects.map((row) => row.data || ""),
        ...assets.map((row) => row.data || ""),
        ...messages.map((row) => `${row.content || ""}\n${row.toolResult || ""}\n${JSON.stringify(row.references || [])}`),
    ].join("\n"));
    jobs.forEach((job) => [...(job.inputFileIds || []), ...(job.outputFileIds || [])].forEach((id) => kept.add(id)));
    messages.forEach((message) => (message.attachments || []).forEach((id) => kept.add(id)));
    for (const id of ids) if (!kept.has(id)) await deleteFile(id, userId).catch(() => undefined);
}
