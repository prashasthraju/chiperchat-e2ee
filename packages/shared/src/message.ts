export interface EncryptedEnvelope {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  recipientDeviceId: string;

  messageType: "prekey" | "ciphertext";

  protocolVersion: string;
  ciphertext: string;

  createdAt: string;
}

export interface Conversation {
  id: string;
  type: "direct";
  memberIds: string[];
  createdAt: string;
}