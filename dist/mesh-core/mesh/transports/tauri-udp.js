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
import { listen } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
export function tauriUdpSupported() {
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
export class TauriUdpTransport extends Emitter {
    constructor(peerId, opts = {}) {
        super();
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'tauri-udp'
        });
        Object.defineProperty(this, "peerId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "group", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "port", {
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
        this.group = opts.group;
        this.port = opts.port;
        this.presenceMs = opts.presenceMs ?? 2000;
        this.peerTimeoutMs = opts.peerTimeoutMs ?? 6000;
    }
    async start() {
        this.unlisten = await listen('mesh-udp-datagram', (ev) => this.onDatagram(Uint8Array.from(ev.payload)));
        await invoke('mesh_udp_start', { group: this.group, port: this.port });
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
        await invoke('mesh_udp_stop').catch(() => { });
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
        void invoke('mesh_udp_send', { data: Array.from(bytes) }).catch(() => { });
    }
}
