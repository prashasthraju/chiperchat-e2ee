import { createSignalProtocolClient } from "@open-e2ee/signal-protocol-sdk";
import type { SignalProtocolLocalStore } from "@open-e2ee/signal-protocol-sdk/local/store";
import type { SignalProtocolRelayConnectionState } from "@open-e2ee/signal-protocol-sdk/remote/signal-relay";
import { CipherChatRelay } from "./transport.js";

export interface ReceivedMessage {
  id: string;
  from: string;
  text: string;
  // Sender's clock, epoch ms.
  sentAt: number;
  receivedAt: number;
}

export interface SentMessage {
  id: string;
  to: string;
  text: string;
  sentAt: number;
}

export interface CipherChatOptions {
  serverUrl: string;
  userId: string;
  // Read on every request, so a re-login can swap the token.
  getToken: () => string;
  // Device-local protocol state: identity keys, prekeys, sessions.
  storage: SignalProtocolLocalStore;
  // The id the server assigned to this device on an earlier run, if any.
  deviceId?: number;
  onDeviceAssigned?: (deviceId: number) => void;
  // Registered before the mailbox opens, so no decrypted message is dropped.
  // The relay is acknowledged once this resolves; persist the message here.
  onMessage: (message: ReceivedMessage) => void | Promise<void>;
}

export interface CipherChat {
  readonly userId: string;
  readonly deviceId: number;
  send(to: string, text: string): Promise<SentMessage>;
  onConnectionState(
    listener: (state: SignalProtocolRelayConnectionState) => void
  ): () => void;
  stop(): Promise<void>;
}

// Opens this device's encrypted session layer: registers the device with the
// server, publishes PQXDH prekeys, and starts receiving. PQXDH session setup
// and the Double Ratchet (with the ML-KEM Braid) run inside the SDK.
export async function createCipherChat(options: CipherChatOptions): Promise<CipherChat> {
  const relay = new CipherChatRelay({
    serverUrl: options.serverUrl,
    getToken: options.getToken
  });

  const deviceId = await relay.registerDevice(
    options.userId,
    options.deviceId === undefined ? {} : { deviceId: options.deviceId }
  );
  options.onDeviceAssigned?.(deviceId);

  // Generates identity and prekeys on first run and syncs them to the server.
  const signal = await createSignalProtocolClient({
    identity: { userId: options.userId, deviceId },
    adapters: { storage: options.storage, relay }
  });

  signal.registerHook("onMessageDecrypted", async (message) => {
    await options.onMessage({
      id: message.messageId,
      from: message.senderId,
      text: message.content,
      sentAt: message.timestamp,
      receivedAt: message.receivedAt
    });
  });
  signal.startRelaySubscription();

  return {
    userId: options.userId,
    deviceId,

    async send(to, text) {
      const result = await signal.send(to, text);
      return { id: result.clientMessageId, to, text, sentAt: result.clientTimestamp };
    },

    onConnectionState: (listener) => relay.subscribeRelayConnectionState(listener),

    async stop() {
      signal.stopRelaySubscription();
      await signal.stop();
    }
  };
}

// Forgets this account's device(s), prekeys and identity on the server. Use it
// when the local keys are gone, so a fresh install can publish a new identity.
export async function resetAccountKeys(options: {
  serverUrl: string;
  getToken: () => string;
}): Promise<void> {
  await new CipherChatRelay(options).removeAllDevices();
}
