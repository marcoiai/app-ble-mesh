// ── Shortest-path over the mesh topology ──────────────────────────────────────
// Pure, I/O-free Dijkstra on an undirected unit-cost graph (every mesh hop costs 1).
// Nodes gossip their direct neighbours in HELLO beacons, so each node can assemble a
// view of the whole topology and compute, for any destination, the FIRST hop to take
// and the total hop count. The router turns that first hop into a unicast next-hop
// instead of flooding. Same algorithm the MESH screen uses for display; kept separate
// from the live router so it stays trivially testable.
/**
 * Dijkstra from `self` over `adjacency` (node → set of neighbour node ids). Returns a
 * route for every reachable destination; unreachable nodes (and `self`) are omitted.
 * Undirected + unit cost, so this is really a BFS, but written as Dijkstra so weighted
 * links (link quality, transport cost) can drop in later without restructuring.
 */
export function shortestPaths(self, adjacency) {
    // Collect every node mentioned anywhere in the graph.
    const nodes = new Set([self]);
    for (const [node, neighbours] of adjacency) {
        nodes.add(node);
        for (const n of neighbours)
            nodes.add(n);
    }
    const dist = new Map();
    const prev = new Map();
    for (const n of nodes)
        dist.set(n, n === self ? 0 : Infinity);
    const unsettled = new Set(nodes);
    while (unsettled.size > 0) {
        // Pop the unsettled node with the smallest tentative distance.
        let u;
        let best = Infinity;
        for (const n of unsettled) {
            const d = dist.get(n);
            if (d < best) {
                best = d;
                u = n;
            }
        }
        if (u === undefined || best === Infinity)
            break; // rest is unreachable
        unsettled.delete(u);
        for (const v of adjacency.get(u) ?? []) {
            const alt = best + 1;
            if (alt < (dist.get(v) ?? Infinity)) {
                dist.set(v, alt);
                prev.set(v, u);
            }
        }
    }
    // Walk the predecessor chain back to `self` to recover the first hop of each path.
    const routes = new Map();
    for (const dest of nodes) {
        if (dest === self)
            continue;
        const d = dist.get(dest);
        if (!Number.isFinite(d))
            continue; // no path
        let cur = dest;
        let guard = 0;
        while (prev.get(cur) !== self && prev.has(cur) && guard++ < nodes.size) {
            cur = prev.get(cur);
        }
        // `cur` is now the neighbour of `self` on the shortest path (the first hop).
        if (prev.get(cur) === self || d === 1) {
            routes.set(dest, { nextHop: cur, hops: d });
        }
    }
    return routes;
}
