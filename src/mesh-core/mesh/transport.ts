// ── The transport seam ───────────────────────────────────────────────────────
// This is the ONE interface every physical carrier implements: loopback (now),
// and later BLE, WiFi-Direct, WebRTC, ultrasonic, QR-sneakernet — or the adapter
// Codex is building. The mesh core (router/node/services) only ever talks to this
// interface, so swapping or adding a carrier never touches protocol logic.
//
// A "peer" here is a transport-level neighbour handle (a string id for the other
// end of a direct link). It need not equal a mesh NodeId, though simple transports
// (loopback) make them the same.

export type TransportEvents = {
  /** A raw frame arrived from a direct neighbour. */
  frame: { frame: Uint8Array; from: string };
  /** A direct neighbour link came up. */
  peerUp: { peer: string };
  /** A direct neighbour link went down. */
  peerDown: { peer: string };
};

export interface Transport {
  /** Stable name for diagnostics, e.g. "loopback", "ble", "webrtc". */
  readonly name: string;

  /** Begin operating (open radios, join the hub, etc.). */
  start(): Promise<void> | void;
  /** Tear down. */
  stop(): Promise<void> | void;

  /** Current direct neighbour handles. */
  neighbors(): string[];

  /** Send a frame to one direct neighbour. */
  sendTo(peer: string, frame: Uint8Array): void;
  /** Send a frame to every direct neighbour, optionally excluding one. */
  sendAll(frame: Uint8Array, opts?: { except?: string }): void;

  /** Subscribe to transport events. Returns an unsubscribe fn. */
  on<K extends keyof TransportEvents>(
    event: K,
    fn: (payload: TransportEvents[K]) => void,
  ): () => void;
}
