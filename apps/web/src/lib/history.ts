// Decrypted messages live in this browser only. The relay deletes ciphertext
// once it is acknowledged, so this is the sole copy of the conversation.
export interface ChatMessage {
  id: string;
  peer: string;
  direction: "in" | "out";
  text: string;
  at: number;
}

const cache = new Map<string, ChatMessage[]>();
const listeners = new Map<string, Set<() => void>>();

const storageKey = (userId: string) => `cipherchat:history:${userId}`;

function read(userId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

// Returns the same array until a message is added, as useSyncExternalStore needs.
export function getHistory(userId: string): ChatMessage[] {
  let messages = cache.get(userId);
  if (!messages) {
    messages = read(userId);
    cache.set(userId, messages);
  }
  return messages;
}

export function addMessage(userId: string, message: ChatMessage): void {
  const current = getHistory(userId);
  // The SDK delivers at least once, so repeats are expected.
  if (current.some((m) => m.id === message.id && m.direction === message.direction)) {
    return;
  }

  const next = [...current, message].sort((a, b) => a.at - b.at);
  cache.set(userId, next);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the message stays visible for this page load.
  }
  listeners.get(userId)?.forEach((listener) => listener());
}

export function subscribeHistory(userId: string, listener: () => void): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
