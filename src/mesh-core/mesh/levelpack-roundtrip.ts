// Isolated round-trip + size proof for the body codecs (gzip / lp / lpgz).
// Run: node src/mesh-core/mesh/levelpack-roundtrip.ts
// Proves: every codec is lossless on real mesh body shapes, and shows the bytes.
import { packBody, unpackBody, packBodySmallest, type BodyCodec } from './compress.js';

const enc = new TextEncoder();
const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v)).length;
const wireBytes = (b64: string) => atob(b64).length; // decoded payload size on the wire

// order-insensitive structural equality (JSON semantics — key order doesn't matter)
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
  }
  return false;
}

const samples: Record<string, unknown> = {
  chat: { room: 'lobby', from: 'PV-00042', label: 'marco', text: 'noix, vamo testar a mesh off-grid agora 🎮', ts: 1781300000000 },
  gameEvent: { from: 'PV-00042', payload: { x: 12, y: -7, dx: 1, dy: 0, buttons: 3, seq: 1024, tick: 99999 } },
  roster: { type: 'mesh.hello', caps: ['chat', 'game', 'trade', 'stream'], neighbors: ['PV-1', 'PV-2', 'PV-3'], hops: 2, lastSeen: 1781300000123, direct: false },
  edges: { n: -123456789, f: 3.14159265, z: 0, t: true, f2: false, nul: null, s: 'héllo wörld', empty: {}, arr: [] },
  bulk: { items: Array.from({ length: 20 }, (_, i) => ({ id: 'rom-' + i, title: 'Game Title ' + i, systemId: 'genesis', ts: 1781300000000 + i })) },
};

const codecs: BodyCodec[] = ['gzip', 'lp', 'lpgz'];
let anyLossy = false;

console.log('body         json   gzip    lp     lpgz   winner   (bytes on wire)');
for (const [name, body] of Object.entries(samples)) {
  const sizes: Record<string, number> = {};
  for (const codec of codecs) {
    const packed = await packBody(body, codec);
    const back = await unpackBody(packed, codec);
    if (!deepEqual(body, back)) {
      anyLossy = true;
      console.error(`  ✗ LOSSY ${name}/${codec}:`, JSON.stringify(back));
    }
    sizes[codec] = wireBytes(packed);
  }
  const winner = await packBodySmallest(body);
  const pad = (n: number, w = 6) => String(n).padStart(w);
  console.log(
    `${name.padEnd(11)} ${pad(jsonBytes(body))} ${pad(sizes.gzip)} ${pad(sizes.lp)} ${pad(sizes.lpgz)}   ${winner.codec.padEnd(5)}`,
  );
}
console.log(anyLossy ? '\nRESULT: ✗ a codec was LOSSY' : '\nRESULT: ✓ all codecs lossless on every shape');
if (anyLossy) process.exitCode = 1;
