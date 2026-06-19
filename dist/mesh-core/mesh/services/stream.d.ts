import type { MeshService } from '../node.js';
export interface StreamMeta {
    id: string;
    title: string;
    host: string;
    kind: string;
}
export interface StreamChunk {
    id: string;
    seq: number;
    data: string;
}
export interface StreamPublisher {
    push(data: string): void;
    close(): void;
}
export interface StreamApi {
    /** Start broadcasting. Returns a publisher you push chunks into. */
    open(meta: Omit<StreamMeta, 'host'>): StreamPublisher;
    /** Subscribe to a stream by id. Returns an unsubscribe fn. */
    listen(id: string, handlers: {
        onChunk?: (c: StreamChunk) => void;
        onEnd?: () => void;
    }): () => void;
    /** React to stream announcements heard on the mesh (re-announced ~every 2.5s). */
    onAnnounce(handler: (meta: StreamMeta) => void): () => void;
    /** React to a stream going away (publisher closed). Lost-connection cases are
     *  handled by the consumer expiring streams that stop re-announcing. */
    onGone(handler: (id: string) => void): () => void;
}
export declare function streamService(): MeshService<StreamApi>;
//# sourceMappingURL=stream.d.ts.map