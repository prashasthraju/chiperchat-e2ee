import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { CipherChat } from "@cipherchat/crypto";
import { addMessage, getHistory, subscribeHistory } from "../lib/history";
import type { Session } from "../lib/session";

interface Props {
  session: Session;
  chat: CipherChat;
  onSignOut: () => void;
}

type Connection = "stopped" | "connecting" | "connected" | "reconnecting";

const USERNAME = /^[a-z0-9_]{3,32}$/;

export function Chat({ session, chat, onSignOut }: Props) {
  const me = session.user.id;
  const history = useSyncExternalStore(
    (listener) => subscribeHistory(me, listener),
    () => getHistory(me)
  );

  const [active, setActive] = useState<string>();
  const [newPeer, setNewPeer] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => chat.onConnectionState((state) => setConnection(state.state)),
    [chat]
  );

  const peers = [...new Set(history.map((message) => message.peer))];
  if (active && !peers.includes(active)) peers.push(active);

  const thread = history.filter((message) => message.peer === active);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, active]);

  function startConversation(event: FormEvent) {
    event.preventDefault();
    const peer = newPeer.trim().toLowerCase();
    if (!USERNAME.test(peer)) return setError("Usernames are 3-32 letters, digits or underscores");
    if (peer === me) return setError("You can't message yourself");
    setError(undefined);
    setActive(peer);
    setNewPeer("");
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!active || !text) return;

    setSending(true);
    setError(undefined);
    try {
      const sent = await chat.send(active, text);
      addMessage(me, {
        id: sent.id,
        peer: active,
        direction: "out",
        text: sent.text,
        at: sent.sentAt
      });
      setDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message could not be sent");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat">
      <aside className="sidebar">
        <header>
          <strong>{me}</strong>
          <span className={`dot ${connection}`} title={connection} />
        </header>

        <form onSubmit={startConversation} className="new-chat">
          <input
            value={newPeer}
            onChange={(event) => setNewPeer(event.target.value)}
            placeholder="Message a username…"
            aria-label="Start a conversation with a username"
            autoCapitalize="none"
          />
          <button type="submit">Chat</button>
        </form>

        <ul>
          {peers.map((peer) => (
            <li key={peer}>
              <button
                className={peer === active ? "peer active" : "peer"}
                onClick={() => {
                  setActive(peer);
                  setError(undefined);
                }}
              >
                {peer}
              </button>
            </li>
          ))}
        </ul>

        <footer>
          <small className="muted">Device {chat.deviceId} · PQXDH + Double Ratchet</small>
          <button className="link" onClick={onSignOut}>Sign out</button>
        </footer>
      </aside>

      <section className="thread">
        {active ? (
          <>
            <header>
              <strong>{active}</strong>
              <small className="muted">end-to-end encrypted</small>
            </header>

            <div className="messages">
              {thread.map((message) => (
                <div key={`${message.direction}-${message.id}`} className={`bubble ${message.direction}`}>
                  {message.text}
                </div>
              ))}
              <div ref={endRef} />
            </div>

            {error && <p className="error" role="alert">{error}</p>}

            <form onSubmit={send} className="composer">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a message"
                aria-label="Message"
                autoFocus
              />
              <button type="submit" disabled={sending || !draft.trim()}>Send</button>
            </form>
          </>
        ) : (
          <div className="empty">
            <p>Pick a conversation or message a username to start.</p>
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
