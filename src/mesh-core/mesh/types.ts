// ── Mesh protocol: core wire types ───────────────────────────────────────────
// The protocol is transport-agnostic. Everything that travels between nodes is an
// `Envelope`. Transports only move opaque byte frames; routing, dedup, pub/sub and
// request/reply all live above the transport in pure logic (see router.ts / node.ts).

/** Protocol version carried on every envelope. Bump on breaking wire changes. */
export const PROTOCOL_VERSION = 1;

/** A node address. MVP: random hex; designed to later become a public-key hash. */
export type NodeId = string;

/**
 * The single unit that crosses the mesh. Encoded to bytes by the codec, carried by
 * any transport, relayed hop-by-hop by the router.
 */
export interface Envelope {
  /** Protocol version. */
  v: number;
  /** Globally-unique message id — the dedup key for the flood router. */
  id: string;
  /** Application message type, e.g. "chat.say", "trade.req", "stream.chunk". */
  type: string;
  /** Origin node. */
  from: NodeId;
  /** Destination node, or `null` for a broadcast/flood. */
  to: NodeId | null;
  /** Optional pub/sub topic (chat rooms, stream ids, game lobbies). */
  channel?: string;
  /** Remaining relays allowed. 0 = direct neighbours only. Prevents infinite flood. */
  ttl: number;
  /** Node ids already traversed — loop avoidance + traceroute. */
  path: NodeId[];
  /** Origin timestamp (ms since epoch). */
  ts: number;
  /** Correlation id for request/reply pairing. */
  corr?: string;
  /** True when this envelope is a reply to `corr`. */
  reply?: boolean;
  /** True when `body` is a sealed JsonTransportEnvelope (gzip + AES-GCM). */
  enc?: boolean;
  /** True when `body` is a compressed payload (open mesh). */
  zip?: boolean;
  /**
   * Which body codec produced `body` when `zip` is true. Absent == 'gzip', so
   * frames from nodes that predate levelpack still decode. See compress.ts.
   */
  zc?: 'gzip' | 'lp' | 'lpgz';
  /** Application payload. */
  body: unknown;
}

/** Human-facing identity for a node, gossiped via hello beacons. */
export interface NodeInfo {
  id: NodeId;
  label: string;
  /** Free-form capability tags, e.g. ["chat", "trade", "stream", "game"]. */
  caps: string[];
}

/** A peer the local node currently knows about. */
export interface PeerRecord {
  id: NodeId;
  label: string;
  caps: string[];
  /** Transport-level neighbour handle the peer was last heard through. */
  via: string;
  /** The peer's own direct neighbours (gossiped via hello) — feeds route graphs. */
  neighbors: NodeId[];
  /** Hops away: 0 = direct neighbour, >0 = reached through relays. */
  hops: number;
  /** Last time we heard from this peer (ms). */
  lastSeen: number;
  /** True when the peer is a direct transport neighbour. */
  direct: boolean;
}

/** Context handed to a message handler. */
export interface MessageContext {
  /** The decoded envelope. */
  envelope: Envelope;
  from: NodeId;
  type: string;
  channel?: string;
  body: unknown;
  /** Send a reply back to the sender (only meaningful for request messages). */
  reply: (body: unknown) => void;
}

export type MessageHandler = (ctx: MessageContext) => void;
