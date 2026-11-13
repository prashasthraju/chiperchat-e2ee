import express, {
  type ErrorRequestHandler
} from "express";
import cors from "cors";
import { z } from "zod";
import { pool } from "./config/db.js";
import { env } from "./config/env.js";
import { HttpError } from "./lib/http-error.js";
import { authRouter } from "./routes/auth.js";
import { relayRouter } from "./routes/relay.js";

const app = express();

app.use(cors({
  origin: env.CLIENT_ORIGIN
}));

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "cipherchat-server"
  });
});

app.get("/db-health", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS current_time");

    res.json({
      status: "connected",
      database: "cipherchat",
      time: result.rows[0].current_time
    });
  } catch (error) {
    console.error("Database connection failed:", error);

    res.status(500).json({
      status: "error",
      message: "Database connection failed"
    });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/relay", relayRouter);

const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.data !== undefined && { data: error.data })
    });
    return;
  }

  if (error instanceof z.ZodError) {
    res.status(400).json({
      code: "INVALID_REQUEST",
      message: error.issues.map((issue) => issue.message).join("; "),
      data: error.issues
    });
    return;
  }

  // body-parser failures (malformed JSON, payload too large) carry a status.
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ code: "BAD_REQUEST", message: "Malformed request" });
    return;
  }

  console.error("Unhandled error:", error);
  res.status(500).json({ code: "INTERNAL", message: "Internal server error" });
};

app.use(handleError);

export default app;
