import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BleCoreMeshDemo } from "./BleCoreMeshDemo";
import { ProtocolCoreDemo } from "./ProtocolCoreDemo";
import "./App.css";

// ---- Tipos espelhados do Rust (ble.rs) ------------------------------------
interface DeviceInfo {
  id: string;
  name: string;
  rssi: number | null;
  connected: boolean;
  services: string[];
}

// Serviço anunciado pelo levelup (0xFEED na forma curta).
const FEED_UUID = "0000feed-0000-1000-8000-00805f9b34fb";
const FEED_CHAR_UUID = "0000fee1-0000-1000-8000-00805f9b34fb";
const advertisesFeed = (d: DeviceInfo) =>
  d.services.some((u) => u.toLowerCase() === FEED_UUID);
const OPCODE_PING = 2;
const OPCODE_PONG = 3;

interface CharacteristicInfo {
  uuid: string;
  read: boolean;
  write: boolean;
  notify: boolean;
}

interface ServiceInfo {
  uuid: string;
  characteristics: CharacteristicInfo[];
}

interface NotificationPayload {
  device_id: string;
  char_uuid: string;
  value: number[];
}

interface ProtocolNodeInfo {
  node_addr: number;
}

interface ProtocolFrameOut {
  src_addr: number;
  dst_addr: number;
  ttl: number;
  sequence_number: number;
  opcode: number;
  payload_text: string;
  payload_len: number;
  checksum: number;
}

interface ProtocolRelayPayload {
  src_addr: number;
  dst_addr: number;
  sequence_number: number;
  ttl: number;
  target_device_id: string;
  char_uuid: string;
  bytes_len: number;
}

interface ProtocolTransportPayload {
  sequence_number: number;
  packet_count: number;
  bytes_len: number;
}

interface PeripheralStatus {
  running: boolean;
}

interface MeshStats {
  pingsSent: number;
  pongsReceived: number;
  relays: number;
  lastRttMs: number | null;
  lastPackets: number;
  lastBytes: number;
}

function shortUuid(uuid: string): string {
  // Mostra a forma curta 16-bit quando for um UUID Bluetooth padrão.
  const m = uuid.match(/^0000([0-9a-fA-F]{4})-0000-1000-8000-00805f9b34fb$/);
  return m ? `0x${m[1].toUpperCase()}` : uuid;
}

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [writeUuid, setWriteUuid] = useState("");
  const [writeText, setWriteText] = useState("Hello");
  const [nodeAddr, setNodeAddr] = useState<number | null>(null);
  const [feedOnly, setFeedOnly] = useState(false);
  const [macAdvertise, setMacAdvertise] = useState(false);
  const [runtimePlatform, setRuntimePlatform] = useState("unknown");
  const [logs, setLogs] = useState<string[]>([]);
  const [meshStats, setMeshStats] = useState<MeshStats>({
    pingsSent: 0,
    pongsReceived: 0,
    relays: 0,
    lastRttMs: null,
    lastPackets: 0,
    lastBytes: 0,
  });
  const logRef = useRef<HTMLDivElement>(null);
  const pendingPings = useRef<Map<number, number>>(new Map());
  const canSendMesh =
    runtimePlatform === "android" || (connectedId != null && writeUuid.length > 0);

  const addLog = (msg: string) =>
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${msg}`]);

  // Escuta notificações (dados recebidos) vindas dos dispositivos conectados.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenProtocol: (() => void) | undefined;
    let unlistenRelay: (() => void) | undefined;
    let unlistenTransport: (() => void) | undefined;
    let unlistenMacPeripheral: (() => void) | undefined;
    (async () => {
      invoke<ProtocolNodeInfo>("protocol_node_info")
        .then((info) => {
          setNodeAddr(info.node_addr);
          addLog(`🧬 Protocol node addr: ${info.node_addr}`);
        })
        .catch((e) => addLog(`⚠️ Protocol node info failed: ${e}`));
      invoke<string>("runtime_platform")
        .then((platform) => {
          setRuntimePlatform(platform);
          if (platform === "android") {
            addLog("📣 Android BLE peripheral starts automatically.");
          }
        })
        .catch(() => setRuntimePlatform("unknown"));
      unlisten = await listen<NotificationPayload>("ble-notification", (event) => {
        const { char_uuid, value } = event.payload;
        const ascii = value
          .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
          .join("");
        addLog(
          `📥 NOTIFY ${shortUuid(char_uuid)} → [${value.join(", ")}]  "${ascii}"`
        );
      });
      unlistenProtocol = await listen<ProtocolFrameOut>("protocol-frame", (event) => {
        const f = event.payload;
        if (f.opcode === OPCODE_PONG) {
          const parts = f.payload_text.split(":");
          const pingSeq = Number(parts[1]);
          const sentAt = Number(parts[2]);
          const started = pendingPings.current.get(pingSeq) ?? sentAt;
          pendingPings.current.delete(pingSeq);
          const rtt = Date.now() - started;
          setMeshStats((prev) => ({
            ...prev,
            pongsReceived: prev.pongsReceived + 1,
            lastRttMs: rtt,
          }));
          addLog(`🏓 PONG from=${f.src_addr} pingSeq=${pingSeq} rtt=${rtt}ms`);
          return;
        }
        if (f.opcode === OPCODE_PING) {
          addLog(`📍 PING from=${f.src_addr} seq=${f.sequence_number}; auto-pong should answer`);
        }
        addLog(
          `🧭 PROTOCOL src=${f.src_addr} dst=${f.dst_addr} ttl=${f.ttl} seq=${f.sequence_number} op=${f.opcode} len=${f.payload_len} "${f.payload_text}"`
        );
      });
      unlistenRelay = await listen<ProtocolRelayPayload>("protocol-relay", (event) => {
        const r = event.payload;
        setMeshStats((prev) => ({ ...prev, relays: prev.relays + 1 }));
        addLog(
          `🔁 RELAY src=${r.src_addr} dst=${r.dst_addr} seq=${r.sequence_number} ttl=${r.ttl} → ${shortUuid(r.char_uuid)} bytes=${r.bytes_len}`
        );
      });
      unlistenTransport = await listen<ProtocolTransportPayload>("protocol-transport", (event) => {
        const t = event.payload;
        setMeshStats((prev) => ({
          ...prev,
          lastPackets: t.packet_count,
          lastBytes: t.bytes_len,
        }));
        addLog(
          `🧩 TRANSPORT seq=${t.sequence_number} packets=${t.packet_count} bytes=${t.bytes_len}`
        );
      });
      unlistenMacPeripheral = await listen<string>("macos-peripheral-log", (event) => {
        addLog(`📣 MAC ADV ${event.payload}`);
      });
      invoke<string>("runtime_platform")
        .then((platform) => {
          if (platform === "macos") {
            invoke<PeripheralStatus>("macos_peripheral_status")
              .then((status) => setMacAdvertise(status.running))
              .catch(() => setMacAdvertise(false));
          }
        })
        .catch(() => setMacAdvertise(false));
    })();
    return () => {
      unlisten?.();
      unlistenProtocol?.();
      unlistenRelay?.();
      unlistenTransport?.();
      unlistenMacPeripheral?.();
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs]);

  const handleScan = async () => {
    if (runtimePlatform === "android") {
      addLog("📣 Android is already advertising 0xFEED. Scan from a Mac to connect to this phone.");
      return;
    }
    setIsScanning(true);
    addLog("🔍 Scanning for nearby BLE devices (~4s)...");
    try {
      const found = await invoke<DeviceInfo[]>("scan_devices");
      setDevices(found);
      addLog(`✅ Found ${found.length} device(s).`);
    } catch (e) {
      addLog(`❌ Scan failed: ${e}`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleToggleMacAdvertise = async () => {
    if (runtimePlatform !== "macos") {
      addLog("📣 This device advertises automatically; macOS helper is not used here.");
      return;
    }
    try {
      const status = await invoke<PeripheralStatus>(
        macAdvertise ? "macos_peripheral_stop" : "macos_peripheral_start"
      );
      setMacAdvertise(status.running);
      addLog(status.running ? "📣 This Mac is advertising 0xFEED" : "📣 Mac advertising stopped");
    } catch (e) {
      addLog(`❌ Mac advertise failed: ${e}`);
    }
  };

  const handleConnect = async (id: string, name: string) => {
    setConnecting(true);
    addLog(`🔗 Connecting to ${name} ...`);
    try {
      const svcs = await invoke<ServiceInfo[]>("connect_device", { id });
      setServices(svcs);
      setConnectedId(id);
      const charCount = svcs.reduce((n, s) => n + s.characteristics.length, 0);
      addLog(`✅ Connected. ${svcs.length} service(s), ${charCount} characteristic(s).`);
      // Pré-seleciona a primeira característica gravável para conveniência.
      const allCharacteristics = svcs.flatMap((s) => s.characteristics);
      const feedWritable = allCharacteristics.find(
        (c) => c.write && c.uuid.toLowerCase() === FEED_CHAR_UUID
      );
      const firstWritable = feedWritable ?? allCharacteristics
        .find((c) => c.write);
      if (firstWritable) setWriteUuid(firstWritable.uuid);
    } catch (e) {
      addLog(`❌ Connect failed: ${e}`);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!connectedId) return;
    try {
      const res = await invoke<string>("disconnect_device", { deviceId: connectedId });
      addLog(`🔌 ${res}`);
    } catch (e) {
      addLog(`❌ Disconnect error: ${e}`);
    }
    setConnectedId(null);
    setServices([]);
  };

  const handleWrite = async () => {
    if (!connectedId || !writeUuid) {
      addLog("⚠️ Pick a writable characteristic first.");
      return;
    }
    const bytes = Array.from(new TextEncoder().encode(writeText));
    try {
      const res = await invoke<string>("write_characteristic", {
        deviceId: connectedId,
        charUuid: writeUuid,
        data: bytes,
      });
      addLog(`📤 ${res}  "${writeText}"`);
    } catch (e) {
      addLog(`❌ Write failed: ${e}`);
    }
  };

  const handleProtocolSend = async () => {
    if (!connectedId || !writeUuid) {
      addLog("⚠️ Pick a writable characteristic first.");
      return;
    }
    try {
      const res = await invoke<string>("send_protocol_text_to_device", {
        request: {
          deviceId: connectedId,
          charUuid: writeUuid,
          dstAddr: 65535,
          ttl: 3,
          text: writeText,
        },
      });
      addLog(`📡 ${res}  "${writeText}"`);
    } catch (e) {
      addLog(`❌ Protocol send failed: ${e}`);
    }
  };

  const handleMeshPing = async () => {
    if (runtimePlatform === "android") {
      try {
        const res = await invoke<string>("send_android_peripheral_ping");
        const seq = Number(res.match(/seq=(\d+)/)?.[1]);
        if (Number.isFinite(seq)) {
          pendingPings.current.set(seq, Date.now());
        }
        setMeshStats((prev) => ({
          ...prev,
          pingsSent: prev.pingsSent + 1,
          lastRttMs: null,
        }));
        addLog(`🏓 ${res}`);
      } catch (e) {
        addLog(`❌ Android mesh ping failed: ${e}`);
      }
      return;
    }
    if (!connectedId || !writeUuid) {
      addLog("⚠️ Pick a writable characteristic first.");
      return;
    }
    try {
      const res = await invoke<string>("send_protocol_ping_to_device", {
        request: {
          deviceId: connectedId,
          charUuid: writeUuid,
          dstAddr: 65535,
          ttl: 4,
        },
      });
      const seq = Number(res.match(/seq=(\d+)/)?.[1]);
      if (Number.isFinite(seq)) {
        pendingPings.current.set(seq, Date.now());
      }
      setMeshStats((prev) => ({
        ...prev,
        pingsSent: prev.pingsSent + 1,
        lastRttMs: null,
      }));
      addLog(`🏓 ${res}`);
    } catch (e) {
      addLog(`❌ Mesh ping failed: ${e}`);
    }
  };

  return (
    <main style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Agnostic BLE — Connection</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Advertise or scan for another 0xFEED node → connect → ping over off-grid BLE.
        {nodeAddr != null && (
          <span style={{ marginLeft: 8, fontFamily: "monospace" }}>
            node={nodeAddr}
          </span>
        )}
      </p>

      <ProtocolCoreDemo />
      <BleCoreMeshDemo
        runtimePlatform={runtimePlatform}
        connectedId={connectedId}
        writeUuid={writeUuid}
      />

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Coluna esquerda: descoberta de dispositivos */}
        <section style={{ flex: 1 }}>
          {runtimePlatform === "macos" ? (
            <>
              <button
                onClick={handleToggleMacAdvertise}
                style={btn(macAdvertise ? "#d9534f" : "#111")}
              >
                {macAdvertise ? "Stop advertising this Mac" : "Advertise this Mac"}
              </button>

              <div style={{ marginTop: 8, fontSize: 12, color: macAdvertise ? "#1f7a1f" : "#777" }}>
                {macAdvertise
                  ? "This Mac should be visible as app-ble-mesh / 0xFEED."
                  : "Start advertising on one Mac, then scan from the other."}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12, color: "#1f7a1f" }}>
              {runtimePlatform === "android"
                ? "This Android advertises 0xFEED automatically while the app is open."
                : "Advertising status is managed by this platform."}
            </div>
          )}

          <button
            onClick={handleScan}
            disabled={isScanning || runtimePlatform === "android"}
            style={btn(runtimePlatform === "android" ? "#777" : "#5cb85c")}
          >
            {runtimePlatform === "android"
              ? "Android advertising; scan from Mac"
              : isScanning
                ? "Scanning..."
                : "Scan for devices"}
          </button>

          <label style={{ display: "block", marginTop: 8, fontSize: 13, color: "#555" }}>
            <input
              type="checkbox"
              checked={feedOnly}
              onChange={(e) => setFeedOnly(e.target.checked)}
            />{" "}
            Show only 0xFEED (levelup) — {devices.filter(advertisesFeed).length} found
          </label>

          <div style={{ marginTop: 12 }}>
            {devices.length === 0 && (
              <p style={{ color: "#999" }}>No devices yet. Run a scan.</p>
            )}
            {devices
              .filter((d) => !feedOnly || advertisesFeed(d))
              .map((d) => {
              const isConnected = d.id === connectedId;
              return (
                <div key={d.id} style={card(isConnected)}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <strong>
                      {d.name}
                      {advertisesFeed(d) && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: 10,
                            fontWeight: 700,
                            color: "#fff",
                            background: "#e67e22",
                            padding: "1px 5px",
                            borderRadius: 3,
                          }}
                        >
                          FEED
                        </span>
                      )}
                    </strong>
                    <span style={{ color: "#888", fontSize: 12 }}>
                      {d.rssi != null ? `${d.rssi} dBm` : "—"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#aaa", wordBreak: "break-all" }}>
                    {d.id}
                  </div>
                  {isConnected ? (
                    <button onClick={handleDisconnect} style={miniBtn("#d9534f")}>
                      Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(d.id, d.name)}
                      disabled={connecting || connectedId != null}
                      style={miniBtn("#0275d8")}
                    >
                      {connecting ? "..." : "Connect"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Coluna direita: serviços + envio de dados */}
        <section style={{ flex: 1 }}>
          {connectedId ? (
            <>
              <h3 style={{ marginTop: 0 }}>Services & Characteristics</h3>
              <div style={{ maxHeight: 260, overflowY: "auto" }}>
                {services.map((s) => (
                  <div key={s.uuid} style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>
                      Service {shortUuid(s.uuid)}
                    </div>
                    {s.characteristics.map((c) => (
                      <div
                        key={c.uuid}
                        onClick={() => c.write && setWriteUuid(c.uuid)}
                        style={{
                          fontSize: 12,
                          padding: "3px 8px",
                          marginLeft: 10,
                          cursor: c.write ? "pointer" : "default",
                          background: writeUuid === c.uuid ? "#e6f0ff" : "transparent",
                          borderRadius: 4,
                        }}
                      >
                        {shortUuid(c.uuid)}{" "}
                        <span style={{ color: "#888" }}>
                          {[c.read && "R", c.write && "W", c.notify && "N"]
                            .filter(Boolean)
                            .join("/")}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <h3>Send data</h3>
              <input
                value={writeUuid}
                onChange={(e) => setWriteUuid(e.target.value)}
                placeholder="characteristic uuid (W)"
                style={{ width: "100%", padding: 6, marginBottom: 6, fontSize: 12 }}
              />
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={writeText}
                  onChange={(e) => setWriteText(e.target.value)}
                  style={{ flex: 1, padding: 6 }}
                />
                <button onClick={handleWrite} style={btn("#0275d8")}>
                  Send raw
                </button>
                <button onClick={handleProtocolSend} style={btn("#6f42c1")}>
                  Send protocol
                </button>
              </div>

            </>
          ) : (
            <p style={{ color: "#999" }}>
              Connect to the Android 0xFEED device to see services and enable protocol sends.
            </p>
          )}

          <h3>Mesh proof</h3>
          <div style={{ ...card(false), background: "#f7fbf8" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                fontSize: 12,
              }}
            >
              <strong>Ping sent: {meshStats.pingsSent}</strong>
              <strong>Pong recv: {meshStats.pongsReceived}</strong>
              <span>Relays: {meshStats.relays}</span>
              <span>
                RTT: {meshStats.lastRttMs == null ? "waiting" : `${meshStats.lastRttMs}ms`}
              </span>
              <span>Packets: {meshStats.lastPackets}</span>
              <span>Bytes: {meshStats.lastBytes}</span>
            </div>
            <button
              onClick={handleMeshPing}
              disabled={!canSendMesh}
              style={{
                ...btn(canSendMesh ? "#111" : "#777"),
                marginTop: 10,
                cursor: canSendMesh ? "pointer" : "not-allowed",
              }}
            >
              {runtimePlatform === "android" ? "Ping subscribed Mac" : "Ping mesh"}
            </button>
            {!canSendMesh && (
              <div style={{ marginTop: 8, color: "#777", fontSize: 12 }}>
                {runtimePlatform === "android"
                  ? "Waiting for a Mac to connect and subscribe."
                  : "Waiting for a connected writable 0xFEED characteristic."}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Log de tráfego */}
      <h3 style={{ marginBottom: 6 }}>Traffic log</h3>
      <div
        ref={logRef}
        style={{
          textAlign: "left",
          background: "#111",
          color: "#00ff00",
          padding: 12,
          borderRadius: 8,
          height: 220,
          overflowY: "auto",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        {logs.length === 0 && <span style={{ color: "#444" }}>Idle...</span>}
        {logs.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
      </div>
    </main>
  );
}

const btn = (bg: string): React.CSSProperties => ({
  padding: "10px 18px",
  fontSize: 14,
  cursor: "pointer",
  background: bg,
  color: "white",
  border: "none",
  borderRadius: 4,
});

const miniBtn = (bg: string): React.CSSProperties => ({
  ...btn(bg),
  padding: "4px 10px",
  fontSize: 12,
  marginTop: 6,
});

const card = (active: boolean): React.CSSProperties => ({
  border: `1px solid ${active ? "#0275d8" : "#ddd"}`,
  borderRadius: 6,
  padding: 10,
  marginBottom: 8,
  background: active ? "#f5f9ff" : "#fafafa",
});

export default App;
