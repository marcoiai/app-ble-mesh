// ── Loopback transport ───────────────────────────────────────────────────────
// A virtual "radio" for running the whole mesh inside one process — no hardware,
// no LAN, no internet. A `LoopbackHub` models physical proximity: two transports
// are neighbours only if you `link()` them. That lets us build real multi-hop
// topologies (A—B—C, where A and C can't hear each other) and watch the router
// relay point→point→point. This is the reference transport the others mirror.

import { Emitter } from '../emitter.ts';
import type { Transport, TransportEvents } from '../transport.ts';

/** Shared medium. Transports register here; `link()` makes two of them neighbours. */
export class LoopbackHub {
  private nodes = new Map<string, LoopbackTransport>();
  private links = new Map<string, Set<string>>();
  /** Simulated per-hop latency (ms). 0 = synchronous-ish (still async via queueMicrotask). */
  latencyMs = 0;
  /** Drop fraction [0..1] — simulate an unreliable medium (for stress tests). */
  lossRate = 0;
  /** Count of frames actually delivered — total network traffic (for stress tests). */
  delivered = 0;

  register(t: LoopbackTransport): void {
    this.nodes.set(t.peerId, t);
    if (!this.links.has(t.peerId)) this.links.set(t.peerId, new Set());
  }

  unregister(peerId: string): void {
    this.nodes.delete(peerId);
    for (const peer of this.links.get(peerId) ?? []) this.unlink(peerId, peer);
    this.links.delete(peerId);
  }

  /** Connect two nodes as direct neighbours (bidirectional). */
  link(a: string, b: string): void {
    if (a === b) return;
    this.edgeSet(a).add(b);
    this.edgeSet(b).add(a);
    this.nodes.get(a)?.notifyUp(b);
    this.nodes.get(b)?.notifyUp(a);
  }

  private edgeSet(id: string): Set<string> {
    let set = this.links.get(id);
    if (!set) {
      set = new Set();
      this.links.set(id, set);
    }
    return set;
  }

  /** Disconnect two neighbours. */
  unlink(a: string, b: string): void {
    this.links.get(a)?.delete(b);
    this.links.get(b)?.delete(a);
    this.nodes.get(a)?.notifyDown(b);
    this.nodes.get(b)?.notifyDown(a);
  }

  neighborsOf(peerId: string): string[] {
    return [...(this.links.get(peerId) ?? [])];
  }

  /** Deliver a frame from `src` to `dst` if they're linked. */
  deliver(src: string, dst: string, frame: Uint8Array): void {
    if (!this.links.get(src)?.has(dst)) return;
    if (this.lossRate > 0 && Math.random() < this.lossRate) return; // dropped by the medium
    const target = this.nodes.get(dst);
    if (!target) return;
    this.delivered += 1;
    const fire = () => target.receive(frame, src);
    if (this.latencyMs > 0) setTimeout(fire, this.latencyMs);
    else queueMicrotask(fire);
  }
}

export class LoopbackTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'loopback';
  readonly peerId: string;
  private hub: LoopbackHub;
  private started = false;

  /** `peerId` is the transport-level handle; pass the owning node's id to keep them aligned. */
  constructor(hub: LoopbackHub, peerId: string) {
    super();
    this.hub = hub;
    this.peerId = peerId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.hub.register(this);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.hub.unregister(this.peerId);
  }

  neighbors(): string[] {
    return this.hub.neighborsOf(this.peerId);
  }

  sendTo(peer: string, frame: Uint8Array): void {
    this.hub.deliver(this.peerId, peer, frame);
  }

  sendAll(frame: Uint8Array, opts?: { except?: string }): void {
    for (const peer of this.neighbors()) {
      if (peer === opts?.except) continue;
      this.hub.deliver(this.peerId, peer, frame);
    }
  }

  // Called by the hub.
  receive(frame: Uint8Array, from: string): void {
    this.emit('frame', { frame, from });
  }
  notifyUp(peer: string): void {
    this.emit('peerUp', { peer });
  }
  notifyDown(peer: string): void {
    this.emit('peerDown', { peer });
  }
}
