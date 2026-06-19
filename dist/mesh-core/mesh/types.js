// ── Mesh protocol: core wire types ───────────────────────────────────────────
// The protocol is transport-agnostic. Everything that travels between nodes is an
// `Envelope`. Transports only move opaque byte frames; routing, dedup, pub/sub and
// request/reply all live above the transport in pure logic (see router.ts / node.ts).
/** Protocol version carried on every envelope. Bump on breaking wire changes. */
export const PROTOCOL_VERSION = 1;
