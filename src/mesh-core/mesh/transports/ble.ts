// ── BLE / WiFi-Direct transport (stub) ───────────────────────────────────────
// The "truest" version of the request: nearby-only radio. No internet, no LAN, no
// router — each device discovers and links to whoever is physically in range, and
// the mesh router relays onward from there. On desktop this lives behind a native
// layer (the Tauri/Rust side, or a platform plugin); in the browser, Web Bluetooth.
//
// Stub: shows the exact surface a native adapter (e.g. the one Codex is building)
// implements to drop in. `advertise()`/`scan()` map to BLE GAP; each connected
// device becomes one transport neighbour, frames ride a GATT characteristic.

import { Emitter } from '../emitter.ts';
import type { Transport, TransportEvents } from '../transport.ts';

export interface BleOptions {
  /** Service UUID nodes advertise/scan for so they only find each other. */
  serviceUuid?: string;
}

export class BleTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'ble';
  private opts: BleOptions;
  private links = new Set<string>(); // connected device handles

  constructor(opts: BleOptions = {}) {
    super();
    this.opts = opts;
  }

  start(): void {
    void this.opts; // TODO: advertise(serviceUuid) + scan(); emit peerUp/peerDown on connect/disconnect.
    throw new Error('BleTransport: requires a native adapter — not available in this environment (stub)');
  }

  stop(): void {
    this.links.clear();
  }

  neighbors(): string[] {
    return [...this.links];
  }

  sendTo(_peer: string, _frame: Uint8Array): void {
    // TODO: write _frame to the peer's GATT characteristic.
    throw new Error('BleTransport: not implemented yet (stub)');
  }

  sendAll(_frame: Uint8Array, _opts?: { except?: string }): void {
    // TODO: fan out to all connected devices, skipping _opts.except.
    throw new Error('BleTransport: not implemented yet (stub)');
  }
}
