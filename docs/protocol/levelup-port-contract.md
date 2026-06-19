# Levelup mesh port contract

This file records the behavior that was proven in Levelup before extracting the
mesh core into this repo. Keep this as a regression checklist when changing the
core, BLE carrier, Android bridge, or native startup.

## Working baseline

- Mac to Mac works off-grid through Multipeer/AWDL.
- Mac to Android works off-grid through BLE, with Android acting as a GATT
  peripheral/bridge and Macs writing/subscribing as centrals.
- Android can become the practical radio bridge when two Macs can both see it.
- `chat.direct`, ping/pong, presence, and relayed frames must work without any
  UI panel being open.
- Runtime startup must not depend on Wi-Fi, LAN IP, or a dev server once the app
  is installed.
- The protocol must stay transport-agnostic: BLE, Multipeer, UDP, Wi-Fi Direct,
  WebRTC, and future carriers only move opaque mesh bytes.

## Transport invariants

- Every carrier reports direct neighbor up/down and raw rx/tx result.
- Fragmentation is per-carrier; the mesh core sees complete frames.
- BLE fragmentation must respect negotiated payload size and bound both receive
  buffers and outgoing queues.
- Presence should burst after startup/recovery, but recovery must be debounced so
  a network change does not create reconnect storms.
- Failed writes to stale BLE peers must drop or quarantine that peer instead of
  keeping a zombie link forever.
- Self-heal belongs at the link/protocol layer, not in a screen or debug panel.

## Android/native startup

- Android needs the app-side bridge plus `master_program` sidecar/runtime started
  automatically on app startup.
- Android builds should include the architecture-specific binary, for example
  `master_program-aarch64-linux-android`, not a universal/host binary.
- Android cleartext/local socket/network permissions are part of the platform
  contract when the runtime talks to `127.0.0.1` or local dev endpoints.
- The app must keep BLE advertising/subscription state alive when Wi-Fi is off,
  toggled, or unavailable.

## Debug/log contract

- BLE debug logs must be behind an explicit debug toggle/env flag.
- Normal states such as "no subscribed centrals" or repeated rearm attempts must
  be throttled or silent by default.
- Frame counters and stream packet logs should be sampled/throttled so the log
  path cannot compete with the radio path.

## Dynamic config lessons

- Dev URLs must not be baked to a stale LAN IP.
- When dev-server mode is needed, bind Vite to `0.0.0.0` and pass the intended
  host explicitly.
- Device identity should support stable aliases (`M5`, `M1`, `Moto`) for tests,
  but runtime routing should use node IDs, not IPs.

## Smoke test

1. Start Droid only, no Wi-Fi, confirm BLE advertising and runtime online.
2. Start Mac A, confirm it discovers/subscribes to Droid.
3. Start Mac B, confirm both Macs and Droid see each other.
4. Send ping each direction: Mac A to Droid, Droid to Mac A, Mac B to Droid,
   Droid to Mac B, Mac A to Mac B through relay when direct is absent.
5. Send chat each direction, including Mac to Droid.
6. Start a pixel stream and keep control messages working.
7. Toggle Wi-Fi on one device, then off again. The mesh should recover without
   requiring an app restart or debug panel open.
8. Leave the island idle for 10 minutes, then ping/chat again.

## Failure checklist: mesh OFF after Wi-Fi is disabled

Probable causes:

- Android BLE permissions were not granted or were revoked.
- Android GATT server is not advertising.
- Kotlin/Android bridge crashed or failed to register.
- Native runtime/sidecar is not online on Android.
- No central subscribed to the Android peripheral after the network transition.

Checks:

- `adb logcat | grep -E "BLE|BleMesh|mesh"`
- `adb shell pm dump com.marco.levelup`
- Confirm Android advertises the mesh service UUID.
- Confirm Macs subscribe to Android and do not keep writing to stale/zombie peers.
- Confirm `master_program` is running locally on Android when Levelup depends on it.
