import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[]) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) return;
            const blob = await getMediaBlob(storageKey);
            if (!blob) return;
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, "我的资产.zip");
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    // 旧的 storageKey 在服务端无法复用，导入时重新上传文件，再把资产指向新的引用。
    const uploaded = new Map<string, { url: string; storageKey: string; bytes: number; mimeType: string }>();
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            uploaded.set(item.storageKey, item.mimeType.startsWith("image/") ? await uploadImage(typedBlob) : await uploadMediaFile(typedBlob, item.mimeType.split("/")[0] || "file"));
        }),
    );
    return data.assets.map((asset) => {
        const stored = asset.kind === "text" ? undefined : uploaded.get(asset.data.storageKey || "");
        if (!stored) return asset;
        const shared = { storageKey: stored.storageKey, bytes: stored.bytes, mimeType: stored.mimeType };
        if (asset.kind === "image") return { ...asset, coverUrl: stored.url, data: { ...asset.data, ...shared, dataUrl: stored.url } };
        return { ...asset, data: { ...asset.data, ...shared, url: stored.url } };
    });
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
