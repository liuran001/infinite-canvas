import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const imagePage = await readFile(new URL("./src/pages/image/index.tsx", import.meta.url), "utf8");
const videoPage = await readFile(new URL("./src/pages/video/index.tsx", import.meta.url), "utf8");
const serverApi = await readFile(new URL("./src/services/api/server.ts", import.meta.url), "utf8");
const accountLocalData = await readFile(new URL("./src/services/account-local-data.ts", import.meta.url), "utf8");
const imageStorage = await readFile(new URL("./src/services/image-storage.ts", import.meta.url), "utf8");

for (const [name, source, kind] of [
    ["image", imagePage, "image"],
    ["video", videoPage, "video"],
]) {
    assert.match(source, /listAllServerJobs\(\["succeeded", "failed", "canceled"\]\)/, `${name}: history must come from all terminal server-job pages`);
    assert.match(source, new RegExp(`job\\.kind === "${kind}"`), `${name}: history must filter the matching server job kind`);
    assert.match(source, /new Map\(jobs\.map\(\(job\) => \[job\.id, job\]\)\)/, `${name}: history must deduplicate by stable server job id`);
    assert.match(source, /file\.cleared \? "" : serverFileUrl\(file\.id\)/, `${name}: cleared server outputs must not retain a playable URL`);
    assert.match(source, /useServerStore\(\(state\) => state\.user\?\.id \|\| ""\)/, `${name}: account changes must scope history refreshes`);
    assert.match(source, /serverApi\.deleteJobHistory\(/, `${name}: deleting a visible server history row must delete the server record`);
    assert.match(source, /value\.ownerId === ownerId/, `${name}: local supplements must belong to the active account`);
    assert.doesNotMatch(source, /!value\.ownerId\s*\|\|/, `${name}: unowned legacy supplements must not leak across accounts`);
}

assert.match(serverApi, /deleteJobHistory:\s*\(id: string\)/, "server API must expose generation-history deletion");
assert.match(serverApi, /options\.before[\s\S]*params\.set\("before"[\s\S]*options\.limit[\s\S]*params\.set\("limit"/, "server API must send the opaque before cursor and page limit");
assert.match(serverApi, /items: ServerJob\[\]; nextBefore: string/, "server API must type the next-page cursor");
assert.match(serverApi, /for \(;;\)[\s\S]*page\.nextBefore[\s\S]*before = page\.nextBefore/, "unlimited history must follow nextBefore until the server ends pagination");
assert.match(accountLocalData, /value\?\.ownerId === ownerId/, "account cleanup must remove only the matching account history entries");
assert.doesNotMatch(accountLocalData, /storeName \}\)\.clear\(\)/, "account cleanup must not clear another account's whole history store");
assert.doesNotMatch(accountLocalData, /infinite-canvas-plugins|share_agent_history|agent_chat_messages/, "account cleanup must preserve independent plugin and agent private databases");
assert.match(imageStorage, /response\.status === 404 \|\| response\.status === 410/, "media probes must only treat not-found and gone responses as cleared");
assert.doesNotMatch(imageStorage, /response\.status === 400/, "media probes must not erase history after an ordinary bad request");

console.log("generation history UI contract: 25/25");
