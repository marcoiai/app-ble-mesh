import type { MeshService } from '../node.js';
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
export declare function chatService(): MeshService<ChatApi>;
//# sourceMappingURL=chat.d.ts.map