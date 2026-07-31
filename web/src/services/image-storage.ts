import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "@/lib/image-utils";
import { serverApi, serverFileUrl } from "@/services/api/server";
import { isServerMode } from "@/stores/use-server-store";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

/** 服务器模式下的 storageKey 前缀，其余情况沿用本地 image: 前缀。 */
const SERVER_PREFIX = "server:";
const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const objectUrls = new Map<string, string>();

export function serverStorageKey(fileId: string) {
    return `${SERVER_PREFIX}${fileId}`;
}

export function serverFileIdOf(storageKey?: string) {
    return storageKey?.startsWith(SERVER_PREFIX) ? storageKey.slice(SERVER_PREFIX.length) : "";
}

export function isServerStorageKey(storageKey?: string) {
    return Boolean(storageKey?.startsWith(SERVER_PREFIX));
}

async function toBlob(input: string | Blob) {
    return typeof input === "string" ? (await fetch(input)).blob() : input;
}

/**
 * 服务器模式直接把图片存到服务端并引用直链，
 * 本地模式仍然落 localforage，两种模式的返回结构保持一致。
 */
export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    const blob = await toBlob(input);
    const localUrl = URL.createObjectURL(blob);
    const meta = await readImageMeta(localUrl);
    const mimeType = blob.type || meta.mimeType;

    if (isServerMode()) {
        try {
            const file = await serverApi.uploadFile(blob, { width: meta.width, height: meta.height, filename: `image.${mimeType.split("/")[1] || "png"}` });
            URL.revokeObjectURL(localUrl);
            return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), width: file.width || meta.width, height: file.height || meta.height, bytes: file.bytes || blob.size, mimeType: file.mimeType || mimeType };
        } catch {
            // 上传失败时退回本地保存，避免刚生成的图片直接丢失。
        }
    }

    const storageKey = `image:${nanoid()}`;
    await store.setItem(storageKey, blob);
    objectUrls.set(storageKey, localUrl);
    return { url: localUrl, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType };
}

/** 已经在服务端的文件直接登记引用，不重复上传。 */
export function adoptServerImage(file: { id: string; mimeType: string; bytes: number; width: number; height: number }): UploadedImage {
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), width: file.width, height: file.height, bytes: file.bytes, mimeType: file.mimeType };
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    const fileId = serverFileIdOf(storageKey);
    if (fileId) return serverFileUrl(fileId);
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    const fileId = serverFileIdOf(storageKey);
    if (fileId) return fetch(serverFileUrl(fileId)).then((response) => (response.ok ? response.blob() : null));
    return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    if (isServerStorageKey(storageKey)) return serverFileUrl(serverFileIdOf(storageKey));
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const fileId = serverFileIdOf(key);
            if (fileId) return serverApi.deleteFile(fileId).catch(() => undefined);
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

/** 只清理本地缓存条目，服务端文件由用户显式删除素材或画布时回收。 */
export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && (value.storageKey.startsWith("image:") || value.storageKey.startsWith(SERVER_PREFIX))) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}
