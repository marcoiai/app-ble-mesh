import type { MeshService } from '../node.js';
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
export declare function gameService(): MeshService<GameApi>;
//# sourceMappingURL=game.d.ts.map