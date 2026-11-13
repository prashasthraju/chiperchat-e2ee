import type { WireCiphertext } from "@cipherchat/shared";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeCiphertext(ciphertext: string | Uint8Array): WireCiphertext {
  return typeof ciphertext === "string"
    ? { kind: "string", value: ciphertext }
    : { kind: "bytes", value: bytesToBase64(ciphertext) };
}

export function decodeCiphertext(wire: WireCiphertext): string | Uint8Array {
  return wire.kind === "string" ? wire.value : base64ToBytes(wire.value);
}
