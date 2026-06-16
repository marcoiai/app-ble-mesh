#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/src-tauri/gen/android"

./gradlew :app:assembleArm64Debug
adb install -r app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
