import { useEffect, useRef, useState } from "react";
import {
  BleTransport,
  MeshNode,
  chatService,
  type ChatApi,
  type ChatMessage,
  type PeerRecord,
} from "./mesh-core";

interface BleCoreMeshDemoProps {
  runtimePlatform: string;
  connectedId: string | null;
  writeUuid: string;
}

type Runtime = {
  node: MeshNode;
  chat: ChatApi;
  unsubs: Array<() => void>;
};

const room = "radio-demo";
const secret = "levelup-offgrid";

export function BleCoreMeshDemo({ runtimePlatform, connectedId, writeUuid }: BleCoreMeshDemoProps) {
  const runtimeRef = useRef<Runtime | null>(null);
  const [running, setRunning] = useState(false);
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [text, setText] = useState("radio mesh payload");
  const [rtt, setRtt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const isAndroid = runtimePlatform === "android";
  const canStart = isAndroid || Boolean(connectedId && writeUuid);

  const log = (line: string) => {
    setLogs((prev) => [...prev.slice(-7), `${new Date().toLocaleTimeString()} ${line}`]);
  };

  const refreshPeers = () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    setPeers(rt.node.knownPeers());
  };

  const stop = async () => {
    const rt = runtimeRef.current;
    runtimeRef.current = null;
    if (!rt) return;
    rt.unsubs.forEach((off) => off());
    await rt.node.stop();
    setRunning(false);
    setPeers([]);
  };

  const start = async () => {
    await stop();
    if (!canStart) return;

    const node = new MeshNode({
      label: isAndroid ? "Android radio" : "Desktop radio",
      caps: ["ble", "chat", "ping"],
      heartbeatMs: 1500,
      defaultTtl: 6,
      discoveryTtl: 4,
      routing: "unicast",
      gossipFanout: 2,
    });

    node.setSecret(secret);
    node.addTransport(
      new BleTransport(
        isAndroid
          ? { mode: "peripheral", peerId: "ble-neighbor" }
          : {
              mode: "central",
              deviceId: connectedId,
              charUuid: writeUuid,
              peerId: connectedId ?? "ble-neighbor",
            },
      ),
    );

    const chat = node.use(chatService());
    const unsubs: Array<() => void> = [
      chat.on(room, (msg) => setMessages((prev) => [...prev.slice(-7), msg])),
      node.events.on("peer:join", (peer) => {
        log(`peer joined: ${peer.label} (${peer.hops} hop)`);
        refreshPeers();
      }),
      node.events.on("peer:update", refreshPeers),
      node.events.on("peer:leave", (peer) => {
        log(`peer left: ${peer.label}`);
        refreshPeers();
      }),
    ];

    runtimeRef.current = { node, chat, unsubs };
    await node.start();
    setRunning(true);
    log(isAndroid ? "BLE core transport advertising/listening" : "BLE core transport linked to connected device");
    refreshPeers();
  };

  useEffect(() => {
    void start();
    const timer = setInterval(refreshPeers, 800);
    return () => {
      clearInterval(timer);
      void stop();
    };
  }, [runtimePlatform, connectedId, writeUuid]);

  const send = () => {
    const line = text.trim();
    const rt = runtimeRef.current;
    if (!rt || !line) return;
    rt.chat.say(room, line);
    log(`sent encrypted chat frame (${line.length} chars)`);
  };

  const ping = async () => {
    const rt = runtimeRef.current;
    const peer = peers[0];
    if (!rt || !peer) return;
    setBusy(true);
    setRtt(null);
    try {
      const ms = await rt.node.ping(peer.id, 3500);
      setRtt(ms);
      log(`ping ${peer.label}: ${ms}ms`);
    } catch (err) {
      log(`ping failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={panel}>
      <div style={header}>
        <div>
          <h2 style={title}>BLE Core Carrier</h2>
          <p style={subtitle}>
            Same mesh core, now through BLE. Payloads stay compressed/encrypted by MeshNode.
          </p>
        </div>
        <span style={status(running)}>{running ? "online" : "waiting"}</span>
      </div>

      {!canStart && (
        <p style={hint}>Connect to a writable 0xFEED device to bind the BLE carrier.</p>
      )}

      <div style={row}>
        <button onClick={() => void start()} disabled={!canStart} style={button("#111")}>
          Restart carrier
        </button>
        <button onClick={ping} disabled={!running || peers.length === 0 || busy} style={button("#0b6bcb")}>
          {busy ? "Pinging..." : "Ping first peer"}
        </button>
        <span style={metric}>Peers: {peers.length}</span>
        <span style={metric}>RTT: {rtt == null ? "waiting" : `${rtt}ms`}</span>
      </div>

      <div style={row}>
        <input value={text} onChange={(event) => setText(event.target.value)} style={input} />
        <button onClick={send} disabled={!running} style={button("#23615f")}>
          Send chat
        </button>
      </div>

      <div style={grid}>
        <div style={box}>
          <strong>Known mesh peers</strong>
          {peers.length === 0 ? (
            <p style={hint}>Waiting for hello frames.</p>
          ) : (
            peers.map((peer) => (
              <div key={peer.id} style={line}>
                <span>{peer.label}</span>
                <span>{peer.direct ? "direct" : `${peer.hops} hop`}</span>
              </div>
            ))
          )}
        </div>
        <div style={box}>
          <strong>Received chat</strong>
          {messages.length === 0 ? (
            <p style={hint}>No chat frames yet.</p>
          ) : (
            messages.map((msg, index) => (
              <div key={`${msg.ts}-${index}`} style={stackLine}>
                <span style={muted}>{msg.label}</span>
                <span>{msg.text}</span>
              </div>
            ))
          )}
        </div>
        <div style={box}>
          <strong>Carrier log</strong>
          {logs.length === 0 ? (
            <p style={hint}>Idle.</p>
          ) : (
            logs.map((entry) => (
              <div key={entry} style={monoLine}>
                {entry}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

const panel: React.CSSProperties = {
  border: "1px solid #d9dde3",
  borderRadius: 8,
  padding: 16,
  marginBottom: 22,
  background: "#ffffff",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 12,
};

const title: React.CSSProperties = {
  margin: 0,
  textAlign: "left",
};

const subtitle: React.CSSProperties = {
  margin: "4px 0 0",
  color: "#596677",
  fontSize: 13,
};

const status = (active: boolean): React.CSSProperties => ({
  padding: "3px 8px",
  borderRadius: 999,
  color: active ? "#0f5132" : "#664d03",
  background: active ? "#d1e7dd" : "#fff3cd",
  fontSize: 12,
  fontWeight: 700,
});

const row: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  marginTop: 12,
};

const button = (bg: string): React.CSSProperties => ({
  border: 0,
  borderRadius: 5,
  background: bg,
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  padding: "8px 12px",
  boxShadow: "none",
});

const input: React.CSSProperties = {
  flex: "1 1 240px",
  minWidth: 0,
  padding: "8px 10px",
  border: "1px solid #ccd3dc",
  borderRadius: 5,
  boxShadow: "none",
};

const metric: React.CSSProperties = {
  color: "#334155",
  fontSize: 13,
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 10,
  marginTop: 12,
};

const box: React.CSSProperties = {
  border: "1px solid #e2e6ea",
  borderRadius: 6,
  padding: 10,
  background: "#fbfcfd",
  minHeight: 104,
};

const line: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  marginTop: 7,
  fontSize: 12,
};

const stackLine: React.CSSProperties = {
  display: "grid",
  gap: 2,
  marginTop: 7,
  fontSize: 12,
};

const monoLine: React.CSSProperties = {
  fontFamily: "monospace",
  color: "#334155",
  fontSize: 11,
  marginTop: 6,
};

const muted: React.CSSProperties = {
  color: "#687586",
  fontSize: 11,
};

const hint: React.CSSProperties = {
  color: "#7a8796",
  fontSize: 12,
  margin: "8px 0 0",
};
