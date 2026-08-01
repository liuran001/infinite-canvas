import { Router } from "express";

import { handle, ok } from "../lib/response";
import { requireUser, userAuth } from "../middleware/auth";
import { deletePasskey, listPasskeys, passkeyLoginOptions, passkeyLoginVerify, passkeyRegisterOptions, passkeyRegisterVerify, renamePasskey } from "../services/passkey";

export const passkeyRouter = Router();

passkeyRouter.post("/auth/passkey/login/options", handle(async (req, res) => ok(res, await passkeyLoginOptions(req, String(req.body?.username || "")))));

passkeyRouter.post("/auth/passkey/login/verify", handle(async (req, res) => ok(res, await passkeyLoginVerify(req, String(req.body?.flowId || ""), req.body?.response))));

passkeyRouter.post("/auth/passkey/register/options", userAuth, handle(async (req, res) => ok(res, await passkeyRegisterOptions(req, requireUser(req).id))));

passkeyRouter.post(
    "/auth/passkey/register/verify",
    userAuth,
    handle(async (req, res) => ok(res, await passkeyRegisterVerify(req, requireUser(req).id, req.body?.response, String(req.body?.name || "")))),
);

passkeyRouter.get("/auth/passkeys", userAuth, handle(async (req, res) => ok(res, await listPasskeys(requireUser(req).id))));

passkeyRouter.put("/auth/passkeys/:id", userAuth, handle(async (req, res) => ok(res, await renamePasskey(requireUser(req).id, String(req.params.id), String(req.body?.name || "")))));

passkeyRouter.delete(
    "/auth/passkeys/:id",
    userAuth,
    handle(async (req, res) => {
        await deletePasskey(requireUser(req).id, String(req.params.id));
        ok(res, true);
    }),
);
