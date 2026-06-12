#![allow(dead_code)]

use std::sync::{Mutex, OnceLock};

use jni::objects::{GlobalRef, JClass, JObject, JValue};
use jni::sys::jbyteArray;
use jni::{JNIEnv, JavaVM};
use tauri::{AppHandle, Emitter};

use crate::ble::NotificationPayload;

static JVM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

#[no_mangle]
pub extern "system" fn Java_com_auser_app_1ble_1mesh_BleMeshPeripheral_nativeRegister(
    env: JNIEnv,
    class: JClass,
) {
    if let Err(error) = btleplug::platform::init(&env) {
        eprintln!("[ble-android] btleplug init failed: {error}");
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }
    if let Ok(vm) = env.get_java_vm() {
        let _ = JVM.set(vm);
    }
    if let Ok(global) = env.new_global_ref(class) {
        let _ = CLASS.set(global);
    }
    eprintln!("[ble-android] registered JVM + class");
}

#[no_mangle]
pub extern "system" fn Java_com_auser_app_1ble_1mesh_BleMeshPeripheral_nativeOnFrame(
    env: JNIEnv,
    _class: JClass,
    data: jbyteArray,
) {
    let Ok(bytes) = env.convert_byte_array(data) else {
        return;
    };
    if let Ok(guard) = APP.lock() {
        if let Some(app) = guard.as_ref() {
            let _ = app.emit("mesh-ble-frame", bytes.clone());
            let app_clone = app.clone();
            let protocol_bytes = bytes.clone();
            tauri::async_runtime::spawn(async move {
                crate::ble::handle_android_peripheral_bytes(app_clone, protocol_bytes).await;
            });
            let _ = app.emit(
                "ble-notification",
                NotificationPayload {
                    device_id: "android-peripheral-write".to_string(),
                    char_uuid: "0000fee1-0000-1000-8000-00805f9b34fb".to_string(),
                    value: bytes,
                },
            );
        }
    }
}

pub fn start(app: AppHandle) {
    *APP.lock().unwrap() = Some(app);
    if let Err(error) = call_static_void("start") {
        eprintln!("[ble-android] start failed: {error}");
    }
}

pub fn bluetooth_enabled() -> Result<bool, String> {
    call_static_bool("isBluetoothEnabled")
}

pub fn send(data: Vec<u8>) -> Result<(), String> {
    let jvm = JVM.get().ok_or("ble-android: not registered")?;
    let env = jvm
        .attach_current_thread()
        .map_err(|error| error.to_string())?;
    let class = CLASS.get().ok_or("ble-android: no class")?;
    let cls = JClass::from(class.as_obj());
    let arr = env
        .byte_array_from_slice(&data)
        .map_err(|error| error.to_string())?;
    let arr = JObject::from(arr);
    env.call_static_method(cls, "send", "([B)V", &[JValue::Object(arr)])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn stop() {
    let _ = call_static_void("stop");
    *APP.lock().unwrap() = None;
}

fn call_static_void(name: &str) -> Result<(), String> {
    let jvm = JVM.get().ok_or("ble-android: not registered")?;
    let env = jvm
        .attach_current_thread()
        .map_err(|error| error.to_string())?;
    let class = CLASS.get().ok_or("ble-android: no class")?;
    let cls = JClass::from(class.as_obj());
    env.call_static_method(cls, name, "()V", &[])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn call_static_bool(name: &str) -> Result<bool, String> {
    let jvm = JVM.get().ok_or("ble-android: not registered")?;
    let env = jvm
        .attach_current_thread()
        .map_err(|error| error.to_string())?;
    let class = CLASS.get().ok_or("ble-android: no class")?;
    let cls = JClass::from(class.as_obj());
    env.call_static_method(cls, name, "()Z", &[])
        .map_err(|error| error.to_string())?
        .z()
        .map_err(|error| error.to_string())
}
