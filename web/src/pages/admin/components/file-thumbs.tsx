import { Image } from "antd";
import { ImageOff, Music, Video } from "lucide-react";

import { serverFileUrl } from "@/services/api/server";
import type { AdminFile } from "@/services/api/admin";

/** 只需要 id 与类型就能出图，画布节点也能直接复用。 */
type ThumbFile = Pick<AdminFile, "id" | "kind" | "cleared">;

/** 文件缩略图。图片直接懒加载直链并支持点击放大，视频/音频只给一个可跳转的类型标记，避免列表里拉大文件。 */
function Thumb({ file, size }: { file: ThumbFile; size: number }) {
    if (file.cleared) {
        return (
            <span style={{ width: size, height: size }} className="flex shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-stone-300 px-1 text-center text-[10px] leading-tight text-stone-400 dark:border-stone-700">
                <ImageOff className="size-4" />
                {file.kind === "image" ? "图片已清除" : "文件已清除"}
            </span>
        );
    }
    const url = serverFileUrl(file.id);
    if (file.kind === "image") {
        return <Image src={url} width={size} height={size} loading="lazy" rootClassName="shrink-0" className="rounded object-cover" alt="" />;
    }
    const Icon = file.kind === "video" ? Video : Music;
    return (
        <a href={url} target="_blank" rel="noreferrer" style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded bg-stone-100 text-stone-500 dark:bg-stone-800">
            <Icon className="size-4" />
        </a>
    );
}

export function AdminFileThumbs({ files, size = 40 }: { files: ThumbFile[]; size?: number }) {
    if (!files.length) return <span className="text-xs text-stone-400">-</span>;
    return (
        <Image.PreviewGroup>
            <div className="flex flex-wrap gap-1">
                {files.map((file) => (
                    <Thumb key={file.id} file={file} size={size} />
                ))}
            </div>
        </Image.PreviewGroup>
    );
}
