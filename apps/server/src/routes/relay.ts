import { Router, type Request } from "express";
import { z } from "zod";
import type {
  ProvisionIdentityRequest,
  RegisterDeviceResponse,
  SendEnvelopeRequest,
  UploadPreKeysRequest
} from "@cipherchat/shared";
import { HttpError } from "../lib/http-error.js";
import { authedUserId, requireAuth } from "../middleware/auth.js";
import * as relay from "../services/relay.js";

const deviceId = z.coerce.number().int().min(1).max(5);
const userId = z.string().min(1).max(64);
const base64 = z.string().min(1).max(8192);

const identity = z.object({
  version: z.literal(1),
  x25519PublicKey: base64,
  ed25519PublicKey: base64
});

const provisionIdentity = z.object({
  deviceId,
  registrationId: z.number().int().min(0),
  identity
});

const preKeyUpload = z.object({
  type: z.enum(["ecPreKey", "ecSignedPreKey", "kemOneTimePreKey", "kemLastResortPreKey"]),
  keyId: z.number().int().min(0),
  publicKey: base64,
  signature: base64.optional()
});

const uploadPreKeys = z.object({
  deviceId,
  keys: z.array(preKeyUpload).max(1000)
});

const envelope = z.object({
  targetUserId: userId,
  targetDeviceId: deviceId,
  senderUserId: userId,
  senderDeviceId: deviceId,
  ciphertext: z.object({
    kind: z.enum(["string", "bytes"]),
    value: z.string().max(1_000_000)
  }),
  messageType: z.enum([
    "ciphertext",
    "prekey_bundle",
    "sender_key",
    "unidentified_sender",
    "retry_request"
  ]),
  deliveryClass: z.enum(["user-visible", "background-sync", "ephemeral"]),
  contentKind: z.enum(["message", "receipt"]).optional(),
  timestamp: z.number(),
  clientMessageId: z.string().min(1).max(128).optional(),
  operationEpochMilliseconds: z.number().optional(),
  declaredDeviceIds: z.array(deviceId).max(5).optional(),
  recipientRegistrationId: z.number().int().optional(),
  contentHint: z.number().int().optional()
});

// zod types optional keys as `T | undefined`, which the shared interfaces
// (exactOptionalPropertyTypes) do not accept, so parsed bodies are asserted.
function parseBody<T>(schema: z.ZodType, req: Request): T {
  return schema.parse(req.body) as T;
}

export const relayRouter = Router();

relayRouter.use(requireAuth);

relayRouter.post("/devices", async (req, res) => {
  const { deviceId: requested } = z
    .object({ deviceId: deviceId.optional() })
    .parse(req.body ?? {});

  const body: RegisterDeviceResponse = {
    deviceId: await relay.registerDevice(authedUserId(res), requested)
  };
  res.status(201).json(body);
});

// Wipes the caller's devices, prekeys and identity (used after losing local keys).
relayRouter.delete("/devices", async (_req, res) => {
  await relay.removeAllDevices(authedUserId(res));
  res.status(204).end();
});

relayRouter.delete("/devices/:deviceId", async (req, res) => {
  await relay.removeDevice(authedUserId(res), deviceId.parse(req.params["deviceId"]));
  res.status(204).end();
});

relayRouter.get("/users/:userId/devices", async (req, res) => {
  res.json(await relay.listDevices(userId.parse(req.params["userId"])));
});

relayRouter.get("/users/:userId/identity", async (req, res) => {
  const found = await relay.getIdentity(userId.parse(req.params["userId"]));
  if (!found) throw new HttpError(404, "NOT_FOUND", "No identity for that user");
  res.json(found);
});

relayRouter.put("/identity", async (req, res) => {
  await relay.provisionIdentity(
    authedUserId(res),
    parseBody<ProvisionIdentityRequest>(provisionIdentity, req)
  );
  res.status(204).end();
});

relayRouter.post("/prekeys", async (req, res) => {
  const body = parseBody<UploadPreKeysRequest>(uploadPreKeys, req);
  await relay.uploadPreKeys(authedUserId(res), body.deviceId, body.keys);
  res.status(204).end();
});

// POST because fetching a bundle consumes one-time prekeys.
relayRouter.post("/users/:userId/devices/:deviceId/bundle", async (req, res) => {
  const bundle = await relay.fetchPreKeyBundle(
    userId.parse(req.params["userId"]),
    deviceId.parse(req.params["deviceId"])
  );
  if (!bundle) throw new HttpError(404, "NOT_FOUND", "No prekey bundle available");
  res.json(bundle);
});

relayRouter.get("/devices/:deviceId/prekeys/inventory", async (req, res) => {
  res.json(
    await relay.getPreKeyInventory(
      authedUserId(res),
      deviceId.parse(req.params["deviceId"])
    )
  );
});

relayRouter.post("/devices/:deviceId/prekeys/clear-stale-kem", async (req, res) => {
  const cleared = await relay.clearStaleKemPreKeys(
    authedUserId(res),
    deviceId.parse(req.params["deviceId"])
  );
  res.json({ cleared });
});

relayRouter.post("/messages", async (req, res) => {
  res.json(
    await relay.sendEnvelope(
      authedUserId(res),
      parseBody<SendEnvelopeRequest>(envelope, req)
    )
  );
});
