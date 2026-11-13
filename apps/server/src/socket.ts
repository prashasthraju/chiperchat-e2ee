import { Server } from "socket.io";
import { Server as HttpServer } from "node:http";
import { MAILBOX_ACK_EVENT } from "@cipherchat/shared";
import { env } from "./config/env.js";
import { verifyToken } from "./lib/jwt.js";
import {
  acknowledgeEnvelopes,
  attachMailbox,
  flushMailbox,
  joinMailbox
} from "./services/mailbox.js";
import { deviceBelongsTo, touchDevice } from "./services/relay.js";

interface SocketAuth {
  userId: string;
  deviceId: number;
}

export function initializeSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: env.CLIENT_ORIGIN
    }
  });

  attachMailbox(io);

  // A socket is one device's mailbox. It must present a valid token and a
  // device id that belongs to that token's user.
  io.use(async (socket, next) => {
    try {
      const { token, deviceId } = socket.handshake.auth as {
        token?: unknown;
        deviceId?: unknown;
      };
      if (typeof token !== "string" || typeof deviceId !== "number") {
        throw new Error("Missing credentials");
      }

      const userId = await verifyToken(token);
      if (!(await deviceBelongsTo(userId, deviceId))) {
        throw new Error("Unknown device");
      }

      socket.data = { userId, deviceId } satisfies SocketAuth;
      next();
    } catch {
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const { userId, deviceId } = socket.data as SocketAuth;

    joinMailbox(socket, userId, deviceId);
    void touchDevice(userId, deviceId);
    flushMailbox(socket, userId, deviceId).catch((error: unknown) => {
      console.error("Mailbox flush failed:", error);
    });

    socket.on(MAILBOX_ACK_EVENT, (ids: unknown) => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return;

      acknowledgeEnvelopes(userId, deviceId, ids as string[]).catch((error: unknown) => {
        console.error("Mailbox acknowledge failed:", error);
      });
    });
  });

  return io;
}
