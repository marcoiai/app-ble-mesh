use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

static HELPER: OnceLock<Arc<Mutex<Option<MacosPeripheralProcess>>>> = OnceLock::new();

struct MacosPeripheralProcess {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, serde::Serialize)]
pub struct MacosPeripheralStatus {
    pub running: bool,
}

fn helper_state() -> Arc<Mutex<Option<MacosPeripheralProcess>>> {
    HELPER.get_or_init(|| Arc::new(Mutex::new(None))).clone()
}

pub fn status() -> MacosPeripheralStatus {
    MacosPeripheralStatus {
        running: helper_state().lock().unwrap().is_some(),
    }
}

pub fn start(app: AppHandle) -> Result<MacosPeripheralStatus, String> {
    let state = helper_state();
    let mut guard = state.lock().unwrap();
    if guard.is_some() {
        return Ok(MacosPeripheralStatus { running: true });
    }

    let mut child = Command::new(env!("MACOS_BLE_HELPER"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("macOS BLE helper spawn failed: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "macOS BLE helper stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "macOS BLE helper stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "macOS BLE helper stderr unavailable".to_string())?;

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            handle_helper_line(&app, &line);
        }
    });

    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[macos-ble-helper] {line}");
        }
    });

    *guard = Some(MacosPeripheralProcess { child, stdin });
    Ok(MacosPeripheralStatus { running: true })
}

pub fn stop() -> Result<MacosPeripheralStatus, String> {
    let state = helper_state();
    let mut guard = state.lock().unwrap();
    if let Some(mut process) = guard.take() {
        let _ = writeln!(process.stdin, "STOP");
        let _ = process.stdin.flush();
        let _ = process.child.kill();
        let _ = process.child.wait();
    }

    Ok(MacosPeripheralStatus { running: false })
}

pub fn send(data: Vec<u8>) -> Result<(), String> {
    let state = helper_state();
    let mut guard = state.lock().unwrap();
    let process = guard
        .as_mut()
        .ok_or_else(|| "macOS peripheral is not advertising".to_string())?;
    writeln!(process.stdin, "SEND {}", hex_encode(&data)).map_err(|error| error.to_string())?;
    process.stdin.flush().map_err(|error| error.to_string())
}

fn handle_helper_line(app: &AppHandle, line: &str) {
    let _ = app.emit("macos-peripheral-log", line.to_string());
    if let Some(hex) = line.strip_prefix("WRITE ") {
        if let Ok(bytes) = hex_decode(hex) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::ble::handle_macos_peripheral_bytes(app, bytes).await;
            });
        }
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) {
        return Err("hex length must be even".to_string());
    }

    let mut bytes = Vec::with_capacity(text.len() / 2);
    let mut i = 0;
    while i < text.len() {
        let byte = u8::from_str_radix(&text[i..i + 2], 16).map_err(|error| error.to_string())?;
        bytes.push(byte);
        i += 2;
    }
    Ok(bytes)
}
