import "reflect-metadata";

import { createChecker, prepareEnv } from "./verify-common";

/**
 * 画布分享专项验证：token 熵与哈希存储、guest 令牌、唯一授权入口的判定矩阵、
 * 撤销断流、访问日志节流、访客上传限流与克隆事务。
 * 这些语义大多发生在服务层内部（哈希、事务回滚、内存节流），端到端 smoke 只能看到最终状态码，
 * 所以和 verify-storage.ts 一样在服务层直接验证。
 * 用法：cd server && npx tsx verify-share.ts
 */
const env = prepareEnv("verify-share");

async function main() {
    const { check, rejects, finish } = createChecker();
    const { initDatabase, repo } = await import("./src/db/data-source");
    const { Job, PhysicalBlob, Project, ProjectAccessLog, ProjectShare, StoredFile, User } = await import("./src/db/entities");
    const { createShare, findShareByToken, guestSessionOf, listShares, logShareAccess, ownerShareView, resetShareRuntimeState, scheduleShareExpiry, shareRevokesAccess, shareTokenHash, shareView, signGuestToken, updateShare, verifyGuestToken, assertShareUploadAllowed } = await import("./src/services/project-share");
    const { resolveProjectAccess } = await import("./src/services/project-access");
    const { disconnectShare, listProjectPresence, subscribeProject, updateProjectPresence } = await import("./src/services/project-realtime");
    const { cloneSharedProject } = await import("./src/services/project-clone");
    const { currentAuthUser } = await import("./src/services/auth");
    const { deleteFile, saveFile } = await import("./src/services/files");
    const { archiveJobOutputs, deleteGenerationHistoryJob } = await import("./src/services/generation-history");
    const { storageOf } = await import("./src/services/quota");
    const { saveProject } = await import("./src/services/sync");
    const { now } = await import("./src/lib/errors");

    await initDatabase();
    const users = repo(User);
    const shares = repo(ProjectShare);
    const logs = repo(ProjectAccessLog);
    const projects = repo(Project);
    const files = repo(StoredFile);
    const blobs = repo(PhysicalBlob);
    const jobs = repo(Job);
    const makeUser = async (id: string, quota: number) =>
        users.insert({ id, username: id, password: "", email: "", displayName: id, avatarUrl: "", role: "user", credits: 0, storageQuota: quota, affCode: id, affCount: 0, inviterId: "", linuxDoId: "", status: "active", lastLoginAt: "", preferences: "", extra: "", createdAt: now(), updatedAt: now() });
    const actorOf = (id: string) => ({ id, displayName: id, avatarUrl: "" });
    const ownerCtx = { user: actorOf("owner-1"), guest: null };
    const strangerCtx = { user: actorOf("stranger"), guest: null };
    const anonymousCtx = { user: null, guest: null };
    const status = async (work: () => Promise<unknown>) => {
        try {
            await work();
            return 200;
        } catch (error) {
            return (error as { status?: number }).status || 500;
        }
    };
    const codeOf = async (work: () => Promise<unknown>) => {
        try {
            await work();
            return "";
        } catch (error) {
            return String((error as { code?: string }).code || "");
        }
    };

    await makeUser("owner-1", 10 << 20);
    await makeUser("stranger", 10 << 20);
    await makeUser("cloner", 10 << 20);
    await makeUser("cloner-duplicate", 10 << 20);
    await makeUser("cloner-tight", 16);

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const otherPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const fileA = await saveFile("owner-1", png, "image/png");
    const fileB = await saveFile("owner-1", otherPng, "image/png");
    const canvas = { nodes: [{ id: "n1", type: "image", metadata: { storageKey: `server:${fileA.id}` } }, { id: "n2", type: "image", metadata: { storageKey: `server:${fileB.id}` } }], connections: [] };
    await saveProject("owner-1", { id: "p1", title: "分享画布", data: canvas, revision: 0, clientId: "verify-owner" });

    console.log("token 生成与存储");
    const viewer = await createShare("owner-1", "p1", { role: "viewer", allowAnonymous: true, allowClone: true, expiresAt: "", ownerPays: false, allowAnonymousEdit: true });
    check("viewer 分享归一化关闭匿名编辑", viewer.share.allowAnonymousEdit, false);
    check("明文 token 至少 128 bit", Buffer.from(viewer.token, "base64url").length >= 16, true);
    check("库里存的是哈希而不是明文", viewer.share.tokenHash !== viewer.token, true);
    check("哈希与明文可复算对上", viewer.share.tokenHash, shareTokenHash(viewer.token));
    check("tokenPrefix 不超过 8 个字符", viewer.share.tokenPrefix.length <= 8, true);
    check("tokenPrefix 是明文前缀", viewer.token.startsWith(viewer.share.tokenPrefix), true);
    const generated = new Set<string>();
    for (let index = 0; index < 1000; index += 1) generated.add((await createShare("owner-1", "p1", { role: "viewer", allowAnonymous: true, allowClone: false, expiresAt: "" })).token);
    check("1000 个 token 互不重复", generated.size, 1000);
    await shares.delete({ projectId: "p1", role: "viewer", allowClone: false });
    check("清理批量生成的分享后只剩一条只读分享", await shares.countBy({ projectId: "p1" }), 1);

    console.log("明文回显与可复制状态");
    // 分享链接要随时可复制，所以明文与哈希各存一列。哈希仍是校验的唯一入口，明文只负责回显。
    check("明文落库供所有者随时取回", (await shares.findOneByOrFail({ id: viewer.share.id })).token, viewer.token);
    const owned = ownerShareView(await shares.findOneByOrFail({ id: viewer.share.id }));
    check("所有者视图带出完整明文", owned.token, viewer.token);
    check("所有者视图标记为可复制", owned.copyable, true);
    check("列表里同样能取回明文", (await listShares("p1", "owner-1")).find((row) => row.id === viewer.share.id)?.token, viewer.token);
    // 默认视图是给一切非所有者路径用的，它永远不能带明文——带出去的可能是一条能编辑别人画布的链接。
    const anonymousView = shareView(await shares.findOneByOrFail({ id: viewer.share.id })) as { token?: string; copyable: boolean };
    check("默认视图不带明文", anonymousView.token, undefined);
    check("默认视图恒为不可复制", anonymousView.copyable, false);
    check("默认视图仍然给出前缀", shareView(await shares.findOneByOrFail({ id: viewer.share.id })).tokenPrefix, viewer.share.tokenPrefix);
    // 存量记录建于「只存哈希」的年代，明文不可逆推。它必须表现成「不可复制」，
    // 而不是给前端一个空串让它自己猜——猜错就是把残缺链接渲染成可复制的样子让用户发出去。
    await shares.update({ id: viewer.share.id }, { token: "" });
    const legacy = ownerShareView(await shares.findOneByOrFail({ id: viewer.share.id }));
    check("存量记录标记为不可复制", legacy.copyable, false);
    check("存量记录不给出残缺明文", legacy.token, undefined);
    check("存量记录仍然给出前缀", legacy.tokenPrefix, viewer.share.tokenPrefix);
    // 最要紧的一条：明文列为空绝不能影响校验，校验走的是 tokenHash。
    check("存量记录的 token 校验照常通过", (await findShareByToken(viewer.token))?.id, viewer.share.id);
    await shares.update({ id: viewer.share.id }, { token: viewer.token });

    console.log("token 校验");
    check("正确 token 能查到分享", (await findShareByToken(viewer.token))?.id, viewer.share.id);
    // 校验一律按哈希等值查询定位。改成认明文列的话，存量记录（明文为空）会全部失效，
    // 而且空串会互相撞在一起，一条空明文能匹配到任意一条老分享。
    check("明文对不上哈希时查不到", await findShareByToken(`${viewer.token}x`), null);
    check("错误 token 查不到", await findShareByToken("deadbeefdeadbeefdeadbeef"), null);
    check("空 token 查不到", await findShareByToken(""), null);
    await shares.update({ id: viewer.share.id }, { enabled: false });
    check("已撤销的分享查不到", await findShareByToken(viewer.token), null);
    await shares.update({ id: viewer.share.id }, { enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    check("已过期的分享查不到", await findShareByToken(viewer.token), null);
    await shares.update({ id: viewer.share.id }, { expiresAt: new Date(Date.now() + 600_000).toISOString() });
    check("未过期的分享仍可用", (await findShareByToken(viewer.token))?.id, viewer.share.id);
    await shares.update({ id: viewer.share.id }, { expiresAt: "" });

    // 前端清空「过期时间」时发的是 null，服务层必须把它当成「改为永不过期」，而不是「没传这个字段」。
    await shares.update({ id: viewer.share.id }, { expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await updateShare(await shares.findOneByOrFail({ id: viewer.share.id }), { expiresAt: null as unknown as string });
    check("清空过期时间后落库为空串", (await shares.findOneByOrFail({ id: viewer.share.id })).expiresAt, "");
    check("清空过期时间后分享恢复永久可用", (await findShareByToken(viewer.token))?.id, viewer.share.id);
    // 未提及 expiresAt 的补丁不能顺手抹掉已设的过期时间。
    await shares.update({ id: viewer.share.id }, { expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await updateShare(await shares.findOneByOrFail({ id: viewer.share.id }), { allowClone: false });
    check("不涉及过期时间的补丁保留原过期时间", Boolean((await shares.findOneByOrFail({ id: viewer.share.id })).expiresAt), true);
    await shares.update({ id: viewer.share.id }, { expiresAt: "", allowClone: true });

    console.log("guest 令牌");
    const viewerShare = await shares.findOneByOrFail({ id: viewer.share.id });
    const anonymousSession = guestSessionOf(viewerShare, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    const guestToken = signGuestToken(anonymousSession);
    const decoded = verifyGuestToken(guestToken);
    check("guest 载荷带 kind 标记", decoded?.kind, "guest");
    check("guest 载荷带分享与画布", `${decoded?.shareId}/${decoded?.projectId}/${decoded?.role}`, `${viewerShare.id}/p1/viewer`);
    check("匿名访客 actorId 带分享前缀", decoded?.actorId.startsWith(`guest:${viewerShare.id}:`), true);
    check("匿名访客有访客昵称", decoded?.displayName.startsWith("访客-"), true);
    const claims = JSON.parse(Buffer.from(guestToken.split(".")[1], "base64url").toString("utf8")) as { exp: number; iat: number };
    check("guest 令牌不超过 30 分钟", claims.exp - claims.iat <= 1800, true);
    check("用户令牌不会被当成 guest", verifyGuestToken(await import("jsonwebtoken").then((jwt) => jwt.default.sign({ userId: "owner-1", kind: "user" }, "verify-secret"))), null);
    check("guest 令牌换不出账号身份", await currentAuthUser(guestToken), null);
    check("刷新页面可以沿用同一个匿名 id", guestSessionOf(viewerShare, { accountId: "", actorId: anonymousSession.actorId, displayName: "", avatarUrl: "" }).actorId, anonymousSession.actorId);
    check("别的分享的 actorId 不会被沿用", guestSessionOf(viewerShare, { accountId: "", actorId: "guest:other-share:abcdefgh", displayName: "", avatarUrl: "" }).actorId.startsWith(`guest:${viewerShare.id}:`), true);
    const namedSession = guestSessionOf(viewerShare, { accountId: "stranger", actorId: "", displayName: "路人", avatarUrl: "" });
    check("已登录访客用账号 id 作为 actorId", namedSession.actorId, "stranger");
    check("已登录访客不算匿名", namedSession.anonymous, false);

    console.log("唯一授权入口");
    const viewerCtx = { user: null, guest: verifyGuestToken(signGuestToken(anonymousSession)) };
    const editor = await createShare("owner-1", "p1", { role: "editor", allowAnonymous: true, allowClone: false, expiresAt: "", ownerPays: true, allowAnonymousEdit: true });
    check("editor ownerPays 开启匿名编辑", editor.share.allowAnonymousEdit, true);
    const editorSession = guestSessionOf(editor.share, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    const editorCtx = { user: null, guest: editorSession };
    check("所有者可读", (await resolveProjectAccess(ownerCtx, "p1", "read")).role, "owner");
    check("所有者可写", (await resolveProjectAccess(ownerCtx, "p1", "write")).role, "owner");
    check("其他账号无分享时读取按不存在处理", await status(() => resolveProjectAccess(strangerCtx, "p1", "read")), 404);
    check("匿名无分享时读取按不存在处理", await status(() => resolveProjectAccess(anonymousCtx, "p1", "read")), 404);
    check("只读分享可读", (await resolveProjectAccess(viewerCtx, "p1", "read")).role, "viewer");
    check("只读分享写入返回 403", await status(() => resolveProjectAccess(viewerCtx, "p1", "write")), 403);
    check("只读分享写入有稳定错误码", await codeOf(() => resolveProjectAccess(viewerCtx, "p1", "write")), "SHARE_READ_ONLY");
    const editorAccess = await resolveProjectAccess(editorCtx, "p1", "write");
    check("可编辑分享可写", editorAccess.role, "editor");
    check("可编辑分享写入的目标是所有者", editorAccess.ownerId, "owner-1");
    check("可编辑分享的 actorId 不是所有者", editorAccess.actorId !== "owner-1", true);
    check("访客访问带出分享本体", editorAccess.share?.id, editor.share.id);

    const anonymousEditorNoPay = await createShare("owner-1", "p1", { role: "editor", allowAnonymous: true, allowClone: false, expiresAt: "", ownerPays: false, allowAnonymousEdit: true });
    const anonymousEditorNoPayCtx = { user: null, guest: guestSessionOf(anonymousEditorNoPay.share, { accountId: "", actorId: "", displayName: "", avatarUrl: "" }) };
    check("未开启 ownerPays 的匿名 editor 有效角色降为 viewer", (await resolveProjectAccess(anonymousEditorNoPayCtx, "p1", "read")).role, "viewer");
    check("未开启 ownerPays 的匿名 editor 禁止写入", await status(() => resolveProjectAccess(anonymousEditorNoPayCtx, "p1", "write")), 403);
    await shares.update({ id: anonymousEditorNoPay.share.id }, { allowAnonymousEdit: true });
    check("数据库异常组合也不能绕过 ownerPays 匿名编辑约束", (await resolveProjectAccess(anonymousEditorNoPayCtx, "p1", "read")).role, "viewer");

    await shares.update({ id: editor.share.id }, { role: "viewer" });
    check("链接被降级后旧令牌立刻只能读", await status(() => resolveProjectAccess(editorCtx, "p1", "write")), 403);
    await shares.update({ id: editor.share.id }, { role: "editor" });
    await shares.update({ id: viewerShare.id }, { enabled: false });
    check("撤销后旧令牌按不存在处理", await status(() => resolveProjectAccess(viewerCtx, "p1", "read")), 404);
    await shares.update({ id: viewerShare.id }, { enabled: true, expiresAt: new Date(Date.now() - 1000).toISOString() });
    check("过期后旧令牌按不存在处理", await status(() => resolveProjectAccess(viewerCtx, "p1", "read")), 404);
    await shares.update({ id: viewerShare.id }, { expiresAt: "", allowAnonymous: false });
    check("关掉匿名后匿名令牌按不存在处理", await status(() => resolveProjectAccess(viewerCtx, "p1", "read")), 404);
    await shares.update({ id: viewerShare.id }, { allowAnonymous: true });
    const crossCtx = { user: null, guest: { ...anonymousSession, projectId: "p2" } };
    check("令牌里的画布和请求路径不一致时按不存在处理", await status(() => resolveProjectAccess(crossCtx, "p1", "read")), 404);
    const forgedCtx = { user: null, guest: { ...anonymousSession, ownerId: "stranger", role: "editor" as const } };
    check("篡改令牌里的所有者也拿不到别人的画布", (await resolveProjectAccess(forgedCtx, "p1", "read")).ownerId, "owner-1");
    check("篡改令牌里的角色不会提权", await status(() => resolveProjectAccess(forgedCtx, "p1", "write")), 403);
    await projects.update({ userId: "owner-1", projectId: "p1" }, { deleted: true });
    check("画布已软删除时分享按不存在处理", await status(() => resolveProjectAccess(viewerCtx, "p1", "read")), 404);
    check("画布已软删除时所有者也读不到", await status(() => resolveProjectAccess(ownerCtx, "p1", "read")), 404);
    await projects.update({ userId: "owner-1", projectId: "p1" }, { deleted: false });

    console.log("访客写入复用现有 CAS");
    const revision = (await projects.findOneByOrFail({ userId: "owner-1", projectId: "p1" })).revision;
    const written = await saveProject(editorAccess.ownerId, { id: "p1", title: "访客改标题", data: canvas, revision, clientId: "verify-guest" });
    check("访客写入照常推进 revision", written.revision, revision + 1);
    check("访客写入不会产生第二份画布", await projects.countBy({ projectId: "p1" }), 1);
    check("画布仍属于原所有者", (await projects.findOneByOrFail({ userId: "owner-1", projectId: "p1" })).title, "访客改标题");
    await rejects("访客用旧 revision 写入照样冲突", () => saveProject(editorAccess.ownerId, { id: "p1", title: "x", data: canvas, revision, clientId: "verify-guest" }));

    console.log("撤销立即断流");
    resetShareRuntimeState();
    const closed: string[] = [];
    const ownerUnsubscribe = subscribeProject("owner-1", "p1", () => undefined, { clientId: "owner-client", close: () => closed.push("owner") });
    const guestUnsubscribe = subscribeProject("owner-1", "p1", () => undefined, { shareId: editor.share.id, clientId: "guest-client", close: () => closed.push("guest") });
    const otherUnsubscribe = subscribeProject("owner-1", "p1", () => undefined, { shareId: viewerShare.id, clientId: "other-client", close: () => closed.push("other") });
    updateProjectPresence("owner-1", "p1", actorOf("owner-1"), { clientId: "owner-client", nodeIds: [], activity: "idle" });
    updateProjectPresence("owner-1", "p1", actorOf(editorSession.actorId), { clientId: "guest-client", nodeIds: [], activity: "editing" });
    updateProjectPresence("owner-1", "p1", actorOf("other"), { clientId: "other-client", nodeIds: [], activity: "idle" });
    check("撤销前三个连接都在 Presence 里", listProjectPresence("owner-1", "p1").length, 3);
    check("撤销断开了该分享的连接", disconnectShare("owner-1", "p1", editor.share.id), 1);
    check("只有该分享的连接被关闭", closed.join(","), "guest");
    check("被撤销连接的 Presence 被清掉", listProjectPresence("owner-1", "p1").map((item) => item.clientId).join(","), "other-client,owner-client");
    check("重复撤销不会再关一次", disconnectShare("owner-1", "p1", editor.share.id), 0);
    ownerUnsubscribe();
    guestUnsubscribe();
    otherUnsubscribe();

    // 画布 SSE 的三处时序：ready 与窗口期事件的先后、flush 中途被断流、读库期间就断开的连接。
    // 这些都发生在路由闭包里，端到端只能看到"流没了"，所以直接把路由处理器拿出来喂假的 req/res。
    console.log("画布 SSE 时序");
    resetShareRuntimeState();
    const { syncRouter } = await import("./src/routes/sync");
    const { openRealtimeChannel } = await import("./src/services/realtime-channels");
    const { publishProjectSaved } = await import("./src/services/project-realtime");
    type Layer = { route?: { path: string; stack: { handle: (req: unknown, res: unknown, next: (error?: unknown) => void) => void }[] } };
    const realtime = (syncRouter.stack as unknown as Layer[]).find((layer) => layer.route?.path === "/v1/projects/:id/realtime")?.route;
    check("找得到画布 SSE 路由", Boolean(realtime), true);
    const handler = realtime!.stack[realtime!.stack.length - 1].handle;
    // 假 res 只实现路由用到的那几个方法。onWrite 用来在写出某一帧的瞬间模拟 disconnectShare 的 res.end()。
    const makeRes = (onWrite?: (chunk: string, res: { writableEnded: boolean }) => void) => {
        const chunks: string[] = [];
        const res = {
            writableEnded: false,
            chunks,
            statusCode: 200,
            status(code: number) { res.statusCode = code; return res; },
            setHeader() { return res; },
            flushHeaders() { return res; },
            json(body: unknown) { chunks.push(`json:${JSON.stringify(body)}`); return res; },
            write(chunk: string) {
                if (res.writableEnded) throw new Error("ERR_STREAM_WRITE_AFTER_END");
                chunks.push(chunk);
                onWrite?.(chunk, res);
                return true;
            },
            end() { res.writableEnded = true; return res; },
        };
        return res;
    };
    const makeReq = (clientId: string, guest: typeof editorSession) => {
        const closeHandlers: (() => void)[] = [];
        return {
            params: { id: "p1" },
            query: { clientId, sinceRevision: "0" },
            guest,
            on(event: string, listener: () => void) { if (event === "close") closeHandlers.push(listener); },
            fireClose() { closeHandlers.forEach((listener) => listener()); },
        };
    };
    const frames = (res: { chunks: string[] }) => res.chunks.filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; revision?: number });
    const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
    const liveShare = await shares.findOneByOrFail({ id: editor.share.id });
    const liveSession = guestSessionOf(liveShare, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    const liveRevision = (await projects.findOneByOrFail({ userId: "owner-1", projectId: "p1" })).revision;

    // 窗口期事件必须排在 ready 之后：先写事件、后写带旧快照的 ready，客户端会停在旧 revision 上。
    const orderedRes = makeRes();
    const orderedReq = makeReq("sse-order-client", liveSession);
    handler(orderedReq, orderedRes, () => undefined);
    publishProjectSaved("owner-1", "p1", liveRevision + 5, "other-client");
    await settle();
    const orderedFrames = frames(orderedRes);
    check("ready 之前不会先写窗口期事件", orderedFrames.findIndex((frame) => frame.type === "ready") < orderedFrames.length - 1, true);
    check("ready 之后补发窗口期事件", orderedFrames[orderedFrames.length - 1].revision, liveRevision + 5);
    check("窗口期事件只补发一次", orderedFrames.filter((frame) => frame.revision === liveRevision + 5).length, 1);
    orderedReq.fireClose();
    check("正常关闭后连接不再登记", disconnectShare("owner-1", "p1", editor.share.id), 0);

    // flush 补发到一半被 disconnectShare 关掉：剩下的事件静默丢弃，绝不能抛 ERR_STREAM_WRITE_AFTER_END。
    // 抛在 flush 的循环里等于把这条流截断，而调用方（bus 的 emit）没有任何理由接得住它。
    const cutRes = makeRes((chunk, res) => { if (chunk.includes('"ready"')) res.writableEnded = true; });
    const cutReq = makeReq("sse-cut-client", liveSession);
    handler(cutReq, cutRes, () => undefined);
    publishProjectSaved("owner-1", "p1", liveRevision + 6, "other-client");
    publishProjectSaved("owner-1", "p1", liveRevision + 7, "other-client");
    await settle();
    check("flush 中途被关掉后写到 ready 为止", frames(cutRes).map((frame) => frame.type).join(","), `project.saved,ready`);
    check("结束后的补发被静默丢弃而不是抛错", cutRes.chunks.some((chunk) => chunk.startsWith("json:")), false);
    cutReq.fireClose();
    check("被中途关掉的连接同样不再登记", disconnectShare("owner-1", "p1", editor.share.id), 0);

    // 读库这段 await 里对端就走了：清理必须已经挂上，否则 listener 与 Presence 会永久留在内存里。
    const goneRes = makeRes();
    const goneReq = makeReq("sse-gone-client", liveSession);
    handler(goneReq, goneRes, () => undefined);
    updateProjectPresence("owner-1", "p1", actorOf(liveSession.actorId), { clientId: "sse-gone-client", nodeIds: [], activity: "idle" });
    goneRes.writableEnded = true;
    goneReq.fireClose();
    await settle();
    check("读库期间断开的连接已经退订", disconnectShare("owner-1", "p1", editor.share.id), 0);
    check("读库期间断开的连接不留 Presence", listProjectPresence("owner-1", "p1").some((item) => item.clientId === "sse-gone-client"), false);
    publishProjectSaved("owner-1", "p1", liveRevision + 8, "other-client");
    await settle();
    check("断开后的事件不会再写进这条连接", frames(goneRes).length, 0);

    // 分享自然到期时不会再经过 PATCH 路由，必须由已经建立的长连接自己按 expiresAt 收权。
    // SSE 与 WebSocket 都要主动清理订阅；只等 guest token 过期会让不断线的客户端继续收到画布更新。
    let immediateExpiryCalled = false;
    const cancelImmediateExpiry = scheduleShareExpiry(new Date(Date.now() - 1000).toISOString(), () => { immediateExpiryCalled = true; });
    check("已到期分享不会在响应构建栈内同步收权", immediateExpiryCalled, false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("已到期分享会在下一事件循环收权", immediateExpiryCalled, true);
    cancelImmediateExpiry();
    const expiring = await createShare("owner-1", "p1", {
        role: "editor",
        allowAnonymous: true,
        allowClone: false,
        ownerPays: true,
        allowAnonymousEdit: true,
        expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const expiringSession = guestSessionOf(expiring.share, { accountId: "", actorId: "", displayName: "", avatarUrl: "" });
    const websocketFrames: Array<{ type: string; payload?: { reason?: string } }> = [];
    let websocketClosed = false;
    await openRealtimeChannel({
        identity: { userId: "", displayName: "", avatarUrl: "", guest: expiringSession },
        id: "expiring-project",
        channel: "project:p1",
        payload: { clientId: "ws-expiring-client", sinceRevision: 0 },
        send: (frame) => websocketFrames.push(frame as { type: string; payload?: { reason?: string } }),
        onClosed: () => { websocketClosed = true; },
    });
    const expiringRes = makeRes();
    const expiringReq = makeReq("sse-expiring-client", expiringSession);
    handler(expiringReq, expiringRes, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    check("分享自然过期后 WebSocket 频道主动关闭", websocketClosed, true);
    check("分享自然过期后 WebSocket 发出撤销帧", websocketFrames.some((frame) => frame.type === "unsubscribed" && frame.payload?.reason === "REVOKED"), true);
    check("分享自然过期后 SSE 主动结束", expiringRes.writableEnded, true);
    check("分享自然过期后实时订阅已清理", disconnectShare("owner-1", "p1", expiring.share.id), 0);

    console.log("哪些改动会收权");
    // 断流条件此前散在路由里没法直接测，导致「关掉匿名不断流」漏到了合并之后。
    const revokeBase = await shares.findOneByOrFail({ id: viewerShare.id });
    const withPatch = (patch: Partial<typeof revokeBase>) => ({ ...revokeBase, ...patch });
    check("撤销要断流", shareRevokesAccess(revokeBase, withPatch({ enabled: false })), true);
    check("降级为只读要断流", shareRevokesAccess({ ...revokeBase, role: "editor" }, withPatch({ role: "viewer" })), true);
    check("关掉匿名要断流", shareRevokesAccess({ ...revokeBase, allowAnonymous: true }, withPatch({ allowAnonymous: false })), true);
    check("改成已过期要断流", shareRevokesAccess(revokeBase, withPatch({ expiresAt: new Date(Date.now() - 1000).toISOString() })), true);
    check("放开匿名不必断流", shareRevokesAccess({ ...revokeBase, allowAnonymous: false }, withPatch({ allowAnonymous: true })), false);
    check("升级为可编辑要断流并立即重换权限", shareRevokesAccess({ ...revokeBase, role: "viewer" }, withPatch({ role: "editor" })), true);
    check("开启房主代扣要断流并刷新计费策略", shareRevokesAccess({ ...revokeBase, ownerPays: false }, withPatch({ ownerPays: true })), true);
    check("关闭房主代扣要断流并刷新计费策略", shareRevokesAccess({ ...revokeBase, ownerPays: true }, withPatch({ ownerPays: false })), true);
    check("开启匿名编辑要断流并立即提权", shareRevokesAccess({ ...revokeBase, allowAnonymousEdit: false }, withPatch({ allowAnonymousEdit: true })), true);
    check("修改有效期要断流并重建到期计时器", shareRevokesAccess(revokeBase, withPatch({ expiresAt: new Date(Date.now() + 600_000).toISOString() })), true);
    check("只改允许克隆不必断流", shareRevokesAccess(revokeBase, withPatch({ allowClone: !revokeBase.allowClone })), false);

    console.log("访问日志节流");
    resetShareRuntimeState();
    const base = Date.parse("2026-08-02T00:00:00.000Z");
    const record = (event: "open" | "edit" | "clone", at: number, actorId = editorSession.actorId) => logShareAccess(editor.share, { actorId, isAnonymous: true, event, ip: "203.0.113.9", userAgent: "smoke-agent" }, at);
    await record("open", base);
    await record("open", base + 1000);
    await record("open", base + 60_000);
    check("同一访客连续打开只落一条", await logs.countBy({ shareId: editor.share.id, event: "open" }), 1);
    await record("open", base + 5 * 60_000 + 1);
    check("超过 5 分钟后再落一条", await logs.countBy({ shareId: editor.share.id, event: "open" }), 2);
    await record("open", base + 6 * 60_000, "guest:other");
    check("换一个访客单独计节流", await logs.countBy({ shareId: editor.share.id, event: "open" }), 3);
    await record("edit", base);
    await record("edit", base + 1000);
    check("编辑事件同样节流", await logs.countBy({ shareId: editor.share.id, event: "edit" }), 1);
    await record("clone", base);
    await record("clone", base + 1000);
    await record("clone", base + 2000);
    check("克隆事件不节流", await logs.countBy({ shareId: editor.share.id, event: "clone" }), 3);
    check("日志只存 IP 哈希", (await logs.findOneByOrFail({ shareId: editor.share.id, event: "clone" })).ipHash.includes("203.0.113.9"), false);
    check("日志记下了访问来源", (await logs.findOneByOrFail({ shareId: editor.share.id, event: "clone" })).userAgent, "smoke-agent");

    console.log("访客上传");
    resetShareRuntimeState();
    // 复刻 POST /v1/files 里访客分支的三步：按 projectId 判权 → 访客限流 → 以所有者身份落库。
    // 路由本身只是这三步的拼装，语义都在服务层，端到端只能看到状态码。
    const guestUpload = async (ctx: typeof editorCtx | typeof viewerCtx, body: Buffer) => {
        const access = await resolveProjectAccess(ctx, "p1", "write");
        assertShareUploadAllowed(access.share!.id, access.actorId, body.length);
        return saveFile(access.ownerId, body, "image/png");
    };
    const uploadPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fxQ8gAAAABJRU5ErkJggg==", "base64");
    const ownerFilesBefore = await files.countBy({ userId: "owner-1" });
    const guestUsedBefore = await files.countBy({ userId: editorSession.actorId });
    const uploaded = await guestUpload(editorCtx, uploadPng);
    check("可编辑访客能上传", Boolean(uploaded.id), true);
    check("上传的文件记在所有者名下", (await files.findOneByOrFail({ id: uploaded.id })).userId, "owner-1");
    check("所有者名下多出一条文件记录", await files.countBy({ userId: "owner-1" }), ownerFilesBefore + 1);
    check("访客名下不留文件记录", await files.countBy({ userId: editorSession.actorId }), guestUsedBefore);
    check("上传计的是所有者的用量", (await storageOf("owner-1")).used > (await storageOf(editorSession.actorId)).used, true);
    check("只读访客上传被拒", await status(() => guestUpload(viewerCtx, uploadPng)), 403);
    check("只读访客上传有稳定错误码", await codeOf(() => guestUpload(viewerCtx, uploadPng)), "SHARE_READ_ONLY");
    check("只读访客被拒后没留下文件", await files.countBy({ userId: "owner-1" }), ownerFilesBefore + 1);
    resetShareRuntimeState();
    for (let index = 0; index < 20; index += 1) assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1);
    check("超过频次上限的访客上传被拒", await status(() => guestUpload(editorCtx, uploadPng)), 429);
    check("被限流的上传不会落库", await files.countBy({ userId: "owner-1" }), ownerFilesBefore + 1);

    console.log("访客上传限流");
    resetShareRuntimeState();
    for (let index = 0; index < 20; index += 1) assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1024, base);
    check("第 21 次上传被限流", await status(async () => assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1024, base)), 429);
    check("限流有稳定错误码", await codeOf(async () => assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1024, base)), "RATE_LIMITED");
    check("换一个访客不受影响", await status(async () => assertShareUploadAllowed(editor.share.id, "guest:other", 1024, base)), 200);
    check("窗口过去后恢复", await status(async () => assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1024, base + 10 * 60_000 + 1)), 200);
    resetShareRuntimeState();
    assertShareUploadAllowed(editor.share.id, editorSession.actorId, 100 << 20, base);
    check("超过总字节上限被限流", await status(async () => assertShareUploadAllowed(editor.share.id, editorSession.actorId, 1, base)), 429);

    console.log("克隆");
    resetShareRuntimeState();
    const cloneShare = await createShare("owner-1", "p1", { role: "viewer", allowAnonymous: true, allowClone: true, expiresAt: "" });
    const blobsBefore = await blobs.count();
    const objectsBefore = await blobs.find();
    const cloned = await cloneSharedProject(cloneShare.share, "cloner");
    const clonedRow = await projects.findOneByOrFail({ userId: "cloner", projectId: cloned.id });
    check("副本归克隆者所有", clonedRow.userId, "cloner");
    check("副本 revision 从 1 开始", clonedRow.revision, 1);
    check("副本标题带「的副本」", clonedRow.title.endsWith("的副本"), true);
    const clonedIds = Array.from(clonedRow.data.matchAll(/server:(file-[\w-]+)/g), (matched) => matched[1]);
    check("副本引用了两个文件", clonedIds.length, 2);
    check("副本里的 fileId 全部换成新的", clonedIds.some((id) => id === fileA.id || id === fileB.id), false);
    const clonedFiles = await files.find({ where: clonedIds.map((id) => ({ id })) });
    check("新文件记录都属于克隆者", clonedFiles.every((file) => file.userId === "cloner"), true);
    check("新文件记录指向同一份物理对象", clonedFiles.map((file) => file.path).sort().join(","), [fileA.path, fileB.path].sort().join(","));
    check("克隆不新增物理对象", await blobs.count(), blobsBefore);
    check("克隆不复制字节", (await blobs.find()).map((blob) => Number(blob.bytes)).reduce((sum, value) => sum + value, 0), objectsBefore.map((blob) => Number(blob.bytes)).reduce((sum, value) => sum + value, 0));
    check("物理对象引用计数按新引用增加", (await blobs.findOneByOrFail({ checksum: fileA.checksum })).refCount, 2);
    check("克隆写下一条 clone 日志", await logs.countBy({ shareId: cloneShare.share.id, event: "clone" }), 1);

    const tightFiles = await files.countBy({ userId: "cloner-tight" });
    check("配额不足的克隆被拒绝", await status(() => cloneSharedProject(cloneShare.share, "cloner-tight")), 403);
    check("配额不足时不留下文件记录", await files.countBy({ userId: "cloner-tight" }), tightFiles);
    check("配额不足时不留下画布", await projects.countBy({ userId: "cloner-tight" }), 0);
    check("配额不足时引用计数没有被改坏", (await blobs.findOneByOrFail({ checksum: fileA.checksum })).refCount, 2);

    const noClone = await createShare("owner-1", "p1", { role: "viewer", allowAnonymous: true, allowClone: false, expiresAt: "" });
    check("不允许克隆的分享被拒绝", await codeOf(() => cloneSharedProject(noClone.share, "cloner")), "CLONE_DISABLED");
    check("匿名不能克隆", await codeOf(() => cloneSharedProject(cloneShare.share, "")), "FORBIDDEN");

    // 克隆者已经有同内容的文件时复用自己的引用，不该给同一份内容再记一次账。
    const usedBeforeRepeat = await files.countBy({ userId: "cloner" });
    await cloneSharedProject(cloneShare.share, "cloner");
    check("重复克隆复用克隆者已有的文件引用", await files.countBy({ userId: "cloner" }), usedBeforeRepeat);
    check("重复克隆不会重复增加引用计数", (await blobs.findOneByOrFail({ checksum: fileA.checksum })).refCount, 2);

    // 同一画布可能在团队解散、旧数据导入等场景里出现两个 fileId 指向同一 checksum。
    // 克隆必须把它们都改写到克隆者的一条逻辑文件，不能撞唯一约束导致整张画布无法保存。
    const duplicateSource = files.create({ ...fileA, id: "file-owner-duplicate", teamId: "", dedupeKey: "legacy-scope", bytes: Number(fileA.bytes), createdAt: now() });
    await files.insert(duplicateSource);
    await blobs.increment({ checksum: fileA.checksum }, "refCount", 1);
    await saveProject("owner-1", {
        id: "p-duplicate",
        title: "同图多引用",
        data: { nodes: [{ id: "same-a", type: "image", metadata: { storageKey: `server:${fileA.id}` } }, { id: "same-b", type: "image", metadata: { storageKey: `server:${duplicateSource.id}` } }], connections: [] },
        revision: 0,
        clientId: "verify-owner-duplicate",
    });
    const duplicateShare = await createShare("owner-1", "p-duplicate", { role: "viewer", allowAnonymous: true, allowClone: true, expiresAt: "" });
    const duplicateClone = await cloneSharedProject(duplicateShare.share, "cloner-duplicate");
    const duplicateCloneRow = await projects.findOneByOrFail({ userId: "cloner-duplicate", projectId: duplicateClone.id });
    const duplicateCloneIds = Array.from(duplicateCloneRow.data.matchAll(/server:(file-[\w-]+)/g), (matched) => matched[1]);
    check("同 checksum 的多个源 fileId 克隆后仍保留全部节点引用", duplicateCloneIds.length, 2);
    check("同 checksum 的多个源 fileId 复用克隆者同一 fileId", new Set(duplicateCloneIds).size, 1);
    check("同 checksum 的多个源 fileId 只新增一条逻辑文件", await files.countBy({ userId: "cloner-duplicate" }), 1);

    // 画布数据可由访客编辑，不能把外部账号的 fileId 原样带进副本，也不能只复制一半后留下半成品。
    const validOwnerFile = await saveFile("owner-1", Buffer.from("valid owner clone file"), "image/png");
    const foreignFile = await saveFile("stranger", Buffer.from("foreign clone file"), "image/png");
    await saveProject("owner-1", {
        id: "p-foreign-file",
        title: "夹带外部文件",
        data: {
            nodes: [
                { id: "valid", type: "image", metadata: { storageKey: `server:${validOwnerFile.id}` } },
                { id: "foreign", type: "image", metadata: { storageKey: `server:${foreignFile.id}` } },
            ],
            connections: [],
        },
        revision: 0,
        clientId: "verify-foreign-file",
    });
    const foreignShare = await createShare("owner-1", "p-foreign-file", { role: "viewer", allowAnonymous: true, allowClone: true, expiresAt: "" });
    const clonerFilesBeforeForeign = await files.countBy({ userId: "cloner" });
    const clonerProjectsBeforeForeign = await projects.countBy({ userId: "cloner" });
    check("夹带外部账号 fileId 的画布拒绝克隆", await status(() => cloneSharedProject(foreignShare.share, "cloner")), 400);
    check("拒绝外部 fileId 时不留下文件", await files.countBy({ userId: "cloner" }), clonerFilesBeforeForeign);
    check("拒绝外部 fileId 时不留下画布", await projects.countBy({ userId: "cloner" }), clonerProjectsBeforeForeign);

    // 房主从云空间删掉生成图后，画布仍能靠 GenerationOutput 的历史引用显示。
    // 克隆必须把这份历史媒体转成克隆者自己的 StoredFile；继续引用房主 fileId 会在历史到期后破图，且绕过克隆者配额。
    const historyFile = await saveFile("owner-1", Buffer.from("history-only clone image"), "image/png");
    const historyJob = jobs.create({
        id: "job-history-only-clone",
        userId: "owner-1",
        storageUserId: "owner-1",
        payerUserId: "owner-1",
        shareId: "",
        clientJobId: "client-history-only-clone",
        kind: "image",
        status: "succeeded",
        model: "image-model",
        prompt: "history clone",
        params: "{}",
        inputFileIds: [],
        outputFileIds: [historyFile.id],
        text: "",
        context: {},
        error: "",
        credits: 1,
        progress: 100,
        seq: 1,
        upstreamTaskId: "",
        payerKind: "user",
        payerTeamId: "",
        payerLogId: "",
        storageTeamId: "",
        createdAt: now(),
        updatedAt: now(),
        finishedAt: now(),
    });
    await jobs.insert(historyJob);
    await archiveJobOutputs(historyJob);
    await saveProject("owner-1", {
        id: "p-history-only",
        title: "仅历史媒体",
        data: { nodes: [{ id: "history-image", type: "image", metadata: { storageKey: `server:${historyFile.id}` } }], connections: [] },
        revision: 0,
        clientId: "verify-history-only",
    });
    await deleteFile(historyFile.id, "owner-1");
    check("仅历史媒体的原云文件已删除", await files.countBy({ id: historyFile.id }), 0);
    const historyShare = await createShare("owner-1", "p-history-only", { role: "viewer", allowAnonymous: true, allowClone: true, expiresAt: "" });
    const historyClone = await cloneSharedProject(historyShare.share, "cloner");
    const historyCloneRow = await projects.findOneByOrFail({ userId: "cloner", projectId: historyClone.id });
    const historyCloneId = Array.from(historyCloneRow.data.matchAll(/server:(file-[\w-]+)/g), (matched) => matched[1])[0];
    check("仅历史媒体克隆后换成克隆者 fileId", historyCloneId === historyFile.id, false);
    const historyCloneFile = await files.findOneByOrFail({ id: historyCloneId, userId: "cloner" });
    check("仅历史媒体克隆后仍指向同一物理对象", historyCloneFile.checksum, historyFile.checksum);
    await deleteGenerationHistoryJob(historyJob.id);
    check("房主历史删除后克隆媒体仍保持 active", (await blobs.findOneByOrFail({ checksum: historyFile.checksum })).state, "active");
    check("房主历史删除后克隆者文件仍存在", await files.countBy({ id: historyCloneId, userId: "cloner" }), 1);

    await saveProject("owner-1", { id: "p1", title: "源画布改了", data: { nodes: [], connections: [] }, revision: (await projects.findOneByOrFail({ userId: "owner-1", projectId: "p1" })).revision, clientId: "verify-owner" });
    check("源画布后续修改不影响副本", (await projects.findOneByOrFail({ userId: "cloner", projectId: cloned.id })).data.includes(clonedIds[0]), true);

    finish(env.root);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
