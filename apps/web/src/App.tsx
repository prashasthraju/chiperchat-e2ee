
import { useEffect, useState } from "react";
import { socket } from "./lib/socket";

function App() {
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");

  useEffect(() => {
    socket.connect();

    socket.on("connect", () => {
      setConnected(true);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("test:response", (data: { message: string }) => {
      setResponse(data.message);
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("test:response");
      socket.disconnect();
    };
  }, []);

  const sendMessage = () => {
    if (!message.trim()) return;

    socket.emit("test:message", message);
    setMessage("");
  };

  return (
    <div style={{ padding: "40px", fontFamily: "sans-serif" }}>
      <h1>CipherChat</h1>

      <p>
        Server status: {connected ? "Connected" : "Disconnected"}
      </p>

      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Enter a test message"
      />

      <button onClick={sendMessage}>
        Send
      </button>

      <p>Server response: {response}</p>
    </div>
  );
}

export default App;
