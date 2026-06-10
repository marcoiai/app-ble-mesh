use std::sync::{Arc, Mutex}; // Arc para compartilhamento seguro entre threads
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use btleplug::api::{
    Central, CentralEvent, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use serde::{Deserialize, Serialize};
use futures::stream::StreamExt;

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
}

// 3. Estado Global injetado no Tauri v2
pub struct BleState {
    pub manager: Manager,
    pub cache: Arc<Mutex<NetworkCache>>,
    // Periféricos atualmente conectados, indexados pelo seu id (string).
    // Guardamos o handle clonável para reutilizar a conexão em writes/subscribe.
    pub connected: Arc<Mutex<HashMap<String, Peripheral>>>,
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

/// Helper: pega o primeiro adaptador Bluetooth físico da máquina.
async fn first_adapter(state: &tauri::State<'_, BleState>) -> Result<Adapter, String> {
    let adapters = state.manager.adapters().await.map_err(|e| e.to_string())?;
    adapters
        .into_iter()
        .next()
        .ok_or_else(|| "No hardware Bluetooth adapter found on this system.".to_string())
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
        devices.push(DeviceInfo { id, name, rssi, connected, services });
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
    let peripherals = adapter.peripherals().await.map_err(|e| e.to_string())?;

    let peripheral = peripherals
        .into_iter()
        .find(|p| p.id().to_string() == id)
        .ok_or_else(|| "Device not found. Run a scan again.".to_string())?;

    if !peripheral.is_connected().await.unwrap_or(false) {
        peripheral.connect().await.map_err(|e| e.to_string())?;
        println!("[CONNECT] Linked to {}", id);
    }

    peripheral
        .discover_services()
        .await
        .map_err(|e| e.to_string())?;

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
    if let Ok(mut stream) = peripheral.notifications().await {
        tokio::spawn(async move {
            while let Some(n) = stream.next().await {
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

/// Comando Tauri: desconecta de um periférico e limpa o estado.
#[tauri::command]
pub async fn disconnect_device(
    device_id: String,
    state: tauri::State<'_, BleState>,
) -> Result<String, String> {
    let peripheral = {
        state.connected.lock().unwrap().remove(&device_id)
    };

    if let Some(p) = peripheral {
        p.disconnect().await.map_err(|e| e.to_string())?;
        Ok(format!("Disconnected from {}", device_id))
    } else {
        Err("Device was not connected.".to_string())
    }
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
            if let CentralEvent::ManufacturerDataAdvertisement { manufacturer_data, .. } = event {
                for (_company_id, bytes) in &manufacturer_data {
                    if let Ok(incoming_packet) = serde_json::from_slice::<GenericMeshPacket>(bytes) {
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
