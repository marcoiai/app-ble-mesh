// ── BLE / native transport ───────────────────────────────────────────────────
// A real nearby-only carrier for MeshNode. The protocol core still owns routing,
// relay, compression, dedup and AES-GCM payload privacy. This adapter only moves
// already-encoded mesh-core frames through the Tauri BLE bridge.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.ts';
import type { Transport, TransportEvents } from '../transport.ts';

export interface BleOptions {
  mode?: 'central' | 'peripheral';
  deviceId?: string | null;
  charUuid?: string | null;
  peerId?: string;
  ttl?: number;
}

interface MeshCoreFramePayload {
  fromPeer: string;
  srcAddr: number;
  payload: number[];
}

export class BleTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'ble';
  private opts: BleOptions;
  private links = new Set<string>();
  private unlisten?: () => void;

  constructor(opts: BleOptions = {}) {
    super();
    this.opts = { mode: 'central', ttl: 4, ...opts };
  }

  async start(): Promise<void> {
    const initialPeer = this.peerHandle();
    if (initialPeer) this.markPeerUp(initialPeer);

    this.unlisten = await listen<MeshCoreFramePayload>('mesh-core-frame', (event) => {
      const from = event.payload.fromPeer || this.peerHandle() || 'ble-neighbor';
      this.markPeerUp(from);
      this.emit('frame', {
        from,
        frame: new Uint8Array(event.payload.payload),
      });
    });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    for (const peer of this.links) this.emit('peerDown', { peer });
    this.links.clear();
  }

  neighbors(): string[] {
    return [...this.links];
  }

  sendTo(_peer: string, frame: Uint8Array): void {
    void this.write(frame);
  }

  sendAll(frame: Uint8Array, opts?: { except?: string }): void {
    if (opts?.except && this.links.size === 1 && this.links.has(opts.except)) return;
    void this.write(frame);
  }

  private peerHandle(): string | null {
    if (this.opts.peerId) return this.opts.peerId;
    if (this.opts.mode === 'central') return this.opts.deviceId ?? null;
    return 'ble-neighbor';
  }

  private markPeerUp(peer: string): void {
    if (this.links.has(peer)) return;
    this.links.add(peer);
    this.emit('peerUp', { peer });
  }

  private async write(frame: Uint8Array): Promise<void> {
    const data = Array.from(frame);
    if (this.opts.mode === 'peripheral') {
      await invoke<string>('send_android_peripheral_core_frame', { data });
      return;
    }

    if (!this.opts.deviceId || !this.opts.charUuid) {
      throw new Error('BleTransport: central mode requires deviceId and charUuid');
    }

    await invoke<string>('send_core_frame_to_device', {
      request: {
        deviceId: this.opts.deviceId,
        charUuid: this.opts.charUuid,
        dstAddr: 65535,
        ttl: this.opts.ttl ?? 4,
        data,
      },
    });
  }
}
