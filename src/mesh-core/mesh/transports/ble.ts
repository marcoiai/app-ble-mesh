// ── BLE / native byte-pipe transport ────────────────────────────────────────
// Mirrors the working Levelup contract: native BLE only moves opaque byte
// chunks and emits `mesh-ble-frame`; TypeScript owns presence, chunking,
// peer ids, routing, encryption, and delivery.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.ts';
import type { Transport, TransportEvents } from '../transport.ts';

type Wire =
  | { t: 'frame'; from: string; to?: string; data: string }
  | { t: 'present'; from: string }
  | { t: 'bye'; from: string };

export interface BleOptions {
  peerId?: string;
  presenceMs?: number;
  peerTimeoutMs?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frameToB64(frame: Uint8Array): string {
  let bin = '';
  frame.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

function b64ToFrame(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export class BleTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'ble';
  readonly peerId: string;
  private peers = new Map<string, number>();
  private presenceMs: number;
  private peerTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unlisten: UnlistenFn | null = null;
  private sendSeq = Math.floor(Math.random() * 0xffff);
  private rxbuf = new Map<number, { total: number; parts: Map<number, Uint8Array>; ts: number }>();
  private chunkPayload = 16;
  private restarting = false;

  constructor(opts: BleOptions = {}) {
    super();
    this.peerId = opts.peerId ?? globalThis.crypto.randomUUID();
    this.presenceMs = opts.presenceMs ?? 1800;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 8000;
  }

  async start(): Promise<void> {
    this.unlisten = await listen<number[]>('mesh-ble-frame', (event) => {
      this.onDatagram(Uint8Array.from(event.payload));
    });
    await invoke('mesh_ble_start');
    this.post({ t: 'present', from: this.peerId });
    this.timer = setInterval(() => {
      this.post({ t: 'present', from: this.peerId });
      this.expire();
      this.refreshPayloadSize();
    }, this.presenceMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try {
      this.post({ t: 'bye', from: this.peerId });
    } catch {
      // shutting down
    }
    this.unlisten?.();
    this.unlisten = null;
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

  private refreshPayloadSize(): void {
    void invoke<number>('mesh_ble_payload')
      .then((payload) => {
        const usable = Math.max(16, Math.min(508, payload - 4));
        this.chunkPayload = usable;
      })
      .catch(() => {});
  }

  private onDatagram(bytes: Uint8Array): void {
    if (bytes.length < 4) return;
    const id = (bytes[0] << 8) | bytes[1];
    const index = bytes[2];
    const total = bytes[3];
    const payload = bytes.subarray(4);

    if (total <= 1) {
      this.handleWire(payload);
      return;
    }

    let partial = this.rxbuf.get(id);
    if (!partial) {
      partial = { total, parts: new Map(), ts: Date.now() };
      this.rxbuf.set(id, partial);
    }
    partial.parts.set(index, payload);

    if (partial.parts.size >= partial.total) {
      this.rxbuf.delete(id);
      let len = 0;
      for (let i = 0; i < partial.total; i += 1) {
        const chunk = partial.parts.get(i);
        if (!chunk) return;
        len += chunk.length;
      }
      const full = new Uint8Array(len);
      let offset = 0;
      for (let i = 0; i < partial.total; i += 1) {
        const chunk = partial.parts.get(i)!;
        full.set(chunk, offset);
        offset += chunk.length;
      }
      this.handleWire(full);
    }

    if (this.rxbuf.size > 64) {
      const cutoff = Date.now() - 5000;
      for (const [key, value] of this.rxbuf) {
        if (value.ts < cutoff) this.rxbuf.delete(key);
      }
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
      // Do not filter by the transport-level target here. BLE peripheral mode is
      // effectively a tiny shared bus: a relay node must be able to receive a
      // frame even when the final mesh destination is someone else.
      this.emit('frame', { from: msg.from, frame: b64ToFrame(msg.data) });
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
    for (const [peer, lastSeen] of this.peers) {
      if (lastSeen < cutoff) {
        this.peers.delete(peer);
        this.emit('peerDown', { peer });
      }
    }
  }

  private post(wire: Wire): void {
    const bytes = encoder.encode(JSON.stringify(wire));
    const total = Math.max(1, Math.ceil(bytes.length / this.chunkPayload));
    if (total > 255) return;
    const id = (this.sendSeq = (this.sendSeq + 1) & 0xffff);
    for (let i = 0; i < total; i += 1) {
      const slice = bytes.subarray(i * this.chunkPayload, (i + 1) * this.chunkPayload);
      const chunk = new Uint8Array(4 + slice.length);
      chunk[0] = (id >> 8) & 0xff;
      chunk[1] = id & 0xff;
      chunk[2] = i;
      chunk[3] = total;
      chunk.set(slice, 4);
      void this.trySend(chunk);
    }
  }

  private async trySend(chunk: Uint8Array, retried = false): Promise<void> {
    try {
      await invoke('mesh_ble_send', { data: Array.from(chunk) });
    } catch (err) {
      const text = String(err);
      const recoverable =
        text.includes('not started') ||
        text.includes('not advertising') ||
        text.includes('not registered') ||
        text.includes('no connected');
      if (recoverable && !retried && !this.restarting) {
        this.restarting = true;
        try {
          await invoke('mesh_ble_start');
          this.restarting = false;
          await this.trySend(chunk, true);
          this.presenceBurst();
        } catch {
          this.restarting = false;
        }
      }
    }
  }

  private presenceBurst(): void {
    for (const delay of [0, 400, 900]) {
      setTimeout(() => this.post({ t: 'present', from: this.peerId }), delay);
    }
  }
}
