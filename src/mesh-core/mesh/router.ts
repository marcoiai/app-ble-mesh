// ── Router: the point→point→point relay logic ────────────────────────────────
// Pure decision logic, no I/O — easy to reason about and test. Given an incoming
// frame and the neighbour it came from, it decides: deliver locally? forward on?
// and how (flood vs. unicast via a learned route).
//
// Loop/storm control: a seen-id LRU drops duplicates, TTL bounds relay distance,
// and we never echo a frame back to the neighbour it came from. Reverse-path
// learning records "to reach X, send via the neighbour I last heard X through".

import { decode } from './codec.js';
import type { Envelope, NodeId } from './types.js';

export interface Route {
  via: string; // transport neighbour handle
  hops: number;
  ts: number;
}

/** How to push a frame onward. */
export type ForwardPlan =
  | { kind: 'flood'; except: string | null }
  | { kind: 'unicast'; via: string };

export interface RouteResult {
  /** Decoded envelope, when the frame was valid and not a duplicate. */
  envelope?: Envelope;
  /** Present when the frame should be delivered to local handlers. */
  deliver?: Envelope;
  /** Present when the frame should be relayed; `env` is already ttl-/path-adjusted. */
  forward?: { env: Envelope; plan: ForwardPlan };
}

export interface RouterOptions {
  selfId: NodeId;
  /** "flood" (reliable, simple) or "unicast" (prefer learned routes, flood fallback). */
  mode?: 'flood' | 'unicast';
  /** Max remembered message ids for dedup. */
  seenCapacity?: number;
}

export class Router {
  readonly selfId: NodeId;
  private mode: 'flood' | 'unicast';
  private seenCapacity: number;
  private seen = new Set<string>();
  // Reverse-path learning: "to reach X, send via the neighbour I last heard X through".
  private routes = new Map<NodeId, Route>();
  // Dijkstra shortest-path routes, recomputed by the node from gossiped topology and
  // pushed in via setComputedRoutes(). Preferred over reverse-path when present.
  private computed = new Map<NodeId, Route>();

  constructor(opts: RouterOptions) {
    this.selfId = opts.selfId;
    this.mode = opts.mode ?? 'flood';
    this.seenCapacity = opts.seenCapacity ?? 4096;
  }

  /** Record a locally-originated message id so we ignore its echoes. */
  noteOwn(id: string): void {
    this.remember(id);
  }

  /**
   * Install the shortest-path routes the node computed from the gossiped topology graph.
   * Replaces the previous set wholesale (a destination that dropped off the graph loses
   * its computed route and falls back to reverse-path learning / flood).
   */
  setComputedRoutes(routes: Map<NodeId, Route>): void {
    this.computed = routes;
  }

  /** Best known next-hop for a destination: Dijkstra first, then reverse-path learning. */
  routeFor(to: NodeId): Route | undefined {
    return this.computed.get(to) ?? this.routes.get(to);
  }

  /** Snapshot of the effective route table (computed ∪ learned), for the connections screen. */
  routeTable(): Map<NodeId, Route> {
    const merged = new Map(this.routes);
    for (const [to, route] of this.computed) merged.set(to, route);
    return merged;
  }

  /**
   * Process a frame received from `fromPeer`. Returns deliver/forward decisions;
   * the caller (MeshNode) performs the actual I/O.
   */
  handle(frame: Uint8Array, fromPeer: string, now: number): RouteResult {
    let env: Envelope;
    try {
      env = decode(frame);
    } catch {
      return {}; // malformed — drop
    }

    if (this.seen.has(env.id)) return { envelope: env }; // duplicate — drop
    this.remember(env.id);

    // Reverse-path learning: we just heard `from` arriving via `fromPeer`.
    // path holds every node traversed including the origin, so relays = length - 1
    // (a direct neighbour's frame arrives with path = [origin] → 0 hops).
    if (env.from !== this.selfId) {
      this.routes.set(env.from, { via: fromPeer, hops: Math.max(0, env.path.length - 1), ts: now });
    }

    const forSelf = env.to === this.selfId;
    const broadcast = env.to === null || env.to === undefined;
    const result: RouteResult = { envelope: env };

    if (forSelf || broadcast) result.deliver = env;

    // Relay rules: never relay a unicast that was for us; respect TTL; avoid loops.
    const shouldRelay =
      !forSelf && env.ttl > 0 && !env.path.includes(this.selfId);

    if (shouldRelay) {
      const next: Envelope = {
        ...env,
        ttl: env.ttl - 1,
        path: [...env.path, this.selfId],
      };
      const route = broadcast ? undefined : this.routeFor(env.to as NodeId);
      const plan: ForwardPlan =
        this.mode === 'unicast' && route
          ? { kind: 'unicast', via: route.via }
          : { kind: 'flood', except: fromPeer };
      result.forward = { env: next, plan };
    }

    return result;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.seenCapacity) {
      // Set preserves insertion order — evict oldest.
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
