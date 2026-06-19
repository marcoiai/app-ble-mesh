// ── The transport seam ───────────────────────────────────────────────────────
// This is the ONE interface every physical carrier implements: loopback (now),
// and later BLE, WiFi-Direct, WebRTC, ultrasonic, QR-sneakernet — or the adapter
// Codex is building. The mesh core (router/node/services) only ever talks to this
// interface, so swapping or adding a carrier never touches protocol logic.
//
// A "peer" here is a transport-level neighbour handle (a string id for the other
// end of a direct link). It need not equal a mesh NodeId, though simple transports
// (loopback) make them the same.
export {};
