// ── BLE / native byte-pipe transport ────────────────────────────────────────
// Mirrors the working Levelup contract: native BLE only moves opaque byte
// chunks and emits `mesh-ble-frame`; TypeScript owns presence, chunking,
// peer ids, routing, encryption, and delivery.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DEFAULT_PRESENCE_MS = 4000;
const DEFAULT_PEER_TIMEOUT_MS = DEFAULT_PRESENCE_MS * 3;
function frameToB64(frame) {
    let bin = '';
    frame.forEach((b) => {
        bin += String.fromCharCode(b);
    });
    return btoa(bin);
}
function b64ToFrame(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1)
        out[i] = bin.charCodeAt(i);
    return out;
}
export class BleTransport extends Emitter {
    constructor(opts = {}) {
        super();
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'ble'
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
        Object.defineProperty(this, "sendSeq", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: Math.floor(Math.random() * 0xffff)
        });
        Object.defineProperty(this, "rxbuf", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "chunkPayload", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 16
        });
        Object.defineProperty(this, "restarting", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "sendQueue", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: Promise.resolve()
        });
        this.peerId = opts.peerId ?? globalThis.crypto.randomUUID();
        this.presenceMs = opts.presenceMs ?? DEFAULT_PRESENCE_MS;
        this.peerTimeoutMs = opts.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
    }
    async start() {
        this.unlisten = await listen('mesh-ble-frame', (event) => {
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
    async stop() {
        if (this.timer)
            clearInterval(this.timer);
        try {
            this.post({ t: 'bye', from: this.peerId });
        }
        catch {
            // shutting down
        }
        this.unlisten?.();
        this.unlisten = null;
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
    refreshPayloadSize() {
        void invoke('mesh_ble_payload')
            .then((payload) => {
            const usable = Math.max(16, Math.min(508, payload - 4));
            this.chunkPayload = usable;
        })
            .catch(() => { });
    }
    onDatagram(bytes) {
        if (bytes.length < 4)
            return;
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
                if (!chunk)
                    return;
                len += chunk.length;
            }
            const full = new Uint8Array(len);
            let offset = 0;
            for (let i = 0; i < partial.total; i += 1) {
                const chunk = partial.parts.get(i);
                full.set(chunk, offset);
                offset += chunk.length;
            }
            this.handleWire(full);
        }
        if (this.rxbuf.size > 64) {
            const cutoff = Date.now() - 5000;
            for (const [key, value] of this.rxbuf) {
                if (value.ts < cutoff)
                    this.rxbuf.delete(key);
            }
        }
    }
    handleWire(bytes) {
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
            // Do not filter by the transport-level target here. BLE peripheral mode is
            // effectively a tiny shared bus: a relay node must be able to receive a
            // frame even when the final mesh destination is someone else.
            this.emit('frame', { from: msg.from, frame: b64ToFrame(msg.data) });
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
        for (const [peer, lastSeen] of this.peers) {
            if (lastSeen < cutoff) {
                this.peers.delete(peer);
                this.emit('peerDown', { peer });
            }
        }
    }
    post(wire) {
        const bytes = encoder.encode(JSON.stringify(wire));
        const total = Math.max(1, Math.ceil(bytes.length / this.chunkPayload));
        if (total > 255)
            return;
        const id = (this.sendSeq = (this.sendSeq + 1) & 0xffff);
        for (let i = 0; i < total; i += 1) {
            const slice = bytes.subarray(i * this.chunkPayload, (i + 1) * this.chunkPayload);
            const chunk = new Uint8Array(4 + slice.length);
            chunk[0] = (id >> 8) & 0xff;
            chunk[1] = id & 0xff;
            chunk[2] = i;
            chunk[3] = total;
            chunk.set(slice, 4);
            this.sendQueue = this.sendQueue
                .catch(() => undefined)
                .then(() => this.trySend(chunk));
        }
    }
    async trySend(chunk, retried = false) {
        try {
            const started = performance.now();
            const result = await invoke('mesh_ble_send', { data: Array.from(chunk) });
            const elapsedMs = Math.round(performance.now() - started);
            if (elapsedMs > 80) {
                console.debug(`[mesh ble] ${result}; js=${elapsedMs}ms bytes=${chunk.length}`);
            }
        }
        catch (err) {
            const text = String(err);
            const recoverable = text.includes('not started') ||
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
                }
                catch {
                    this.restarting = false;
                }
            }
        }
    }
    presenceBurst() {
        for (const delay of [0, 400, 900]) {
            setTimeout(() => this.post({ t: 'present', from: this.peerId }), delay);
        }
    }
}
