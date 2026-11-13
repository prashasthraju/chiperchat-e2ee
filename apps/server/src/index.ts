import { createServer } from "node:http";
import app from "./app.js";
import { initializeSocket } from "./socket.js";
import "dotenv/config";
const PORT = process.env.PORT || 3000;

const server = createServer(app);

initializeSocket(server);

server.listen(PORT, () => {
  console.log(`CipherChat server running on port ${PORT}`);
});