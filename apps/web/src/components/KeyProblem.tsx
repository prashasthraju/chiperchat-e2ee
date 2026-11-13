import { useState } from "react";
import {
  LocalDeviceOwnedByOtherUserError,
  RelayHttpError,
  resetAccountKeys,
  resetBrowserDevice
} from "@cipherchat/crypto";
import { SERVER_URL } from "../lib/config";
import type { Session } from "../lib/session";

interface Props {
  session: Session;
  error: Error;
  onSignOut: () => void;
}

// Shown when the chat cannot start. Two failures are recoverable by wiping keys:
// this browser holds another account's keys, or the server remembers an identity
// this browser no longer has.
export function KeyProblem({ session, error, onSignOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const otherOwner = error instanceof LocalDeviceOwnedByOtherUserError;
  const identityMismatch =
    error instanceof RelayHttpError && error.code === "IDENTITY_MISMATCH";

  async function reset() {
    setBusy(true);
    setFailure(undefined);
    try {
      // The server-side wipe is only meaningful for this account's own keys.
      if (identityMismatch) {
        await resetAccountKeys({ serverUrl: SERVER_URL, getToken: () => session.token });
      }
      await resetBrowserDevice();
      window.location.reload();
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Reset failed");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="card">
        <h1>Can't start encrypted chat</h1>
        <p className="error">{error.message}</p>

        {otherOwner && (
          <p className="muted">
            Each browser profile can hold one account's keys. Erase them to use this
            account here, or open the app in another browser profile.
          </p>
        )}
        {identityMismatch && (
          <p className="muted">
            The server has an identity for this account that this browser doesn't hold
            (for example, after clearing site data). Resetting publishes new keys;
            contacts will see a changed identity.
          </p>
        )}
        {failure && <p className="error" role="alert">{failure}</p>}

        {(otherOwner || identityMismatch) && (
          <button onClick={reset} disabled={busy}>
            {identityMismatch ? "Reset my keys" : "Erase this browser's keys"}
          </button>
        )}
        <button className="link" onClick={onSignOut}>Sign out</button>
      </div>
    </main>
  );
}
