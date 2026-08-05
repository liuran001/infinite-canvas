import "reflect-metadata";

import { createServer } from "node:http";

import { createApp } from "./app";
import { config } from "./config";
import { initDatabase } from "./db/data-source";
import { publicBaseUrlWarning } from "./routes/files";
import { resetRunningAgentSessions } from "./services/agent";
import { startAccountDeletionCleanup } from "./services/account-deletion";
import { ensureDefaultAdmin } from "./services/auth";
import { startBlobGarbageCollector } from "./services/blob-gc";
import { migratePhysicalBlobs } from "./services/file-migration";
import { startGenerationHistoryCleanup } from "./services/generation-history";
import { startJobWorker } from "./services/jobs";
import { ensurePromptCategories, refreshPromptSyncScheduler } from "./services/prompts";
import { attachRealtime } from "./services/realtime-hub";

async function main() {
    await initDatabase();
    await migratePhysicalBlobs();
    await startGenerationHistoryCleanup();
    startAccountDeletionCleanup();
    startBlobGarbageCollector();
    await ensureDefaultAdmin();
    await ensurePromptCategories();
    await refreshPromptSyncScheduler();
    await startJobWorker();
    await resetRunningAgentSessions();
    publicBaseUrlWarning();
    const server = createServer(createApp());
    attachRealtime(server);
    server.listen(config.port, () => console.log(`infinite-canvas server listening on :${config.port}`));
}

main().catch((error) => {
    console.error("服务启动失败:", error);
    process.exit(1);
});
