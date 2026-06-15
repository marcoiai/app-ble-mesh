import { useEffect, useRef, useState } from "react";
import {
  LoopbackHub,
  LoopbackTransport,
  MeshNode,
  chatService,
  type ChatApi,
  type ChatMessage,
  type PeerRecord,
} from "./mesh-core";

type DemoRuntime = {
  hub: LoopbackHub;
  alpha: MeshNode;
  relay: MeshNode;
  beta: MeshNode;
  alphaChat: ChatApi;
  betaChat: ChatApi;
  unsubs: Array<() => void>;
};

type LogLine = {
  ts: number;
  text: string;
};

type MessageLine = ChatMessage & {
  receiver: string;
};

type PeerSnapshot = {
  alpha: PeerRecord[];
  relay: PeerRecord[];
  beta: PeerRecord[];
  frames: number;
};

const room = "protocol-demo";

export function ProtocolCoreDemo() {
  const runtimeRef = useRef<DemoRuntime | null>(null);
  const [running, setRunning] = useState(false);
  const [privateMesh, setPrivateMesh] = useState(true);
  const [secret, setSecret] = useState("levelup-offgrid");
  const [alphaText, setAlphaText] = useState("alpha -> beta over mesh");
  const [betaText, setBetaText] = useState("beta -> alpha reply");
  const [rtt, setRtt] = useState<number | null>(null);
  const [busyPing, setBusyPing] = useState(false);
  const [messages, setMessages] = useState<MessageLine[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [peers, setPeers] = useState<PeerSnapshot>({
    alpha: [],
    relay: [],
    beta: [],
    frames: 0,
  });

  const pushLog = (text: string) => {
    setLogs((prev) => [...prev.slice(-9), { ts: Date.now(), text }]);
  };

  const refreshPeers = () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    setPeers({
      alpha: rt.alpha.knownPeers(),
      relay: rt.relay.knownPeers(),
      beta: rt.beta.knownPeers(),
      frames: rt.hub.delivered,
    });
  };

  const applySecret = (value: string, enabled = privateMesh) => {
    const key = enabled && value.trim().length > 0 ? value.trim() : null;
    const rt = runtimeRef.current;
    rt?.alpha.setSecret(key);
    rt?.relay.setSecret(key);
    rt?.beta.setSecret(key);
  };

  const stopRuntime = async () => {
    const rt = runtimeRef.current;
    runtimeRef.current = null;
    if (!rt) return;
    rt.unsubs.forEach((off) => off());
    await Promise.all([rt.alpha.stop(), rt.relay.stop(), rt.beta.stop()]);
    setRunning(false);
    pushLog("demo stopped");
  };

  const startRuntime = async () => {
    await stopRuntime();

    const hub = new LoopbackHub();
    hub.latencyMs = 12;

    const alpha = new MeshNode({
      label: "Alpha UI",
      caps: ["demo", "chat", "ping"],
      heartbeatMs: 1200,
      defaultTtl: 6,
      discoveryTtl: 4,
      routing: "unicast",
      gossipFanout: 2,
    });
    const relay = new MeshNode({
      label: "Relay",
      caps: ["relay"],
      heartbeatMs: 1200,
      defaultTtl: 6,
      discoveryTtl: 4,
      routing: "unicast",
      gossipFanout: 2,
    });
    const beta = new MeshNode({
      label: "Beta UI",
      caps: ["demo", "chat", "ping"],
      heartbeatMs: 1200,
      defaultTtl: 6,
      discoveryTtl: 4,
      routing: "unicast",
      gossipFanout: 2,
    });

    alpha.addTransport(new LoopbackTransport(hub, alpha.id));
    relay.addTransport(new LoopbackTransport(hub, relay.id));
    beta.addTransport(new LoopbackTransport(hub, beta.id));

    const alphaChat = alpha.use(chatService());
    const betaChat = beta.use(chatService());
    const unsubs: Array<() => void> = [
      alphaChat.on(room, (msg) =>
        setMessages((prev) => [...prev.slice(-7), { ...msg, receiver: "Alpha UI" }]),
      ),
      betaChat.on(room, (msg) =>
        setMessages((prev) => [...prev.slice(-7), { ...msg, receiver: "Beta UI" }]),
      ),
      alpha.events.on("peer:join", (peer) => pushLog(`Alpha learned ${peer.label} in ${peer.hops} hop(s)`)),
      relay.events.on("peer:join", (peer) => pushLog(`Relay learned ${peer.label} in ${peer.hops} hop(s)`)),
      beta.events.on("peer:join", (peer) => pushLog(`Beta learned ${peer.label} in ${peer.hops} hop(s)`)),
    ];

    runtimeRef.current = { hub, alpha, relay, beta, alphaChat, betaChat, unsubs };
    applySecret(secret, privateMesh);

    await Promise.all([alpha.start(), relay.start(), beta.start()]);
    hub.link(alpha.id, relay.id);
    hub.link(relay.id, beta.id);
    setRunning(true);
    setRtt(null);
    setMessages([]);
    pushLog("topology online: Alpha UI -> Relay -> Beta UI");
    refreshPeers();
  };

  useEffect(() => {
    void startRuntime();
    const timer = setInterval(refreshPeers, 600);
    return () => {
      clearInterval(timer);
      void stopRuntime();
    };
  }, []);

  const handlePrivateMeshChange = (enabled: boolean) => {
    setPrivateMesh(enabled);
    applySecret(secret, enabled);
    pushLog(enabled ? "private mesh enabled for app payloads" : "open mesh payloads enabled");
  };

  const handleSecretChange = (value: string) => {
    setSecret(value);
    applySecret(value);
  };

  const handlePing = async () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    setBusyPing(true);
    setRtt(null);
    try {
      const { rtt: ms, fwdPath } = await rt.alpha.ping(rt.beta.id, 2500);
      setRtt(ms);
      const hops = fwdPath.length > 1 ? ` (${fwdPath.length - 1} hop)` : "";
      pushLog(`Alpha pinged Beta through Relay in ${ms}ms${hops}`);
      refreshPeers();
    } catch (err) {
      pushLog(`ping failed: ${String(err)}`);
    } finally {
      setBusyPing(false);
    }
  };

  const sendChat = (side: "alpha" | "beta") => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const text = side === "alpha" ? alphaText : betaText;
    const line = text.trim();
    if (!line) return;
    if (side === "alpha") rt.alphaChat.say(room, line);
    else rt.betaChat.say(room, line);
    pushLog(
      `${side === "alpha" ? "Alpha" : "Beta"} published ${privateMesh ? "encrypted" : "open"} chat frame`,
    );
  };

  return (
    <section style={panel}>
      <div style={headerRow}>
        <div>
          <h2 style={title}>Protocol Core Demo</h2>
          <p style={subtitle}>
            Alpha UI - Relay - Beta UI. Carrier: loopback. Payload mode: {privateMesh ? "private" : "open"}.
          </p>
        </div>
        <div style={statusPill(running)}>
          {running ? "running" : "stopped"}
        </div>
      </div>

      <div style={toolbar}>
        <button onClick={() => void startRuntime()} style={actionButton("#111")}>
          Restart island
        </button>
        <button onClick={handlePing} disabled={!running || busyPing} style={actionButton("#0b6bcb")}>
          {busyPing ? "Pinging..." : "Ping Alpha -> Beta"}
        </button>
        <label style={checkLabel}>
          <input
            type="checkbox"
            checked={privateMesh}
            onChange={(event) => handlePrivateMeshChange(event.target.checked)}
          />
          Private payloads
        </label>
        <input
          value={secret}
          onChange={(event) => handleSecretChange(event.target.value)}
          placeholder="group passphrase"
          style={secretInput}
        />
      </div>

      <div style={topologyGrid}>
        <NodeCard name="Alpha UI" peers={peers.alpha} role="source / subscriber" />
        <NodeCard name="Relay" peers={peers.relay} role="router only" />
        <NodeCard name="Beta UI" peers={peers.beta} role="target / subscriber" />
      </div>

      <div style={metricsRow}>
        <Metric label="RTT" value={rtt == null ? "waiting" : `${rtt}ms`} />
        <Metric label="Frames delivered" value={String(peers.frames)} />
        <Metric label="Topology" value="Alpha - Relay - Beta" />
        <Metric label="Payload mode" value={privateMesh ? "encrypted" : "open"} />
      </div>

      <div style={chatGrid}>
        <div style={chatComposer}>
          <strong>Alpha says</strong>
          <div style={composerRow}>
            <input value={alphaText} onChange={(event) => setAlphaText(event.target.value)} style={chatInput} />
            <button onClick={() => sendChat("alpha")} style={actionButton("#23615f")}>
              Send
            </button>
          </div>
        </div>
        <div style={chatComposer}>
          <strong>Beta says</strong>
          <div style={composerRow}>
            <input value={betaText} onChange={(event) => setBetaText(event.target.value)} style={chatInput} />
            <button onClick={() => sendChat("beta")} style={actionButton("#23615f")}>
              Send
            </button>
          </div>
        </div>
      </div>

      <div style={bottomGrid}>
        <div style={messageBox}>
          <strong>Room traffic</strong>
          {messages.length === 0 ? (
            <p style={emptyText}>Send a chat frame from either side.</p>
          ) : (
            messages.map((msg, index) => (
              <div key={`${msg.ts}-${index}`} style={messageLine}>
                <span style={messageMeta}>
                  {msg.receiver} received {msg.label}
                </span>
                <span>{msg.text}</span>
              </div>
            ))
          )}
        </div>
        <div style={messageBox}>
          <strong>Core log</strong>
          {logs.length === 0 ? (
            <p style={emptyText}>Waiting for core events.</p>
          ) : (
            logs.map((line, index) => (
              <div key={`${line.ts}-${index}-${line.text}`} style={logLine}>
                {new Date(line.ts).toLocaleTimeString()} {line.text}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function NodeCard({ name, peers, role }: { name: string; peers: PeerRecord[]; role: string }) {
  return (
    <div style={nodeCard}>
      <div style={nodeTitleRow}>
        <strong>{name}</strong>
        <span style={nodeRole}>{role}</span>
      </div>
      {peers.length === 0 ? (
        <p style={emptyText}>discovering peers</p>
      ) : (
        peers.map((peer) => (
          <div key={peer.id} style={peerLine}>
            <span>{peer.label}</span>
            <span>{peer.direct ? "direct" : `${peer.hops} hop(s)`}</span>
          </div>
        ))
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricBox}>
      <span style={metricLabel}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const panel: React.CSSProperties = {
  border: "1px solid #d9dde3",
  borderRadius: 8,
  padding: 16,
  marginBottom: 22,
  background: "#ffffff",
};

const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "flex-start",
};

const title: React.CSSProperties = {
  margin: 0,
  textAlign: "left",
};

const subtitle: React.CSSProperties = {
  margin: "4px 0 0",
  color: "#555f6d",
  fontSize: 13,
  lineHeight: "19px",
};

const statusPill = (active: boolean): React.CSSProperties => ({
  padding: "3px 8px",
  borderRadius: 999,
  color: active ? "#0f5132" : "#842029",
  background: active ? "#d1e7dd" : "#f8d7da",
  fontSize: 12,
  fontWeight: 700,
});

const toolbar: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "center",
  marginTop: 14,
};

const actionButton = (bg: string): React.CSSProperties => ({
  border: 0,
  borderRadius: 5,
  background: bg,
  color: "#fff",
  cursor: "pointer",
  fontSize: 13,
  padding: "8px 12px",
  boxShadow: "none",
});

const checkLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  color: "#27313f",
};

const secretInput: React.CSSProperties = {
  minWidth: 190,
  flex: "1 1 190px",
  padding: "8px 10px",
  border: "1px solid #ccd3dc",
  borderRadius: 5,
  boxShadow: "none",
};

const topologyGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
  marginTop: 14,
};

const nodeCard: React.CSSProperties = {
  border: "1px solid #e2e6ea",
  borderRadius: 6,
  padding: 10,
  background: "#f8fafc",
  minHeight: 102,
};

const nodeTitleRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  alignItems: "baseline",
};

const nodeRole: React.CSSProperties = {
  color: "#657282",
  fontSize: 11,
};

const peerLine: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  marginTop: 6,
  fontSize: 12,
  color: "#26313f",
};

const metricsRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
  gap: 8,
  marginTop: 12,
};

const metricBox: React.CSSProperties = {
  border: "1px solid #e5e9ee",
  borderRadius: 6,
  padding: "8px 10px",
  background: "#fff",
};

const metricLabel: React.CSSProperties = {
  display: "block",
  color: "#687586",
  fontSize: 11,
};

const chatGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 10,
  marginTop: 14,
};

const chatComposer: React.CSSProperties = {
  border: "1px solid #e2e6ea",
  borderRadius: 6,
  padding: 10,
};

const composerRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 8,
};

const chatInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 10px",
  border: "1px solid #ccd3dc",
  borderRadius: 5,
  boxShadow: "none",
};

const bottomGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 10,
  marginTop: 12,
};

const messageBox: React.CSSProperties = {
  border: "1px solid #e2e6ea",
  borderRadius: 6,
  padding: 10,
  background: "#fbfcfd",
  minHeight: 116,
};

const messageLine: React.CSSProperties = {
  display: "grid",
  gap: 2,
  paddingTop: 7,
  fontSize: 12,
};

const messageMeta: React.CSSProperties = {
  color: "#687586",
  fontSize: 11,
};

const logLine: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  color: "#27313f",
  paddingTop: 5,
};

const emptyText: React.CSSProperties = {
  color: "#7a8796",
  fontSize: 12,
  margin: "8px 0 0",
};
