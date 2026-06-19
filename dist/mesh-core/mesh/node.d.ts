import { Emitter } from './emitter.js';
import { type IdentityOptions } from './identity.js';
import { type BodyCodec } from './compress.js';
import type { Transport } from './transport.js';
import { type MessageContext, type MessageHandler, type NodeId, type NodeInfo, type PeerRecord } from './types.js';
export type MeshNodeEvents = {
    started: void;
    stopped: void;
    'peer:join': PeerRecord;
    'peer:update': PeerRecord;
    'peer:leave': PeerRecord;
    message: MessageContext;
    'request:sent': {
        corr: string;
        to: NodeId;
        type: string;
        timeoutMs: number;
    };
    'request:reply': {
        corr: string;
        from: NodeId;
        type: string;
        elapsedMs: number;
    };
    'request:timeout': {
        corr: string;
        to: NodeId;
        type: string;
        timeoutMs: number;
        elapsedMs: number;
    };
    'request:late-reply': {
        corr: string;
        from: NodeId;
        type: string;
        elapsedMs?: number;
        lateByMs?: number;
    };
};
export interface MeshNodeOptions extends IdentityOptions {
    /** Default relay budget for app messages (0 = neighbours only). */
    defaultTtl?: number;
    /**
     * Relay budget for hello beacons → how far presence travels. 0 = direct
     * neighbours only; higher values populate the mesh roster with relayed peers
     * (still distinguishable by hop count). Keep small to bound beacon flooding.
     */
    discoveryTtl?: number;
    /** Hello beacon interval (ms). */
    heartbeatMs?: number;
    /** Routing mode passed to the Router. */
    routing?: 'flood' | 'unicast';
    /** gzip app payloads on the open mesh (default: true when supported). */
    compress?: boolean;
    /** Only compress payloads at least this many bytes (default 256). */
    compressThreshold?: number;
    /**
     * Open-mesh body codec. 'auto' (default) tries gzip/lp/lpgz and picks the
     * smallest result for each message. 'gzip'/'lp'/'lpgz' forces a specific
     * codec — useful for debugging or when you need deterministic wire output.
     * Receivers always decode by the envelope's `zc` field so all options are
     * backward-compatible.
     */
    bodyCodec?: BodyCodec | 'auto';
    /**
     * Store-and-forward hold time (ms). A node keeps recent frames and replays them to
     * peers that appear later, so a message survives gaps in time ("some e volta").
     * Default 5 min; 0 disables. The receiver's dedup makes replay harmless.
     */
    storeMs?: number;
    /** Max frames held for store-and-forward (default 512). */
    storeCapacity?: number;
    /**
     * Broadcast fanout for gossip propagation. 0 (default) = classic flood: send to every
     * direct neighbour via sendAll. ≥1 = pick that many neighbours at random and unicast to
     * each. The Router's dedup LRU suppresses copies, so a small fanout (3–4) is enough to
     * cover an island while cutting application-level echoes — the win that scales the mesh
     * past a handful of nodes. Set when explicitly opting in; the default keeps current
     * behaviour everywhere. Broadcast-medium transports (BLE/UDP) still saturate the radio
     * at the same cost — gossip cuts the *upper layer* duplication, not the radio.
     */
    gossipFanout?: number;
}
export interface MeshService<API = unknown> {
    readonly name: string;
    attach(node: MeshNode): API;
    detach?(node: MeshNode): void;
}
export declare class MeshNode {
    /** Lifecycle + discovery events (peer:join/update/leave, started/stopped, message). */
    readonly events: Emitter<MeshNodeEvents>;
    readonly info: NodeInfo;
    readonly id: NodeId;
    private router;
    private store;
    private transports;
    private unsubs;
    private peerToTransport;
    private transportLastSeen;
    private transportLastHeal;
    private healingTransports;
    private handlers;
    private channels;
    private pending;
    private timedOut;
    private peers;
    private services;
    private serviceObjects;
    private defaultTtl;
    private discoveryTtl;
    private heartbeatMs;
    private compress;
    private compressThreshold;
    private bodyCodec;
    private gossipFanout;
    private heartbeat?;
    private running;
    private secure;
    private secretKey;
    constructor(opts?: MeshNodeOptions);
    addTransport(t: Transport): this;
    neighbors(): string[];
    knownPeers(): PeerRecord[];
    start(): Promise<void>;
    private startTransport;
    private selfHealTransports;
    private rearmTransport;
    stop(): Promise<void>;
    use<API>(service: MeshService<API>): API;
    service<API>(name: string): API | undefined;
    /**
     * Turn the mesh into a private/isolated one. With a passphrase set, every app
     * payload (chat, trade, stream, game) is compacted + encrypted (gzip → AES-GCM)
     * so only nodes sharing the passphrase can read it. Control traffic (hello/ping)
     * stays clear so discovery still works. Pass null to go back to the open mesh.
     */
    setSecret(passphrase: string | null): void;
    /** Whether this node is on a private (encrypted) mesh. */
    get encrypted(): boolean;
    /** Current group key (the passphrase), or null on the open mesh. */
    get groupKey(): string | null;
    /** Directed fire-and-forget message to a specific node. */
    send(to: NodeId, type: string, body: unknown): string;
    /** Flood a message to the whole reachable mesh. */
    broadcast(type: string, body: unknown): string;
    /** Publish on a pub/sub channel (delivered to every subscriber in range). */
    publish(channel: string, type: string, body: unknown): string;
    /** Subscribe to a channel. Returns an unsubscribe fn. */
    subscribe(channel: string, handler: MessageHandler): () => void;
    /** Low-level: handle every message of a given type. Returns an unsubscribe fn. */
    on(type: string, handler: MessageHandler): () => void;
    /** Request/reply across the mesh. Resolves with the reply body, or rejects on timeout. */
    request(to: NodeId, type: string, body: unknown, timeoutMs?: number): Promise<unknown>;
    /** Ping a peer — resolves with RTT in ms and the forward path taken. */
    ping(to: NodeId, timeoutMs?: number): Promise<{
        rtt: number;
        fwdPath: NodeId[];
    }>;
    private originate;
    /** Send an (already-built) envelope onward: unicast via a learned route, else flood. */
    private route;
    private onIncoming;
    private dispatch;
    private deliver;
    private sayHello;
    private rememberTimedOut;
    /** Farewell on graceful exit: tell the mesh we're leaving + hand off our neighbours. */
    private sayBye;
    /** A peer announced it's leaving: drop it immediately (skip the staleness wait). The
     * handed-off neighbour list rides in the record for graph/reconnect consumers. */
    private noteBye;
    private notePeer;
    /**
     * Rebuild the shortest-path route table from the gossiped topology and push it to the
     * router. Each peer's HELLO carries its direct neighbours, so assembling them gives a
     * view of the whole island; Dijkstra then yields the first hop toward every node. The
     * first hop is always a direct neighbour, so we resolve it to that neighbour's learned
     * transport handle (`via`). Cheap at island scale (≤6 nodes) — fine to run on each change.
     */
    private recomputeRoutes;
    private expirePeers;
    private dropPeersVia;
    /**
     * Store-and-forward capture: hold a carry-worthy frame so we can replay it to peers
     * that appear later. Skips control/transient traffic (hello, ping, replies) — those
     * make no sense to resurrect. We store the exact on-wire envelope (sealed/zipped as
     * sent), so replay is byte-identical and the receiver dedups it cleanly.
     */
    private carry;
    /** Replay held frames to a peer that just came up: broadcasts to everyone, a unicast
     * only when its destination itself is the newcomer (the mule reached the target). */
    private replayTo;
    private flood;
    private transmitTo;
}
//# sourceMappingURL=node.d.ts.map