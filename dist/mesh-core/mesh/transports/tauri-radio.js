// ── Native radio transport (seam for BLE / Wi-Fi-Direct / Multipeer) ──────────
// The browser/webview can't drive Bluetooth/Wi-Fi-Direct radios, so the real radio
// lives natively (Rust + platform APIs: btleplug for BLE, Multipeer on Apple, Wi-Fi
// Direct on Android). This adapter is the TS seam: it sends frames via `invoke`
// (mesh_radio_send) and receives them via the `mesh-radio-frame` event — exactly
// like TauriUdpTransport, so the mesh engine treats a radio like any transport.
//
// This is the OFF-GRID path with no LAN/router. Fill in the native mesh_radio_*
// commands (see src-tauri) per platform; until then start() fails gracefully and
// the node keeps running on its other transports.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
export function tauriRadioSupported() {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function frameToB64(frame) {
    let bin = '';
    frame.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
}
function b64ToFrame(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1)
        out[i] = bin.charCodeAt(i);
    return out;
}
export class TauriRadioTransport extends Emitter {
    constructor(peerId, opts = {}) {
        super();
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'radio'
        });
        Object.defineProperty(this, "peerId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "peers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "presenceMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "peerTimeoutMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "timer", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "unlisten", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        this.peerId = peerId;
        this.presenceMs = opts.presenceMs ?? 2000;
        this.peerTimeoutMs = opts.peerTimeoutMs ?? 8000;
    }
    async start() {
        this.unlisten = await listen('mesh-radio-frame', (ev) => this.onDatagram(Uint8Array.from(ev.payload)));
        // Rejects until the native radio is implemented — caller's start is resilient.
        await invoke('mesh_radio_start', { peerId: this.peerId });
        this.post({ t: 'present', from: this.peerId });
        this.timer = setInterval(() => {
            this.post({ t: 'present', from: this.peerId });
            this.expire();
        }, this.presenceMs);
    }
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        try {
            this.post({ t: 'bye', from: this.peerId });
        }
        catch { /* shutting down */ }
        if (this.unlisten)
            this.unlisten();
        this.unlisten = null;
        await invoke('mesh_radio_stop').catch(() => { });
        this.peers.clear();
    }
    neighbors() {
        return [...this.peers.keys()];
    }
    sendTo(peer, frame) {
        this.post({ t: 'frame', from: this.peerId, to: peer, data: frameToB64(frame) });
    }
    sendAll(frame, _opts) {
        this.post({ t: 'frame', from: this.peerId, data: frameToB64(frame) });
    }
    onDatagram(bytes) {
        let msg;
        try {
            msg = JSON.parse(decoder.decode(bytes));
        }
        catch {
            return;
        }
        if (!msg || msg.from === this.peerId)
            return;
        this.touch(msg.from);
        if (msg.t === 'frame') {
            if (msg.to && msg.to !== this.peerId)
                return;
            this.emit('frame', { frame: b64ToFrame(msg.data), from: msg.from });
        }
        else if (msg.t === 'bye') {
            if (this.peers.delete(msg.from))
                this.emit('peerDown', { peer: msg.from });
        }
    }
    touch(peer) {
        const known = this.peers.has(peer);
        this.peers.set(peer, Date.now());
        if (!known) {
            this.emit('peerUp', { peer });
            this.post({ t: 'present', from: this.peerId });
        }
    }
    expire() {
        const cutoff = Date.now() - this.peerTimeoutMs;
        for (const [peer, last] of this.peers) {
            if (last < cutoff) {
                this.peers.delete(peer);
                this.emit('peerDown', { peer });
            }
        }
    }
    post(wire) {
        const bytes = encoder.encode(JSON.stringify(wire));
        void invoke('mesh_radio_send', { data: Array.from(bytes) }).catch(() => { });
    }
}
