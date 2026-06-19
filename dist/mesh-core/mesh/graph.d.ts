import type { NodeId } from './types.js';
export interface GraphRoute {
    /** Node id of the first hop to take from `self` toward the destination. */
    nextHop: NodeId;
    /** Total number of hops from `self` to the destination. */
    hops: number;
}
/**
 * Dijkstra from `self` over `adjacency` (node → set of neighbour node ids). Returns a
 * route for every reachable destination; unreachable nodes (and `self`) are omitted.
 * Undirected + unit cost, so this is really a BFS, but written as Dijkstra so weighted
 * links (link quality, transport cost) can drop in later without restructuring.
 */
export declare function shortestPaths(self: NodeId, adjacency: Map<NodeId, Set<NodeId>>): Map<NodeId, GraphRoute>;
//# sourceMappingURL=graph.d.ts.map