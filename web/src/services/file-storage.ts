import { serverApi, serverFileUrl } from "@/services/api/server";
import { serverFileIdOf, serverStorageKey } from "@/services/image-storage";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

/** 视频、音频同样存到服务端并引用直链，直链支持 Range 请求，播放器可以正常拖动进度。 */
export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const localUrl = URL.createObjectURL(blob);
    const mimeType = blob.type || "application/octet-stream";
    const meta = mimeType.startsWith("video/") ? await readVideoMeta(localUrl) : mimeType.startsWith("audio/") ? await readAudioMeta(localUrl) : {};
    URL.revokeObjectURL(localUrl);
    const file = await serverApi.uploadFile(blob, { ...meta, filename: `${prefix}.${mimeType.split("/")[1] || "bin"}` });
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), bytes: file.bytes || blob.size, mimeType: file.mimeType || mimeType, ...meta };
}

export function adoptServerMedia(file: { id: string; mimeType: string; bytes: number; width: number; height: number; durationMs: number }): UploadedFile {
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), bytes: file.bytes, mimeType: file.mimeType, width: file.width || undefined, height: file.height || undefined, durationMs: file.durationMs || undefined };
}

export function resolveMediaUrl(storageKey?: string, fallback = "") {
    const fileId = serverFileIdOf(storageKey);
    return fileId ? serverFileUrl(fileId) : fallback;
}

export async function getMediaBlob(storageKey: string) {
    const fileId = serverFileIdOf(storageKey);
    if (!fileId) return null;
    return fetch(serverFileUrl(fileId)).then((response) => (response.ok ? response.blob() : null));
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys))
            .map(serverFileIdOf)
            .filter(Boolean)
            .map((fileId) => serverApi.deleteFile(fileId).catch(() => undefined)),
    );
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
