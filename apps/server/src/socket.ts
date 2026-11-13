
import { Server } from "socket.io";
import { Server as HttpServer } from "node:http";

export function initializeSocket(server: HttpServer) {
  const io = new Server(server, {
    cors: {
      origin: "http://localhost:5173"
    }
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("test:message", (message: string) => {
      console.log("Received from client:", message);

      socket.emit("test:response", {
        message: `Server received: ${message}`,
        timestamp: new Date().toISOString()
      });
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  return io;
}
