// ── Payload compression (gzip) ───────────────────────────────────────────────
// Shrinks app payloads on the wire with gzip (CompressionStream — browser + Node).
// Applied automatically by MeshNode to bodies above a size threshold on the OPEN
// mesh. On the private mesh, json-transport already gzips before encrypting, so this
// is the open-mesh counterpart. Control traffic (hello/ping) is never compressed.
import { levelPack, levelUnpack } from './levelpack.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function compressionSupported() {
    return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}
function toBase64(bytes) {
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
}
function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1)
        out[i] = bin.charCodeAt(i);
    return out;
}
async function collect(stream) {
    const chunks = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
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
async function deflate(bytes) {
    return collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
}
/** gunzip raw bytes → bytes. */
async function inflate(bytes) {
    return collect(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
}
/** gzip a value → base64 string. */
export async function gzipValue(value) {
    return toBase64(await deflate(encoder.encode(JSON.stringify(value))));
}
/** Reverse of gzipValue. */
export async function gunzipValue(b64) {
    const out = await inflate(fromBase64(b64));
    return JSON.parse(decoder.decode(out));
}
/** Compress a body with the chosen codec → base64 string. */
export async function packBody(value, codec = 'gzip') {
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
export async function unpackBody(b64, codec = 'gzip') {
    switch (codec) {
        case 'lp':
            return levelUnpack(fromBase64(b64));
        case 'lpgz':
            return levelUnpack(await inflate(fromBase64(b64)));
        case 'gzip':
        default:
            return gunzipValue(b64);
    }
}
/** Smallest codec for a body: tries each, returns the winner (id + base64). */
export async function packBodySmallest(value, codecs = ['gzip', 'lp', 'lpgz']) {
    const packed = await Promise.all(codecs.map(async (codec) => ({ codec, data: await packBody(value, codec) })));
    return packed.reduce((best, cur) => (cur.data.length < best.data.length ? cur : best));
}
/** Rough encoded size of a value, to decide whether compressing is worth it. */
export function encodedSize(value) {
    try {
        return encoder.encode(JSON.stringify(value)).length;
    }
    catch {
        return 0;
    }
}
