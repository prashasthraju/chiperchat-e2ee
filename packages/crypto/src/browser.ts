import type { SignalProtocolLocalStore } from "@open-e2ee/signal-protocol-sdk/local/store";
import { indexedDbStore } from "@open-e2ee/signal-protocol-sdk/local/store/web";
import { LocalDeviceOwnedByOtherUserError } from "./errors.js";

// The SDK's IndexedDB store always uses this database name, so one browser
// origin holds the keys of exactly one account.
const DATABASE_NAME = "signal-protocol-storage";
const OWNER_KEY = "cipherchat:device";

interface DeviceMarker {
  userId: string;
  deviceId: number;
}

function readMarker(): DeviceMarker | undefined {
  try {
    const raw = localStorage.getItem(OWNER_KEY);
    return raw ? (JSON.parse(raw) as DeviceMarker) : undefined;
  } catch {
    return undefined;
  }
}

export interface BrowserDevice {
  storage: SignalProtocolLocalStore;
  deviceId?: number;
  remember(deviceId: number): void;
}

// Opens the browser's key store for `userId`. Throws
// LocalDeviceOwnedByOtherUserError when it already belongs to someone else,
// instead of silently mixing two accounts' keys.
export async function openBrowserDevice(userId: string): Promise<BrowserDevice> {
  const marker = readMarker();
  if (marker && marker.userId !== userId) {
    throw new LocalDeviceOwnedByOtherUserError(marker.userId);
  }

  return {
    storage: await indexedDbStore(),
    ...(marker ? { deviceId: marker.deviceId } : {}),
    remember(deviceId) {
      localStorage.setItem(OWNER_KEY, JSON.stringify({ userId, deviceId }));
    }
  };
}

export function browserDeviceOwner(): string | undefined {
  return readMarker()?.userId;
}

// Deletes every key stored in this browser. Reload afterwards: if the store
// is still open, the deletion completes once the page releases it.
export async function resetBrowserDevice(): Promise<void> {
  localStorage.removeItem(OWNER_KEY);

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
