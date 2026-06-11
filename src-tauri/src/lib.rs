use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use btleplug::platform::Manager;

mod ble;
#[cfg(target_os = "android")]
mod ble_android;
mod protocol;

#[tauri::command]
fn android_peripheral_send(data: Vec<u8>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        ble_android::send(data.clone())?;
        return Ok(format!(
            "Notified {} byte(s) to subscribed centrals",
            data.len()
        ));
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = data;
        Err("Android peripheral is only available on Android".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = tauri::async_runtime::block_on(async {
        Manager::new()
            .await
            .expect("Failed to init native BLE driver.")
    });

    let initial_cache = ble::NetworkCache {
        seen_packets: HashMap::new(),
        relay_cache: protocol::RelayCache::new(2048),
        reassembly_cache: protocol::ReassemblyCache::new(256),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ble::BleState {
            manager,
            cache: Arc::new(Mutex::new(initial_cache)),
            node_addr: protocol::derive_node_addr(),
            sequence: Arc::new(Mutex::new(0)),
            connected: Arc::new(Mutex::new(HashMap::new())),
        })
        .setup(|_app| {
            #[cfg(target_os = "android")]
            ble_android::start(_app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ble::scan_devices,
            ble::connect_device,
            ble::write_characteristic,
            ble::send_mesh_packet_to_device,
            ble::send_protocol_text_to_device,
            ble::send_protocol_ping_to_device,
            ble::protocol_node_info,
            ble::disconnect_device,
            ble::start_hardware_mesh_scan,
            android_peripheral_send
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
