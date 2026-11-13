import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  ProvisionIdentityRequest,
  SendEnvelopeRequest,
  SendEnvelopeResponse,
  WireDeviceInfo,
  WireEnvelope,
  WireIdentity,
  WirePreKeyBundle,
  WirePreKeyInventory,
  WirePreKeyMetadata,
  WirePreKeyType,
  WirePreKeyUpload
} from "@cipherchat/shared";
import { pool } from "../config/db.js";
import { HttpError } from "../lib/http-error.js";
import { pushEnvelope } from "./mailbox.js";

const MAX_DEVICES = 5;
const PREKEY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const ENVELOPE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ONE_TIME_PREKEYS_PER_TYPE = 500;

async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function deviceBelongsTo(
  userId: string,
  deviceId: number
): Promise<boolean> {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM devices WHERE user_id = $1 AND device_id = $2",
    [userId, deviceId]
  );
  return rowCount === 1;
}

async function assertOwnDevice(
  db: PoolClient | typeof pool,
  userId: string,
  deviceId: number
): Promise<void> {
  const { rowCount } = await db.query(
    "SELECT 1 FROM devices WHERE user_id = $1 AND device_id = $2",
    [userId, deviceId]
  );
  if (rowCount !== 1) {
    throw new HttpError(404, "NOT_FOUND", "Device is not registered");
  }
}

export async function touchDevice(userId: string, deviceId: number): Promise<void> {
  await pool.query(
    "UPDATE devices SET last_seen_at = now() WHERE user_id = $1 AND device_id = $2",
    [userId, deviceId]
  );
}

// Devices

export async function registerDevice(
  userId: string,
  requested?: number
): Promise<number> {
  if (requested !== undefined) {
    // Idempotent: a device that already exists keeps its id.
    await pool.query(
      "INSERT INTO devices (user_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, requested]
    );
    return requested;
  }

  // Try each free id with ON CONFLICT so two concurrent registrations cannot
  // claim the same one.
  for (let deviceId = 1; deviceId <= MAX_DEVICES; deviceId += 1) {
    const { rowCount } = await pool.query(
      `INSERT INTO devices (user_id, device_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, deviceId]
    );
    if (rowCount === 1) return deviceId;
  }

  throw new HttpError(409, "DEVICE_LIMIT", "Device limit reached");
}

export async function removeDevice(userId: string, deviceId: number): Promise<void> {
  await inTransaction(async (db) => {
    await db.query("DELETE FROM devices WHERE user_id = $1 AND device_id = $2", [
      userId,
      deviceId
    ]);

    const { rowCount } = await db.query("SELECT 1 FROM devices WHERE user_id = $1", [
      userId
    ]);
    // The identity belongs to the account's devices; with none left, a fresh
    // install may provision a new one.
    if (rowCount === 0) {
      await db.query("DELETE FROM identities WHERE user_id = $1", [userId]);
    }
  });
}

export async function removeAllDevices(userId: string): Promise<void> {
  await inTransaction(async (db) => {
    await db.query("DELETE FROM devices WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM identities WHERE user_id = $1", [userId]);
  });
}

export async function listDevices(userId: string): Promise<WireDeviceInfo[]> {
  const { rows } = await pool.query<{
    device_id: number;
    created_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT device_id, created_at, last_seen_at FROM devices
     WHERE user_id = $1 AND registration_id IS NOT NULL
     ORDER BY device_id`,
    [userId]
  );

  return rows.map((row) => ({
    deviceId: row.device_id,
    registered: true,
    linked: row.device_id > 1,
    enabled: true,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at?.getTime() ?? null
  }));
}

// Identity

export async function getIdentity(userId: string): Promise<WireIdentity | null> {
  const { rows } = await pool.query<{
    x25519_public_key: string;
    ed25519_public_key: string;
  }>("SELECT x25519_public_key, ed25519_public_key FROM identities WHERE user_id = $1", [
    userId
  ]);

  const row = rows[0];
  return row
    ? {
        version: 1,
        x25519PublicKey: row.x25519_public_key,
        ed25519PublicKey: row.ed25519_public_key
      }
    : null;
}

export async function provisionIdentity(
  userId: string,
  request: ProvisionIdentityRequest
): Promise<void> {
  const { deviceId, registrationId, identity } = request;

  await inTransaction(async (db) => {
    await assertOwnDevice(db, userId, deviceId);

    const existing = await db.query<{
      x25519_public_key: string;
      ed25519_public_key: string;
    }>(
      "SELECT x25519_public_key, ed25519_public_key FROM identities WHERE user_id = $1 FOR UPDATE",
      [userId]
    );

    const current = existing.rows[0];
    if (!current) {
      await db.query(
        `INSERT INTO identities (user_id, x25519_public_key, ed25519_public_key)
         VALUES ($1, $2, $3)`,
        [userId, identity.x25519PublicKey, identity.ed25519PublicKey]
      );
    } else if (
      current.x25519_public_key !== identity.x25519PublicKey ||
      current.ed25519_public_key !== identity.ed25519PublicKey
    ) {
      throw new HttpError(
        409,
        "IDENTITY_MISMATCH",
        "This account already has a different identity key"
      );
    }

    const device = await db.query<{ registration_id: number | null }>(
      "SELECT registration_id FROM devices WHERE user_id = $1 AND device_id = $2 FOR UPDATE",
      [userId, deviceId]
    );
    const previous = device.rows[0]?.registration_id ?? null;

    // A new registration id means the device was reinstalled. Its old
    // prekeys have no private halves any more.
    if (previous !== null && previous !== registrationId) {
      await db.query("DELETE FROM prekeys WHERE user_id = $1 AND device_id = $2", [
        userId,
        deviceId
      ]);
    }

    await db.query(
      "UPDATE devices SET registration_id = $3 WHERE user_id = $1 AND device_id = $2",
      [userId, deviceId, registrationId]
    );
  });
}

// Prekeys

export async function uploadPreKeys(
  userId: string,
  deviceId: number,
  keys: WirePreKeyUpload[]
): Promise<void> {
  await inTransaction(async (db) => {
    await assertOwnDevice(db, userId, deviceId);

    // Only the newest key of each reusable type is kept.
    const reusable = new Map<WirePreKeyType, WirePreKeyUpload>();
    const oneTime: WirePreKeyUpload[] = [];

    for (const key of keys) {
      if (key.type === "ecSignedPreKey" || key.type === "kemLastResortPreKey") {
        reusable.set(key.type, key);
      } else {
        oneTime.push(key);
      }
      if (key.type !== "ecPreKey" && !key.signature) {
        throw new HttpError(400, "INVALID_REQUEST", `${key.type} requires a signature`);
      }
    }

    for (const key of reusable.values()) {
      await db.query(
        "DELETE FROM prekeys WHERE user_id = $1 AND device_id = $2 AND type = $3",
        [userId, deviceId, key.type]
      );
      await insertPreKey(db, userId, deviceId, key);
    }

    for (const key of oneTime) {
      await insertPreKey(db, userId, deviceId, key);
    }

    for (const type of ["ecPreKey", "kemOneTimePreKey"] as const) {
      const { rows } = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM prekeys
         WHERE user_id = $1 AND device_id = $2 AND type = $3`,
        [userId, deviceId, type]
      );
      if ((rows[0]?.count ?? 0) > MAX_ONE_TIME_PREKEYS_PER_TYPE) {
        throw new HttpError(400, "TOO_MANY_PREKEYS", "Too many one-time prekeys stored");
      }
    }
  });
}

async function insertPreKey(
  db: PoolClient,
  userId: string,
  deviceId: number,
  key: WirePreKeyUpload
): Promise<void> {
  await db.query(
    `INSERT INTO prekeys (user_id, device_id, type, key_id, public_key, signature)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [userId, deviceId, key.type, key.keyId, key.publicKey, key.signature ?? null]
  );
}

interface PreKeyRow {
  key_id: number;
  public_key: string;
  signature: string | null;
}

async function consumeOneTimePreKey(
  db: PoolClient,
  userId: string,
  deviceId: number,
  type: WirePreKeyType
): Promise<PreKeyRow | undefined> {
  // SKIP LOCKED makes concurrent fetches take different keys, so a one-time
  // key is handed out at most once.
  const { rows } = await db.query<PreKeyRow>(
    `DELETE FROM prekeys
     WHERE (user_id, device_id, type, key_id) = (
       SELECT user_id, device_id, type, key_id FROM prekeys
       WHERE user_id = $1 AND device_id = $2 AND type = $3
       ORDER BY key_id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING key_id, public_key, signature`,
    [userId, deviceId, type]
  );
  return rows[0];
}

export async function fetchPreKeyBundle(
  userId: string,
  deviceId: number
): Promise<WirePreKeyBundle | null> {
  return inTransaction(async (db) => {
    const { rows } = await db.query<{
      registration_id: number;
      x25519_public_key: string;
      ed25519_public_key: string;
    }>(
      `SELECT d.registration_id, i.x25519_public_key, i.ed25519_public_key
       FROM devices d JOIN identities i ON i.user_id = d.user_id
       WHERE d.user_id = $1 AND d.device_id = $2 AND d.registration_id IS NOT NULL`,
      [userId, deviceId]
    );
    const device = rows[0];
    if (!device) return null;

    const reusable = async (type: WirePreKeyType) => {
      const result = await db.query<PreKeyRow>(
        `SELECT key_id, public_key, signature FROM prekeys
         WHERE user_id = $1 AND device_id = $2 AND type = $3
         ORDER BY created_at DESC LIMIT 1`,
        [userId, deviceId, type]
      );
      return result.rows[0];
    };

    const ecSigned = await reusable("ecSignedPreKey");
    const kemLastResort = await reusable("kemLastResortPreKey");
    if (!ecSigned?.signature || !kemLastResort?.signature) return null;

    const ecOneTime = await consumeOneTimePreKey(db, userId, deviceId, "ecPreKey");
    const kemOneTime = await consumeOneTimePreKey(
      db,
      userId,
      deviceId,
      "kemOneTimePreKey"
    );

    return {
      registrationId: device.registration_id,
      deviceId,
      identity: {
        version: 1,
        x25519PublicKey: device.x25519_public_key,
        ed25519PublicKey: device.ed25519_public_key
      },
      ecSignedPreKey: {
        keyId: ecSigned.key_id,
        publicKey: ecSigned.public_key,
        signature: ecSigned.signature
      },
      ecOneTimePreKey: ecOneTime
        ? { keyId: ecOneTime.key_id, publicKey: ecOneTime.public_key }
        : null,
      kemLastResortPreKey: {
        keyId: kemLastResort.key_id,
        publicKey: kemLastResort.public_key,
        signature: kemLastResort.signature
      },
      kemOneTimePreKey:
        kemOneTime?.signature
          ? {
              keyId: kemOneTime.key_id,
              publicKey: kemOneTime.public_key,
              signature: kemOneTime.signature
            }
          : null
    };
  });
}

export async function getPreKeyInventory(
  userId: string,
  deviceId: number
): Promise<WirePreKeyInventory> {
  await assertOwnDevice(pool, userId, deviceId);

  const reusable = async (type: WirePreKeyType): Promise<WirePreKeyMetadata | null> => {
    const { rows } = await pool.query<{
      key_id: number;
      public_key: string;
      created_ms: string;
    }>(
      `SELECT key_id, public_key,
              (extract(epoch FROM created_at) * 1000)::bigint AS created_ms
       FROM prekeys WHERE user_id = $1 AND device_id = $2 AND type = $3
       ORDER BY created_at DESC LIMIT 1`,
      [userId, deviceId, type]
    );
    const row = rows[0];
    if (!row) return null;
    const createdAt = Number(row.created_ms);
    return {
      keyId: row.key_id,
      publicKey: row.public_key,
      createdAt,
      expiresAt: createdAt + PREKEY_LIFETIME_MS
    };
  };

  const { rows } = await pool.query<{ type: WirePreKeyType; count: number }>(
    `SELECT type, count(*)::int AS count FROM prekeys
     WHERE user_id = $1 AND device_id = $2 AND type IN ('ecPreKey', 'kemOneTimePreKey')
     GROUP BY type`,
    [userId, deviceId]
  );
  const countOf = (type: WirePreKeyType) =>
    rows.find((row) => row.type === type)?.count ?? 0;

  return {
    ecSignedPreKey: await reusable("ecSignedPreKey"),
    kemLastResortPreKey: await reusable("kemLastResortPreKey"),
    ecOneTimePreKeyCount: countOf("ecPreKey"),
    kemOneTimePreKeyCount: countOf("kemOneTimePreKey")
  };
}

export async function clearStaleKemPreKeys(
  userId: string,
  deviceId: number
): Promise<number> {
  await assertOwnDevice(pool, userId, deviceId);
  const { rowCount } = await pool.query(
    `DELETE FROM prekeys
     WHERE user_id = $1 AND device_id = $2 AND type = 'kemOneTimePreKey'`,
    [userId, deviceId]
  );
  return rowCount ?? 0;
}

// Envelopes

export async function sendEnvelope(
  senderUserId: string,
  request: SendEnvelopeRequest
): Promise<SendEnvelopeResponse> {
  if (request.senderUserId !== senderUserId) {
    throw new HttpError(403, "FORBIDDEN", "Envelope sender does not match the caller");
  }
  if (!(await deviceBelongsTo(senderUserId, request.senderDeviceId))) {
    throw new HttpError(403, "FORBIDDEN", "Sender device is not registered");
  }

  const { rows: targetDevices } = await pool.query<{
    device_id: number;
    registration_id: number;
  }>(
    `SELECT device_id, registration_id FROM devices
     WHERE user_id = $1 AND registration_id IS NOT NULL`,
    [request.targetUserId]
  );
  const target = targetDevices.find((row) => row.device_id === request.targetDeviceId);

  if (!target) {
    throw new HttpError(404, "NOT_FOUND", "Recipient device not found");
  }

  if (
    request.recipientRegistrationId !== undefined &&
    request.recipientRegistrationId !== target.registration_id
  ) {
    const message = "The recipient device was reinstalled";
    throw new HttpError(409, "STALE_DEVICE", message, {
      code: "STALE_DEVICE",
      staleDevices: [request.targetDeviceId],
      reason: "device_reinstalled",
      message
    });
  }

  let deviceSetChecked = false;
  if (request.declaredDeviceIds !== undefined) {
    const actual = targetDevices.map((row) => row.device_id).sort((a, b) => a - b);
    const declared = [...request.declaredDeviceIds].sort((a, b) => a - b);
    if (
      actual.length !== declared.length ||
      actual.some((id, index) => id !== declared[index])
    ) {
      throw new HttpError(
        409,
        "DEVICE_SET_MISMATCH",
        "The declared device set differs from the recipient's devices",
        { deviceIds: actual }
      );
    }
    deviceSetChecked = true;
  }

  const serverTimestamp = Date.now();
  const messageId = request.clientMessageId ?? randomUUID();
  const envelope: WireEnvelope = { ...request, id: messageId, serverTimestamp };

  if (request.deliveryClass === "ephemeral") {
    // Live-only: delivered if the device is connected, never stored.
    pushEnvelope(request.targetUserId, request.targetDeviceId, envelope);
    return { messageId, serverTimestamp, duplicate: false, ...(deviceSetChecked && { deviceSetChecked: true as const }) };
  }

  const inserted = await pool.query(
    `INSERT INTO envelopes
       (id, target_user_id, target_device_id, sender_user_id, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::double precision * interval '1 millisecond')
     ON CONFLICT DO NOTHING`,
    [
      messageId,
      request.targetUserId,
      request.targetDeviceId,
      senderUserId,
      JSON.stringify(envelope),
      ENVELOPE_RETENTION_MS
    ]
  );

  const duplicate = inserted.rowCount === 0;
  if (duplicate) {
    const { rows } = await pool.query<{ sender_user_id: string }>(
      `SELECT sender_user_id FROM envelopes
       WHERE id = $1 AND target_user_id = $2 AND target_device_id = $3`,
      [messageId, request.targetUserId, request.targetDeviceId]
    );
    // Same id from another sender is a collision, not a retry.
    if (rows[0] && rows[0].sender_user_id !== senderUserId) {
      throw new HttpError(409, "MESSAGE_ID_CONFLICT", "Message id already in use");
    }
  } else {
    pushEnvelope(request.targetUserId, request.targetDeviceId, envelope);
  }

  return {
    messageId,
    serverTimestamp,
    duplicate,
    ...(deviceSetChecked && { deviceSetChecked: true as const })
  };
}

export async function purgeExpiredEnvelopes(): Promise<void> {
  await pool.query("DELETE FROM envelopes WHERE expires_at < now()");
}
