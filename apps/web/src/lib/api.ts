import type { AuthCredentials, AuthResponse, RelayErrorBody } from "@cipherchat/shared";
import { SERVER_URL } from "./config";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, init);
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the server");
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (body ?? {}) as Partial<RelayErrorBody>;
    throw new ApiError(
      response.status,
      error.code ?? "HTTP_ERROR",
      error.message ?? `Request failed (${response.status})`
    );
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

export const register = (credentials: AuthCredentials) =>
  call<AuthResponse>("/api/auth/register", json(credentials));

export const login = (credentials: AuthCredentials) =>
  call<AuthResponse>("/api/auth/login", json(credentials));

export const fetchMe = (token: string) =>
  call<AuthResponse["user"]>("/api/auth/me", {
    headers: { authorization: `Bearer ${token}` }
  });
