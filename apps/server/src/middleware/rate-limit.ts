import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";

// Fixed-window limiter keyed by client address. In-memory, so it only holds
// for a single server process.
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > limit) {
      throw new HttpError(429, "RATE_LIMITED", "Too many requests");
    }
    next();
  };
}
