import { pool } from "../config/db.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username      text PRIMARY KEY,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One composite identity per account. Every device of the account shares it.
CREATE TABLE IF NOT EXISTS identities (
  user_id            text PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  x25519_public_key  text NOT NULL,
  ed25519_public_key text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- registration_id stays NULL until the device provisions its identity, so
-- half-registered devices are never offered to senders.
CREATE TABLE IF NOT EXISTS devices (
  user_id         text NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  device_id       smallint NOT NULL CHECK (device_id BETWEEN 1 AND 5),
  registration_id integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz,
  PRIMARY KEY (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS prekeys (
  user_id    text NOT NULL,
  device_id  smallint NOT NULL,
  type       text NOT NULL CHECK (type IN
               ('ecPreKey', 'ecSignedPreKey', 'kemOneTimePreKey', 'kemLastResortPreKey')),
  key_id     integer NOT NULL,
  public_key text NOT NULL,
  signature  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, type, key_id),
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, device_id) ON DELETE CASCADE
);

-- Ciphertext waiting for a device to acknowledge it.
CREATE TABLE IF NOT EXISTS envelopes (
  id               text NOT NULL,
  target_user_id   text NOT NULL,
  target_device_id smallint NOT NULL,
  sender_user_id   text NOT NULL,
  payload          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (id, target_user_id, target_device_id),
  FOREIGN KEY (target_user_id, target_device_id) REFERENCES devices(user_id, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS envelopes_mailbox_idx
  ON envelopes (target_user_id, target_device_id, created_at, id);
`;

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA);
}
