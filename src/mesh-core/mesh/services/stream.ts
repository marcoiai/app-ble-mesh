// Stream service — chunked pub/sub broadcast over the mesh. A publisher opens a
// stream (channel `stream:<id>`) and pushes chunks; listeners subscribe and relay
// onward automatically (point→point→point), so a viewer two hops away still gets
// the feed with no central HLS host. Chunks are opaque (base64 audio/video/data) —
// wiring them into a <video> via MediaSource is the renderer's job.

import type { MeshNode, MeshService } from '../node.js';

export interface StreamMeta {
  id: string;
  title: string;
  host: string;
  kind: string; // "video" | "audio" | "data"
}

export interface StreamChunk {
  id: string; // stream id
  seq: number;
  data: string; // base64
}

export interface StreamPublisher {
  push(data: string): void;
  close(): void;
}

export interface StreamApi {
  /** Start broadcasting. Returns a publisher you push chunks into. */
  open(meta: Omit<StreamMeta, 'host'>): StreamPublisher;
  /** Subscribe to a stream by id. Returns an unsubscribe fn. */
  listen(
    id: string,
    handlers: { onChunk?: (c: StreamChunk) => void; onEnd?: () => void },
  ): () => void;
  /** React to stream announcements heard on the mesh (re-announced ~every 2.5s). */
  onAnnounce(handler: (meta: StreamMeta) => void): () => void;
  /** React to a stream going away (publisher closed). Lost-connection cases are
   *  handled by the consumer expiring streams that stop re-announcing. */
  onGone(handler: (id: string) => void): () => void;
}

const REANNOUNCE_MS = 2500;

export function streamService(): MeshService<StreamApi> {
  return {
    name: 'stream',
    attach(node: MeshNode): StreamApi {
      return {
        open(metaIn) {
          const meta: StreamMeta = { ...metaIn, host: node.id };
          node.broadcast('stream.live', meta); // announce to the mesh
          // Keep re-announcing so listeners can tell live streams from stale ones.
          const reannounce = setInterval(() => node.broadcast('stream.live', meta), REANNOUNCE_MS);
          let seq = 0;
          return {
            push: (data) =>
              node.publish(`stream:${meta.id}`, 'stream.chunk', {
                id: meta.id,
                seq: seq++,
                data,
              } satisfies StreamChunk),
            close: () => {
              clearInterval(reannounce);
              node.publish(`stream:${meta.id}`, 'stream.end', { id: meta.id });
              node.broadcast('stream.dead', { id: meta.id }); // tell the list to drop it now
            },
          };
        },
        listen(id, { onChunk, onEnd }) {
          return node.subscribe(`stream:${id}`, (ctx) => {
            if (ctx.type === 'stream.chunk') onChunk?.(ctx.body as StreamChunk);
            else if (ctx.type === 'stream.end') onEnd?.();
          });
        },
        onAnnounce(handler) {
          return node.on('stream.live', (ctx) => handler(ctx.body as StreamMeta));
        },
        onGone(handler) {
          return node.on('stream.dead', (ctx) => handler((ctx.body as { id: string }).id));
        },
      };
    },
  };
}
