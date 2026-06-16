import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
  peripheralLinkCount: number;
  writeUuid: string;
  macAdvertise: boolean;
}

interface ProtocolFrameOut {
  opcode: number;
  payload_text: string;
}

interface CoreEnvelope {
  id?: string;
  type?: string;
  from?: string;
  body?: {
    label?: string;
    caps?: string[];
    neighbors?: string[];
  };
}

type Runtime = {
  node: MeshNode;
  chat: ChatApi;
  unsubs: Array<() => void>;
};

const room = "radio-demo";
const secret = "levelup-offgrid";
const OPCODE_CORE_FRAME = 16;
const DEVICE_LABEL_KEY = "app-ble-mesh.deviceLabel";
const MESH_TICK_MS = 4000;
type PingToast = { text: string; tone: "wait" | "ok" | "bad" };

export function BleCoreMeshDemo({ runtimePlatform, connectedId, peripheralLinkCount, writeUuid, macAdvertise }: BleCoreMeshDemoProps) {
  const runtimeRef = useRef<Runtime | null>(null);
  const lastVisualHelloId = useRef<string | null>(null);
  const lastPrivateFrameAt = useRef(0);
  const pingToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [running, setRunning] = useState(false);
  const [peers, setPeers] = useState<PeerRecord[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [text, setText] = useState("radio mesh payload");
  const [rtt, setRtt] = useState<number | null>(null);
  const [lastHello, setLastHello] = useState<string | null>(null);
  const [lastPingStatus, setLastPingStatus] = useState<"idle" | "sent" | "ok" | "fail">("idle");
  const [pingNotice, setPingNotice] = useState<string | null>(null);
  const [pingToast, setPingToast] = useState<PingToast | null>(null);
  const [visualPeerCount, setVisualPeerCount] = useState(0);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [peerStats, setPeerStats] = useState<Map<string, { rtt: number; path: string[] }>>(new Map());

  const isAndroid = runtimePlatform === "android";
  const isMacPeripheral = runtimePlatform === "macos" && macAdvertise;
  const isPeripheral = isAndroid || isMacPeripheral;
  const canStart = isAndroid ? peripheralLinkCount > 0 : isPeripheral || Boolean(connectedId && writeUuid);

  const log = (line: string) => {
    setLogs((prev) => [...prev.slice(-7), `${new Date().toLocaleTimeString()} ${line}`]);
  };

  const showPingToast = (toast: PingToast, hideAfterMs = 0) => {
    if (pingToastTimer.current) clearTimeout(pingToastTimer.current);
    setPingToast(toast);
    if (hideAfterMs > 0) {
      pingToastTimer.current = setTimeout(() => setPingToast(null), hideAfterMs);
    }
  };

  const addMessage = (msg: ChatMessage) => {
    const visibleText = messageText(msg);
    const normalized = { ...msg, text: visibleText };
    setMessages((prev) => {
      const exists = prev.some((item) => item.from === normalized.from && item.ts === normalized.ts && item.text === normalized.text);
      if (exists) return prev;
      return [...prev.slice(-7), normalized];
    });
  };

  const refreshPeers = () => {
    const rt = runtimeRef.current;
    if (!rt) return;
    const nextPeers = rt.node.knownPeers();
    setPeers(nextPeers);
    setSelectedPeerId((current) => {
      if (current && nextPeers.some((peer) => peer.id === current)) return current;
      return nextPeers[0]?.id ?? null;
    });
  };

  const stop = async () => {
    const rt = runtimeRef.current;
    runtimeRef.current = null;
    if (!rt) return;
    rt.unsubs.forEach((off) => off());
    await rt.node.stop();
    setRunning(false);
    setPeers([]);
    setSelectedPeerId(null);
  };

  const start = async () => {
    await stop();
    if (!canStart) return;

    const node = new MeshNode({
      label: localMeshLabel(runtimePlatform),
      caps: ["ble", "chat", "ping"],
      heartbeatMs: MESH_TICK_MS,
      defaultTtl: 6,
      discoveryTtl: 4,
      routing: "unicast",
      gossipFanout: 2,
    });

    node.setSecret(secret);
    node.addTransport(new BleTransport({ peerId: node.id }));

    const chat = node.use(chatService());
    const unsubs: Array<() => void> = [
      chat.on(room, addMessage),
      node.events.on("peer:join", (peer) => {
        setLastHello(`${peer.label} ${peer.direct ? "direct" : `${peer.hops} hop`}`);
        setVisualPeerCount((count) => Math.max(count, 1));
        log(`peer joined: ${peer.label} (${peer.hops} hop)`);
        refreshPeers();
      }),
      node.events.on("peer:update", (peer) => {
        setLastHello(`${peer.label} ${peer.direct ? "direct" : `${peer.hops} hop`}`);
        setVisualPeerCount((count) => Math.max(count, 1));
        refreshPeers();
      }),
      node.events.on("peer:leave", (peer) => {
        log(`peer left: ${peer.label}`);
        refreshPeers();
      }),
      node.events.on("message", (ctx) => {
        if (ctx.type !== "mesh.ping" || ctx.envelope.reply) return;
        const peer = rtPeerLabel(ctx.from, node.knownPeers());
        showPingToast({ text: `Ping received from ${peer}`, tone: "ok" }, 3200);
        setPingNotice(`Received ping from ${peer}`);
        setLastPingStatus("ok");
        log(`PING received from ${peer}`);
      }),
    ];

    runtimeRef.current = { node, chat, unsubs };
    await node.start();
    setRunning(true);
    setLastPingStatus("idle");
    setPingNotice(null);
    setPingToast(null);
    setLastHello(null);
    setVisualPeerCount(0);
    log(isPeripheral ? "BLE core transport advertising/listening" : "BLE core transport linked to connected device");
    refreshPeers();
  };

  useEffect(() => {
    void start();
    const timer = setInterval(refreshPeers, MESH_TICK_MS);
    return () => {
      clearInterval(timer);
      void stop();
    };
  }, [runtimePlatform, connectedId, peripheralLinkCount, writeUuid, macAdvertise]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ProtocolFrameOut>("protocol-frame", (event) => {
      const frame = event.payload;
      if (frame.opcode !== OPCODE_CORE_FRAME) return;
      try {
        const env = JSON.parse(frame.payload_text) as CoreEnvelope;
        if (env.type === "mesh.hello") {
          if (env.id && lastVisualHelloId.current === env.id) return;
          lastVisualHelloId.current = env.id ?? null;
          const label = env.body?.label ?? shortNode(env.from);
          const caps = env.body?.caps?.join(",") ?? "mesh";
          setLastHello(`${label} (${caps})`);
          setVisualPeerCount((count) => Math.max(count, 1));
          log(`HELLO ${label}`);
        }
        if (env.type === "mesh.ping") {
          setLastPingStatus("ok");
          log(`PING frame from ${shortNode(env.from)}`);
        }
      } catch {
        const now = Date.now();
        if (now - lastPrivateFrameAt.current > 2000) {
          lastPrivateFrameAt.current = now;
          log(`private mesh frame received (${frame.payload_text.length} byte preview)`);
        }
      }
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

  const send = () => {
    const line = text.trim();
    const rt = runtimeRef.current;
    if (!rt || !line) return;
    const msg: ChatMessage = {
      room,
      from: rt.node.id,
      label: "You",
      text: line,
      ts: Date.now(),
    };
    addMessage(msg);
    rt.chat.say(room, line);
    log(`sent encrypted chat frame (${line.length} chars)`);
  };

  const ping = async () => {
    const rt = runtimeRef.current;
    const peer = peers.find((item) => item.id === selectedPeerId) ?? peers[0];
    if (!rt || !peer) {
      showPingToast({ text: "No nearby device to ping yet", tone: "bad" }, 2400);
      return;
    }
    setBusy(true);
    setRtt(null);
    setLastPingStatus("sent");
    setPingNotice("Sending ping...");
    showPingToast({ text: `Pinging ${peer.label}...`, tone: "wait" });
    try {
      const { rtt: ms, fwdPath } = await rt.node.ping(peer.id, 3500);
      setRtt(ms);
      setLastPingStatus("ok");
      setPingNotice(`Ping worked (${ms}ms)`);
      showPingToast({ text: `Ping worked: ${ms}ms`, tone: "ok" }, 3200);
      setPeerStats((prev) => new Map(prev).set(peer.id, { rtt: ms, path: fwdPath }));
      const pathStr = fwdPath.length > 1 ? ` via ${fwdPath.length - 1} hop(s)` : " direct";
      log(`ping ${peer.label}: ${ms}ms${pathStr}`);
    } catch (err) {
      setLastPingStatus("fail");
      setPingNotice("Ping timed out");
      showPingToast({ text: "Ping timed out", tone: "bad" }, 3600);
      log(`ping failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const connectionState = isPeripheral
    ? "Ready"
    : connectedId
      ? "Connected"
      : "Looking";
  const connectionSummary = isPeripheral
    ? "Ready for nearby devices."
    : connectedId
      ? "Connected to a nearby device."
      : "Looking for nearby devices.";
  const nearbyCount = Math.max(peers.length, visualPeerCount);
  const selectedPeer = peers.find((peer) => peer.id === selectedPeerId) ?? peers[0] ?? null;

  return (
    <section style={panel}>
      {pingToast && (
        <div style={toastStyle(pingToast.tone)} role="alert" aria-live="assertive">
          {pingToast.text}
        </div>
      )}

      <div style={header}>
        <div>
          <h2 style={title}>Nearby Mesh</h2>
          <p style={subtitle}>{connectionSummary}</p>
        </div>
        <span style={status(running)}>{running ? "Online" : "Waiting"}</span>
      </div>

      {!canStart && (
        <p style={hint}>Connect to a nearby mesh device to start.</p>
      )}

      <div style={statusGrid}>
        <StatusTile label="Status" value={connectionState} tone={running ? "ok" : "wait"} />
        <StatusTile label="Nearby" value={String(nearbyCount)} tone={nearbyCount > 0 ? "ok" : "wait"} />
        <StatusTile label="Last signal" value={lastHello ?? "Waiting"} tone={lastHello ? "ok" : "wait"} />
        <StatusTile label="Ping" value={pingLabel(lastPingStatus, rtt)} tone={lastPingStatus === "ok" ? "ok" : lastPingStatus === "fail" ? "bad" : "wait"} active={lastPingStatus !== "idle"} />
      </div>

      <div style={row}>
        <button onClick={ping} disabled={!running || !selectedPeer || busy} style={bigButton(lastPingStatus)}>
          {busy ? "Pinging..." : selectedPeer ? `Ping ${selectedPeer.label}` : "Send ping"}
        </button>
        <button onClick={() => void start()} disabled={!canStart} style={button("#5f6368")}>
          Restart
        </button>
        {pingNotice && (
          <span style={pingBadge(lastPingStatus)}>
            {pingNotice}
          </span>
        )}
      </div>

      <div style={row}>
        <input value={text} onChange={(event) => setText(event.target.value)} style={input} />
        <button onClick={send} disabled={!running} style={button("#23615f")}>
          Send chat
        </button>
      </div>

      <div style={grid}>
        <div style={box}>
          <strong>Nearby devices</strong>
          {peers.length === 0 ? (
            <p style={hint}>Waiting for a nearby device.</p>
          ) : (
            peers.map((peer) => {
              const stats = peerStats.get(peer.id);
              const nodeId = runtimeRef.current?.node.id;
              return (
                <button
                  key={peer.id}
                  type="button"
                  onClick={() => setSelectedPeerId(peer.id)}
                  style={peerButton(peer.id === selectedPeerId)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                    <span>{peer.label}</span>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {stats && <span style={rttBadge}>{stats.rtt}ms</span>}
                      <span style={muted}>{peer.direct ? "direct" : `${peer.hops} hop`}</span>
                    </div>
                  </div>
                  {stats && stats.path.length > 0 && (
                    <div style={pathLine}>
                      {pathLabels(stats.path, nodeId, peers).join(" → ")}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div style={box}>
          <strong>Messages</strong>
          {messages.length === 0 ? (
            <p style={hint}>No messages yet.</p>
          ) : (
            messages.map((msg, index) => (
              <div key={`${msg.ts}-${index}`} style={messageLine(msg.from === runtimeRef.current?.node.id)}>
                <div style={messageMeta}>
                  <span>{msg.from === runtimeRef.current?.node.id ? "You" : msg.label}</span>
                  <span>{formatMessageTime(msg.ts)}</span>
                </div>
                <span style={messageBody}>{msg.text}</span>
              </div>
            ))
          )}
        </div>
        <div style={box}>
          <strong>Activity</strong>
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

function pathLabels(path: string[], localId: string | undefined, peers: PeerRecord[]): string[] {
  return path.map((nodeId) => {
    if (nodeId === localId) return "You";
    return peers.find((p) => p.id === nodeId)?.label ?? nodeId.slice(0, 6);
  });
}

function shortNode(id: string | undefined): string {
  if (!id) return "peer";
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function rtPeerLabel(id: string, peers: PeerRecord[]): string {
  return peers.find((peer) => peer.id === id)?.label ?? shortNode(id);
}

function localMeshLabel(runtimePlatform: string): string {
  if (typeof window === "undefined") {
    return runtimePlatform === "android" ? "Android radio" : "Mac radio";
  }
  const saved = window.localStorage.getItem(DEVICE_LABEL_KEY);
  if (saved) return saved;

  const platform = runtimePlatform === "android" ? "Droid" : runtimePlatform === "macos" ? "Mac" : "Desktop";
  const suffix = globalThis.crypto.randomUUID().slice(0, 4).toUpperCase();
  const label = `${platform}-${suffix}`;
  window.localStorage.setItem(DEVICE_LABEL_KEY, label);
  return label;
}

function StatusTile({ label, value, tone, active = false }: { label: string; value: string; tone: "ok" | "wait" | "bad"; active?: boolean }) {
  return (
    <div style={tile(tone, active)}>
      <span style={tileLabel}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function pingLabel(statusValue: "idle" | "sent" | "ok" | "fail", rtt: number | null): string {
  if (statusValue === "ok") return rtt == null ? "OK" : `${rtt}ms`;
  if (statusValue === "sent") return "Sent";
  if (statusValue === "fail") return "Failed";
  return "Ready";
}

function messageText(msg: ChatMessage): string {
  const text = String(msg.text ?? "").trim();
  if (text) return text;
  return "(empty message)";
}

function formatMessageTime(ts: number): string {
  if (!Number.isFinite(ts)) return "--:--:--";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
  color: "#334155",
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

const statusGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: 8,
  marginTop: 14,
};

const tile = (tone: "ok" | "wait" | "bad", active = false): React.CSSProperties => ({
  border: `1px solid ${tone === "ok" ? "#9fd3b5" : tone === "bad" ? "#efb5b5" : "#d8dde5"}`,
  borderRadius: 6,
  padding: "9px 10px",
  background: tone === "ok" ? "#f0fbf5" : tone === "bad" ? "#fff5f5" : "#f8fafc",
  boxShadow: active ? `0 0 0 3px ${tone === "bad" ? "rgba(217, 83, 79, 0.16)" : "rgba(25, 135, 84, 0.16)"}` : "none",
  minHeight: 54,
});

const tileLabel: React.CSSProperties = {
  display: "block",
  color: "#334155",
  fontSize: 11,
  fontWeight: 700,
  marginBottom: 2,
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

const bigButton = (statusValue: "idle" | "sent" | "ok" | "fail"): React.CSSProperties => ({
  ...button(statusValue === "ok" ? "#198754" : statusValue === "fail" ? "#d9534f" : "#0b6bcb"),
  fontSize: 15,
  padding: "11px 18px",
});

const pingBadge = (statusValue: "idle" | "sent" | "ok" | "fail"): React.CSSProperties => ({
  borderRadius: 999,
  padding: "7px 10px",
  background: statusValue === "ok" ? "#d1e7dd" : statusValue === "fail" ? "#f8d7da" : "#e7f1ff",
  color: statusValue === "ok" ? "#0f5132" : statusValue === "fail" ? "#842029" : "#084298",
  fontSize: 12,
  fontWeight: 700,
});

const toastStyle = (tone: "wait" | "ok" | "bad"): React.CSSProperties => ({
  position: "fixed",
  top: 22,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 9999,
  border: `1px solid ${tone === "ok" ? "#75b798" : tone === "bad" ? "#ea868f" : "#9ec5fe"}`,
  borderRadius: 10,
  padding: "14px 18px",
  minWidth: 260,
  maxWidth: "calc(100vw - 32px)",
  textAlign: "center",
  background: tone === "ok" ? "#d1e7dd" : tone === "bad" ? "#f8d7da" : "#e7f1ff",
  color: tone === "ok" ? "#0f5132" : tone === "bad" ? "#842029" : "#084298",
  fontSize: 16,
  fontWeight: 800,
  boxShadow: "0 18px 46px rgba(15, 23, 42, 0.28)",
});

const input: React.CSSProperties = {
  flex: "1 1 240px",
  minWidth: 0,
  padding: "8px 10px",
  border: "1px solid #ccd3dc",
  borderRadius: 5,
  boxShadow: "none",
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

const peerButton = (selected: boolean): React.CSSProperties => ({
  ...line,
  width: "100%",
  border: `1px solid ${selected ? "#8bbcff" : "#e2e8f0"}`,
  borderRadius: 5,
  background: selected ? "#e7f1ff" : "#ffffff",
  color: "#111827",
  cursor: "pointer",
  font: "inherit",
  padding: "7px 8px",
  textAlign: "left",
});

const messageLine = (own: boolean): React.CSSProperties => ({
  display: "grid",
  gap: 4,
  marginTop: 7,
  fontSize: 12,
  padding: "7px 8px",
  borderRadius: 6,
  background: own ? "#eef7ff" : "#f4f7fa",
  border: `1px solid ${own ? "#bddcff" : "#e2e8f0"}`,
});

const messageMeta: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  color: "#475569",
  fontSize: 11,
};

const messageBody: React.CSSProperties = {
  color: "#0f172a",
  fontSize: 13,
  lineHeight: 1.35,
  overflowWrap: "anywhere",
};

const monoLine: React.CSSProperties = {
  fontFamily: "monospace",
  color: "#334155",
  fontSize: 11,
  marginTop: 6,
};

const muted: React.CSSProperties = {
  color: "#475569",
  fontSize: 11,
};

const hint: React.CSSProperties = {
  color: "#475569",
  fontSize: 12,
  margin: "8px 0 0",
};

const rttBadge: React.CSSProperties = {
  background: "#d1e7dd",
  color: "#0f5132",
  borderRadius: 999,
  padding: "1px 6px",
  fontSize: 11,
  fontWeight: 700,
};

const pathLine: React.CSSProperties = {
  width: "100%",
  marginTop: 3,
  fontSize: 10,
  color: "#64748b",
  fontFamily: "monospace",
  textAlign: "left",
};
