import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface BroadcastChannelOptions {
    /** Shared bus name — same name = same mesh. Default 'levelup-mesh'. */
    channelName?: string;
    /** Presence ping interval (ms). */
    presenceMs?: number;
    /** Drop a peer if unseen for this long (ms). */
    peerTimeoutMs?: number;
}
/** Available only where the BroadcastChannel API exists (browsers, Tauri webview). */
export declare function broadcastChannelSupported(): boolean;
export declare class BroadcastChannelTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "broadcast-channel";
    readonly peerId: string;
    private channelName;
    private bc;
    private peers;
    private presenceMs;
    private peerTimeoutMs;
    private timer?;
    /** `peerId` should be the owning node's id so transport handles == NodeIds. */
    constructor(peerId: string, opts?: BroadcastChannelOptions);
    start(): void;
    stop(): void;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, _opts?: {
        except?: string;
    }): void;
    private onWire;
    private touch;
    private expire;
    private post;
}
//# sourceMappingURL=broadcast-channel.d.ts.map