import "reflect-metadata";

import { createApp } from "./app";
import { config } from "./config";
import { initDatabase } from "./db/data-source";
import { publicBaseUrlWarning } from "./routes/files";
import { resetRunningAgentSessions } from "./services/agent";
import { ensureDefaultAdmin } from "./services/auth";
import { startJobWorker } from "./services/jobs";
import { ensurePromptCategories, refreshPromptSyncScheduler } from "./services/prompts";

async function main() {
    await initDatabase();
    await ensureDefaultAdmin();
    await ensurePromptCategories();
    await refreshPromptSyncScheduler();
    await startJobWorker();
    await resetRunningAgentSessions();
    publicBaseUrlWarning();
    createApp().listen(config.port, () => console.log(`infinite-canvas server listening on :${config.port}`));
}

main().catch((error) => {
    console.error("服务启动失败:", error);
    process.exit(1);
});
