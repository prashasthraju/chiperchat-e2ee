import type { Server, Socket } from "socket.io";
import { MAILBOX_ENVELOPE_EVENT, type WireEnvelope } from "@cipherchat/shared";
import { pool } from "../config/db.js";

const PAGE_SIZE = 200;

let io: Server | undefined;

const roomOf = (userId: string, deviceId: number) => `mailbox:${userId}:${deviceId}`;

export function attachMailbox(server: Server): void {
  io = server;
}

export function joinMailbox(socket: Socket, userId: string, deviceId: number): void {
  void socket.join(roomOf(userId, deviceId));
}

export function pushEnvelope(
  userId: string,
  deviceId: number,
  envelope: WireEnvelope
): void {
  io?.to(roomOf(userId, deviceId)).emit(MAILBOX_ENVELOPE_EVENT, envelope);
}

// Replays everything still unacknowledged, oldest first. Called after the
// socket has joined its room, so an envelope arriving meanwhile may be sent
// twice; the SDK deduplicates on the envelope id.
export async function flushMailbox(
  socket: Socket,
  userId: string,
  deviceId: number
): Promise<void> {
  // created_at is carried as text: a JS Date would truncate microseconds.
  let cursor: { createdAt: string; id: string } | undefined;

  for (;;) {
    const { rows } = await pool.query<{
      id: string;
      created_text: string;
      payload: WireEnvelope;
    }>(
      `SELECT id, created_at::text AS created_text, payload FROM envelopes
       WHERE target_user_id = $1 AND target_device_id = $2
         AND expires_at > now()
         AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4))
       ORDER BY created_at, id
       LIMIT ${PAGE_SIZE}`,
      [userId, deviceId, cursor?.createdAt ?? null, cursor?.id ?? ""]
    );

    for (const row of rows) {
      socket.emit(MAILBOX_ENVELOPE_EVENT, row.payload);
    }

    const last = rows[rows.length - 1];
    if (!last || rows.length < PAGE_SIZE) return;
    cursor = { createdAt: last.created_text, id: last.id };
  }
}

export async function acknowledgeEnvelopes(
  userId: string,
  deviceId: number,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `DELETE FROM envelopes
     WHERE target_user_id = $1 AND target_device_id = $2 AND id = ANY($3::text[])`,
    [userId, deviceId, ids]
  );
}
