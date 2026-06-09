import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// O formato de pacote agnóstico universal que criamos
interface GenericMeshPacket {
  src_addr: number;
  dst_addr: number;
  ttl: number;
  sequence_number: number;
  opcode: number;
  payload: number[];
}

function App() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // Função utilitária para imprimir mensagens na tela do app
  const addLog = (message: string) => {
    setLogs((prev) => [...prev, message]);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    // Conecta o ouvinte para escutar pacotes de rádio REAIS capturados pelo Rust
    async function setupHardwareListener() {
      unlisten = await listen<GenericMeshPacket>("mesh-packet-received", (event) => {
        const packet = event.payload;
        addLog(
          `📡 [RADIO CAPTURE] Valid Node 0x${packet.src_addr.toString(16).toUpperCase()} -> Opcode: 0x${packet.opcode.toString(16).toUpperCase()} | Bytes: [${packet.payload.join(", ")}]`
        );
      });
    }

    setupHardwareListener();

    // Remove o ouvinte quando o app fechar
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Função para ligar o rádio Bluetooth físico do seu Mac
  const toggleHardwareScan = async () => {
    if (isScanning) {
      addLog("Radio is already scanning active.");
      return;
    }

    addLog("Initializing local hardware adapter sequence...");
    try {
      const response = await invoke<string>("start_hardware_mesh_scan");
      addLog(`Status: ${response}`);
      setIsScanning(true);
    } catch (error) {
      addLog(`❌ Hardware Fault: ${error}`);
    }
  };

  // FUNÇÃO DE TRANSMISSÃO: Blasta um pacote de rádio real no ar usando o chip do Mac
  const transmitTestSignal = async () => {
    addLog("Preparing to broadcast a physical mesh packet onto the air...");

    const meshPayloadPacket: GenericMeshPacket = {
      src_addr: 0x00B9,          // Identificador deste nó (Node B9)
      dst_addr: 0xC001,          // Grupo alvo
      ttl: 7,
      sequence_number: Math.floor(Date.now() / 1000), // Número de sequência baseado no relógio atual
      opcode: 0x4444,            // Código de comando agnóstico
      payload: [10, 20, 30, 40]  // Os dados puros (4 bytes) voando pelo rádio
    };

    try {
      const txResult = await invoke<string>("send_hardware_mesh_packet", {
        packet: meshPayloadPacket
      });
      addLog(`📡 [TX SUCCESS]: ${txResult}`);
    } catch (error) {
      addLog(`❌ TX Hardware Error: ${error}`);
    }
  };

  return (
    <main className="container" style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h1>Agnostic Physical BLE Mesh</h1>
      <p>Control and interact with the physical Bluetooth chip on this machine.</p>

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <button
          onClick={toggleHardwareScan}
          style={{
            padding: "12px 24px",
            fontSize: "16px",
            cursor: "pointer",
            backgroundColor: isScanning ? "#d9534f" : "#5cb85c",
            color: "white",
            border: "none",
            borderRadius: "4px"
          }}
        >
          {isScanning ? "Radio Status: LIVE SCANNING" : "Activate Hardware Bluetooth Radio"}
        </button>

        <button
          onClick={transmitTestSignal}
          style={{
            padding: "12px 24px",
            fontSize: "16px",
            cursor: "pointer",
            backgroundColor: "#0275d8",
            color: "white",
            border: "none",
            borderRadius: "4px"
          }}
        >
          Broadcast Test Packet from this Node
        </button>
      </div>

      <div className="log-window" style={{ textAlign: "left", background: "#111", color: "#00ff00", padding: "15px", borderRadius: "8px", maxHeight: "400px", overflowY: "auto", fontFamily: "monospace", border: "1px solid #333" }}>
        <h3>Real-Time Airwaves Traffic Log:</h3>
        {logs.length === 0 && <span style={{ color: "#444" }}>Radio currently dormant. Awaiting activation...</span>}
        {logs.map((log, index) => (
          <div key={index} style={{ marginBottom: "5px", borderBottom: "1px solid #222", paddingBottom: "3px" }}>{log}</div>
        ))}
      </div>
    </main>
  );
}

export default App;
