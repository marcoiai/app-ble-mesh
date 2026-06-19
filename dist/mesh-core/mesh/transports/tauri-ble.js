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
import { listen } from '@tauri-apps/api/event';
import { Emitter } from '../emitter.js';
export function tauriBleSupported() {
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
export class TauriBleTransport extends Emitter {
    constructor(peerId, opts = {}) {
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
        Object.defineProperty(this, "unlistenNetwork", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        // BLE notify/write is capped at the negotiated ATT MTU. Start at the 23-byte-floor
        // payload (16B after our 4B header) and upgrade once native reports real capacity.
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
        this.peerId = peerId;
        this.presenceMs = opts.presenceMs ?? 2000;
        this.peerTimeoutMs = opts.peerTimeoutMs ?? 8000;
    }
    async start() {
        this.unlisten = await listen('mesh-ble-frame', (ev) => this.onDatagram(Uint8Array.from(ev.payload)));
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
    refreshPayloadSize() {
        void invoke('mesh_ble_payload')
            .then((p) => {
            const usable = Math.max(16, Math.min(508, p - 4));
            if (usable !== this.chunkPayload) {
                console.info(`[mesh-ble] chunk payload ${this.chunkPayload} -> ${usable} bytes`);
                this.chunkPayload = usable;
            }
        })
            .catch(() => { });
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
        if (this.unlistenNetwork)
            this.unlistenNetwork();
        this.unlisten = null;
        this.unlistenNetwork = null;
        await invoke('mesh_ble_stop').catch(() => { });
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
    // Inbound chunk: [idHi, idLo, idx, total, ...payload]. Reassemble, then handle the wire.
    onDatagram(bytes) {
        if (bytes.length < 4)
            return;
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
                if (!p)
                    return; // missing fragment — drop the message
                len += p.length;
            }
            const full = new Uint8Array(len);
            let off = 0;
            for (let i = 0; i < buf.total; i += 1) {
                const p = buf.parts.get(i);
                full.set(p, off);
                off += p.length;
            }
            this.handleWire(full);
        }
        // Drop stale partials (lost fragments) so the buffer can't grow unbounded.
        if (this.rxbuf.size > 64) {
            const cutoff = Date.now() - 5000;
            for (const [k, v] of this.rxbuf)
                if (v.t < cutoff)
                    this.rxbuf.delete(k);
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
            // BLE peripheral mode behaves like a tiny shared bus. Let the mesh router see
            // frames even when this node is an intermediate hop, otherwise Droid-central
            // relay topologies drop unicast traffic before routing can forward it.
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
    async restartNative(reason) {
        if (this.restarting)
            return;
        this.restarting = true;
        try {
            console.warn(`[mesh-ble] ${reason} — rearming central links`);
            await invoke('mesh_ble_recover').catch(() => { });
            await new Promise((resolve) => setTimeout(resolve, 250));
            await invoke('mesh_ble_start');
            this.presenceBurst();
        }
        catch (err) {
            console.error('[mesh-ble] native restart failed', err);
        }
        finally {
            this.restarting = false;
        }
    }
    // Outbound: fragment by negotiated link capacity, floor 16.
    post(wire) {
        const bytes = encoder.encode(JSON.stringify(wire));
        const PAYLOAD = this.chunkPayload;
        const total = Math.max(1, Math.ceil(bytes.length / PAYLOAD));
        if (total > 255)
            return;
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
    async tryInvokeSend(chunk, retried = false) {
        try {
            await invoke('mesh_ble_send', { data: Array.from(chunk) });
        }
        catch (e) {
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
    presenceBurst() {
        for (const delay of [0, 500, 1000]) {
            setTimeout(() => this.post({ t: 'present', from: this.peerId }), delay);
        }
    }
}
