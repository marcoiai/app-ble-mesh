use btleplug::api::{
    Central, CentralEvent, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex}; // Arc para compartilhamento seguro entre threads
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::protocol::{self, ProtocolFrame, ProtocolNodeInfo};

// =====================================================================================
//  MODELO DE PACOTE DO MESH (transporte agnóstico que viaja DENTRO de uma característica)
// =====================================================================================

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
    pub relay_cache: protocol::RelayCache,
    pub reassembly_cache: protocol::ReassemblyCache,
}

// 3. Estado Global injetado no Tauri v2
pub struct BleState {
    pub manager: Manager,
    pub cache: Arc<Mutex<NetworkCache>>,
    pub node_addr: u16,
    pub sequence: Arc<Mutex<u32>>,
    // Periféricos atualmente conectados, indexados pelo seu id (string).
    // Guardamos o handle clonável para reutilizar a conexão em writes/subscribe.
    pub connected: Arc<Mutex<HashMap<String, Peripheral>>>,
}

/// Helper: pega o primeiro adaptador Bluetooth físico da máquina.
async fn first_adapter(state: &tauri::State<'_, BleState>) -> Result<Adapter, String> {
    let adapters = state.manager.adapters().await.map_err(|e| e.to_string())?;
    adapters
        .into_iter()
        .next()
        .ok_or_else(|| "No hardware Bluetooth adapter found on this system.".to_string())
}

async fn find_peripheral_for_connect(adapter: &Adapter, id: &str) -> Result<Peripheral, String> {
    let mut peripherals = adapter.peripherals().await.map_err(|e| e.to_string())?;
    if let Some(peripheral) = peripherals.iter().find(|p| p.id().to_string() == id) {
        return Ok(peripheral.clone());
    }

    println!("[CONNECT] Device {id} was not in the adapter cache; rescanning before connect...");
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("Could not restart BLE scan before connect: {e}"))?;
    tokio::time::sleep(Duration::from_millis(2500)).await;

    peripherals = adapter.peripherals().await.map_err(|e| e.to_string())?;
    let peripheral = peripherals.iter().find(|p| p.id().to_string() == id).cloned();
    if let Some(peripheral) = peripheral {
        return Ok(peripheral);
    }

    let seen = peripherals
        .iter()
        .map(|p| p.id().to_string())
        .take(8)
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Device not found after rescan. Run scan again. Wanted: {id}. Adapter currently sees {} device(s): {}",
        peripherals.len(),
        if seen.is_empty() { "(none)" } else { &seen }
    ))
}

// =====================================================================================
//  TIPOS QUE CRUZAM A PONTE RUST -> REACT
// =====================================================================================

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    pub connected: bool,
    // UUIDs de serviço anunciados no advertisement — usado para identificar
    // periféricos por serviço (ex: 0xFEED do levelup) em vez de pelo nome.
    pub services: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct CharacteristicInfo {
    pub uuid: String,
    pub read: bool,
    pub write: bool,
    pub notify: bool,
}

#[derive(Serialize, Clone)]
pub struct ServiceInfo {
    pub uuid: String,
    pub characteristics: Vec<CharacteristicInfo>,
}

#[derive(Serialize, Clone)]
pub struct NotificationPayload {
    pub device_id: String,
    pub char_uuid: String,
    pub value: Vec<u8>,
}

#[derive(Serialize, Clone)]
pub struct ProtocolRelayPayload {
    pub src_addr: u16,
    pub dst_addr: u16,
    pub sequence_number: u32,
    pub ttl: u8,
    pub target_device_id: String,
    pub char_uuid: String,
    pub bytes_len: usize,
}

#[derive(Serialize, Clone)]
pub struct ProtocolTransportPayload {
    pub sequence_number: u32,
    pub packet_count: usize,
    pub bytes_len: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendProtocolTextRequest {
    pub device_id: String,
    pub char_uuid: String,
    pub dst_addr: Option<u16>,
    pub ttl: Option<u8>,
    pub text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendProtocolPingRequest {
    pub device_id: String,
    pub char_uuid: String,
    pub dst_addr: Option<u16>,
    pub ttl: Option<u8>,
}

#[tauri::command]
pub fn protocol_node_info(state: tauri::State<'_, BleState>) -> ProtocolNodeInfo {
    ProtocolNodeInfo {
        node_addr: state.node_addr,
    }
}

// =====================================================================================
//  FLUXO DE CONEXÃO GATT (papel Central — totalmente suportado pelo btleplug)
// =====================================================================================

/// Comando Tauri: varre o ar por ~4s e devolve a lista de dispositivos BLE próximos.
#[tauri::command]
pub async fn scan_devices(state: tauri::State<'_, BleState>) -> Result<Vec<DeviceInfo>, String> {
    let adapter = first_adapter(&state).await?;

    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| e.to_string())?;
    println!("[SCAN] Discovering nearby BLE peripherals...");

    // Janela de descoberta: deixa o rádio coletar advertisements.
    tokio::time::sleep(Duration::from_secs(4)).await;

    let peripherals = adapter.peripherals().await.map_err(|e| e.to_string())?;
    let _ = adapter.stop_scan().await;

    let mut devices: Vec<DeviceInfo> = Vec::new();
    for p in peripherals {
        let id = p.id().to_string();
        let connected = p.is_connected().await.unwrap_or(false);
        let (name, rssi, services) = match p.properties().await {
            Ok(Some(props)) => (
                props.local_name.unwrap_or_else(|| "(unnamed)".to_string()),
                props.rssi,
                props.services.iter().map(|u| u.to_string()).collect(),
            ),
            _ => ("(unnamed)".to_string(), None, Vec::new()),
        };
        devices.push(DeviceInfo {
            id,
            name,
            rssi,
            connected,
            services,
        });
    }

    // Nomeados primeiro, depois por RSSI (sinal mais forte no topo).
    devices.sort_by(|a, b| {
        let a_named = a.name != "(unnamed)";
        let b_named = b.name != "(unnamed)";
        b_named
            .cmp(&a_named)
            .then(b.rssi.unwrap_or(i16::MIN).cmp(&a.rssi.unwrap_or(i16::MIN)))
    });

    println!("[SCAN] Found {} devices.", devices.len());
    Ok(devices)
}

/// Comando Tauri: conecta a um periférico, descobre serviços/características e
/// auto-inscreve nas características de NOTIFY/INDICATE para receber dados em tempo real.
#[tauri::command]
pub async fn connect_device(
    app: AppHandle,
    id: String,
    state: tauri::State<'_, BleState>,
) -> Result<Vec<ServiceInfo>, String> {
    let adapter = first_adapter(&state).await?;
    let peripheral = find_peripheral_for_connect(&adapter, &id).await?;

    if !peripheral.is_connected().await.unwrap_or(false) {
        peripheral
            .connect()
            .await
            .map_err(|e| format!("Connect failed for {id}: {e}"))?;
        println!("[CONNECT] Linked to {}", id);
    }

    let _ = adapter.stop_scan().await;

    peripheral
        .discover_services()
        .await
        .map_err(|e| format!("Service discovery failed for {id}: {e}"))?;

    // Monta o mapa de serviços/características para o frontend.
    let mut services: Vec<ServiceInfo> = Vec::new();
    for service in peripheral.services() {
        let mut chars: Vec<CharacteristicInfo> = Vec::new();
        for c in service.characteristics {
            chars.push(CharacteristicInfo {
                uuid: c.uuid.to_string(),
                read: c.properties.contains(CharPropFlags::READ),
                write: c.properties.contains(CharPropFlags::WRITE)
                    || c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE),
                notify: c.properties.contains(CharPropFlags::NOTIFY)
                    || c.properties.contains(CharPropFlags::INDICATE),
            });
        }
        services.push(ServiceInfo {
            uuid: service.uuid.to_string(),
            characteristics: chars,
        });
    }

    // Auto-inscreve em tudo que suporta notificação/indicação.
    for c in peripheral.characteristics() {
        if c.properties.contains(CharPropFlags::NOTIFY)
            || c.properties.contains(CharPropFlags::INDICATE)
        {
            if let Err(e) = peripheral.subscribe(&c).await {
                println!("[CONNECT] Could not subscribe to {}: {}", c.uuid, e);
            }
        }
    }

    // Guarda o handle conectado para writes/subscribe futuros.
    state
        .connected
        .lock()
        .unwrap()
        .insert(id.clone(), peripheral.clone());

    // Bombeia o stream de notificações para o React via eventos.
    let app_clone = app.clone();
    let dev_id = id.clone();
    let node_addr = state.node_addr;
    let cache_clone = state.cache.clone();
    let connected_clone = state.connected.clone();
    let sequence_clone = state.sequence.clone();
    if let Ok(mut stream) = peripheral.notifications().await {
        tokio::spawn(async move {
            while let Some(n) = stream.next().await {
                handle_protocol_bytes(
                    &app_clone,
                    &n.value,
                    node_addr,
                    cache_clone.clone(),
                    connected_clone.clone(),
                    sequence_clone.clone(),
                    Some(dev_id.clone()),
                    n.uuid.to_string(),
                )
                .await;
                let _ = app_clone.emit(
                    "ble-notification",
                    NotificationPayload {
                        device_id: dev_id.clone(),
                        char_uuid: n.uuid.to_string(),
                        value: n.value,
                    },
                );
            }
            println!("[NOTIFY] Notification stream for {} ended.", dev_id);
        });
    }

    Ok(services)
}

/// Comando Tauri: escreve bytes crus em uma característica do dispositivo conectado.
/// Escolhe automaticamente WithResponse vs WithoutResponse conforme as flags.
#[tauri::command]
pub async fn write_characteristic(
    device_id: String,
    char_uuid: String,
    data: Vec<u8>,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let peripheral = {
        state
            .connected
            .lock()
            .unwrap()
            .get(&device_id)
            .cloned()
            .ok_or_else(|| "Device is not connected. Connect first.".to_string())?
    };

    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid.to_string() == char_uuid)
        .ok_or_else(|| "Characteristic not found on this device.".to_string())?;

    let write_type = if characteristic.properties.contains(CharPropFlags::WRITE) {
        WriteType::WithResponse
    } else {
        WriteType::WithoutResponse
    };

    peripheral
        .write(&characteristic, &data, write_type)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("Wrote {} bytes to {}", data.len(), char_uuid))
}

async fn write_protocol_packets_to_peripheral(
    peripheral: &Peripheral,
    char_uuid: &str,
    packets: &[Vec<u8>],
) -> Result<usize, String> {
    for packet in packets {
        write_protocol_bytes_to_peripheral(peripheral, char_uuid, packet).await?;
    }

    Ok(packets.iter().map(Vec::len).sum())
}

/// Conveniência: empacota um GenericMeshPacket em JSON e escreve numa característica.
#[tauri::command]
pub async fn send_mesh_packet_to_device(
    device_id: String,
    char_uuid: String,
    packet: GenericMeshPacket,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&packet).map_err(|e| e.to_string())?;
    write_characteristic(device_id, char_uuid, bytes, state).await
}

#[tauri::command]
pub async fn send_protocol_text_to_device(
    app: AppHandle,
    request: SendProtocolTextRequest,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let sequence_number = {
        let mut seq = state.sequence.lock().unwrap();
        *seq = seq.wrapping_add(1);
        *seq
    };

    let frame = ProtocolFrame {
        src_addr: state.node_addr,
        dst_addr: request.dst_addr.unwrap_or(protocol::BROADCAST_ADDR),
        ttl: request.ttl.unwrap_or(3),
        sequence_number,
        opcode: protocol::OPCODE_TEXT,
        payload: request.text.into_bytes(),
        checksum: 0,
    };
    let packets = protocol::encode_for_ble_transport(&frame);
    write_protocol_packets_to_device(&request.device_id, &request.char_uuid, &packets, &state)
        .await?;

    emit_protocol_frame(&app, frame.clone());
    emit_protocol_transport(&app, sequence_number, &packets);
    Ok(format!(
        "Sent protocol frame seq={} packets={} bytes={}",
        sequence_number,
        packets.len(),
        packets.iter().map(Vec::len).sum::<usize>()
    ))
}

#[tauri::command]
pub async fn send_protocol_ping_to_device(
    app: AppHandle,
    request: SendProtocolPingRequest,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let sequence_number = next_sequence(&state.sequence);
    let sent_ms = now_millis();
    let frame = ProtocolFrame {
        src_addr: state.node_addr,
        dst_addr: request.dst_addr.unwrap_or(protocol::BROADCAST_ADDR),
        ttl: request.ttl.unwrap_or(3),
        sequence_number,
        opcode: protocol::OPCODE_PING,
        payload: format!("ping:{sequence_number}:{sent_ms}").into_bytes(),
        checksum: 0,
    };
    let packets = protocol::encode_for_ble_transport(&frame);
    write_protocol_packets_to_device(&request.device_id, &request.char_uuid, &packets, &state)
        .await?;

    emit_protocol_frame(&app, frame);
    emit_protocol_transport(&app, sequence_number, &packets);
    Ok(format!(
        "Sent mesh ping seq={} packets={} bytes={}",
        sequence_number,
        packets.len(),
        packets.iter().map(Vec::len).sum::<usize>()
    ))
}

async fn write_protocol_packets_to_device(
    device_id: &str,
    char_uuid: &str,
    packets: &[Vec<u8>],
    state: &tauri::State<'_, BleState>,
) -> Result<usize, String> {
    let peripheral = {
        state
            .connected
            .lock()
            .unwrap()
            .get(device_id)
            .cloned()
            .ok_or_else(|| "Device is not connected. Connect first.".to_string())?
    };

    write_protocol_packets_to_peripheral(&peripheral, char_uuid, packets).await
}

/// Comando Tauri: desconecta de um periférico e limpa o estado.
#[tauri::command]
pub async fn disconnect_device(
    device_id: String,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let peripheral = { state.connected.lock().unwrap().remove(&device_id) };

    if let Some(p) = peripheral {
        p.disconnect().await.map_err(|e| e.to_string())?;
        Ok(format!("Disconnected from {}", device_id))
    } else {
        Err("Device was not connected.".to_string())
    }
}

pub fn emit_protocol_frame(app: &AppHandle, frame: ProtocolFrame) {
    let _ = app.emit("protocol-frame", protocol::to_event(frame));
}

async fn handle_protocol_bytes(
    app: &AppHandle,
    bytes: &[u8],
    node_addr: u16,
    cache: Arc<Mutex<NetworkCache>>,
    connected: Arc<Mutex<HashMap<String, Peripheral>>>,
    sequence: Arc<Mutex<u32>>,
    incoming_device_id: Option<String>,
    char_uuid: String,
) {
    let frame = {
        let mut cache = cache.lock().unwrap();
        match protocol::ingest_transport_packet(&mut cache.reassembly_cache, bytes) {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(_) => return,
        }
    };

    process_completed_frame(
        app,
        frame,
        node_addr,
        cache,
        connected,
        sequence,
        incoming_device_id,
        char_uuid,
    )
    .await;
}

async fn process_completed_frame(
    app: &AppHandle,
    frame: ProtocolFrame,
    node_addr: u16,
    cache: Arc<Mutex<NetworkCache>>,
    connected: Arc<Mutex<HashMap<String, Peripheral>>>,
    sequence: Arc<Mutex<u32>>,
    incoming_device_id: Option<String>,
    char_uuid: String,
) {
    let original_frame = frame.clone();
    let decision = {
        let mut cache = cache.lock().unwrap();
        protocol::process_incoming(&mut cache.relay_cache, node_addr, frame)
    };

    if decision.deliver_locally {
        emit_protocol_frame(app, original_frame.clone());

        if original_frame.opcode == protocol::OPCODE_PING {
            let pong = ProtocolFrame {
                src_addr: node_addr,
                dst_addr: original_frame.src_addr,
                ttl: 3,
                sequence_number: next_sequence(&sequence),
                opcode: protocol::OPCODE_PONG,
                payload: original_frame.payload.clone(),
                checksum: 0,
            };
            let packets = protocol::encode_for_ble_transport(&pong);
            if let Some(device_id) = incoming_device_id.as_ref() {
                let target = connected.lock().unwrap().get(device_id).cloned();
                if let Some(peripheral) = target {
                    let _ = write_protocol_packets_to_peripheral(&peripheral, &char_uuid, &packets)
                        .await;
                    emit_protocol_transport(app, pong.sequence_number, &packets);
                }
            }
        }
    }

    let Some(relay_frame) = decision.relay_frame else {
        return;
    };

    let relay_packets = protocol::encode_for_ble_transport(&relay_frame);
    let targets: Vec<(String, Peripheral)> = connected
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(device_id, peripheral)| {
            if incoming_device_id.as_ref() == Some(device_id) {
                None
            } else {
                Some((device_id.clone(), peripheral.clone()))
            }
        })
        .collect();

    for (target_device_id, peripheral) in targets {
        if write_protocol_packets_to_peripheral(&peripheral, &char_uuid, &relay_packets)
            .await
            .is_ok()
        {
            let _ = app.emit(
                "protocol-relay",
                ProtocolRelayPayload {
                    src_addr: relay_frame.src_addr,
                    dst_addr: relay_frame.dst_addr,
                    sequence_number: relay_frame.sequence_number,
                    ttl: relay_frame.ttl,
                    target_device_id,
                    char_uuid: char_uuid.clone(),
                    bytes_len: relay_packets.iter().map(Vec::len).sum(),
                },
            );
        }
    }
}

fn next_sequence(sequence: &Arc<Mutex<u32>>) -> u32 {
    let mut seq = sequence.lock().unwrap();
    *seq = seq.wrapping_add(1);
    *seq
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn emit_protocol_transport(app: &AppHandle, sequence_number: u32, packets: &[Vec<u8>]) {
    let _ = app.emit(
        "protocol-transport",
        ProtocolTransportPayload {
            sequence_number,
            packet_count: packets.len(),
            bytes_len: packets.iter().map(Vec::len).sum(),
        },
    );
}

#[cfg(target_os = "android")]
pub async fn handle_android_peripheral_bytes(app: AppHandle, bytes: Vec<u8>) {
    use tauri::Manager;

    let state = app.state::<BleState>();
    let frame = {
        let mut cache = state.cache.lock().unwrap();
        match protocol::ingest_transport_packet(&mut cache.reassembly_cache, &bytes) {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(_) => return,
        }
    };

    let decision = {
        let mut cache = state.cache.lock().unwrap();
        protocol::process_incoming(&mut cache.relay_cache, state.node_addr, frame.clone())
    };

    if decision.deliver_locally {
        emit_protocol_frame(&app, frame.clone());

        if frame.opcode == protocol::OPCODE_PING {
            let pong = ProtocolFrame {
                src_addr: state.node_addr,
                dst_addr: frame.src_addr,
                ttl: 3,
                sequence_number: next_sequence(&state.sequence),
                opcode: protocol::OPCODE_PONG,
                payload: frame.payload.clone(),
                checksum: 0,
            };
            let packets = protocol::encode_for_ble_transport(&pong);
            for packet in &packets {
                let _ = crate::ble_android::send(packet.clone());
            }
            emit_protocol_transport(&app, pong.sequence_number, &packets);
        }
    }

    let Some(relay_frame) = decision.relay_frame else {
        return;
    };

    let packets = protocol::encode_for_ble_transport(&relay_frame);
    for packet in &packets {
        let _ = crate::ble_android::send(packet.clone());
    }
    let _ = app.emit(
        "protocol-relay",
        ProtocolRelayPayload {
            src_addr: relay_frame.src_addr,
            dst_addr: relay_frame.dst_addr,
            sequence_number: relay_frame.sequence_number,
            ttl: relay_frame.ttl,
            target_device_id: "android-subscribers".to_string(),
            char_uuid: "0000fee1-0000-1000-8000-00805f9b34fb".to_string(),
            bytes_len: packets.iter().map(Vec::len).sum(),
        },
    );
}

#[cfg(target_os = "macos")]
pub async fn handle_macos_peripheral_bytes(app: AppHandle, bytes: Vec<u8>) {
    use tauri::Manager;

    let state = app.state::<BleState>();
    let frame = {
        let mut cache = state.cache.lock().unwrap();
        match protocol::ingest_transport_packet(&mut cache.reassembly_cache, &bytes) {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(_) => return,
        }
    };

    let decision = {
        let mut cache = state.cache.lock().unwrap();
        protocol::process_incoming(&mut cache.relay_cache, state.node_addr, frame.clone())
    };

    if decision.deliver_locally {
        emit_protocol_frame(&app, frame.clone());

        if frame.opcode == protocol::OPCODE_PING {
            let pong = ProtocolFrame {
                src_addr: state.node_addr,
                dst_addr: frame.src_addr,
                ttl: 3,
                sequence_number: next_sequence(&state.sequence),
                opcode: protocol::OPCODE_PONG,
                payload: frame.payload.clone(),
                checksum: 0,
            };
            let packets = protocol::encode_for_ble_transport(&pong);
            for packet in &packets {
                let _ = crate::ble_macos::send(packet.clone());
            }
            emit_protocol_transport(&app, pong.sequence_number, &packets);
        }
    }

    let Some(relay_frame) = decision.relay_frame else {
        return;
    };

    let packets = protocol::encode_for_ble_transport(&relay_frame);
    for packet in &packets {
        let _ = crate::ble_macos::send(packet.clone());
    }
    let _ = app.emit(
        "protocol-relay",
        ProtocolRelayPayload {
            src_addr: relay_frame.src_addr,
            dst_addr: relay_frame.dst_addr,
            sequence_number: relay_frame.sequence_number,
            ttl: relay_frame.ttl,
            target_device_id: "macos-subscribers".to_string(),
            char_uuid: "0000fee1-0000-1000-8000-00805f9b34fb".to_string(),
            bytes_len: packets.iter().map(Vec::len).sum(),
        },
    );
}

async fn write_protocol_bytes_to_peripheral(
    peripheral: &Peripheral,
    char_uuid: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let characteristic = peripheral
        .characteristics()
        .into_iter()
        .find(|c| c.uuid.to_string() == char_uuid)
        .ok_or_else(|| "Characteristic not found on relay target.".to_string())?;

    let write_type = if characteristic.properties.contains(CharPropFlags::WRITE) {
        WriteType::WithResponse
    } else {
        WriteType::WithoutResponse
    };

    peripheral
        .write(&characteristic, bytes, write_type)
        .await
        .map_err(|e| e.to_string())
}

// =====================================================================================
//  MODELO LEGADO DE MESH POR ADVERTISEMENT (somente RX — btleplug não pode TX/anunciar)
// =====================================================================================

/// Comando Tauri: liga a captura contínua de advertisements (manufacturer data) via rádio.
#[tauri::command]
pub async fn start_hardware_mesh_scan(
    app: AppHandle,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let adapter = first_adapter(&state).await?;
    let mut events = adapter.events().await.map_err(|e| e.to_string())?;

    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| e.to_string())?;
    println!("[HARDWARE] Real radio active and listening...");

    let app_clone = app.clone();
    let cache_clone = state.cache.clone();

    tokio::spawn(async move {
        while let Some(event) = events.next().await {
            if let CentralEvent::ManufacturerDataAdvertisement {
                manufacturer_data, ..
            } = event
            {
                for (_company_id, bytes) in &manufacturer_data {
                    if let Ok(incoming_packet) = serde_json::from_slice::<GenericMeshPacket>(bytes)
                    {
                        let is_valid = {
                            if incoming_packet.ttl == 0 {
                                false
                            } else {
                                let mut cache = cache_clone.lock().unwrap();
                                if let Some(&last_seq) =
                                    cache.seen_packets.get(&incoming_packet.src_addr)
                                {
                                    incoming_packet.sequence_number > last_seq
                                } else {
                                    cache.seen_packets.insert(
                                        incoming_packet.src_addr,
                                        incoming_packet.sequence_number,
                                    );
                                    true
                                }
                            }
                        };

                        if is_valid {
                            {
                                let mut cache = cache_clone.lock().unwrap();
                                cache.seen_packets.insert(
                                    incoming_packet.src_addr,
                                    incoming_packet.sequence_number,
                                );
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
