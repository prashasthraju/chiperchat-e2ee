// End-to-end check against a running server (npm run dev:server):
// two clients, PQXDH session setup, Double Ratchet turns, offline delivery.
import { inMemoryStore } from "@open-e2ee/signal-protocol-sdk/local/store/memory";
import type { AuthResponse } from "@cipherchat/shared";
import { createCipherChat, type CipherChat, type ReceivedMessage } from "../src/index.js";

const serverUrl = process.env["SERVER_URL"] ?? "http://localhost:3000";
const suffix = Math.random().toString(36).slice(2, 8);

async function register(username: string): Promise<AuthResponse> {
  const response = await fetch(`${serverUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "e2e-password-1" })
  });
  if (!response.ok) throw new Error(`register ${username}: ${response.status}`);
  return (await response.json()) as AuthResponse;
}

function inbox() {
  const messages: ReceivedMessage[] = [];
  const waiters: (() => void)[] = [];
  return {
    messages,
    push(message: ReceivedMessage) {
      messages.push(message);
      for (const wake of waiters.splice(0)) wake();
    },
    async next(count: number, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (messages.length < count) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for message #${count}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, remaining);
        });
      }
      return messages[count - 1]!;
    }
  };
}

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(`FAILED: ${label}`);
  console.log(`ok  ${label}`);
}

const [alice, bob] = await Promise.all([register(`alice_${suffix}`), register(`bob_${suffix}`)]);
const aliceBox = inbox();
const bobBox = inbox();
const aliceStore = inMemoryStore();
const bobStore = inMemoryStore();

// A real app persists the assigned device id (the browser keeps it in localStorage).
const deviceIds = new Map<string, number>();

const open = (auth: AuthResponse, storage: ReturnType<typeof inMemoryStore>, box: ReturnType<typeof inbox>) =>
  createCipherChat({
    serverUrl,
    userId: auth.user.id,
    getToken: () => auth.token,
    storage,
    ...(deviceIds.has(auth.user.id) ? { deviceId: deviceIds.get(auth.user.id)! } : {}),
    onDeviceAssigned: (deviceId) => deviceIds.set(auth.user.id, deviceId),
    onMessage: (message) => box.push(message)
  });

let aliceChat: CipherChat | undefined;
let bobChat: CipherChat | undefined;

try {
  aliceChat = await open(alice, aliceStore, aliceBox);
  bobChat = await open(bob, bobStore, bobBox);
  check(aliceChat.deviceId === 1 && bobChat.deviceId === 1, "devices registered");

  await aliceChat.send(bob.user.id, "hello bob");
  const first = await bobBox.next(1);
  check(first.text === "hello bob" && first.from === alice.user.id, "alice -> bob (PQXDH session)");

  await bobChat.send(alice.user.id, "hi alice");
  check((await aliceBox.next(1)).text === "hi alice", "bob -> alice (reply)");

  for (let turn = 0; turn < 3; turn += 1) {
    await aliceChat.send(bob.user.id, `a${turn}`);
    await bobBox.next(2 + turn);
    await bobChat.send(alice.user.id, `b${turn}`);
    await aliceBox.next(2 + turn);
  }
  check(
    bobBox.messages.map((m) => m.text).join() === "hello bob,a0,a1,a2" &&
      aliceBox.messages.map((m) => m.text).join() === "hi alice,b0,b1,b2",
    "ratchet turns delivered in order"
  );

  await bobChat.stop();
  bobChat = undefined;
  await aliceChat.send(bob.user.id, "while you were away");
  bobChat = await open(bob, bobStore, bobBox);
  check((await bobBox.next(5)).text === "while you were away", "offline message delivered on reconnect");

  const unauthorized = await fetch(`${serverUrl}/api/relay/users/${bob.user.id}/devices`);
  check(unauthorized.status === 401, "relay rejects unauthenticated requests");

  console.log("\nAll end-to-end checks passed.");
} finally {
  await aliceChat?.stop();
  await bobChat?.stop();
}
process.exit(0);
