export declare const LEVELUP_MESH_FRAME_KIND = "levelup.mesh.frame.v1";
export declare const LEVELUP_MESH_MAX_NODES = 6;
export declare const LEVELUP_MESH_STALE_MS = 9500;
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
export declare function hashLevelupMeshState(value: unknown): string;
export declare function makeLevelupMeshPulse(input: {
    nodeId: string;
    seq: number;
    transport: LevelupMeshTransport;
    stateHash: string;
    capabilities: string[];
    neighbors?: LevelupMeshNeighbor[];
}): LevelupMeshFrame;
export declare function parseLevelupMeshFrame(text: string): LevelupMeshFrame | null;
export declare function buildLevelupMeshSnapshot(localNodeId: string, peers: Iterable<LevelupMeshPeer>, now?: number): LevelupMeshSnapshot;
//# sourceMappingURL=levelup-mesh.d.ts.map