import { prepareImageForUpload } from "@/lib/image-transcode";
import { readImageMeta } from "@/lib/image-utils";
import { serverFileUrl } from "@/services/api/server";
import { shareApi } from "@/services/api/share";
import { serverStorageKey } from "@/services/image-storage";
import { useShareStore } from "@/stores/use-share-store";
import type { UploadedImage } from "@/services/image-storage";

/**
 * 分享态的图片上传。与 image-storage.uploadImage 的转码、宽高与 storageKey 约定完全一致，
 * 唯一的区别是走分享通道：带 guest 令牌与 projectId，让服务端把文件记在画布所有者名下并单独限流。
 *
 * 刻意不去改 uploadImage 加一个「分享模式」开关：那条路径上的 401 会清掉账号会话，
 * 分享页哪怕只有一个分支走进去，一次上传失败就能把访客从自己的账号里踢出去。
 */
export async function uploadShareImage(input: string | Blob): Promise<UploadedImage> {
    const { guestToken, project, role, status } = useShareStore.getState();
    if (role !== "editor" || status !== "ready" || !guestToken || !project) throw new Error("当前分享链接不允许上传");
    const source = typeof input === "string" ? await (await fetch(input)).blob() : input;
    const blob = await prepareImageForUpload(source);
    const localUrl = URL.createObjectURL(blob);
    const meta = await readImageMeta(localUrl);
    URL.revokeObjectURL(localUrl);
    const mimeType = blob.type || meta.mimeType;
    const file = await shareApi.uploadFile(project.id, guestToken, blob, { width: meta.width, height: meta.height, filename: `image.${mimeType.split("/")[1] || "png"}` });
    return { url: serverFileUrl(file.id), storageKey: serverStorageKey(file.id), width: file.width || meta.width, height: file.height || meta.height, bytes: file.bytes || blob.size, mimeType: file.mimeType || mimeType };
}
