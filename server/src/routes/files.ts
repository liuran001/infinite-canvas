import { Router } from "express";
import multer from "multer";

import { config } from "../config";
import { fail, SafeError } from "../lib/errors";
import { handle, ok } from "../lib/response";
import { accessContext, projectAuth, requireUser, userAuth } from "../middleware/auth";
import { deleteFile, getFile, saveFile, storedObjectOf } from "../services/files";
import { generationOutputObject } from "../services/generation-history";
import { resolveProjectAccess } from "../services/project-access";
import { assertShareUploadAllowed } from "../services/project-share";
import { storageOf } from "../services/quota";
import { getObject } from "../services/storage";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 << 20 } });

export const fileRouter = Router();

/** 当前用户的云空间用量，已用量按文件对象实时聚合。 */
fileRouter.get(
    "/v1/storage",
    userAuth,
    handle(async (req, res) => ok(res, await storageOf(requireUser(req).id))),
);

/**
 * 上传素材。宽高由服务端解析，视频/音频时长交由前端回传，
 * 相同内容会命中已有记录，重复上传不会产生多份文件。
 * 带 projectId 时按画布归属判权：分享访客传上来的图必须落在所有者名下，
 * 否则访客一走图就成了孤儿，所有者打开自己的画布只剩一片破图。
 */
fileRouter.post(
    "/v1/files",
    projectAuth,
    upload.single("file"),
    handle(async (req, res) => {
        if (!req.file) throw fail("请选择要上传的文件");
        const context = accessContext(req);
        const projectId = String(req.body?.projectId || "").trim() || context.guest?.projectId || "";
        const access = projectId || context.guest ? await resolveProjectAccess(context, projectId, "write") : null;
        const ownerId = access ? access.ownerId : requireUser(req).id;
        // 配额拦的是所有者的总空间，拦不住「拿分享链接当图床」，所以访客还要按 (分享, 访客) 单独限频。
        if (access?.share) assertShareUploadAllowed(access.share.id, access.actorId, req.file.size);
        const meta = {
            width: Number(req.body?.width) || undefined,
            height: Number(req.body?.height) || undefined,
            durationMs: Number(req.body?.durationMs) || undefined,
        };
        // 团队画布里传的图记团队的账，个人画布记所有者的账。归属取的是已经解析出来的那张画布，
        // 不读请求体里的 teamId：读了的话，一次夹带 teamId 的上传就能把文件塞进别人团队的空间。
        const file = await saveFile(ownerId, req.file.buffer, req.file.mimetype, meta, access?.project.teamId || "");
        ok(res, { id: file.id, kind: file.kind, mimeType: file.mimeType, bytes: Number(file.bytes), width: file.width, height: file.height, durationMs: file.durationMs });
    }),
);

fileRouter.get(
    "/v1/files/:id",
    userAuth,
    handle(async (req, res) => {
        const file = await getFile(String(req.params.id), requireUser(req).id);
        ok(res, { id: file.id, kind: file.kind, mimeType: file.mimeType, bytes: Number(file.bytes), width: file.width, height: file.height, durationMs: file.durationMs, createdAt: file.createdAt });
    }),
);

fileRouter.delete(
    "/v1/files/:id",
    userAuth,
    handle(async (req, res) => {
        await deleteFile(String(req.params.id), requireUser(req).id);
        ok(res, true);
    }),
);

/**
 * 文件内容直链。ID 是不可枚举的 UUID，这里不做鉴权，
 * 好让火山方舟等上游厂商能直接回源读取参考素材。
 */
const serveContent = handle(async (req, res) => {
    const id = String(req.params.id);
    let file = null;
    try {
        file = await getFile(id);
    } catch (error) {
        // 只有明确的“不存在”才能回退查历史引用；数据库/服务异常必须继续抛，不能伪装成 404。
        if (!(error instanceof SafeError) || error.status !== 404) throw error;
    }
    const archived = file ? null : await generationOutputObject(id);
    if (!file && !archived) throw fail("文件不存在", 404);
    const stored = file ? await storedObjectOf(file) : archived!;
    const meta = file || archived!;
    const total = Number(meta.bytes);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    res.setHeader("Content-Type", meta.mimeType);
    // 历史保留策略会让同一个 fileId 从可读变为 404，不能 immutable 一年；短缓存兼顾画布加载与及时清除。
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.method === "HEAD") {
        if (total) res.setHeader("Content-Length", String(total));
        return res.end();
    }

    if (range && total) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        if (start >= total || start > end) {
            res.status(416).setHeader("Content-Range", `bytes */${total}`);
            return res.end();
        }
        const object = await getObject(stored.path, { start, end }, stored.storage);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        return object.stream.pipe(res);
    }

    const object = await getObject(stored.path, undefined, stored.storage);
    if (object.bytes) res.setHeader("Content-Length", String(object.bytes));
    return object.stream.pipe(res);
});

fileRouter.get("/files/:id/content", serveContent);
fileRouter.head("/files/:id/content", serveContent);

export function publicBaseUrlWarning() {
    if (config.publicBaseUrl) return;
    console.warn("WARNING: 未设置 PUBLIC_BASE_URL，参考素材将以 base64 形式提交给上游，体积较大的视频可能失败");
}
