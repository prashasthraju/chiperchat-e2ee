import { useState, type FormEvent } from "react";
import { ApiError, login, register } from "../lib/api";
import type { Session } from "../lib/session";

interface Props {
  onAuthenticated: (session: Session) => void;
}

export function AuthForm({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const action = mode === "login" ? login : register;
      onAuthenticated(await action({ username, password }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <form className="card" onSubmit={submit}>
        <h1>CipherChat</h1>
        <p className="muted">End-to-end encrypted, post-quantum messaging.</p>

        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </label>

        {error && <p className="error" role="alert">{error}</p>}

        <button type="submit" disabled={busy}>
          {mode === "login" ? "Log in" : "Create account"}
        </button>

        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "Need an account? Register" : "Have an account? Log in"}
        </button>
      </form>
    </main>
  );
}
