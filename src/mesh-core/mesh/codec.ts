// Wire codec: Envelope <-> bytes. MVP is JSON over UTF-8 — readable and debuggable.
// It's isolated here so the framing can later be swapped (CBOR, protobuf, signed
// frames) without touching the router, node, transports, or services.

import type { Envelope } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(env: Envelope): Uint8Array {
  return encoder.encode(JSON.stringify(env));
}

export function decode(frame: Uint8Array): Envelope {
  const env = JSON.parse(decoder.decode(frame)) as Envelope;
  // Minimal structural validation — a hostile/garbled neighbour shouldn't crash us.
  if (
    typeof env !== 'object' ||
    env === null ||
    typeof env.id !== 'string' ||
    typeof env.from !== 'string' ||
    typeof env.type !== 'string' ||
    !Array.isArray(env.path)
  ) {
    throw new Error('mesh: malformed envelope');
  }
  return env;
}
