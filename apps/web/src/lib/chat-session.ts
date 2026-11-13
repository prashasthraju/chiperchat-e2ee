import {
  createCipherChat,
  openBrowserDevice,
  type CipherChat
} from "@cipherchat/crypto";
import { SERVER_URL } from "./config";
import { addMessage } from "./history";

interface Entry {
  userId: string;
  promise: Promise<CipherChat>;
  refs: number;
  stopTimer: ReturnType<typeof setTimeout> | undefined;
}

let entry: Entry | undefined;

function start(userId: string, getToken: () => string): Promise<CipherChat> {
  return openBrowserDevice(userId).then((device) =>
    createCipherChat({
      serverUrl: SERVER_URL,
      userId,
      getToken,
      storage: device.storage,
      ...(device.deviceId === undefined ? {} : { deviceId: device.deviceId }),
      onDeviceAssigned: device.remember,
      onMessage: (message) =>
        addMessage(userId, {
          id: message.id,
          peer: message.from,
          direction: "in",
          text: message.text,
          at: message.sentAt
        })
    })
  );
}

// One CipherChat per signed-in user for the whole page. Components lease it;
// the client is stopped only after the last lease is released, which also
// keeps React StrictMode's mount/unmount/mount from opening two clients that
// would race to create the same identity keys.
export function acquireChat(userId: string, getToken: () => string) {
  if (entry && entry.userId !== userId) {
    const previous = entry;
    entry = undefined;
    void previous.promise.then((chat) => chat.stop()).catch(() => undefined);
  }

  if (!entry) {
    const created: Entry = {
      userId,
      promise: start(userId, getToken),
      refs: 0,
      stopTimer: undefined
    };
    // A failed start must not be cached, or retrying would reuse the failure.
    created.promise.catch(() => {
      if (entry === created) entry = undefined;
    });
    entry = created;
  }

  const lease = entry;
  clearTimeout(lease.stopTimer);
  lease.refs += 1;

  return {
    promise: lease.promise,
    release() {
      lease.refs -= 1;
      if (lease.refs > 0) return;

      lease.stopTimer = setTimeout(() => {
        if (entry === lease) entry = undefined;
        void lease.promise.then((chat) => chat.stop()).catch(() => undefined);
      }, 0);
    }
  };
}
