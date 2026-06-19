import type { Envelope, NodeId } from './types.js';
export interface Route {
    via: string;
    hops: number;
    ts: number;
}
/** How to push a frame onward. */
export type ForwardPlan = {
    kind: 'flood';
    except: string | null;
} | {
    kind: 'unicast';
    via: string;
};
export interface RouteResult {
    /** Decoded envelope, when the frame was valid and not a duplicate. */
    envelope?: Envelope;
    /** Present when the frame should be delivered to local handlers. */
    deliver?: Envelope;
    /** Present when the frame should be relayed; `env` is already ttl-/path-adjusted. */
    forward?: {
        env: Envelope;
        plan: ForwardPlan;
    };
}
export interface RouterOptions {
    selfId: NodeId;
    /** "flood" (reliable, simple) or "unicast" (prefer learned routes, flood fallback). */
    mode?: 'flood' | 'unicast';
    /** Max remembered message ids for dedup. */
    seenCapacity?: number;
}
export declare class Router {
    readonly selfId: NodeId;
    private mode;
    private seenCapacity;
    private seen;
    private routes;
    private computed;
    constructor(opts: RouterOptions);
    /** Record a locally-originated message id so we ignore its echoes. */
    noteOwn(id: string): void;
    /**
     * Install the shortest-path routes the node computed from the gossiped topology graph.
     * Replaces the previous set wholesale (a destination that dropped off the graph loses
     * its computed route and falls back to reverse-path learning / flood).
     */
    setComputedRoutes(routes: Map<NodeId, Route>): void;
    /** Best known next-hop for a destination: Dijkstra first, then reverse-path learning. */
    routeFor(to: NodeId): Route | undefined;
    /** Snapshot of the effective route table (computed ∪ learned), for the connections screen. */
    routeTable(): Map<NodeId, Route>;
    /**
     * Process a frame received from `fromPeer`. Returns deliver/forward decisions;
     * the caller (MeshNode) performs the actual I/O.
     */
    handle(frame: Uint8Array, fromPeer: string, now: number): RouteResult;
    private remember;
}
//# sourceMappingURL=router.d.ts.map