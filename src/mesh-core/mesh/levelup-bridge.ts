// ── Bridge: my MeshNode → Codex's levelup-mesh snapshot/routing model ─────────
// Codex's `levelup-mesh.ts` is a pure presence + Dijkstra shortest-path model;
// my MeshNode produces live presence (PeerRecords incl. each peer's gossiped
// neighbours). This adapter feeds one into the other, so the MESH screen can show
// Codex's computed routes (nextHop / cost / hop path) over the real running mesh.

import type { MeshNode } from './node.ts';
import {
  buildLevelupMeshSnapshot,
  type LevelupMeshPeer,
  type LevelupMeshSnapshot,
  type LevelupMeshTransport,
} from '../levelup-mesh.ts';

/** Map a live MeshNode's known peers into a Codex mesh snapshot (with routes). */
export function toLevelupSnapshot(
  node: MeshNode,
  transport: LevelupMeshTransport = 'store-forward',
  now = Date.now(),
): LevelupMeshSnapshot {
  const peers: LevelupMeshPeer[] = node.knownPeers().map((p) => ({
    nodeId: p.id,
    status: 'online', // recomputed from lastSeenAt inside buildLevelupMeshSnapshot
    transport,
    stateHash: 'live',
    capabilities: p.caps,
    neighbors: p.neighbors.map((n) => ({ nodeId: n, cost: 1 })),
    lastSeenAt: p.lastSeen,
    lastSeenMsAgo: Math.max(0, now - p.lastSeen),
    seq: 0,
  }));
  return buildLevelupMeshSnapshot(node.id, peers, now);
}
