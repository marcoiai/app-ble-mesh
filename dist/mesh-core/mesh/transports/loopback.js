// ── Loopback transport ───────────────────────────────────────────────────────
// A virtual "radio" for running the whole mesh inside one process — no hardware,
// no LAN, no internet. A `LoopbackHub` models physical proximity: two transports
// are neighbours only if you `link()` them. That lets us build real multi-hop
// topologies (A—B—C, where A and C can't hear each other) and watch the router
// relay point→point→point. This is the reference transport the others mirror.
import { Emitter } from '../emitter.js';
/** Shared medium. Transports register here; `link()` makes two of them neighbours. */
export class LoopbackHub {
    constructor() {
        Object.defineProperty(this, "nodes", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        Object.defineProperty(this, "links", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        /** Simulated per-hop latency (ms). 0 = synchronous-ish (still async via queueMicrotask). */
        Object.defineProperty(this, "latencyMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        /** Drop fraction [0..1] — simulate an unreliable medium (for stress tests). */
        Object.defineProperty(this, "lossRate", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        /** Count of frames actually delivered — total network traffic (for stress tests). */
        Object.defineProperty(this, "delivered", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
    }
    register(t) {
        this.nodes.set(t.peerId, t);
        if (!this.links.has(t.peerId))
            this.links.set(t.peerId, new Set());
    }
    unregister(peerId) {
        this.nodes.delete(peerId);
        for (const peer of this.links.get(peerId) ?? [])
            this.unlink(peerId, peer);
        this.links.delete(peerId);
    }
    /** Connect two nodes as direct neighbours (bidirectional). */
    link(a, b) {
        if (a === b)
            return;
        this.edgeSet(a).add(b);
        this.edgeSet(b).add(a);
        this.nodes.get(a)?.notifyUp(b);
        this.nodes.get(b)?.notifyUp(a);
    }
    edgeSet(id) {
        let set = this.links.get(id);
        if (!set) {
            set = new Set();
            this.links.set(id, set);
        }
        return set;
    }
    /** Disconnect two neighbours. */
    unlink(a, b) {
        this.links.get(a)?.delete(b);
        this.links.get(b)?.delete(a);
        this.nodes.get(a)?.notifyDown(b);
        this.nodes.get(b)?.notifyDown(a);
    }
    neighborsOf(peerId) {
        return [...(this.links.get(peerId) ?? [])];
    }
    /** Deliver a frame from `src` to `dst` if they're linked. */
    deliver(src, dst, frame) {
        if (!this.links.get(src)?.has(dst))
            return;
        if (this.lossRate > 0 && Math.random() < this.lossRate)
            return; // dropped by the medium
        const target = this.nodes.get(dst);
        if (!target)
            return;
        this.delivered += 1;
        const fire = () => target.receive(frame, src);
        if (this.latencyMs > 0)
            setTimeout(fire, this.latencyMs);
        else
            queueMicrotask(fire);
    }
}
export class LoopbackTransport extends Emitter {
    /** `peerId` is the transport-level handle; pass the owning node's id to keep them aligned. */
    constructor(hub, peerId) {
        super();
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 'loopback'
        });
        Object.defineProperty(this, "peerId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "hub", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "started", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        this.hub = hub;
        this.peerId = peerId;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.hub.register(this);
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.hub.unregister(this.peerId);
    }
    neighbors() {
        return this.hub.neighborsOf(this.peerId);
    }
    sendTo(peer, frame) {
        this.hub.deliver(this.peerId, peer, frame);
    }
    sendAll(frame, opts) {
        for (const peer of this.neighbors()) {
            if (peer === opts?.except)
                continue;
            this.hub.deliver(this.peerId, peer, frame);
        }
    }
    // Called by the hub.
    receive(frame, from) {
        this.emit('frame', { frame, from });
    }
    notifyUp(peer) {
        this.emit('peerUp', { peer });
    }
    notifyDown(peer) {
        this.emit('peerDown', { peer });
    }
}
