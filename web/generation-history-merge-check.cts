import assert from "node:assert/strict";

import { mergeServerImageLogs } from "./src/pages/image/index";
import { mergeServerVideoLogs } from "./src/pages/video/index";
import { listAllServerJobs, serverApi, type ServerJob } from "./src/services/api/server";

function job(patch: Partial<ServerJob> & Pick<ServerJob, "id" | "clientJobId" | "kind" | "status">): ServerJob {
    return {
        model: `${patch.kind}-model`,
        progress: 100,
        error: "",
        outputs: [],
        text: "",
        context: { prompt: `${patch.kind} prompt` },
        createdAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-08-05T10:00:03.000Z",
        finishedAt: "2026-08-05T10:00:03.000Z",
        ...patch,
    };
}

const imageJob = job({
    id: "job-image",
    clientJobId: "client-image",
    kind: "image",
    status: "succeeded",
    outputs: [{ id: "file-image", kind: "image", mimeType: "image/png", bytes: 12, width: 1024, height: 1024, durationMs: 0, cleared: true }],
});
const imageLocal = {
    id: "local-batch",
    ownerId: "owner-a",
    clientJobIds: ["client-image"],
    prompt: "local prompt",
    title: "local",
    config: { model: "old", imageModel: "old", quality: "hd", size: "1:1", count: "4" },
    references: [],
    durationMs: 1,
    successCount: 1,
    failCount: 0,
    imageCount: 1,
    size: "1:1",
    quality: "hd",
    status: "成功",
    images: [],
    thumbnails: [],
    createdAt: 1,
    time: "",
    model: "old",
};
const otherOwnerImageLocal = {
    ...imageLocal,
    id: "other-owner-image",
    ownerId: "owner-b",
    quality: "other-owner-quality",
    config: { ...imageLocal.config, quality: "other-owner-quality" },
};
const imageLogs = mergeServerImageLogs(
    [imageJob, imageJob, job({ id: "job-failed", clientJobId: "client-failed", kind: "image", status: "failed", createdAt: "2026-08-05T09:00:00.000Z", error: "failed" })],
    [imageLocal, otherOwnerImageLocal] as never,
    "owner-a",
);
assert.equal(imageLogs.length, 2, "image jobs must deduplicate by server job id");
assert.equal(imageLogs[0].id, "job-image", "image logs must sort by server createdAt");
assert.equal(imageLogs[0].images[0].cleared, true);
assert.equal(imageLogs[0].images[0].dataUrl, "", "cleared images must not keep a usable URL");
assert.equal(imageLogs[0].quality, "hd", "matched local logs may supplement parameters");
assert.equal(imageLogs[1].failCount, 1, "failed server jobs must remain visible");

const videoLocal = {
    id: "local-video",
    ownerId: "owner-a",
    prompt: "local video prompt",
    title: "local video",
    config: { model: "old", videoModel: "old", size: "16:9", vquality: "720", videoSeconds: "5" },
    references: [],
    videoReferences: [],
    audioReferences: [],
    durationMs: 1,
    size: "16:9",
    resolution: "720",
    seconds: "5",
    status: "成功",
    createdAt: 1,
    time: "",
    model: "old",
    task: { id: "local-task", clientJobId: "client-video", model: "old" },
};
const otherOwnerVideoLocal = { ...videoLocal, id: "other-owner-video", ownerId: "owner-b", resolution: "other-owner-resolution" };

const videoLogs = mergeServerVideoLogs(
    [
        job({
            id: "job-video",
            clientJobId: "client-video",
            kind: "video",
            status: "succeeded",
            outputs: [{ id: "file-video", kind: "video", mimeType: "video/mp4", bytes: 34, width: 1280, height: 720, durationMs: 5000, cleared: true }],
        }),
    ],
    [videoLocal, otherOwnerVideoLocal] as never,
    "owner-a",
);
assert.equal(videoLogs[0].id, "job-video");
assert.equal(videoLogs[0].video?.cleared, true);
assert.equal(videoLogs[0].video?.url, "", "cleared videos must not keep a playable URL");
assert.equal(videoLogs[0].seconds, "5", "server media metadata must populate missing local parameters");
assert.equal(videoLogs[0].resolution, "720", "another account's matching client job id must not override local parameters");

const originalJobs = serverApi.jobs;
const cursors: string[] = [];
serverApi.jobs = (async (_statuses, options = {}) => {
    cursors.push(options.before || "");
    return options.before ? { items: [imageJob], nextBefore: "" } : { items: [imageJob], nextBefore: "next-page" };
}) as typeof serverApi.jobs;
void listAllServerJobs(["succeeded"])
    .then((paged) => {
        assert.equal(paged.length, 2, "all history pages must be concatenated");
        assert.deepEqual(cursors, ["", "next-page"], "pagination must follow the opaque nextBefore cursor until empty");
        console.log("generation history merge: 13/13");
    })
    .finally(() => {
        serverApi.jobs = originalJobs;
    });
