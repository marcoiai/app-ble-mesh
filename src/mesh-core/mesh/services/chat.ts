// Chat service — pub/sub rooms over the mesh. Each room is a channel `chat:<room>`.

import type { MeshNode, MeshService } from '../node.ts';

export interface ChatMessage {
  id?: string;
  room: string;
  from: string;
  label: string;
  text: string;
  ts: number;
  delivery?: 'sent' | 'room' | 'direct';
}

export interface ChatApi {
  /** Listen to a room. Returns an unsubscribe fn. */
  on(room: string, handler: (msg: ChatMessage) => void): () => void;
  /** Send a line to a room (flooded to everyone subscribed in range). */
  say(room: string, text: string): ChatMessage;
}

const directType = 'chat.direct';

function messageKey(msg: ChatMessage): string {
  return msg.id ?? `${msg.room}:${msg.from}:${msg.ts}:${msg.text}`;
}

export function chatService(): MeshService<ChatApi> {
  return {
    name: 'chat',
    attach(node: MeshNode): ChatApi {
      return {
        on(room, handler) {
          const seen = new Set<string>();
          const deliver = (msg: ChatMessage, delivery: ChatMessage['delivery']) => {
            if (msg.room !== room) return;
            const key = messageKey(msg);
            if (seen.has(key)) return;
            seen.add(key);
            if (seen.size > 256) {
              const oldest = seen.values().next().value;
              if (oldest !== undefined) seen.delete(oldest);
            }
            handler({ ...msg, delivery });
          };
          const offChannel = node.subscribe(`chat:${room}`, (ctx) => deliver(ctx.body as ChatMessage, 'room'));
          const offDirect = node.on(directType, (ctx) => deliver(ctx.body as ChatMessage, 'direct'));
          return () => {
            offChannel();
            offDirect();
          };
        },
        say(room, text) {
          const msg: ChatMessage = {
            id: globalThis.crypto.randomUUID(),
            room,
            from: node.id,
            label: node.info.label,
            text,
            ts: Date.now(),
          };
          node.publish(`chat:${room}`, 'chat.say', msg);
          node.knownPeers().forEach((peer) => node.send(peer.id, directType, msg));
          return { ...msg, delivery: 'sent' };
        },
      };
    },
  };
}
