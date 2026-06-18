# Protocol Isolation Map

This branch separates the reusable mesh protocol from radio/runtime adapters and the demo app.

## Layers

| Layer | Owns | Must not own |
| --- | --- | --- |
| `src/mesh-core` | identity, envelopes, routing, TTL, dedup, store-and-forward, compression, crypto, services | Tauri commands, BLE APIs, Android/macOS helpers, UI state |
| `src/mesh-adapters` | carrier-specific byte pipes that implement `Transport` | routing decisions, chat semantics, peer topology policy |
| `src-tauri` | native bridge commands/events, BLE central/peripheral implementation, platform permissions | mesh message semantics |
| React demo files | user flows, status, ping popup, chat proof UI | protocol rules or radio-specific packet handling |

## Protocol Files

| File | Role |
| --- | --- |
| `src/mesh-core/mesh/node.ts` | `MeshNode`: lifecycle, hello/bye, peer table, routing integration, request/reply, encryption/compression selection |
| `src/mesh-core/mesh/transport.ts` | Small `Transport` contract every adapter must implement |
| `src/mesh-core/mesh/router.ts` | Flood/unicast forwarding decision logic |
| `src/mesh-core/mesh/graph.ts` | Shortest-path route calculation from gossiped topology |
| `src/mesh-core/mesh/store.ts` | Store-and-forward hold/replay buffer |
| `src/mesh-core/mesh/secure.ts` | Shared-secret encryption/authentication |
| `src/mesh-core/mesh/compress.ts` and `src/mesh-core/mesh/levelpack.ts` | Payload compaction codecs |
| `src/mesh-core/mesh/services/*.ts` | App-level protocol services: chat, game, stream, trade, access point |
| `src/mesh-core/index.ts` | Public protocol surface for apps and demos |

## Adapter Files

| File | Role |
| --- | --- |
| `src/mesh-adapters/tauri-ble.ts` | Tauri BLE carrier adapter. Listens to native `mesh-ble-frame`, sends native `mesh_ble_send`, chunks by MTU, reports direct peers |
| `src/mesh-adapters/index.ts` | Public adapter surface |

## Native Bridge Files

| File | Role |
| --- | --- |
| `src-tauri/src/ble.rs` | Desktop BLE central bridge, protocol byte transport helpers, Tauri commands |
| `src-tauri/src/ble_android.rs` | Android BLE command bridge |
| `src-tauri/src/ble_macos.rs` | macOS peripheral helper bridge |
| `src-tauri/native/macos_ble_peripheral.*` | macOS BLE advertising/peripheral helper |
| `src-tauri/gen/android/app/src/main/java/com/auser/app_ble_mesh/BleMeshPeripheral.kt` | Android BLE peripheral implementation |

## Demo Files

| File | Role |
| --- | --- |
| `src/BleCoreMeshDemo.tsx` | Real BLE proof UI: creates `MeshNode`, attaches `BleTransport`, shows peers, chat, ping popup |
| `src/ProtocolCoreDemo.tsx` | Pure in-browser loopback proof with no native radio |
| `src/LevelPackBench.tsx` | Payload compression benchmark/demo |
| `src/App.tsx` | Tauri shell UI and native BLE controls around the protocol demo |

## Dependency Direction

```text
React demo -> mesh-core
React demo -> mesh-adapters -> mesh-core Transport
mesh-adapters -> Tauri/native bridge
src-tauri/native -> bytes/events only
mesh-core -> no Tauri, no Android, no macOS
```

## Next Isolation Step

Move legacy Rust `protocol.rs` frame semantics toward `mesh-core` ownership or mark it as
native transport framing only. The durable rule is: native code moves bytes; TypeScript core
decides mesh semantics.
