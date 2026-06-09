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
            cache: Arc::new(Mutex::new(initial_cache)) // Envolvido em Arc::new() para compatibilidade
        })
        .invoke_handler(tauri::generate_handler![
            ble::start_hardware_mesh_scan,
            ble::send_hardware_mesh_packet
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
