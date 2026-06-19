import type { MeshService } from '../node.js';
export interface ApCandidacy {
    nodeId: string;
    label: string;
    /** Battery %, 0..100; 50 when unknown. Drains-fast hosts should not win. */
    battery: number;
    /** Direct neighbours — a well-connected node makes a better hub. */
    neighborCount: number;
    /** Whether this node's platform can actually start a hotspot (Android yes, macOS not yet). */
    canHost: boolean;
    ts: number;
}
export interface ApCredentials {
    apNodeId: string;
    ssid: string;
    pass: string;
    ts: number;
}
export interface AccessPointApi {
    /** Elected AP node id, or null when nobody can host. */
    current(): string | null;
    /** True when this node is the elected AP. */
    isSelf(): boolean;
    /** Latest credentials announced by the current AP, if any. */
    credentials(): ApCredentials | null;
    /** Everyone currently in the running (for a debug/visualiser). */
    candidates(): ApCandidacy[];
    /** Update this node's hosting fitness; re-announces + re-elects. */
    setFitness(input: {
        battery?: number;
        canHost?: boolean;
    }): void;
    /** Provide the hotspot the native layer started when this node wins (its SSID/pass). */
    onBecomeAp(fn: () => ApCredentials | Promise<ApCredentials>): void;
    /** Called with fresh credentials this node should join (when it is NOT the AP). */
    onCredentials(fn: (creds: ApCredentials) => void): void;
    /** Notified whenever the elected AP changes. Returns an unsubscribe fn. */
    onChange(fn: (apId: string | null) => void): () => void;
}
export interface AccessPointOptions {
    /** How often to re-announce our candidacy (ms). */
    announceMs?: number;
    /** A candidacy older than this is ignored and dropped (ms). */
    staleMs?: number;
    /** Whether THIS node can host a hotspot. Default false (safe; set true on Android). */
    canHost?: boolean;
}
export declare function accessPointService(opts?: AccessPointOptions): MeshService<AccessPointApi>;
//# sourceMappingURL=access-point.d.ts.map