import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
const advertisesFeed = (d: DeviceInfo) =>
  d.services.some((u) => u.toLowerCase() === FEED_UUID);

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
  const [feedOnly, setFeedOnly] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) =>
    setLogs((prev) => [...prev, `${new Date().toLocaleTimeString()}  ${msg}`]);

  // Escuta notificações (dados recebidos) vindas dos dispositivos conectados.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await listen<NotificationPayload>("ble-notification", (event) => {
        const { char_uuid, value } = event.payload;
        const ascii = value
          .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
          .join("");
        addLog(
          `📥 NOTIFY ${shortUuid(char_uuid)} → [${value.join(", ")}]  "${ascii}"`
        );
      });
    })();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [logs]);

  const handleScan = async () => {
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
      const firstWritable = svcs
        .flatMap((s) => s.characteristics)
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

  return (
    <main style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 900, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Agnostic BLE — Connection</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        Scan → connect → discover services → exchange data over GATT.
      </p>

      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        {/* Coluna esquerda: descoberta de dispositivos */}
        <section style={{ flex: 1 }}>
          <button onClick={handleScan} disabled={isScanning} style={btn("#5cb85c")}>
            {isScanning ? "Scanning..." : "Scan for devices"}
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
                  Send
                </button>
              </div>
            </>
          ) : (
            <p style={{ color: "#999" }}>Connect to a device to see its services.</p>
          )}
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
