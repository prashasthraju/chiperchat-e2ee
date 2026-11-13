import type { AuthResponse } from "@cipherchat/shared";

export type Session = AuthResponse;

const KEY = "cipherchat:session";

export function loadSession(): Session | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
