fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        use std::process::Command;

        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let source = manifest_dir.join("native/macos_ble_peripheral.swift");
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let binary = out_dir.join("macos_ble_peripheral");

        println!("cargo:rerun-if-changed={}", source.display());

        let output = Command::new("xcrun")
            .arg("--sdk")
            .arg("macosx")
            .arg("swiftc")
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .arg("-framework")
            .arg("CoreBluetooth")
            .arg("-framework")
            .arg("Foundation")
            .output()
            .expect("failed to run swiftc for macOS BLE peripheral helper");

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            panic!(
                "swiftc failed while building macOS BLE peripheral helper\n\
                 The build uses `xcrun --sdk macosx swiftc` so the selected Xcode/Command Line Tools provide a matching compiler and SDK.\n\
                 If stderr says the SDK is not supported by the compiler, run `xcode-select -p`, `xcrun --sdk macosx --find swiftc`, and `xcrun --sdk macosx --show-sdk-path` on that Mac.\n\
                 stdout:\n{}\nstderr:\n{}",
                stdout, stderr
            );
        }

        println!("cargo:rustc-env=MACOS_BLE_HELPER={}", binary.display());
    }

    tauri_build::build()
}
