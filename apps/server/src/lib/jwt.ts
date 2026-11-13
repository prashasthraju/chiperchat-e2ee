import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";

const key = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = "cipherchat";

export function signToken(username: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(key);
}

// Resolves to the username the token was issued for, or throws.
export async function verifyToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    algorithms: ["HS256"]
  });

  if (!payload.sub) {
    throw new Error("Token has no subject");
  }

  return payload.sub;
}
