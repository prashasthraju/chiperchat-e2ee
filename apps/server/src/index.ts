import { createServer } from "node:http";
import { env } from "./config/env.js";
import app from "./app.js";
import { ensureSchema } from "./db/schema.js";
import { initializeSocket } from "./socket.js";
import { purgeExpiredEnvelopes } from "./services/relay.js";

await ensureSchema();

const server = createServer(app);

initializeSocket(server);

setInterval(() => {
  purgeExpiredEnvelopes().catch((error: unknown) => {
    console.error("Envelope purge failed:", error);
  });
}, 60 * 60 * 1000).unref();

server.listen(env.PORT, () => {
  console.log(`CipherChat server running on port ${env.PORT}`);
});
