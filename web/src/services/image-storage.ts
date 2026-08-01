import { prepareImageForUpload } from "@/lib/image-transcode";
import { readImageMeta } from "@/lib/image-utils";
import { serverApi, serverFileUrl } from "@/services/api/server";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

/** 图片、视频、音频统一存在服务端，storageKey 一律是 server:<fileId>。 */
const SERVER_PREFIX = "server:";

export function serverStorageKey(fileId: string) {
    return `${SERVER_PREFIX}${fileId}`;
}

export function serverFileIdOf(storageKey?: string) {
    return storageKey?.startsWith(SERVER_PREFIX) ? storageKey.slice(SERVER_PREFIX.length) : "";
}

export function isServerStorageKey(storageKey?: string) {
    return Boolean(storageKey?.startsWith(SERVER_PREFIX));
}

/** 上传到服务端并引用直链；失败直接抛错，由调用方提示用户。 */
export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const source = typeof input === "string" ? await (await fetch(input)).blob() : input;
    // 所有上传入口最终都走到这里，转码放在这一层，新增入口不用再各自处理一遍 HEIC。
    // 宽高、体积、MIME 一律按转码后的 blob 算：配额是按体积计的，沿用原文件会算错。
    const blob = await prepareImageForUpload(source);
    const localUrl = URL.createObjectURL(blob);
    const meta = await readImageMeta(localUrl);
    URL.revokeObjectURL(localUrl);
    const mimeType = blob.type || meta.mimeType;
    const file = await serverApi.uploadFile(blob, { width: meta.width, height: meta.height, filename: `image.${mimeType.split("/")[1] || "png"}` });
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), width: file.width || meta.width, height: file.height || meta.height, bytes: file.bytes || blob.size, mimeType: file.mimeType || mimeType };
}

/** 已经在服务端的文件直接登记引用，不重复上传。 */
export function adoptServerImage(file: { id: string; mimeType: string; bytes: number; width: number; height: number }): UploadedImage {
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), width: file.width, height: file.height, bytes: file.bytes, mimeType: file.mimeType };
}

export function resolveImageUrl(storageKey?: string, fallback = "") {
    const fileId = serverFileIdOf(storageKey);
    return fileId ? serverFileUrl(fileId) : fallback;
}

export async function getImageBlob(storageKey: string) {
    const fileId = serverFileIdOf(storageKey);
    if (!fileId) return null;
    return fetch(serverFileUrl(fileId)).then((response) => (response.ok ? response.blob() : null));
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || resolveImageUrl(image.storageKey, image.url || "");
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys))
            .map(serverFileIdOf)
            .filter(Boolean)
            .map((fileId) => serverApi.deleteFile(fileId).catch(() => undefined)),
    );
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
