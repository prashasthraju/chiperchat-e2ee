import { io, type Socket } from "socket.io-client";
import {
  MAILBOX_ACK_EVENT,
  MAILBOX_ENVELOPE_EVENT,
  type RegisterDeviceResponse,
  type SendEnvelopeRequest,
  type SendEnvelopeResponse,
  type UploadPreKeysRequest,
  type WireDeviceInfo,
  type WireEnvelope,
  type WireIdentity,
  type WirePreKeyBundle,
  type WirePreKeyInventory
} from "@cipherchat/shared";
import type {
  DeviceInfo,
  Envelope,
  PreKeyBundle,
  PreKeyInventory,
  SignalProtocolRelayConnectionReason,
  SignalProtocolRelayConnectionState,
  SignalProtocolRelayServer,
  Unsubscribe
} from "@open-e2ee/signal-protocol-sdk/remote/signal-relay";
import { decodeCiphertext, encodeCiphertext } from "./encoding.js";
import { RelayHttpError, UnsupportedRelayFeatureError } from "./errors.js";
import { HttpClient } from "./http.js";

type Relay = SignalProtocolRelayServer;
type Identity = NonNullable<Awaited<ReturnType<Relay["getIdentityKey"]>>>;
type PublishPlan = Parameters<Relay["publishPlannedPreKeys"]>[2];

// Idle time after the last envelope of a burst before onBatchEnd fires.
const BATCH_IDLE_MS = 300;

function unsupported(feature: string): never {
  throw new UnsupportedRelayFeatureError(feature);
}

function onlyAci(identityType: string | undefined): void {
  if (identityType !== undefined && identityType !== "aci") {
    unsupported("PNI identities");
  }
}

export interface CipherChatRelayOptions {
  serverUrl: string;
  getToken: () => string;
}

// Client side of SignalProtocolRelayServer for the CipherChat server: HTTP for
// directory, prekey and send calls, a Socket.IO connection for the mailbox.
// Only 1:1 messaging is implemented; the group methods throw.
export class CipherChatRelay implements SignalProtocolRelayServer {
  private readonly http: HttpClient;
  private socket: Socket | undefined;
  private connection: SignalProtocolRelayConnectionState = {
    state: "stopped",
    since: Date.now()
  };
  private readonly listeners = new Set<
    (state: SignalProtocolRelayConnectionState) => void
  >();
  private readonly pendingAcks = new Set<string>();
  private publication: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CipherChatRelayOptions) {
    this.http = new HttpClient(options);
  }

  // Connection state

  get relayConnectionState(): SignalProtocolRelayConnectionState {
    return this.connection;
  }

  subscribeRelayConnectionState(
    listener: (state: SignalProtocolRelayConnectionState) => void
  ): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private moveTo(
    state: SignalProtocolRelayConnectionState["state"],
    reason?: SignalProtocolRelayConnectionReason
  ): void {
    if (this.connection.state === state && this.connection.reason === reason) return;

    this.connection = {
      state,
      since: Date.now(),
      ...(reason === undefined ? {} : { reason })
    };
    for (const listener of [...this.listeners]) listener(this.connection);
  }

  // Mailbox

  subscribe(
    _userId: string,
    deviceId: number,
    onEnvelope: (envelope: Envelope) => void | Promise<void>,
    options?: { onBatchStart?: () => void; onBatchEnd?: () => void }
  ): Unsubscribe {
    this.socket?.disconnect();
    this.moveTo("connecting", "handshake");

    const socket = io(this.http.serverUrl, {
      transports: ["websocket"],
      auth: (give) => give({ token: this.options.getToken(), deviceId })
    });
    this.socket = socket;

    // Envelopes are handled one at a time: decryption advances the ratchet, so
    // order must hold within a burst.
    let queue: Promise<void> = Promise.resolve();
    let inBatch = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const endBatch = () => {
      inBatch = false;
      options?.onBatchEnd?.();
    };

    socket.on(MAILBOX_ENVELOPE_EVENT, (wire: WireEnvelope) => {
      if (!inBatch) {
        inBatch = true;
        options?.onBatchStart?.();
      }
      clearTimeout(idleTimer);

      queue = queue
        .then(() => onEnvelope(fromWire(wire)))
        .catch((error: unknown) => {
          // Left unacknowledged, the server replays it on the next connect.
          console.error("Envelope handling failed:", error);
        })
        .finally(() => {
          idleTimer = setTimeout(endBatch, BATCH_IDLE_MS);
        });
    });

    socket.on("connect", () => {
      this.moveTo("connected");
      this.flushAcks(socket);
    });
    socket.on("disconnect", (reason) => {
      if (this.socket === socket && reason !== "io client disconnect") {
        this.moveTo("reconnecting", "closed");
      }
    });
    socket.on("connect_error", (error) => {
      if (this.socket !== socket) return;
      this.moveTo("reconnecting", error.message === "UNAUTHORIZED" ? "authentication" : "error");
    });

    return () => {
      clearTimeout(idleTimer);
      socket.disconnect();
      if (this.socket === socket) {
        this.socket = undefined;
        this.moveTo("stopped");
      }
    };
  }

  async markDelivered(envelopeId: string): Promise<void> {
    this.pendingAcks.add(envelopeId);
    if (this.socket?.connected) this.flushAcks(this.socket);
    // While disconnected the id waits; if it is lost the server replays the
    // envelope and the SDK acknowledges the duplicate.
  }

  private flushAcks(socket: Socket): void {
    if (this.pendingAcks.size === 0) return;
    socket.emit(MAILBOX_ACK_EVENT, [...this.pendingAcks]);
    this.pendingAcks.clear();
  }

  // Delivery

  async send(envelope: Envelope): Promise<{
    messageId: string;
    serverTimestamp: number;
    duplicate?: boolean;
    deviceSetChecked?: boolean;
  }> {
    const result = await this.http.request<SendEnvelopeResponse>(
      "POST",
      "/api/relay/messages",
      toWireRequest(envelope)
    );

    return {
      messageId: result.messageId,
      serverTimestamp: result.serverTimestamp,
      duplicate: result.duplicate,
      ...(result.deviceSetChecked ? { deviceSetChecked: true } : {})
    };
  }

  // Devices

  async getDevices(userId: string): Promise<DeviceInfo[]> {
    const devices = await this.http.request<WireDeviceInfo[]>(
      "GET",
      `/api/relay/users/${encodeURIComponent(userId)}/devices`
    );
    return devices.map((device) => ({
      deviceId: device.deviceId,
      registered: device.registered,
      linked: device.linked,
      enabled: device.enabled,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt
    }));
  }

  async getActiveDevices(userId: string): Promise<{ userId: string; deviceId: number }[]> {
    const devices = await this.getDevices(userId);
    return devices.map((device) => ({ userId, deviceId: device.deviceId }));
  }

  async registerDevice(
    _userId: string,
    device: { deviceId?: number } = {}
  ): Promise<number> {
    const result = await this.http.request<RegisterDeviceResponse>(
      "POST",
      "/api/relay/devices",
      device.deviceId === undefined ? {} : { deviceId: device.deviceId }
    );
    return result.deviceId;
  }

  async removeDevice(_userId: string, deviceId: number): Promise<void> {
    await this.http.request("DELETE", `/api/relay/devices/${deviceId}`);
  }

  // Drops every device, prekey and the identity of the calling account, so a
  // fresh install can provision a new identity. Not part of the SDK interface.
  async removeAllDevices(): Promise<void> {
    await this.http.request("DELETE", "/api/relay/devices");
  }

  // Identity

  async provisionIdentityKey(request: {
    deviceId: number;
    registrationId: number;
    identity: Identity;
    identityType?: string;
  }): Promise<void> {
    onlyAci(request.identityType);
    await this.http.request("PUT", "/api/relay/identity", {
      deviceId: request.deviceId,
      registrationId: request.registrationId,
      identity: {
        version: 1,
        x25519PublicKey: request.identity.x25519PublicKey,
        ed25519PublicKey: request.identity.ed25519PublicKey
      } satisfies WireIdentity
    });
  }

  async rotateIdentityKey(): Promise<void> {
    return unsupported("identity rotation");
  }

  async getIdentityKey(userId: string, identityType?: string): Promise<Identity | null> {
    onlyAci(identityType);
    try {
      const identity = await this.http.request<WireIdentity>(
        "GET",
        `/api/relay/users/${encodeURIComponent(userId)}/identity`
      );
      return identity as unknown as Identity;
    } catch (error) {
      if (error instanceof RelayHttpError && error.status === 404) return null;
      throw error;
    }
  }

  // Prekeys

  async uploadPreKeys(
    _userId: string,
    deviceId: number,
    keys: Parameters<Relay["uploadPreKeys"]>[2],
    identityType?: string
  ): Promise<void> {
    onlyAci(identityType);
    await this.http.request("POST", "/api/relay/prekeys", {
      deviceId,
      keys
    } satisfies UploadPreKeysRequest);
  }

  async fetchPreKeyBundle(
    userId: string,
    deviceId: number,
    _fetcherUserId?: string,
    identityType?: string
  ): Promise<PreKeyBundle | null> {
    onlyAci(identityType);
    try {
      const bundle = await this.http.request<WirePreKeyBundle>(
        "POST",
        `/api/relay/users/${encodeURIComponent(userId)}/devices/${deviceId}/bundle`
      );
      return bundle as unknown as PreKeyBundle;
    } catch (error) {
      if (error instanceof RelayHttpError && error.status === 404) return null;
      throw error;
    }
  }

  async getPreKeyInventory(
    _userId: string,
    deviceId: number,
    identityType?: string
  ): Promise<PreKeyInventory> {
    onlyAci(identityType);
    return this.http.request<WirePreKeyInventory>(
      "GET",
      `/api/relay/devices/${deviceId}/prekeys/inventory`
    );
  }

  async getPreKeyCount(
    userId: string,
    deviceId: number,
    type: "ec" | "kem",
    identityType?: string
  ): Promise<number> {
    const inventory = await this.getPreKeyInventory(userId, deviceId, identityType);
    return type === "ec" ? inventory.ecOneTimePreKeyCount : inventory.kemOneTimePreKeyCount;
  }

  async getEcSignedPreKeyMetadata(userId: string, deviceId: number, identityType?: string) {
    return (await this.getPreKeyInventory(userId, deviceId, identityType)).ecSignedPreKey;
  }

  async getKemLastResortPreKeyMetadata(
    userId: string,
    deviceId: number,
    identityType?: string
  ) {
    return (await this.getPreKeyInventory(userId, deviceId, identityType))
      .kemLastResortPreKey;
  }

  async clearStaleKemPreKeys(
    _userId: string,
    deviceId: number,
    identityType?: string
  ): Promise<{ cleared: number }> {
    onlyAci(identityType);
    return this.http.request<{ cleared: number }>(
      "POST",
      `/api/relay/devices/${deviceId}/prekeys/clear-stale-kem`
    );
  }

  // The plan reads the inventory and decides the uploads, so concurrent
  // publications are serialised to keep that read-then-write atomic per client.
  publishPlannedPreKeys(
    userId: string,
    deviceId: number,
    plan: PublishPlan,
    identityType?: string
  ): Promise<void> {
    const run = async () => {
      const inventory = await this.getPreKeyInventory(userId, deviceId, identityType);
      const uploads = await plan(inventory);
      if (uploads.length > 0) {
        await this.uploadPreKeys(userId, deviceId, [...uploads], identityType);
      }
    };

    const result = this.publication.then(run, run);
    this.publication = result.catch(() => undefined);
    return result;
  }

  // Groups are out of scope for 1:1 messaging.

  async createGroupState(): Promise<never> {
    return unsupported("groups");
  }

  async getGroupState(): Promise<never> {
    return unsupported("groups");
  }

  async getGroupJoinInfo(): Promise<never> {
    return unsupported("groups");
  }

  async getGroupChanges(): Promise<never> {
    return unsupported("groups");
  }

  async submitGroupChange(): Promise<never> {
    return unsupported("groups");
  }

  async issueAuthCredential(): Promise<never> {
    return unsupported("groups");
  }
}

function toWireRequest(envelope: Envelope): SendEnvelopeRequest {
  return {
    targetUserId: envelope.targetUserId,
    targetDeviceId: envelope.targetDeviceId,
    senderUserId: envelope.senderUserId,
    senderDeviceId: envelope.senderDeviceId,
    ciphertext: encodeCiphertext(envelope.ciphertext),
    messageType: envelope.messageType,
    deliveryClass: envelope.deliveryClass,
    timestamp: envelope.timestamp,
    ...(envelope.contentKind === undefined ? {} : { contentKind: envelope.contentKind }),
    ...(envelope.clientMessageId === undefined
      ? {}
      : { clientMessageId: envelope.clientMessageId }),
    ...(envelope.operationEpochMilliseconds === undefined
      ? {}
      : { operationEpochMilliseconds: envelope.operationEpochMilliseconds }),
    ...(envelope.declaredDeviceIds === undefined
      ? {}
      : { declaredDeviceIds: [...envelope.declaredDeviceIds] }),
    ...(envelope.recipientRegistrationId === undefined
      ? {}
      : { recipientRegistrationId: envelope.recipientRegistrationId }),
    ...(envelope.contentHint === undefined ? {} : { contentHint: envelope.contentHint })
  };
}

function fromWire(wire: WireEnvelope): Envelope {
  return {
    id: wire.id,
    targetUserId: wire.targetUserId,
    targetDeviceId: wire.targetDeviceId,
    senderUserId: wire.senderUserId,
    senderDeviceId: wire.senderDeviceId,
    ciphertext: decodeCiphertext(wire.ciphertext),
    messageType: wire.messageType,
    deliveryClass: wire.deliveryClass,
    timestamp: wire.timestamp,
    serverTimestamp: wire.serverTimestamp,
    ...(wire.contentKind === undefined ? {} : { contentKind: wire.contentKind }),
    ...(wire.clientMessageId === undefined ? {} : { clientMessageId: wire.clientMessageId }),
    ...(wire.operationEpochMilliseconds === undefined
      ? {}
      : { operationEpochMilliseconds: wire.operationEpochMilliseconds }),
    ...(wire.declaredDeviceIds === undefined
      ? {}
      : { declaredDeviceIds: wire.declaredDeviceIds }),
    ...(wire.recipientRegistrationId === undefined
      ? {}
      : { recipientRegistrationId: wire.recipientRegistrationId }),
    ...(wire.contentHint === undefined ? {} : { contentHint: wire.contentHint })
  };
}
