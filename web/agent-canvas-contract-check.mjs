// Agent 改画布的行为回归：覆盖本地位置与远端媒体字段合并，以及仅靠 storageKey 的图片水合。
// 用法：node web/agent-canvas-contract-check.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "src");
let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : `\n       实际 ${JSON.stringify(actual)}\n       期望 ${JSON.stringify(expected)}`}`);
    ok ? (pass += 1) : (fail += 1);
}

async function bundle(entry, stubs = {}) {
    const result = await esbuild.build({
        entryPoints: [join(root, entry)],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        plugins: [
            {
                name: "agent-canvas-check-alias",
                setup(build) {
                    build.onResolve({ filter: /^@\// }, (args) => (stubs[args.path] ? { path: args.path, namespace: "stub" } : { path: join(root, args.path.slice(2)) + ".ts" }));
                    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
                },
            },
        ],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

console.log("Agent 画布合并契约");
const { mergeProjectSnapshots } = await bundle("services/project-merge.ts");
const project = (node) => ({
    id: "p1",
    title: "画布",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
    nodes: [node],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
});
const baseNode = {
    id: "image-1",
    type: "image",
    title: "旧标题",
    position: { x: 80, y: 80 },
    width: 340,
    height: 340,
    metadata: { content: "/old.png", storageKey: "server:old", status: "success", prompt: "旧提示词" },
};
const merged = mergeProjectSnapshots(project(baseNode), project({ ...baseNode, position: { x: 640, y: -40 } }), {
    ...project({ ...baseNode, title: "新标题", metadata: { ...baseNode.metadata, content: "", storageKey: "server:new", prompt: "新提示词" } }),
    revision: 2,
});
check("本地移动位置不会被 Agent 远端快照还原", merged.nodes[0].position, { x: 640, y: -40 });
check("同一节点的远端标题仍会合入", merged.nodes[0].title, "新标题");
check("同一节点的远端图片引用仍会合入", merged.nodes[0].metadata.storageKey, "server:new");
check("合并后的 revision 跟随远端", merged.revision, 2);

console.log("Agent 图片水合契约");
const { hydrateCanvasImages } = await bundle("lib/canvas/canvas-generation-helpers.ts", {
    "@/i18n": `export default { t: (key) => key };`,
    "@/stores/use-config-store": `export const defaultConfig = {}; export const resolveModelForCapability = () => "";`,
    "@/services/image-storage": `export const isServerStorageKey = (key) => String(key || "").startsWith("server:"); export const resolveImageUrl = (key, fallback = "") => key ? "/files/" + key.slice(7) + "/content" : fallback; export const uploadImage = async () => { throw new Error("unexpected upload"); };`,
    "@/services/file-storage": `export const resolveMediaUrl = (key, fallback = "") => key ? "/files/" + key.slice(7) + "/content" : fallback;`,
    "@/lib/canvas/canvas-node-factory": `export const imageMetadata = (image) => image; export const referenceUrl = () => "";`,
});
const [hydrated] = await hydrateCanvasImages([{ id: "image-2", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 340, height: 340, metadata: { content: "", storageKey: "server:file-2", status: "success" } }]);
check("content 为空但有 storageKey 的图片仍能显示", hydrated.metadata.content, "/files/file-2/content");

const [batchHydrated] = await hydrateCanvasImages([
    {
        id: "image-3",
        type: "image",
        title: "批量图片",
        position: { x: 0, y: 0 },
        width: 340,
        height: 340,
        metadata: { content: "", images: [{ id: "slot-1", content: "", storageKey: "server:file-3", status: "success", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" }] },
    },
]);
check("批量图片槽位只带 storageKey 时也会水合", batchHydrated.metadata.images[0].content, "/files/file-3/content");

console.log("Agent 运行期间保存契约");
const remoteSync = readFileSync(join(root, "services/remote-sync.ts"), "utf8");
check("Agent 运行期间不会丢弃 dirty 保存", /cloudAgent\.status === "running"[\s\S]{0,120}?state\.dirty\s*=\s*true/.test(remoteSync), true);
check("强制拉取 Agent 快照前识别本地待保存状态", /hasPendingLocal|pendingLocal/.test(remoteSync), true);
check("拉取 Agent 快照时使用三方合并", /pullProject[\s\S]{0,1800}?mergeProjectSnapshots\(/.test(remoteSync), true);
const projectPage = readFileSync(join(root, "pages/canvas/project.tsx"), "utf8");
const agentReloadBlock = projectPage.slice(projectPage.indexOf("// 画布是被服务端直接改的"), projectPage.indexOf('if (shared || !projectLoaded || !["new"', projectPage.indexOf("// 画布是被服务端直接改的")));
check("Agent reload 不绕过统一的远端渲染时序保护", !/setNodes\(|setConnections\(/.test(agentReloadBlock), true);

console.log("Agent 运行期间保存行为");
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timerSeq = 0;
const fakeTimers = new Map();
globalThis.setTimeout = (fn) => {
    const id = ++timerSeq;
    fakeTimers.set(id, fn);
    return id;
};
globalThis.clearTimeout = (id) => fakeTimers.delete(id);
globalThis.__agentCanvasSync = {
    projects: [],
    remote: null,
    status: "idle",
    projectId: "p1",
    saves: [],
};

const syncModule = await bundle("services/remote-sync.ts", {
    "@/services/api/server": `
        export class ServerApiError extends Error {}
        export const serverApi = {
            project: async () => globalThis.__agentCanvasSync.remote,
            saveProject: async (_id, body) => {
                globalThis.__agentCanvasSync.saves.push(body);
                return { revision: body.revision + 1, updatedAt: "2026-01-01T00:00:03.000Z" };
            },
        };
    `,
    "@/services/file-storage": `export const resolveMediaUrl = (_key, fallback = "") => fallback;`,
    "@/services/image-storage": `export const resolveImageUrl = (_key, fallback = "") => fallback;`,
    "@/stores/canvas/use-canvas-store": `
        const state = () => ({
            projects: globalThis.__agentCanvasSync.projects,
            replaceProjects: (projects) => { globalThis.__agentCanvasSync.projects = projects; },
        });
        export const useCanvasStore = {
            getState: state,
            setState: (updater) => {
                const patch = typeof updater === "function" ? updater(state()) : updater;
                if (patch.projects) globalThis.__agentCanvasSync.projects = patch.projects;
            },
        };
        export const applyRemoteProject = (project) => {
            const projects = globalThis.__agentCanvasSync.projects;
            globalThis.__agentCanvasSync.projects = projects.some((item) => item.id === project.id) ? projects.map((item) => item.id === project.id ? project : item) : [project, ...projects];
        };
    `,
    "@/stores/canvas/use-plugin-store": `export const usePluginStore = { getState: () => ({ plugins: [] }), setState: () => {}, persist: { rehydrate: async () => {} } };`,
    "@/stores/use-asset-store": `export const useAssetStore = { getState: () => ({ assets: [], replaceAssets: () => {} }), setState: () => {} };`,
    "@/stores/use-cloud-agent-store": `export const useCloudAgentStore = { getState: () => ({ status: globalThis.__agentCanvasSync.status, projectId: globalThis.__agentCanvasSync.projectId }) };`,
    "@/stores/use-config-store": `export const useConfigStore = { getState: () => ({ config: {} }), setState: () => {} };`,
    "@/stores/use-server-store": `export const isServerMode = () => true; export const useServerStore = { getState: () => ({ syncedAt: "", setSyncState: () => {}, setSyncedAt: () => {} }) };`,
});

const remoteBase = { ...project(baseNode), revision: 1, updatedAt: "2026-01-01T00:00:01.000Z" };
globalThis.__agentCanvasSync.remote = { id: "p1", title: remoteBase.title, data: remoteBase, revision: 1, updatedAt: remoteBase.updatedAt, deleted: false };
await syncModule.pullProject("p1");
const moved = { ...globalThis.__agentCanvasSync.projects[0], nodes: [{ ...baseNode, position: { x: 720, y: 20 } }], updatedAt: "2026-01-01T00:00:02.000Z" };
globalThis.__agentCanvasSync.projects = [moved];
globalThis.__agentCanvasSync.status = "running";
syncModule.pushProject(moved);
for (const [id, fn] of [...fakeTimers]) {
    fakeTimers.delete(id);
    fn();
}
for (let index = 0; index < 8; index += 1) await Promise.resolve();
check("Agent 运行中不会把旧本地快照推回服务端", globalThis.__agentCanvasSync.saves.length, 0);

const remoteWithAgentNode = {
    ...remoteBase,
    revision: 2,
    nodes: [baseNode, { id: "image-agent", type: "image", title: "Agent 新图", position: { x: 1000, y: -40 }, width: 340, height: 340, metadata: { content: "", storageKey: "server:agent", status: "success" } }],
};
globalThis.__agentCanvasSync.remote = { id: "p1", title: remoteWithAgentNode.title, data: remoteWithAgentNode, revision: 2, updatedAt: "2026-01-01T00:00:03.000Z", deleted: false };
globalThis.__agentCanvasSync.status = "idle";
await syncModule.pullProject("p1");
for (let index = 0; index < 12; index += 1) await Promise.resolve();
const synchronized = globalThis.__agentCanvasSync.projects[0];
check("Agent 完成后保留用户最后移动的位置", synchronized.nodes.find((node) => node.id === "image-1").position, { x: 720, y: 20 });
check("Agent 完成后合入新生成的图片节点", synchronized.nodes.find((node) => node.id === "image-agent").metadata.storageKey, "server:agent");
check("合并结果会补推到服务端", globalThis.__agentCanvasSync.saves.length, 1);
check("补推快照同时含本地位置和 Agent 新节点", [globalThis.__agentCanvasSync.saves[0].data.nodes.find((node) => node.id === "image-1").position.x, globalThis.__agentCanvasSync.saves[0].data.nodes.some((node) => node.id === "image-agent")], [720, true]);

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
delete globalThis.__agentCanvasSync;

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
