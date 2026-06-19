// Node identity. MVP uses random bytes for the address; the shape is intentionally
// the same one a public-key identity would take, so we can later set
// `id = hash(publicKey)` and add signing without changing call sites.

import type { NodeId, NodeInfo } from './types.js';

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  // globalThis.crypto exists in browsers and Node 18+.
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a fresh node address (16 random bytes → 32 hex chars). */
export function generateNodeId(): NodeId {
  return toHex(randomBytes(16));
}

/** Short, human-readable form of an id for UI/logs. */
export function shortId(id: NodeId): string {
  return id.length <= 10 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

const ADJECTIVES = ['NEON', 'TURBO', 'PIXEL', 'RETRO', 'CYBER', 'HYPER', 'LASER', 'VAPOR', 'SYNTH', 'MEGA', 'ULTRA', 'GLITCH'];
const NOUNS = ['FOX', 'WOLF', 'HAWK', 'RONIN', 'VIPER', 'COMET', 'DRAGON', 'PHOENIX', 'RAVEN', 'TIGER', 'GHOST', 'ROBOT'];

/** A fun, distinct node name like "NEON-FOX-42" so each node is recognisable. */
export function randomLabel(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${a}-${b}-${n}`;
}

export interface IdentityOptions {
  id?: NodeId;
  label?: string;
  caps?: string[];
}

/** Build a NodeInfo, generating a random id/label when not supplied. */
export function createIdentity(opts: IdentityOptions = {}): NodeInfo {
  const id = opts.id ?? generateNodeId();
  return {
    id,
    label: opts.label ?? randomLabel(),
    caps: opts.caps ?? [],
  };
}
