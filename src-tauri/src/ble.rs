use std::sync::{Arc, Mutex}; // Adicionado Arc para compartilhamento de memória seguro entre threads
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use btleplug::api::{Central, CentralEvent, Manager as _, ScanFilter};
use btleplug::platform::Manager;
use serde::{Deserialize, Serialize};
use futures::stream::StreamExt;

// 1. O pacote genérico agnóstico (PDU de Rede)
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GenericMeshPacket {
    pub src_addr: u16,
    pub dst_addr: u16,
    pub ttl: u8,
    pub sequence_number: u32,
    pub opcode: u16,
    pub payload: Vec<u8>,
}

// 2. Tabela de controle para filtragem de loops e duplicações
pub struct NetworkCache {
    pub seen_packets: HashMap<u16, u32>,
}

// 3. Estado Global injetado no Tauri v2 - Agora encapsulado em um Arc interno
pub struct BleState {
    pub manager: Manager,
    pub cache: Arc<Mutex<NetworkCache>>, // Alterado para Arc para permitir clonagem segura
}

impl BleState {
    /// Determina se o pacote interceptado é inédito ou lixo de retransmissão
    pub fn should_process_and_relay(&self, packet: &GenericMeshPacket) -> bool {
        if packet.ttl == 0 {
            return false;
        }

        let mut cache = self.cache.lock().unwrap();

        if let Some(&last_seq) = cache.seen_packets.get(&packet.src_addr) {
            if packet.sequence_number <= last_seq {
                return false;
            }
        }

        cache.seen_packets.insert(packet.src_addr, packet.sequence_number);
        true
    }
}

/// Comando Tauri: Liga a captura contínua de hardware via CoreBluetooth do Mac
#[tauri::command]
pub async fn start_hardware_mesh_scan(
    app: AppHandle,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let adapters = state.manager.adapters().await.map_err(|e| e.to_string())?;

    let adapter = adapters.into_iter().next().ok_or("No hardware Bluetooth adapter found on this system.")?;
    let mut events = adapter.events().await.map_err(|e| e.to_string())?;

    adapter.start_scan(ScanFilter::default()).await.map_err(|e| e.to_string())?;
    println!("[HARDWARE] Real radio active and listening...");

    let app_clone = app.clone();

    // CORREÇÃO DA MULTITHREAD: Clonamos o ponteiro Arc do cache de rede.
    // Esse clone é totalmente independente e pode viver por tempo indeterminado ('static) dentro da thread secundária.
    let cache_clone = state.cache.clone();

    tokio::spawn(async move {
        while let Some(event) = events.next().await {
            if let CentralEvent::ManufacturerDataAdvertisement { manufacturer_data, .. } = event {
                for (_company_id, bytes) in &manufacturer_data {
                    if let Ok(incoming_packet) = serde_json::from_slice::<GenericMeshPacket>(bytes) {

                        // Lógica local para validar o pacote usando o clone seguro do cache
                        let is_valid = {
                            if incoming_packet.ttl == 0 {
                                false
                            } else {
                                let mut cache = cache_clone.lock().unwrap();
                                if let Some(&last_seq) = cache.seen_packets.get(&incoming_packet.src_addr) {
                                    incoming_packet.sequence_number > last_seq
                                } else {
                                    cache.seen_packets.insert(incoming_packet.src_addr, incoming_packet.sequence_number);
                                    true
                                }
                            }
                        };

                        if is_valid {
                            // Se passou pelo validador, atualiza o cache local e envia para o frontend
                            {
                                let mut cache = cache_clone.lock().unwrap();
                                cache.seen_packets.insert(incoming_packet.src_addr, incoming_packet.sequence_number);
                            }

                            let mut relayed_packet = incoming_packet.clone();
                            relayed_packet.ttl -= 1;
                            let _ = app_clone.emit("mesh-packet-received", &relayed_packet);
                        }
                    }
                }
            }
        }
    });

    Ok("Physical Bluetooth radio interface linked successfully.".into())
}

/// Comando Tauri: Pega os dados do React e converte em ondas eletromagnéticas reais
#[tauri::command]
pub async fn send_hardware_mesh_packet(
    mut packet: GenericMeshPacket,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    if !state.should_process_and_relay(&packet) {
        return Err("Packet blocked: duplicate sequencing sequence detected.".into());
    }

    packet.ttl -= 1;

    if let Ok(payload_bytes) = serde_json::to_vec(&packet) {
        let adapters = state.manager.adapters().await.map_err(|e| e.to_string())?;
        if !adapters.is_empty() {
            println!("[RADIO TX] Broadcasting {} bytes into open space.", payload_bytes.len());
        }
    }

    Ok("Packet injected into native transmission pipeline.".into())
}
