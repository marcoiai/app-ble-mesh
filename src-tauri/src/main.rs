use btleplug::platform::Manager;
use std::collections::HashMap;
use std::sync::{Arc, Mutex}; // Adicionado Arc aqui também

mod ble;
#[cfg(target_os = "android")]
mod ble_android;
#[cfg(target_os = "macos")]
mod ble_macos;
mod protocol;

#[tauri::command]
fn android_peripheral_send(data: Vec<u8>) -> Result<String, String> {
    let _ = data;
    Err("Android peripheral is only available on Android".to_string())
}

#[tauri::command]
fn peripheral_send(data: Vec<u8>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        ble_android::send(data.clone())?;
        return Ok(format!(
            "Notified {} byte(s) to subscribed centrals",
            data.len()
        ));
    }

    #[cfg(target_os = "macos")]
    {
        ble_macos::send(data.clone())?;
        return Ok(format!(
            "Notified {} byte(s) to subscribed centrals",
            data.len()
        ));
    }

    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        let _ = data;
        Err("BLE peripheral send is not available on this platform".to_string())
    }
}

#[tauri::command]
fn macos_peripheral_start(app: tauri::AppHandle) -> Result<MacosPeripheralStatusOut, String> {
    #[cfg(target_os = "macos")]
    {
        let status = ble_macos::start(app)?;
        return Ok(MacosPeripheralStatusOut {
            running: status.running,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("macOS peripheral is only available on macOS".to_string())
    }
}

#[tauri::command]
fn macos_peripheral_stop() -> Result<MacosPeripheralStatusOut, String> {
    #[cfg(target_os = "macos")]
    {
        let status = ble_macos::stop()?;
        return Ok(MacosPeripheralStatusOut {
            running: status.running,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("macOS peripheral is only available on macOS".to_string())
    }
}

#[tauri::command]
fn macos_peripheral_status() -> MacosPeripheralStatusOut {
    #[cfg(target_os = "macos")]
    {
        let status = ble_macos::status();
        return MacosPeripheralStatusOut {
            running: status.running,
        };
    }

    #[cfg(not(target_os = "macos"))]
    {
        MacosPeripheralStatusOut { running: false }
    }
}

#[tauri::command]
fn mesh_ble_start(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = ble_macos::start(app.clone())?;
    }
    #[cfg(target_os = "android")]
    {
        ble_android::start(app);
    }
    Ok(())
}

#[tauri::command]
fn ble_radio_enabled() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        return ble_android::bluetooth_enabled();
    }

    #[cfg(not(target_os = "android"))]
    {
        Ok(true)
    }
}

#[derive(serde::Serialize)]
struct MacosPeripheralStatusOut {
    running: bool,
}

#[tauri::command]
fn runtime_platform() -> &'static str {
    #[cfg(target_os = "android")]
    {
        return "android";
    }
    #[cfg(target_os = "macos")]
    {
        return "macos";
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        "desktop"
    }
}

#[tokio::main]
async fn main() {
    let manager = Manager::new()
        .await
        .expect("Failed to init native BLE driver.");

    let initial_cache = ble::NetworkCache {
        seen_packets: HashMap::new(),
        relay_cache: protocol::RelayCache::new(2048),
        reassembly_cache: protocol::ReassemblyCache::new(256),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ble::BleState {
            manager,
            cache: Arc::new(Mutex::new(initial_cache)), // Envolvido em Arc::new() para compatibilidade
            node_addr: protocol::derive_node_addr(),
            sequence: Arc::new(Mutex::new(0)),
            connected: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            // Fluxo de conexão GATT (central role)
            ble::scan_devices,
            ble::connect_device,
            ble::write_characteristic,
            ble::send_mesh_packet_to_device,
            ble::send_protocol_text_to_device,
            ble::send_protocol_ping_to_device,
            ble::send_core_frame_to_device,
            ble::send_peripheral_core_frame,
            ble::mesh_ble_send,
            ble::mesh_ble_payload,
            ble::send_android_peripheral_ping,
            ble::send_android_peripheral_ping_to,
            ble::send_android_peripheral_core_frame,
            ble::send_peripheral_protocol_text,
            ble::protocol_node_info,
            ble::disconnect_device,
            ble::connected_device_ids,
            ble::peripheral_connected_device_ids,
            // Captura legada de advertisements (somente RX)
            ble::start_hardware_mesh_scan,
            macos_peripheral_start,
            macos_peripheral_stop,
            macos_peripheral_status,
            mesh_ble_start,
            ble_radio_enabled,
            android_peripheral_send,
            peripheral_send,
            runtime_platform
        ])
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
