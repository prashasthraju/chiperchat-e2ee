import { useEffect, useRef, useState } from "react";
import type { CipherChat } from "@cipherchat/crypto";
import { acquireChat } from "./chat-session";
import type { Session } from "./session";

export type ChatState =
  | { phase: "starting" }
  | { phase: "ready"; chat: CipherChat }
  | { phase: "error"; error: Error };

export function useCipherChat(session: Session): ChatState {
  const [state, setState] = useState<ChatState>({ phase: "starting" });
  const tokenRef = useRef(session.token);
  const userId = session.user.id;

  useEffect(() => {
    tokenRef.current = session.token;
  }, [session.token]);

  useEffect(() => {
    let active = true;
    setState({ phase: "starting" });

    const lease = acquireChat(userId, () => tokenRef.current);
    lease.promise.then(
      (chat) => active && setState({ phase: "ready", chat }),
      (error: unknown) =>
        active &&
        setState({
          phase: "error",
          error: error instanceof Error ? error : new Error(String(error))
        })
    );

    return () => {
      active = false;
      lease.release();
    };
  }, [userId]);

  return state;
}
