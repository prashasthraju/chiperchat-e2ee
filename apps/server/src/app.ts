import express from "express";
import cors from "cors";

const app = express();

app.use(cors({
  origin: "http://localhost:5173"
}));

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "cipherchat-server"
  });
});
import { pool } from "./config/db.js";

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

export default app;