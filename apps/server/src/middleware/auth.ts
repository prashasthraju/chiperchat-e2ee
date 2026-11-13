import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { verifyToken } from "../lib/jwt.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    throw new HttpError(401, "UNAUTHORIZED", "Missing bearer token");
  }

  try {
    res.locals["userId"] = await verifyToken(token);
  } catch {
    throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired token");
  }

  next();
}

export function authedUserId(res: Response): string {
  return res.locals["userId"] as string;
}
