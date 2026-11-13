import { useEffect, useState } from "react";
import { AuthForm } from "./components/AuthForm";
import { Chat } from "./components/Chat";
import { KeyProblem } from "./components/KeyProblem";
import { ApiError, fetchMe } from "./lib/api";
import { clearSession, loadSession, saveSession, type Session } from "./lib/session";
import { useCipherChat } from "./lib/useCipherChat";

function Authenticated({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const state = useCipherChat(session);

  if (state.phase === "error") {
    return <KeyProblem session={session} error={state.error} onSignOut={onSignOut} />;
  }
  if (state.phase === "starting") {
    return <main className="auth"><p className="muted">Setting up encryption keys…</p></main>;
  }
  return <Chat session={session} chat={state.chat} onSignOut={onSignOut} />;
}

function App() {
  const [session, setSession] = useState<Session | undefined>(loadSession);
  const [checking, setChecking] = useState(() => loadSession() !== undefined);

  // A stored token may have expired or its account may be gone.
  useEffect(() => {
    const stored = loadSession();
    if (!stored) return;

    fetchMe(stored.token)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          clearSession();
          setSession(undefined);
        }
      })
      .finally(() => setChecking(false));
  }, []);

  function signOut() {
    clearSession();
    setSession(undefined);
  }

  if (checking) {
    return <main className="auth"><p className="muted">Loading…</p></main>;
  }
  if (!session) {
    return (
      <AuthForm
        onAuthenticated={(next) => {
          saveSession(next);
          setSession(next);
        }}
      />
    );
  }
  return <Authenticated session={session} onSignOut={signOut} />;
}

export default App;
