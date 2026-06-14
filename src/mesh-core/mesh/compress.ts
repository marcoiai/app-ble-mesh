// ── Payload compression (gzip) ───────────────────────────────────────────────
// Shrinks app payloads on the wire with gzip (CompressionStream — browser + Node).
// Applied automatically by MeshNode to bodies above a size threshold on the OPEN
// mesh. On the private mesh, json-transport already gzips before encrypting, so this
// is the open-mesh counterpart. Control traffic (hello/ping) is never compressed.

import { levelPack, levelUnpack } from './levelpack.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/**
 * Body codecs for the OPEN-mesh `zip` slot. The envelope's `zip:true` means
 * "body is compressed"; `zc` says HOW. Absent `zc` == 'gzip' so frames from
 * nodes that predate this stay readable.
 *  - 'gzip'  : JSON → gzip (the original; unchanged on the wire)
 *  - 'lp'    : levelpack bytecode only (best for small bodies where gzip's
 *              ~18B wrapper would cost more than it saves)
 *  - 'lpgz'  : levelpack bytecode → gzip (best when the body still has bulk)
 */
export type BodyCodec = 'gzip' | 'lp' | 'lpgz';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** gzip raw bytes → bytes. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
}

/** gunzip raw bytes → bytes. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
}

/** gzip a value → base64 string. */
export async function gzipValue(value: unknown): Promise<string> {
  return toBase64(await deflate(encoder.encode(JSON.stringify(value))));
}

/** Reverse of gzipValue. */
export async function gunzipValue<T = unknown>(b64: string): Promise<T> {
  const out = await inflate(fromBase64(b64));
  return JSON.parse(decoder.decode(out)) as T;
}

/** Compress a body with the chosen codec → base64 string. */
export async function packBody(value: unknown, codec: BodyCodec = 'gzip'): Promise<string> {
  switch (codec) {
    case 'lp':
      return toBase64(levelPack(value));
    case 'lpgz':
      return toBase64(await deflate(levelPack(value)));
    case 'gzip':
    default:
      return gzipValue(value);
  }
}

/** Reverse of packBody for the codec the envelope declared (`zc`, default gzip). */
export async function unpackBody<T = unknown>(b64: string, codec: BodyCodec = 'gzip'): Promise<T> {
  switch (codec) {
    case 'lp':
      return levelUnpack(fromBase64(b64)) as T;
    case 'lpgz':
      return levelUnpack(await inflate(fromBase64(b64))) as T;
    case 'gzip':
    default:
      return gunzipValue<T>(b64);
  }
}

/** Smallest codec for a body: tries each, returns the winner (id + base64). */
export async function packBodySmallest(
  value: unknown,
  codecs: BodyCodec[] = ['gzip', 'lp', 'lpgz'],
): Promise<{ codec: BodyCodec; data: string }> {
  const packed = await Promise.all(codecs.map(async (codec) => ({ codec, data: await packBody(value, codec) })));
  return packed.reduce((best, cur) => (cur.data.length < best.data.length ? cur : best));
}

/** Rough encoded size of a value, to decide whether compressing is worth it. */
export function encodedSize(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}
