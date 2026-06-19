import type { MeshService } from '../node.js';
import type { NodeId } from '../types.js';
export interface TradeObject {
    id: string;
    kind: string;
    name: string;
    meta?: Record<string, unknown>;
    /** Optional payload (base64 for binary). Omitted in list responses. */
    data?: string;
}
export type TradeListing = Omit<TradeObject, 'data'>;
export interface TradeApi {
    /** Make an object available to peers. */
    offer(obj: TradeObject): void;
    /** Stop offering an object. */
    withdraw(id: string): void;
    /** What this node currently offers. */
    catalog(): TradeListing[];
    /** Ask a peer for its catalog. */
    list(peer: NodeId): Promise<TradeListing[]>;
    /** Fetch one object (with data) from a peer. */
    fetch(peer: NodeId, id: string): Promise<TradeObject | null>;
}
export declare function tradeService(): MeshService<TradeApi>;
//# sourceMappingURL=trade.d.ts.map