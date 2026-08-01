import { Router } from "express";
import multer from "multer";

import { config } from "../config";
import { fail } from "../lib/errors";
import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { deleteFile, getFile, saveFile } from "../services/files";
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
 */
fileRouter.post(
    "/v1/files",
    userAuth,
    upload.single("file"),
    handle(async (req, res) => {
        const user = requireUser(req);
        if (!req.file) throw fail("请选择要上传的文件");
        const meta = {
            width: Number(req.body?.width) || undefined,
            height: Number(req.body?.height) || undefined,
            durationMs: Number(req.body?.durationMs) || undefined,
        };
        const file = await saveFile(user.id, req.file.buffer, req.file.mimetype, meta);
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
    const file = await getFile(String(req.params.id));
    const total = Number(file.bytes);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Accept-Ranges", "bytes");

    if (range && total) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
        if (start >= total || start > end) {
            res.status(416).setHeader("Content-Range", `bytes */${total}`);
            return res.end();
        }
        const object = await getObject(file.path, { start, end });
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        return object.stream.pipe(res);
    }

    const object = await getObject(file.path);
    if (object.bytes) res.setHeader("Content-Length", String(object.bytes));
    if (req.method === "HEAD") return res.end();
    return object.stream.pipe(res);
});

fileRouter.get("/files/:id/content", serveContent);
fileRouter.head("/files/:id/content", serveContent);

export function publicBaseUrlWarning() {
    if (config.publicBaseUrl) return;
    console.warn("WARNING: 未设置 PUBLIC_BASE_URL，参考素材将以 base64 形式提交给上游，体积较大的视频可能失败");
}
