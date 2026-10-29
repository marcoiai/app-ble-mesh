import { levelPack, levelUnpack, jsonSize } from './mesh/levelpack.js';

export interface JsonTransportEnvelope {
  kind: 'compact-json';
  v: 1;
  codec: 'json';
  zip: 'gzip';
  alg: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
  stats?: {
    jsonBytes: number;
    gzipBytes: number;
  };
}

interface JsonTransportOptions {
  passphrase: string;
  iterations?: number;
}

const DEFAULT_ITERATIONS = 310000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Use the global btoa/atob (Node 16+, browsers, WebView, Tauri) instead of window.*,
// so the seal/open path also works headless — e.g. inside the mesh test runner or a
// future Node-side relay. Previously a private-mesh send from Node threw "window is
// not defined" inside the catch and the message was dropped silently.
function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.length;
  });
  return bytes;
}

async function gzip(bytes: Uint8Array) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('gzip_unavailable');
  }
  const source = new Blob([bytes]).stream();
  return readStream(source.pipeThrough(new CompressionStream('gzip')));
}

async function gunzip(bytes: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('gunzip_unavailable');
  }
  const source = new Blob([bytes]).stream();
  return readStream(source.pipeThrough(new DecompressionStream('gzip')));
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number) {
  if (!passphrase.trim()) throw new Error('passphrase_required');
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function packJsonForTransport(value: unknown, options: JsonTransportOptions): Promise<JsonTransportEnvelope> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('web_crypto_unavailable');
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const jsonBytes = encoder.encode(JSON.stringify(value));
  const compressed = await gzip(jsonBytes);
  const key = await deriveAesKey(options.passphrase, salt, iterations);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed));

  return {
    kind: 'compact-json',
    v: 1,
    codec: 'json',
    zip: 'gzip',
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToBase64Url(salt),
    iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(encrypted),
    stats: {
      jsonBytes: jsonBytes.byteLength,
      gzipBytes: compressed.byteLength,
    },
  };
}

export async function unpackJsonFromTransport<T = unknown>(
  envelope: JsonTransportEnvelope,
  options: JsonTransportOptions,
): Promise<T> {
  if (envelope.kind !== 'compact-json' || envelope.v !== 1) throw new Error('compact_json_envelope_unsupported');
  if (envelope.codec !== 'json' || envelope.zip !== 'gzip' || envelope.alg !== 'AES-GCM') {
    throw new Error('compact_json_codec_unsupported');
  }
  const salt = base64UrlToBytes(envelope.salt);
  const iv = base64UrlToBytes(envelope.iv);
  const encrypted = base64UrlToBytes(envelope.data);
  const key = await deriveAesKey(options.passphrase, salt, envelope.iterations);
  const compressed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted));
  const jsonBytes = await gunzip(compressed);
  return JSON.parse(decoder.decode(jsonBytes)) as T;
}

/** Level Pack v2: compact binary payload sealed with the existing PBKDF2/AES-GCM crypto.
 * Legacy compact-json v1 remains decodable for compatible private mesh peers. */
export interface LevelPackTransportEnvelope {
  kind: 'level-pack';
  v: 2;
  codec: 'lp';
  zip: 'none' | 'gzip';
  alg: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
  stats: { jsonBytes: number; lpBytes: number; packedBytes: number; encryptedBytes: number };
}

export type SecureTransportEnvelope = JsonTransportEnvelope | LevelPackTransportEnvelope;

export async function packLevelPackForTransport(
  value: unknown,
  options: JsonTransportOptions,
): Promise<LevelPackTransportEnvelope> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('web_crypto_unavailable');
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const lp = levelPack(value);
  // Never gzip unless it saves bytes; encryption always receives compact binary.
  let payload = lp;
  let zip: 'none' | 'gzip' = 'none';
  if (typeof CompressionStream !== 'undefined') {
    const compressed = await gzip(lp);
    if (compressed.byteLength < lp.byteLength) {
      payload = compressed;
      zip = 'gzip';
    }
  }
  const key = await deriveAesKey(options.passphrase, salt, iterations);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  return {
    kind: 'level-pack', v: 2, codec: 'lp', zip, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256',
    iterations, salt: bytesToBase64Url(salt), iv: bytesToBase64Url(iv),
    data: bytesToBase64Url(encrypted),
    stats: { jsonBytes: jsonSize(value), lpBytes: lp.byteLength,
      packedBytes: payload.byteLength, encryptedBytes: encrypted.byteLength },
  };
}

export async function unpackLevelPackFromTransport<T = unknown>(
  envelope: LevelPackTransportEnvelope, options: JsonTransportOptions,
): Promise<T> {
  if (envelope.kind !== 'level-pack' || envelope.v !== 2 || envelope.codec !== 'lp' ||
      envelope.alg !== 'AES-GCM' || envelope.kdf !== 'PBKDF2-SHA256' ||
      (envelope.zip !== 'none' && envelope.zip !== 'gzip')) {
    throw new Error('level_pack_envelope_unsupported');
  }
  const key = await deriveAesKey(options.passphrase, base64UrlToBytes(envelope.salt), envelope.iterations);
  const decrypted = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) }, key, base64UrlToBytes(envelope.data),
  ));
  const binary = envelope.zip === 'gzip' ? await gunzip(decrypted) : decrypted;
  return levelUnpack(binary) as T;
}
