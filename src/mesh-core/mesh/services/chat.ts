// Chat service — pub/sub rooms over the mesh. Each room is a channel `chat:<room>`.

import type { MeshNode, MeshService } from '../node.js';

export interface ChatMessage {
  room: string;
  from: string;
  label: string;
  text: string;
  ts: number;
}

export interface ChatApi {
  /** Listen to a room. Returns an unsubscribe fn. */
  on(room: string, handler: (msg: ChatMessage) => void): () => void;
  /** Send a line to a room (flooded to everyone subscribed in range). */
  say(room: string, text: string): void;
}

export function chatService(): MeshService<ChatApi> {
  return {
    name: 'chat',
    attach(node: MeshNode): ChatApi {
      return {
        on(room, handler) {
          return node.subscribe(`chat:${room}`, (ctx) => handler(ctx.body as ChatMessage));
        },
        say(room, text) {
          const msg: ChatMessage = {
            room,
            from: node.id,
            label: node.info.label,
            text,
            ts: Date.now(),
          };
          node.publish(`chat:${room}`, 'chat.say', msg);
        },
      };
    },
  };
}
