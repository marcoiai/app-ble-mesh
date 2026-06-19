import type { NodeId, NodeInfo } from './types.js';
/** Generate a fresh node address (16 random bytes → 32 hex chars). */
export declare function generateNodeId(): NodeId;
/** Short, human-readable form of an id for UI/logs. */
export declare function shortId(id: NodeId): string;
/** A fun, distinct node name like "NEON-FOX-42" so each node is recognisable. */
export declare function randomLabel(): string;
export interface IdentityOptions {
    id?: NodeId;
    label?: string;
    caps?: string[];
}
/** Build a NodeInfo, generating a random id/label when not supplied. */
export declare function createIdentity(opts?: IdentityOptions): NodeInfo;
//# sourceMappingURL=identity.d.ts.map