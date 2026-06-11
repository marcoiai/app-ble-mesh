# Mesh Core

This folder isolates the transport-agnostic Levelup mesh protocol from the app shell.

It is intentionally independent from Tauri, BLE, Wi-Fi Direct, LAN, WebRTC signaling, and UI code.
Native carriers only move opaque bytes into and out of this core through the `Transport` interface.

## Boundary

Core responsibilities:

- node identity and peer state
- frame encoding/decoding
- routing, relay, deduplication, and TTL
- optional compression
- optional encryption/authentication
- service payloads such as chat, game, stream, trade, and access-point control

Carrier responsibilities:

- discover nearby peers
- open links
- chunk/reassemble for radio MTU when needed
- send and receive raw bytes
- report direct neighbor up/down

## Import Surface

Use `src/mesh-core/index.ts` as the public protocol surface.

The existing BLE proof app can keep its native BLE carrier in `src-tauri`; the next step is to
adapt that carrier so received BLE frames feed a `MeshNode` instead of a demo-specific ping path.

## Protocol Notes

- subNodes: `docs/protocol/subnodes.md`
