export const LEVELUP_MESH_FRAME_KIND = 'levelup.mesh.frame.v1';
export const LEVELUP_MESH_MAX_NODES = 6;
export const LEVELUP_MESH_STALE_MS = 9500;

export type LevelupMeshFrameType = 'pulse' | 'delta' | 'burst';
export type LevelupMeshTransport = 'xmpp-muc' | 'wifi-direct' | 'udp-lan' | 'ble-small' | 'store-forward';

export interface LevelupMeshNeighbor {
  nodeId: string;
  cost: number;
}

export interface LevelupMeshFrame {
  kind: typeof LEVELUP_MESH_FRAME_KIND;
  v: 1;
  frameType: LevelupMeshFrameType;
  sourceNodeId: string;
  targetNodeId?: string;
  seq: number;
  sentAt: number;
  ttl: number;
  hopCount: number;
  transport: LevelupMeshTransport;
  stateHash: string;
  capabilities: string[];
  neighbors: LevelupMeshNeighbor[];
  payload?: unknown;
}

export interface LevelupMeshPeer {
  nodeId: string;
  status: 'online' | 'stale';
  transport: LevelupMeshTransport;
  stateHash: string;
  capabilities: string[];
  neighbors: LevelupMeshNeighbor[];
  lastSeenAt: number;
  lastSeenMsAgo: number;
  seq: number;
  route?: {
    nextHop: string;
    cost: number;
    hops: string[];
  };
}

export interface LevelupMeshSnapshot {
  nodeId: string;
  maxNodes: number;
  peers: LevelupMeshPeer[];
  onlineCount: number;
  updatedAt: number;
}

export function hashLevelupMeshState(value: unknown) {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeLevelupMeshPulse(input: {
  nodeId: string;
  seq: number;
  transport: LevelupMeshTransport;
  stateHash: string;
  capabilities: string[];
  neighbors?: LevelupMeshNeighbor[];
}): LevelupMeshFrame {
  return {
    kind: LEVELUP_MESH_FRAME_KIND,
    v: 1,
    frameType: 'pulse',
    sourceNodeId: input.nodeId,
    seq: input.seq,
    sentAt: Date.now(),
    ttl: 4,
    hopCount: 0,
    transport: input.transport,
    stateHash: input.stateHash,
    capabilities: input.capabilities,
    neighbors: normalizeNeighbors(input.neighbors ?? []),
  };
}

export function parseLevelupMeshFrame(text: string): LevelupMeshFrame | null {
  if (!text.includes(LEVELUP_MESH_FRAME_KIND)) return null;
  try {
    const parsed = JSON.parse(text) as Partial<LevelupMeshFrame>;
    if (parsed.kind !== LEVELUP_MESH_FRAME_KIND || parsed.v !== 1) return null;
    if (parsed.frameType !== 'pulse' && parsed.frameType !== 'delta' && parsed.frameType !== 'burst') return null;
    if (!parsed.sourceNodeId || typeof parsed.sourceNodeId !== 'string') return null;
    return {
      kind: LEVELUP_MESH_FRAME_KIND,
      v: 1,
      frameType: parsed.frameType,
      sourceNodeId: parsed.sourceNodeId,
      targetNodeId: typeof parsed.targetNodeId === 'string' ? parsed.targetNodeId : undefined,
      seq: sanitizeInteger(parsed.seq, 0, Number.MAX_SAFE_INTEGER, 0),
      sentAt: sanitizeInteger(parsed.sentAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      ttl: sanitizeInteger(parsed.ttl, 1, 16, 4),
      hopCount: sanitizeInteger(parsed.hopCount, 0, 16, 0),
      transport: normalizeTransport(parsed.transport),
      stateHash: typeof parsed.stateHash === 'string' ? parsed.stateHash.slice(0, 32) : 'unknown',
      capabilities: Array.isArray(parsed.capabilities)
        ? parsed.capabilities.filter((item): item is string => typeof item === 'string').slice(0, 12)
        : [],
      neighbors: normalizeNeighbors(Array.isArray(parsed.neighbors) ? parsed.neighbors : []),
      payload: parsed.payload,
    };
  } catch {
    return null;
  }
}

export function buildLevelupMeshSnapshot(
  localNodeId: string,
  peers: Iterable<LevelupMeshPeer>,
  now = Date.now(),
): LevelupMeshSnapshot {
  const cappedPeers = Array.from(peers)
    .filter((peer) => peer.nodeId !== localNodeId)
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, LEVELUP_MESH_MAX_NODES - 1)
    .map((peer) => ({
      ...peer,
      lastSeenMsAgo: Math.max(0, now - peer.lastSeenAt),
      status: now - peer.lastSeenAt <= LEVELUP_MESH_STALE_MS ? 'online' as const : 'stale' as const,
    }));

  const routes = shortestRoutes(localNodeId, cappedPeers);
  const peersWithRoutes = cappedPeers.map((peer) => ({
    ...peer,
    route: routes.get(peer.nodeId),
  }));

  return {
    nodeId: localNodeId,
    maxNodes: LEVELUP_MESH_MAX_NODES,
    peers: peersWithRoutes,
    onlineCount: peersWithRoutes.filter((peer) => peer.status === 'online').length,
    updatedAt: now,
  };
}

function shortestRoutes(localNodeId: string, peers: LevelupMeshPeer[]) {
  const nodes = new Set<string>([localNodeId]);
  const graph = new Map<string, LevelupMeshNeighbor[]>();
  const addEdge = (from: string, to: string, cost: number) => {
    if (!from || !to || from === to) return;
    nodes.add(from);
    nodes.add(to);
    const safeCost = sanitizeInteger(cost, 1, 99, 1);
    graph.set(from, [...(graph.get(from) ?? []), { nodeId: to, cost: safeCost }]);
    graph.set(to, [...(graph.get(to) ?? []), { nodeId: from, cost: safeCost }]);
  };

  peers.forEach((peer) => {
    // A direct local↔peer link exists only when the peer is online AND actually
    // lists us as a neighbour (mutual adjacency). When a peer reports no neighbour
    // data we fall back to the original "online ⇒ direct" assumption. This stops a
    // relayed (multi-hop) peer from being treated as a direct cost-1 neighbour.
    const claimsLocal = peer.neighbors.some((neighbor) => neighbor.nodeId === localNodeId);
    if (peer.status === 'online' && (peer.neighbors.length === 0 || claimsLocal)) {
      addEdge(localNodeId, peer.nodeId, 1);
    }
    peer.neighbors.forEach((neighbor) => addEdge(peer.nodeId, neighbor.nodeId, neighbor.cost));
  });

  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  nodes.forEach((node) => distances.set(node, node === localNodeId ? 0 : Number.POSITIVE_INFINITY));

  const unsettled = new Set(nodes);
  while (unsettled.size > 0) {
    const current = Array.from(unsettled).sort((a, b) => (distances.get(a) ?? Infinity) - (distances.get(b) ?? Infinity))[0];
    unsettled.delete(current);
    const currentDistance = distances.get(current) ?? Infinity;
    if (!Number.isFinite(currentDistance)) continue;
    (graph.get(current) ?? []).forEach((edge) => {
      const nextDistance = currentDistance + edge.cost;
      if (nextDistance < (distances.get(edge.nodeId) ?? Infinity)) {
        distances.set(edge.nodeId, nextDistance);
        previous.set(edge.nodeId, current);
      }
    });
  }

  const routes = new Map<string, NonNullable<LevelupMeshPeer['route']>>();
  peers.forEach((peer) => {
    const cost = distances.get(peer.nodeId);
    if (!cost || !Number.isFinite(cost)) return;
    const hops = [peer.nodeId];
    let cursor = peer.nodeId;
    while (previous.has(cursor)) {
      cursor = previous.get(cursor)!;
      hops.unshift(cursor);
      if (cursor === localNodeId) break;
    }
    routes.set(peer.nodeId, {
      nextHop: hops[1] ?? peer.nodeId,
      cost,
      hops,
    });
  });
  return routes;
}

function normalizeTransport(value: unknown): LevelupMeshTransport {
  return value === 'wifi-direct' || value === 'udp-lan' || value === 'ble-small' || value === 'store-forward'
    ? value
    : 'xmpp-muc';
}

function normalizeNeighbors(value: unknown[]): LevelupMeshNeighbor[] {
  return value
    .map((item) => {
      const candidate = item as Partial<LevelupMeshNeighbor>;
      return {
        nodeId: typeof candidate.nodeId === 'string' ? candidate.nodeId.trim() : '',
        cost: sanitizeInteger(candidate.cost, 1, 99, 1),
      };
    })
    .filter((item) => item.nodeId.length > 0)
    .slice(0, LEVELUP_MESH_MAX_NODES - 1);
}

function sanitizeInteger(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
