import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
/** Shared medium. Transports register here; `link()` makes two of them neighbours. */
export declare class LoopbackHub {
    private nodes;
    private links;
    /** Simulated per-hop latency (ms). 0 = synchronous-ish (still async via queueMicrotask). */
    latencyMs: number;
    /** Drop fraction [0..1] — simulate an unreliable medium (for stress tests). */
    lossRate: number;
    /** Count of frames actually delivered — total network traffic (for stress tests). */
    delivered: number;
    register(t: LoopbackTransport): void;
    unregister(peerId: string): void;
    /** Connect two nodes as direct neighbours (bidirectional). */
    link(a: string, b: string): void;
    private edgeSet;
    /** Disconnect two neighbours. */
    unlink(a: string, b: string): void;
    neighborsOf(peerId: string): string[];
    /** Deliver a frame from `src` to `dst` if they're linked. */
    deliver(src: string, dst: string, frame: Uint8Array): void;
}
export declare class LoopbackTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "loopback";
    readonly peerId: string;
    private hub;
    private started;
    /** `peerId` is the transport-level handle; pass the owning node's id to keep them aligned. */
    constructor(hub: LoopbackHub, peerId: string);
    start(): void;
    stop(): void;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, opts?: {
        except?: string;
    }): void;
    receive(frame: Uint8Array, from: string): void;
    notifyUp(peer: string): void;
    notifyDown(peer: string): void;
}
//# sourceMappingURL=loopback.d.ts.map