import type { MeshNode } from './node.js';
export interface MeshInvite {
    v: 1;
    /** Group key (becomes the node secret). */
    key: string;
    /** Optional friendly group name. */
    group?: string;
    /** Who created it (label) — shown on the Accept prompt. */
    from?: string;
}
/**
 * Create an invite to this node's private mesh. If the node isn't private yet, a
 * group key is generated and applied. Returns a blob to hand to the other side.
 */
export declare function createInvite(node: MeshNode, opts?: {
    group?: string;
}): string;
/** Decode an invite blob without applying it — for showing an Accept prompt first. */
export declare function peekInvite(blob: string): MeshInvite;
/** Accept an invite: adopt its group key so this node joins the private mesh. */
export declare function acceptInvite(node: MeshNode, blob: string): MeshInvite;
//# sourceMappingURL=invite.d.ts.map