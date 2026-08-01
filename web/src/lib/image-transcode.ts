/**
 * 上传前的浏览器端图片转码。
 *
 * 手机相册里的照片基本都是 HEIC，Chrome 不解码这种格式：直接传上去只会在服务端存下一个
 * 谁都打不开的文件，画布里是一块空白，送去生成也会失败。浏览器在链路上时就在这里把它转掉，
 * 服务端因此不需要引入任何图像处理依赖。
 *
 * 只处理「显示不了」的格式：png / jpeg / webp / gif / svg 一律原样直传，
 * 多转一次只会白白损失画质、拖慢上传，还会让文件变大。
 */

/** 浏览器和服务端都能直接显示的格式，原样上传。 */
const PASSTHROUGH_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    // GIF 不转：画到 canvas 上只会剩第一帧，把动图弄坏了比不转更糟。
    "image/gif",
    // SVG 是矢量文本，canvas 解不了也没必要栅格化。
    "image/svg+xml",
]);

/** HEIC / HEIF 系列，Chrome 与 Firefox 都不解码，只能靠 WASM 兜底。 */
const HEIF_TYPES = new Set(["image/heic", "image/heif"]);

/** 转 JPEG 时的质量。照片类素材 0.92 基本看不出差别，体积却只有 PNG 的几分之一。 */
const JPEG_QUALITY = 0.92;

/** HEIC 在 iOS 与 Windows 上经常报不出 MIME，accept 里补扩展名，否则文件选择器直接过滤掉。 */
export const IMAGE_FILE_ACCEPT = "image/*,.heic,.heif,.avif";

const IMAGE_FILE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|svg|tiff?)$/i;

/** 判断是不是图片文件。只看 file.type 会把没有 MIME 的 HEIC 当成非图片直接丢掉，用扩展名兜底。 */
export function isImageFile(file: File) {
    return file.type.startsWith("image/") || IMAGE_FILE_EXTENSIONS.test(file.name);
}

/** 需要时转码，不需要时原样返回；失败抛出可直接展示给用户的中文文案。 */
export async function prepareImageForUpload(source: Blob): Promise<Blob> {
    const type = await detectImageType(source);
    if (!type || PASSTHROUGH_TYPES.has(type)) return source;

    // Safari / iOS 自带 HEIC 解码，原生能解就不必加载那 1.3MB 的解码器。
    const bitmap = await createImageBitmap(source).catch(() => null);
    if (!bitmap) return decodeHeif(source, type);
    try {
        return await encodeBitmap(bitmap);
    } finally {
        bitmap.close();
    }
}

/**
 * 按文件头认格式。不能只信 blob.type：iOS 相册选出来的 HEIC 常常没有 MIME，
 * 剪贴板和拖拽进来的 Blob 也可能是空类型，只有前 16 个字节是可靠的。
 */
async function detectImageType(source: Blob) {
    const head = new Uint8Array(await source.slice(0, 16).arrayBuffer());
    return sniffImageType(head) || source.type.split(";")[0].trim().toLowerCase();
}

function sniffImageType(bytes: Uint8Array) {
    if (bytes.length < 12) return "";
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
    const brand = ascii(8, 12);
    // ISO-BMFF 容器，同一个盒子结构也用于 mp4/mov，必须靠 brand 区分，不能见到 ftyp 就当图片。
    if (ascii(4, 8) === "ftyp") return brand.startsWith("avi") ? "image/avif" : /^(hei|hev|mif|msf)/.test(brand) ? "image/heic" : "";
    if (ascii(0, 4) === "RIFF" && brand === "WEBP") return "image/webp";
    if (ascii(0, 4) === "GIF8") return "image/gif";
    if (ascii(0, 2) === "BM") return "image/bmp";
    if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    return "";
}

/** heic2any 打包体积 1.3MB，只在真的遇到 HEIC 时才动态加载，不进主包。 */
async function decodeHeif(source: Blob, type: string) {
    if (!HEIF_TYPES.has(type)) throw new Error("这张图片浏览器无法解码，请转成 PNG 或 JPEG 后再上传");
    const heic2any = (await import("heic2any")).default;
    // HEIC 是相机照片，没有透明通道，直接出 JPEG；转 PNG 会让一张 4MB 的照片膨胀到几十 MB。
    const converted = await heic2any({ blob: source, toType: "image/jpeg", quality: JPEG_QUALITY }).catch(() => null);
    const blob = Array.isArray(converted) ? converted[0] : converted;
    if (!blob) throw new Error("HEIC 图片解码失败，请换一张图片或先转成 JPEG");
    return blob;
}

/** 有透明通道的转 PNG 保住透明，没有的转 JPEG，体积能小一个数量级。 */
async function encodeBitmap(bitmap: ImageBitmap) {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片转码失败，请转成 PNG 或 JPEG 后再上传");
    context.drawImage(bitmap, 0, 0);
    const target = hasAlpha(context, bitmap.width, bitmap.height) ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, target, JPEG_QUALITY));
    if (!blob) throw new Error("图片转码失败，请转成 PNG 或 JPEG 后再上传");
    return blob;
}

function hasAlpha(context: CanvasRenderingContext2D, width: number, height: number) {
    const { data } = context.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 255) return true;
    }
    return false;
}
