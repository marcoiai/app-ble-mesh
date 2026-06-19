// ── Native BLE transport (off-grid, no LAN / router / internet) ──────────────
// The webview can't drive Bluetooth, so the radio lives natively: ble.rs (CoreBluetooth
// peripheral) on macOS, BleMeshPeripheral.kt (GATT server) on Android, and btleplug as the
// central everywhere. This adapter is the TS seam — frames go out via invoke('mesh_ble_send')
// and arrive on the 'mesh-ble-frame' event, exactly like TauriRadioTransport, so the mesh
// engine treats BLE like any other carrier.
//
// BLE is a dumb broadcast byte-pipe (no per-peer addressing), so a tiny presence protocol
// (present/bye + timeout) rides on top to give the mesh peerUp/peerDown and dedup by sender
// id — same wire format as the radio transport. JSON/routing/TTL stay in the mesh core.
//
// Note: frames ride a single GATT notify, so a frame must fit the negotiated BLE MTU
// (~20–244 bytes); large payloads need fragmentation (not done yet). Chat/presence fit.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';

type Wire =
  | { t: 'frame'; from: string; to?: string; data: string }
  | { t: 'present'; from: string }
  | { t: 'bye'; from: string };

export interface TauriBleOptions {
  presenceMs?: number;
  peerTimeoutMs?: number;
}

export function tauriBleSupported(): boolean {
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

export class TauriBleTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'ble';
  readonly peerId: string;
  private peers = new Map<string, number>();
  private presenceMs: number;
  private peerTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unlisten: UnlistenFn | null = null;
  private unlistenNetwork: (() => void) | null = null;
  // BLE notify/write is capped at the negotiated ATT MTU. Start at the 23-byte-floor
  // payload (16B after our 4B header) and upgrade once native reports real capacity.
  private sendSeq = Math.floor(Math.random() * 0xffff);
  private rxbuf = new Map<number, { total: number; parts: Map<number, Uint8Array>; t: number }>();
  private chunkPayload = 16;
  private restarting = false;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(peerId: string, opts: TauriBleOptions = {}) {
    super();
    this.peerId = peerId;
    this.presenceMs = opts.presenceMs ?? 2000;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 8000;
  }

  async start(): Promise<void> {
    this.unlisten = await listen<number[]>('mesh-ble-frame', (ev) =>
      this.onDatagram(Uint8Array.from(ev.payload)),
    );
    // Brings up advertising (peripheral) + scanning (central). Resilient: the node keeps
    // its other transports if either role is unavailable on this platform.
    await invoke('mesh_ble_start');
    this.post({ t: 'present', from: this.peerId });
    this.timer = setInterval(() => {
      this.post({ t: 'present', from: this.peerId });
      this.expire();
      this.refreshPayloadSize();
    }, this.presenceMs);
    const recoverAfterNetworkShift = () => {
      const peers = [...this.peers.keys()];
      this.peers.clear();
      peers.forEach((peer) => this.emit('peerDown', { peer }));
      void this.restartNative('network changed');
    };
    window.addEventListener('online', recoverAfterNetworkShift);
    window.addEventListener('offline', recoverAfterNetworkShift);
    this.unlistenNetwork = () => {
      window.removeEventListener('online', recoverAfterNetworkShift);
      window.removeEventListener('offline', recoverAfterNetworkShift);
    };
  }

  private refreshPayloadSize(): void {
    void invoke<number>('mesh_ble_payload')
      .then((p) => {
        const usable = Math.max(16, Math.min(508, p - 4));
        if (usable !== this.chunkPayload) {
          console.info(`[mesh-ble] chunk payload ${this.chunkPayload} -> ${usable} bytes`);
          this.chunkPayload = usable;
        }
      })
      .catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try { this.post({ t: 'bye', from: this.peerId }); } catch { /* shutting down */ }
    if (this.unlisten) this.unlisten();
    if (this.unlistenNetwork) this.unlistenNetwork();
    this.unlisten = null;
    this.unlistenNetwork = null;
    await invoke('mesh_ble_stop').catch(() => {});
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

  // Inbound chunk: [idHi, idLo, idx, total, ...payload]. Reassemble, then handle the wire.
  private onDatagram(bytes: Uint8Array): void {
    if (bytes.length < 4) return;
    const id = (bytes[0] << 8) | bytes[1];
    const idx = bytes[2];
    const total = bytes[3];
    const payload = bytes.subarray(4);
    if (total <= 1) {
      this.handleWire(payload);
      return;
    }
    let buf = this.rxbuf.get(id);
    if (!buf) {
      buf = { total, parts: new Map(), t: Date.now() };
      this.rxbuf.set(id, buf);
    }
    buf.parts.set(idx, payload);
    if (buf.parts.size >= buf.total) {
      this.rxbuf.delete(id);
      let len = 0;
      for (let i = 0; i < buf.total; i += 1) {
        const p = buf.parts.get(i);
        if (!p) return; // missing fragment — drop the message
        len += p.length;
      }
      const full = new Uint8Array(len);
      let off = 0;
      for (let i = 0; i < buf.total; i += 1) {
        const p = buf.parts.get(i)!;
        full.set(p, off);
        off += p.length;
      }
      this.handleWire(full);
    }
    // Drop stale partials (lost fragments) so the buffer can't grow unbounded.
    if (this.rxbuf.size > 64) {
      const cutoff = Date.now() - 5000;
      for (const [k, v] of this.rxbuf) if (v.t < cutoff) this.rxbuf.delete(k);
    }
  }

  private handleWire(bytes: Uint8Array): void {
    let msg: Wire;
    try {
      msg = JSON.parse(decoder.decode(bytes)) as Wire;
    } catch {
      return;
    }
    if (!msg || msg.from === this.peerId) return;
    this.touch(msg.from);
    if (msg.t === 'frame') {
      // BLE peripheral mode behaves like a tiny shared bus. Let the mesh router see
      // frames even when this node is an intermediate hop, otherwise Droid-central
      // relay topologies drop unicast traffic before routing can forward it.
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

  private async restartNative(reason: string): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      console.warn(`[mesh-ble] ${reason} — rearming central links`);
      await invoke('mesh_ble_recover').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
      await invoke('mesh_ble_start');
      this.presenceBurst();
    } catch (err) {
      console.error('[mesh-ble] native restart failed', err);
    } finally {
      this.restarting = false;
    }
  }

  // Outbound: fragment by negotiated link capacity, floor 16.
  private post(wire: Wire): void {
    const bytes = encoder.encode(JSON.stringify(wire));
    const PAYLOAD = this.chunkPayload;
    const total = Math.max(1, Math.ceil(bytes.length / PAYLOAD));
    if (total > 255) return;
    const id = (this.sendSeq = (this.sendSeq + 1) & 0xffff);
    for (let i = 0; i < total; i += 1) {
      const slice = bytes.subarray(i * PAYLOAD, (i + 1) * PAYLOAD);
      const chunk = new Uint8Array(4 + slice.length);
      chunk[0] = (id >> 8) & 0xff;
      chunk[1] = id & 0xff;
      chunk[2] = i;
      chunk[3] = total;
      chunk.set(slice, 4);
      this.sendQueue = this.sendQueue
        .catch(() => undefined)
        .then(() => this.tryInvokeSend(chunk));
    }
  }

  private async tryInvokeSend(chunk: Uint8Array, retried = false): Promise<void> {
    try {
      await invoke('mesh_ble_send', { data: Array.from(chunk) });
    } catch (e) {
      const msg = String(e);
      const isDead = msg.includes('not_started')
        || msg.includes('not_running')
        || msg.includes('not registered')
        || msg.includes('not ready');
      if (isDead && !retried && !this.restarting) {
        await this.restartNative('transport dropped');
        await this.tryInvokeSend(chunk, true);
        return;
      }
      console.error('[mesh-ble] send failed', e);
    }
  }

  private presenceBurst(): void {
    for (const delay of [0, 500, 1000]) {
      setTimeout(() => this.post({ t: 'present', from: this.peerId }), delay);
    }
  }
}
