#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/src-tauri/gen/android"

cd ../../..

pnpm tauri android build --debug --target aarch64 --apk --split-per-abi
adb install -r src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
adb shell monkey -p com.auser.app_ble_mesh -c android.intent.category.LAUNCHER 1
