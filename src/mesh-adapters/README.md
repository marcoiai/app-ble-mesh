# Mesh Adapters

Adapters connect the pure protocol core to a real carrier.

They may know about Tauri commands, native events, BLE MTU, Wi-Fi Direct, LAN sockets,
or platform-specific recovery. They should expose only the `Transport` contract to
`mesh-core`.

## Current Adapters

- `tauri-ble.ts`: bridges Tauri's `mesh_ble_start`, `mesh_ble_send`, `mesh_ble_payload`,
  and `mesh-ble-frame` event into a protocol `Transport`.

## Rule

If a file imports `@tauri-apps/*`, native APIs, Android, macOS, Wi-Fi Direct, or browser-only
runtime APIs, it belongs here or in the app shell, not inside `src/mesh-core`.
