import { Router } from "express";
import { z } from "zod";
import type { AuthResponse, User } from "@cipherchat/shared";
import { pool } from "../config/db.js";
import { HttpError } from "../lib/http-error.js";
import { signToken } from "../lib/jwt.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword
} from "../lib/password.js";
import { authedUserId, requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";

const credentials = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,32}$/, "Use 3-32 letters, digits or underscores"),
  password: z.string().min(8, "Use at least 8 characters").max(128)
});

interface UserRow {
  username: string;
  password_hash: string;
  created_at: Date;
}

const toUser = (row: Pick<UserRow, "username" | "created_at">): User => ({
  id: row.username,
  username: row.username,
  createdAt: row.created_at.toISOString()
});

export const authRouter = Router();

authRouter.use(rateLimit(20, 60_000));

authRouter.post("/register", async (req, res) => {
  const { username, password } = credentials.parse(req.body);

  let row: UserRow | undefined;
  try {
    const result = await pool.query<UserRow>(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2)
       RETURNING username, password_hash, created_at`,
      [username, await hashPassword(password)]
    );
    row = result.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, "USERNAME_TAKEN", "That username is taken");
    }
    throw error;
  }
  if (!row) throw new Error("User insert returned no row");

  const body: AuthResponse = { token: await signToken(row.username), user: toUser(row) };
  res.status(201).json(body);
});

authRouter.post("/login", async (req, res) => {
  const { username, password } = credentials.parse(req.body);

  const { rows } = await pool.query<UserRow>(
    "SELECT username, password_hash, created_at FROM users WHERE username = $1",
    [username]
  );
  const row = rows[0];

  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Wrong username or password");
  }

  const body: AuthResponse = { token: await signToken(row.username), user: toUser(row) };
  res.json(body);
});

authRouter.get("/me", requireAuth, async (_req, res) => {
  const { rows } = await pool.query<UserRow>(
    "SELECT username, password_hash, created_at FROM users WHERE username = $1",
    [authedUserId(res)]
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, "UNAUTHORIZED", "Account no longer exists");

  res.json(toUser(row));
});
