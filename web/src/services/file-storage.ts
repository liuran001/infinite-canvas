import localforage from "localforage";
import { nanoid } from "nanoid";

import { serverApi, serverFileUrl } from "@/services/api/server";
import { isServerStorageKey, serverFileIdOf, serverStorageKey } from "@/services/image-storage";
import { isServerMode } from "@/stores/use-server-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const objectUrls = new Map<string, string>();

/**
 * 服务器模式下视频、音频同样存到服务端并引用直链，
 * 直链支持 Range 请求，播放器可以正常拖动进度。
 */
export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const localUrl = URL.createObjectURL(blob);
    const mimeType = blob.type || "application/octet-stream";
    const meta = mimeType.startsWith("video/") ? await readVideoMeta(localUrl) : mimeType.startsWith("audio/") ? await readAudioMeta(localUrl) : {};

    if (isServerMode()) {
        try {
            const file = await serverApi.uploadFile(blob, { ...meta, filename: `${prefix}.${mimeType.split("/")[1] || "bin"}` });
            URL.revokeObjectURL(localUrl);
            return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), bytes: file.bytes || blob.size, mimeType: file.mimeType || mimeType, ...meta };
        } catch {
            // 上传失败时退回本地保存，避免刚生成的素材直接丢失。
        }
    }

    const storageKey = `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    objectUrls.set(storageKey, localUrl);
    return { url: localUrl, storageKey, bytes: blob.size, mimeType, ...meta };
}

export function adoptServerMedia(file: { id: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number }): UploadedFile {
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), bytes: file.bytes, mimeType: file.mimeType, width: file.width || undefined, height: file.height || undefined, durationMs: file.durationMs || undefined };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
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

export async function getMediaBlob(storageKey: string) {
    const fileId = serverFileIdOf(storageKey);
    if (fileId) return fetch(serverFileUrl(fileId)).then((response) => (response.ok ? response.blob() : null));
    return store.getItem<Blob>(storageKey);
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    if (isServerStorageKey(storageKey)) return serverFileUrl(serverFileIdOf(storageKey));
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
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
export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await Promise.all(unused.map((key) => store.removeItem(key)));
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
