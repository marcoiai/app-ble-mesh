// ── Invite / Accept: join a private mesh without typing a passphrase ──────────
// Instead of both sides typing the same word, the host creates an invite that
// carries a freshly-generated group key; the other side pastes it and Accepts —
// done, both are on the same encrypted mesh. Hand the invite over a trusted channel
// (copy-paste / AirDrop / QR), just like the WebRTC handshake blob.

import type { MeshNode } from './node.ts';

export interface MeshInvite {
  v: 1;
  /** Group key (becomes the node secret). */
  key: string;
  /** Optional friendly group name. */
  group?: string;
  /** Who created it (label) — shown on the Accept prompt. */
  from?: string;
}

function randomKey(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/=+$/g, '');
}

/**
 * Create an invite to this node's private mesh. If the node isn't private yet, a
 * group key is generated and applied. Returns a blob to hand to the other side.
 */
export function createInvite(node: MeshNode, opts: { group?: string } = {}): string {
  let key = node.groupKey;
  if (!key) {
    key = randomKey();
    node.setSecret(key);
  }
  const invite: MeshInvite = { v: 1, key, group: opts.group, from: node.info.label };
  return btoa(unescape(encodeURIComponent(JSON.stringify(invite))));
}

/** Decode an invite blob without applying it — for showing an Accept prompt first. */
export function peekInvite(blob: string): MeshInvite {
  const invite = JSON.parse(decodeURIComponent(escape(atob(blob.trim())))) as MeshInvite;
  if (!invite || invite.v !== 1 || typeof invite.key !== 'string') {
    throw new Error('invalid invite');
  }
  return invite;
}

/** Accept an invite: adopt its group key so this node joins the private mesh. */
export function acceptInvite(node: MeshNode, blob: string): MeshInvite {
  const invite = peekInvite(blob);
  node.setSecret(invite.key);
  return invite;
}
