// ── Tauri UDP transport ──────────────────────────────────────────────────────
// The off-grid LAN transport, IN THE UI. The webview can't open sockets, so the
// UDP multicast socket lives in the Rust backend (see src-tauri mesh_udp_*). This
// adapter bridges to it: it sends datagrams via `invoke` and receives them via the
// `mesh-udp-datagram` event. Same wire format as the other transports; discovery,
// presence and dedup stay here in TS. Result: open the app on two machines on the
// same Wi-Fi and they find each other and talk — no server, no copy-paste.
//
// Only usable inside the Tauri shell.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';

type Wire =
  | { t: 'frame'; from: string; to?: string; data: string }
  | { t: 'present'; from: string }
  | { t: 'bye'; from: string };

export interface TauriUdpOptions {
  group?: string;
  port?: number;
  presenceMs?: number;
  peerTimeoutMs?: number;
}

export function tauriUdpSupported(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frameToB64(frame: Uint8Array): string {
  let bin = '';
  frame.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
function b64ToFrame(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export class TauriUdpTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'tauri-udp';
  readonly peerId: string;
  private group?: string;
  private port?: number;
  private peers = new Map<string, number>();
  private presenceMs: number;
  private peerTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unlisten: UnlistenFn | null = null;

  constructor(peerId: string, opts: TauriUdpOptions = {}) {
    super();
    this.peerId = peerId;
    this.group = opts.group;
    this.port = opts.port;
    this.presenceMs = opts.presenceMs ?? 2000;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 6000;
  }

  async start(): Promise<void> {
    this.unlisten = await listen<number[]>('mesh-udp-datagram', (ev) =>
      this.onDatagram(Uint8Array.from(ev.payload)),
    );
    await invoke('mesh_udp_start', { group: this.group, port: this.port });
    this.post({ t: 'present', from: this.peerId });
    this.timer = setInterval(() => {
      this.post({ t: 'present', from: this.peerId });
      this.expire();
    }, this.presenceMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try { this.post({ t: 'bye', from: this.peerId }); } catch { /* shutting down */ }
    if (this.unlisten) this.unlisten();
    this.unlisten = null;
    await invoke('mesh_udp_stop').catch(() => {});
    this.peers.clear();
  }

  neighbors(): string[] {
    return [...this.peers.keys()];
  }

  sendTo(peer: string, frame: Uint8Array): void {
    this.post({ t: 'frame', from: this.peerId, to: peer, data: frameToB64(frame) });
  }

  sendAll(frame: Uint8Array, _opts?: { except?: string }): void {
    this.post({ t: 'frame', from: this.peerId, data: frameToB64(frame) });
  }

  private onDatagram(bytes: Uint8Array): void {
    let msg: Wire;
    try {
      msg = JSON.parse(decoder.decode(bytes)) as Wire;
    } catch {
      return;
    }
    if (!msg || msg.from === this.peerId) return;
    this.touch(msg.from);
    if (msg.t === 'frame') {
      if (msg.to && msg.to !== this.peerId) return;
      this.emit('frame', { frame: b64ToFrame(msg.data), from: msg.from });
    } else if (msg.t === 'bye') {
      if (this.peers.delete(msg.from)) this.emit('peerDown', { peer: msg.from });
    }
  }

  private touch(peer: string): void {
    const known = this.peers.has(peer);
    this.peers.set(peer, Date.now());
    if (!known) {
      this.emit('peerUp', { peer });
      this.post({ t: 'present', from: this.peerId });
    }
  }

  private expire(): void {
    const cutoff = Date.now() - this.peerTimeoutMs;
    for (const [peer, last] of this.peers) {
      if (last < cutoff) {
        this.peers.delete(peer);
        this.emit('peerDown', { peer });
      }
    }
  }

  private post(wire: Wire): void {
    const bytes = encoder.encode(JSON.stringify(wire));
    void invoke('mesh_udp_send', { data: Array.from(bytes) }).catch(() => {});
  }
}
