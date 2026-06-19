// ── Secure channel: private/isolated mesh via Codex's json-transport codec ────
// Wraps `packJsonForTransport` / `unpackJsonFromTransport` (gzip → AES-GCM, key
// derived from a shared passphrase) into a tiny seal/open pair. Use it to encrypt
// message *bodies* before handing them to the mesh, so only nodes that share the
// passphrase can read them — an "isolated LAN" carved out of the open mesh.
//
//   const ch = createSecureChannel('arcade-crew-2026');
//   node.send(peer, 'secure.msg', await ch.seal({ text: 'gg' }));
//   node.on('secure.msg', async (ctx) => {
//     const msg = await ch.open<{ text: string }>(ctx.body as JsonTransportEnvelope);
//   });
//
// Crypto is async (Web Crypto), so this layers on top of the mesh at the
// application level — the sync core/codec stays untouched. Browser/Tauri only.

import {
  packJsonForTransport,
  unpackJsonFromTransport,
  type JsonTransportEnvelope,
} from '../json-transport.js';

export interface SecureChannel {
  /** Encrypt a value into a transport envelope (safe to send as a message body). */
  seal(value: unknown): Promise<JsonTransportEnvelope>;
  /** Decrypt an envelope back into the original value. */
  open<T = unknown>(envelope: JsonTransportEnvelope): Promise<T>;
}

export function createSecureChannel(passphrase: string, iterations?: number): SecureChannel {
  const options = { passphrase, iterations };
  return {
    seal: (value) => packJsonForTransport(value, options),
    open: <T>(envelope: JsonTransportEnvelope) => unpackJsonFromTransport<T>(envelope, options),
  };
}
