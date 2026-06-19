// Trade service — request/reply object exchange. A node "offers" objects locally;
// peers can list a node's catalog and fetch a specific object across the mesh.
// "Objects" are anything: ROM blobs, save states, items, cards. Binary rides as
// base64 in `data` for the JSON MVP codec.

import type { MeshNode, MeshService } from '../node.js';
import type { NodeId } from '../types.js';

export interface TradeObject {
  id: string;
  kind: string; // "rom" | "save" | "item" | …
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

export function tradeService(): MeshService<TradeApi> {
  const store = new Map<string, TradeObject>();

  return {
    name: 'trade',
    attach(node: MeshNode): TradeApi {
      const listing = (): TradeListing[] =>
        [...store.values()].map(({ data: _data, ...rest }) => rest);

      // Answer catalog + object requests from peers.
      node.on('trade.list', (ctx) => ctx.reply(listing()));
      node.on('trade.get', (ctx) => {
        const { id } = (ctx.body as { id: string }) ?? { id: '' };
        ctx.reply(store.get(id) ?? null);
      });

      return {
        offer: (obj) => void store.set(obj.id, obj),
        withdraw: (id) => void store.delete(id),
        catalog: listing,
        list: (peer) => node.request(peer, 'trade.list', {}) as Promise<TradeListing[]>,
        fetch: (peer, id) =>
          node.request(peer, 'trade.get', { id }) as Promise<TradeObject | null>,
      };
    },
  };
}
