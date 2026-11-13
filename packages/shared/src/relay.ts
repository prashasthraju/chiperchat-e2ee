// Wire types between the relay transport (packages/crypto) and the relay
// routes (apps/server). Key material is opaque base64 produced by the SDK.

export type RelayDeviceId = number;

export type WireCiphertext =
  | { kind: "string"; value: string }
  | { kind: "bytes"; value: string };

export interface WireEnvelope {
  id: string;
  targetUserId: string;
  targetDeviceId: number;
  senderUserId: string;
  senderDeviceId: number;
  ciphertext: WireCiphertext;
  messageType:
    | "ciphertext"
    | "prekey_bundle"
    | "sender_key"
    | "unidentified_sender"
    | "retry_request";
  deliveryClass: "user-visible" | "background-sync" | "ephemeral";
  contentKind?: "message" | "receipt";
  timestamp: number;
  serverTimestamp: number;
  clientMessageId?: string;
  operationEpochMilliseconds?: number;
  declaredDeviceIds?: number[];
  recipientRegistrationId?: number;
  contentHint?: number;
}

export type SendEnvelopeRequest = Omit<WireEnvelope, "id" | "serverTimestamp">;

export interface SendEnvelopeResponse {
  messageId: string;
  serverTimestamp: number;
  duplicate: boolean;
  deviceSetChecked?: true;
}

export interface WireIdentity {
  version: 1;
  x25519PublicKey: string;
  ed25519PublicKey: string;
}

export interface ProvisionIdentityRequest {
  deviceId: number;
  registrationId: number;
  identity: WireIdentity;
}

export type WirePreKeyType =
  | "ecPreKey"
  | "ecSignedPreKey"
  | "kemOneTimePreKey"
  | "kemLastResortPreKey";

export interface WirePreKeyUpload {
  type: WirePreKeyType;
  keyId: number;
  publicKey: string;
  signature?: string;
}

export interface UploadPreKeysRequest {
  deviceId: number;
  keys: WirePreKeyUpload[];
}

export interface WirePreKeyMetadata {
  keyId: number;
  createdAt: number;
  expiresAt: number;
  publicKey: string;
}

export interface WirePreKeyInventory {
  ecSignedPreKey: WirePreKeyMetadata | null;
  kemLastResortPreKey: WirePreKeyMetadata | null;
  ecOneTimePreKeyCount: number;
  kemOneTimePreKeyCount: number;
}

interface WireSignedKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface WirePreKeyBundle {
  registrationId: number;
  deviceId: number;
  identity: WireIdentity;
  ecSignedPreKey: WireSignedKey;
  ecOneTimePreKey: { keyId: number; publicKey: string } | null;
  kemLastResortPreKey: WireSignedKey;
  kemOneTimePreKey: WireSignedKey | null;
}

export interface WireDeviceInfo {
  deviceId: number;
  registered: true;
  linked: boolean;
  enabled: true;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface RegisterDeviceResponse {
  deviceId: number;
}

// Socket.IO mailbox events.
export const MAILBOX_ENVELOPE_EVENT = "mailbox:envelope";
export const MAILBOX_ACK_EVENT = "mailbox:ack";

export interface RelayErrorBody {
  code: string;
  message: string;
  data?: unknown;
}
