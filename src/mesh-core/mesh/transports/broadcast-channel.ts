// ── BroadcastChannel transport ───────────────────────────────────────────────
// A REAL transport (not the in-process sandbox) that's fully configless: open the
// app in two browser tabs/windows on the same origin and they discover each other
// and talk — no server, no LAN address to type, no handshake. The BroadcastChannel
// is a shared bus, so every tab is a direct neighbour (one broadcast domain); the
// mesh's own hello beacons + dedup handle discovery and loop safety on top.
//
// Same-origin/same-browser only. For separate machines, use the WebRTC transport.

import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';

type Wire =
  | { t: 'frame'; from: string; to?: string; data: Uint8Array }
  | { t: 'present'; from: string }
  | { t: 'bye'; from: string };

export interface BroadcastChannelOptions {
  /** Shared bus name — same name = same mesh. Default 'levelup-mesh'. */
  channelName?: string;
  /** Presence ping interval (ms). */
  presenceMs?: number;
  /** Drop a peer if unseen for this long (ms). */
  peerTimeoutMs?: number;
}

/** Available only where the BroadcastChannel API exists (browsers, Tauri webview). */
export function broadcastChannelSupported(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

export class BroadcastChannelTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'broadcast-channel';
  readonly peerId: string;
  private channelName: string;
  private bc: BroadcastChannel | null = null;
  private peers = new Map<string, number>(); // peerId -> lastSeen
  private presenceMs: number;
  private peerTimeoutMs: number;
  private timer?: ReturnType<typeof setInterval>;

  /** `peerId` should be the owning node's id so transport handles == NodeIds. */
  constructor(peerId: string, opts: BroadcastChannelOptions = {}) {
    super();
    this.peerId = peerId;
    this.channelName = opts.channelName ?? 'levelup-mesh';
    this.presenceMs = opts.presenceMs ?? 2000;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 6000;
  }

  start(): void {
    if (this.bc) return;
    if (!broadcastChannelSupported()) throw new Error('BroadcastChannel not supported here');
    this.bc = new BroadcastChannel(this.channelName);
    this.bc.onmessage = (ev: MessageEvent) => this.onWire(ev.data as Wire);
    this.post({ t: 'present', from: this.peerId });
    this.timer = setInterval(() => {
      this.post({ t: 'present', from: this.peerId });
      this.expire();
    }, this.presenceMs);
  }

  stop(): void {
    if (!this.bc) return;
    this.post({ t: 'bye', from: this.peerId });
    if (this.timer) clearInterval(this.timer);
    this.bc.close();
    this.bc = null;
    this.peers.clear();
  }

  neighbors(): string[] {
    return [...this.peers.keys()];
  }

  sendTo(peer: string, frame: Uint8Array): void {
    this.post({ t: 'frame', from: this.peerId, to: peer, data: frame });
  }

  sendAll(frame: Uint8Array, _opts?: { except?: string }): void {
    // Single broadcast domain: one post reaches every other tab. `except` is a no-op
    // here — the router's dedup set makes redundant receipt harmless.
    this.post({ t: 'frame', from: this.peerId, data: frame });
  }

  private onWire(msg: Wire): void {
    if (!msg || typeof msg !== 'object' || msg.from === this.peerId) return;
    this.touch(msg.from);
    if (msg.t === 'frame') {
      if (msg.to && msg.to !== this.peerId) return; // unicast addressed elsewhere
      this.emit('frame', { frame: new Uint8Array(msg.data), from: msg.from });
    } else if (msg.t === 'bye') {
      if (this.peers.delete(msg.from)) this.emit('peerDown', { peer: msg.from });
    }
  }

  private touch(peer: string): void {
    const known = this.peers.has(peer);
    this.peers.set(peer, Date.now());
    if (!known) {
      this.emit('peerUp', { peer });
      this.post({ t: 'present', from: this.peerId }); // help the newcomer find us fast
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

  private post(msg: Wire): void {
    this.bc?.postMessage(msg);
  }
}
