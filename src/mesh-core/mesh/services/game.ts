// Game service — lobby + state/input sync over a channel `game:<id>`. Minimal
// building block for nearby multiplayer: a host announces a lobby, peers join,
// inputs and state snapshots are published to everyone in the lobby. Netcode
// (rollback, lockstep, authority) is left to the game on top — this is transport.

import type { MeshNode, MeshService } from '../node.ts';

export interface GameLobby {
  id: string;
  title: string;
  host: string;
  systemId?: string;
}

export interface GameApi {
  /** Announce a lobby and join it. */
  host(lobby: Omit<GameLobby, 'host'>): void;
  /** Join an existing lobby (announces presence on the channel). */
  join(id: string): void;
  /** Broadcast a player input to the lobby. */
  input(id: string, payload: unknown): void;
  /** Broadcast an authoritative state snapshot to the lobby. */
  state(id: string, payload: unknown): void;
  /** Receive inputs for a lobby. */
  onInput(id: string, handler: (from: string, payload: unknown) => void): () => void;
  /** Receive state snapshots for a lobby. */
  onState(id: string, handler: (from: string, payload: unknown) => void): () => void;
  /** React to lobby announcements heard on the mesh. */
  onLobby(handler: (lobby: GameLobby) => void): () => void;
}

export function gameService(): MeshService<GameApi> {
  return {
    name: 'game',
    attach(node: MeshNode): GameApi {
      return {
        host(lobbyIn) {
          const lobby: GameLobby = { ...lobbyIn, host: node.id };
          node.broadcast('game.lobby', lobby);
          node.publish(`game:${lobby.id}`, 'game.join', { from: node.id });
        },
        join(id) {
          node.publish(`game:${id}`, 'game.join', { from: node.id });
        },
        input(id, payload) {
          node.publish(`game:${id}`, 'game.input', { from: node.id, payload });
        },
        state(id, payload) {
          node.publish(`game:${id}`, 'game.state', { from: node.id, payload });
        },
        onInput(id, handler) {
          return node.subscribe(`game:${id}`, (ctx) => {
            if (ctx.type !== 'game.input') return;
            const { from, payload } = ctx.body as { from: string; payload: unknown };
            handler(from, payload);
          });
        },
        onState(id, handler) {
          return node.subscribe(`game:${id}`, (ctx) => {
            if (ctx.type !== 'game.state') return;
            const { from, payload } = ctx.body as { from: string; payload: unknown };
            handler(from, payload);
          });
        },
        onLobby(handler) {
          return node.on('game.lobby', (ctx) => handler(ctx.body as GameLobby));
        },
      };
    },
  };
}
