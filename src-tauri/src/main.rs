use std::collections::HashMap;
use std::sync::{Arc, Mutex}; // Adicionado Arc aqui também
use btleplug::platform::Manager;

mod ble;

#[tokio::main]
async fn main() {
    let manager = Manager::new().await.expect("Failed to init native BLE driver.");

    let initial_cache = ble::NetworkCache {
        seen_packets: HashMap::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ble::BleState {
            manager,
            cache: Arc::new(Mutex::new(initial_cache)), // Envolvido em Arc::new() para compatibilidade
            connected: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            // Fluxo de conexão GATT (central role)
            ble::scan_devices,
            ble::connect_device,
            ble::write_characteristic,
            ble::send_mesh_packet_to_device,
            ble::disconnect_device,
            // Captura legada de advertisements (somente RX)
            ble::start_hardware_mesh_scan
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
