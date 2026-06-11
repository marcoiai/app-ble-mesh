fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        use std::process::Command;

        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        let source = manifest_dir.join("native/macos_ble_peripheral.m");
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let binary = out_dir.join("macos_ble_peripheral");

        println!("cargo:rerun-if-changed={}", source.display());

        let output = Command::new("xcrun")
            .arg("--sdk")
            .arg("macosx")
            .arg("clang")
            .arg("-fobjc-arc")
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .arg("-framework")
            .arg("CoreBluetooth")
            .arg("-framework")
            .arg("Foundation")
            .output()
            .expect("failed to run clang for macOS BLE peripheral helper");

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            panic!(
                "clang failed while building macOS BLE peripheral helper\n\
                 The build uses `xcrun --sdk macosx clang` to compile the CoreBluetooth helper.\n\
                 If stderr mentions an unsupported SDK, run `xcode-select -p`, `xcrun --sdk macosx --find clang`, and `xcrun --sdk macosx --show-sdk-path` on that Mac.\n\
                 stdout:\n{}\nstderr:\n{}",
                stdout, stderr
            );
        }

        println!("cargo:rustc-env=MACOS_BLE_HELPER={}", binary.display());
    }

    tauri_build::build()
}
