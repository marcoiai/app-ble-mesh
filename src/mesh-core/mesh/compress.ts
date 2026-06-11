// ── Payload compression (gzip) ───────────────────────────────────────────────
// Shrinks app payloads on the wire with gzip (CompressionStream — browser + Node).
// Applied automatically by MeshNode to bodies above a size threshold on the OPEN
// mesh. On the private mesh, json-transport already gzips before encrypting, so this
// is the open-mesh counterpart. Control traffic (hello/ping) is never compressed.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function compressionSupported(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

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

/** gzip a value → base64 string. */
export async function gzipValue(value: unknown): Promise<string> {
  const input = encoder.encode(JSON.stringify(value));
  const out = await collect(new Blob([input]).stream().pipeThrough(new CompressionStream('gzip')));
  return toBase64(out);
}

/** Reverse of gzipValue. */
export async function gunzipValue<T = unknown>(b64: string): Promise<T> {
  const bytes = fromBase64(b64);
  const out = await collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  return JSON.parse(decoder.decode(out)) as T;
}

/** Rough encoded size of a value, to decide whether compressing is worth it. */
export function encodedSize(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}
