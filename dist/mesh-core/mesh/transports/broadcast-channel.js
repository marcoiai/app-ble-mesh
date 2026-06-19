// ── BroadcastChannel transport ───────────────────────────────────────────────
// A REAL transport (not the in-process sandbox) that's fully configless: open the
// app in two browser tabs/windows on the same origin and they discover each other
// and talk — no server, no LAN address to type, no handshake. The BroadcastChannel
// is a shared bus, so every tab is a direct neighbour (one broadcast domain); the
// mesh's own hello beacons + dedup handle discovery and loop safety on top.
//
// Same-origin/same-browser only. For separate machines, use the WebRTC transport.
import { Emitter } from '../emitter.js';
/** Available only where the BroadcastChannel API exists (browsers, Tauri webview). */
export function broadcastChannelSupported() {
    return typeof BroadcastChannel !== 'undefined';
}
export class BroadcastChannelTransport extends Emitter {
    /** `peerId` should be the owning node's id so transport handles == NodeIds. */
    constructor(peerId, opts = {}) {
        super();
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'broadcast-channel'
        });
        Object.defineProperty(this, "peerId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "channelName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "bc", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "peers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        }); // peerId -> lastSeen
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
            value: void 0
        });
        this.peerId = peerId;
        this.channelName = opts.channelName ?? 'levelup-mesh';
        this.presenceMs = opts.presenceMs ?? 2000;
        this.peerTimeoutMs = opts.peerTimeoutMs ?? 6000;
    }
    start() {
        if (this.bc)
            return;
        if (!broadcastChannelSupported())
            throw new Error('BroadcastChannel not supported here');
        this.bc = new BroadcastChannel(this.channelName);
        this.bc.onmessage = (ev) => this.onWire(ev.data);
        this.post({ t: 'present', from: this.peerId });
        this.timer = setInterval(() => {
            this.post({ t: 'present', from: this.peerId });
            this.expire();
        }, this.presenceMs);
    }
    stop() {
        if (!this.bc)
            return;
        this.post({ t: 'bye', from: this.peerId });
        if (this.timer)
            clearInterval(this.timer);
        this.bc.close();
        this.bc = null;
        this.peers.clear();
    }
    neighbors() {
        return [...this.peers.keys()];
    }
    sendTo(peer, frame) {
        this.post({ t: 'frame', from: this.peerId, to: peer, data: frame });
    }
    sendAll(frame, _opts) {
        // Single broadcast domain: one post reaches every other tab. `except` is a no-op
        // here — the router's dedup set makes redundant receipt harmless.
        this.post({ t: 'frame', from: this.peerId, data: frame });
    }
    onWire(msg) {
        if (!msg || typeof msg !== 'object' || msg.from === this.peerId)
            return;
        this.touch(msg.from);
        if (msg.t === 'frame') {
            if (msg.to && msg.to !== this.peerId)
                return; // unicast addressed elsewhere
            this.emit('frame', { frame: new Uint8Array(msg.data), from: msg.from });
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
            this.post({ t: 'present', from: this.peerId }); // help the newcomer find us fast
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
    post(msg) {
        this.bc?.postMessage(msg);
    }
}
