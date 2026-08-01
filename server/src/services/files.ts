import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import mime from "mime-types";

import { repo } from "../db/data-source";
import { StoredFile } from "../db/entities";
import { fail, newId, now } from "../lib/errors";
import { assertQuota } from "./quota";
import { deleteObject, putObject, useS3 } from "./storage";

const IMAGE_MAX_BYTES = 30 << 20;
const VIDEO_MAX_BYTES = 200 << 20;
const AUDIO_MAX_BYTES = 30 << 20;

export type FileMeta = { width?: number; height?: number; durationMs?: number };

export function fileKind(mimeType: string) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "other";
}

function maxBytes(kind: string) {
    if (kind === "image") return IMAGE_MAX_BYTES;
    if (kind === "video") return VIDEO_MAX_BYTES;
    if (kind === "audio") return AUDIO_MAX_BYTES;
    return IMAGE_MAX_BYTES;
}

function sizeMessage(kind: string) {
    if (kind === "video") return "视频超过大小限制，请使用 200MB 以内的文件";
    if (kind === "audio") return "音频超过大小限制，请使用 30MB 以内的文件";
    return "图片超过大小限制，请使用 30MB 以内的文件";
}

function objectKey(id: string, mimeType: string) {
    const extension = mime.extension(mimeType) || "bin";
    const date = new Date();
    return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}.${extension}`;
}

/** 图片宽高由服务端解析，视频/音频时长解析需要 ffprobe，交由上传方回传。 */
function readImageMeta(body: Buffer, mimeType: string): FileMeta {
    if (!mimeType.startsWith("image/")) return {};
    try {
        const size = imageSize(body);
        return { width: size.width, height: size.height };
    } catch {
        return {};
    }
}

/**
 * 按字节魔数认出图片格式，返回 image-size 的格式名（png / jpg / webp / gif / avif ...），认不出来返回空串。
 * 从外部地址下载的内容只能这样判断：URL 扩展名和响应头都是对方随便写的，
 * 一个改名成 .png 的 HTML 或可执行文件必须在落库之前就被认出来。
 */
export function imageTypeOf(body: Buffer) {
    try {
        return imageSize(body).type || "";
    } catch {
        return "";
    }
}

/**
 * 写入文件对象。相同内容（同 owner + 同 sha256）直接复用已有记录，
 * 避免同一张参考图反复上传占用存储；命中复用时不产生新增占用，因此不校验配额。
 */
export async function saveFile(userId: string, body: Buffer, mimeType: string, meta: FileMeta = {}) {
    const type = (mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
    const kind = fileKind(type);
    if (!body.length) throw fail("上传文件为空");
    if (body.length > maxBytes(kind)) throw fail(sizeMessage(kind));

    const files = repo(StoredFile);
    const checksum = createHash("sha256").update(body).digest("hex");
    const existing = await files.findOneBy({ userId, checksum });
    if (existing) return existing;
    await assertQuota(userId, body.length);

    const id = newId("file");
    const key = objectKey(id, type);
    await putObject(key, body, type);
    const imageMeta = readImageMeta(body, type);
    return files.save({
        id,
        userId,
        kind,
        mimeType: type,
        bytes: body.length,
        width: meta.width || imageMeta.width || 0,
        height: meta.height || imageMeta.height || 0,
        durationMs: meta.durationMs || 0,
        storage: useS3 ? "s3" : "local",
        path: key,
        checksum,
        createdAt: now(),
    } as StoredFile);
}

export async function saveFileFromDataUrl(userId: string, dataUrl: string, meta?: FileMeta) {
    const matched = /^data:([^;,]+)?(;base64)?,/.exec(dataUrl);
    if (!matched) throw fail("图片数据格式不正确");
    const payload = dataUrl.slice(matched[0].length);
    const body = matched[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    return saveFile(userId, body, matched[1] || "image/png", meta);
}

export async function saveFileFromUrl(userId: string, url: string, meta?: FileMeta) {
    if (url.startsWith("data:")) return saveFileFromDataUrl(userId, url, meta);
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) }).catch(() => {
        throw fail("下载生成结果失败");
    });
    if (!response.ok) throw fail(`下载生成结果失败：${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return saveFile(userId, body, response.headers.get("content-type") || "application/octet-stream", meta);
}

export async function getFile(id: string, userId?: string) {
    const file = await repo(StoredFile).findOneBy({ id });
    if (!file) throw fail("文件不存在");
    if (userId !== undefined && file.userId && file.userId !== userId) throw fail("无权访问该文件");
    return file;
}

export async function deleteFile(id: string, userId: string) {
    const file = await getFile(id, userId);
    await deleteObject(file.path);
    await repo(StoredFile).delete({ id });
}

export async function listFiles(userId: string, ids: string[]) {
    if (!ids.length) return [];
    const files = await repo(StoredFile).find({ where: ids.map((id) => ({ id })) });
    return files.filter((file) => !file.userId || file.userId === userId);
}

export function publicFileUrl(baseUrl: string, id: string) {
    return `${baseUrl}/api/files/${id}/content`;
}
