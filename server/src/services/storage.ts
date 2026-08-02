import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import { config } from "../config";
import type { FileStorage } from "../db/entities";
import { fail } from "../lib/errors";

export type ObjectRange = { start: number; end: number };
export type ObjectBody = { stream: Readable; bytes: number };

const localRoot = path.join(config.dataDir, "files");

function s3Client() {
    if (!config.s3.bucket) throw fail("未配置 S3_BUCKET，无法使用对象存储");
    return import("@aws-sdk/client-s3").then(({ S3Client }) => ({
        client: new S3Client({
            region: config.s3.region,
            endpoint: config.s3.endpoint || undefined,
            forcePathStyle: config.s3.forcePathStyle,
            credentials: config.s3.accessKeyId ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } : undefined,
        }),
    }));
}

function s3Key(key: string) {
    return config.s3.prefix ? `${config.s3.prefix}/${key}` : key;
}

export const useS3 = config.fileDriver === "s3";
export const configuredFileStorage = (): FileStorage => (useS3 ? "s3" : "local");

export async function putObject(key: string, body: Buffer, mimeType: string, storage: FileStorage = configuredFileStorage()) {
    if (storage !== "s3") {
        const target = path.join(localRoot, key);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, body);
        return;
    }
    const [{ client }, { PutObjectCommand }] = await Promise.all([s3Client(), import("@aws-sdk/client-s3")]);
    await client.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: s3Key(key), Body: body, ContentType: mimeType }));
}

export async function getObject(key: string, range?: ObjectRange, storage: FileStorage = configuredFileStorage()): Promise<ObjectBody> {
    if (storage !== "s3") {
        const target = path.join(localRoot, key);
        const stat = await fs.promises.stat(target).catch(() => null);
        if (!stat) throw fail("文件不存在");
        const stream = fs.createReadStream(target, range);
        return { stream, bytes: range ? range.end - range.start + 1 : stat.size };
    }
    const [{ client }, { GetObjectCommand }] = await Promise.all([s3Client(), import("@aws-sdk/client-s3")]);
    const result = await client
        .send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: s3Key(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }))
        .catch(() => {
            throw fail("文件不存在");
        });
    return { stream: result.Body as Readable, bytes: Number(result.ContentLength) || 0 };
}

export async function deleteObject(key: string, storage: FileStorage = configuredFileStorage()) {
    if (storage !== "s3") {
        await fs.promises.rm(path.join(localRoot, key), { force: true });
        return;
    }
    const [{ client }, { DeleteObjectCommand }] = await Promise.all([s3Client(), import("@aws-sdk/client-s3")]);
    await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: s3Key(key) }));
}
