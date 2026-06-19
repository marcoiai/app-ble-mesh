import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface TauriBleOptions {
    presenceMs?: number;
    peerTimeoutMs?: number;
}
export declare function tauriBleSupported(): boolean;
export declare class TauriBleTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "ble";
    readonly peerId: string;
    private peers;
    private presenceMs;
    private peerTimeoutMs;
    private timer;
    private unlisten;
    private unlistenNetwork;
    private sendSeq;
    private rxbuf;
    private chunkPayload;
    private restarting;
    private sendQueue;
    constructor(peerId: string, opts?: TauriBleOptions);
    start(): Promise<void>;
    private refreshPayloadSize;
    stop(): Promise<void>;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, _opts?: {
        except?: string;
    }): void;
    private onDatagram;
    private handleWire;
    private touch;
    private expire;
    private restartNative;
    private post;
    private tryInvokeSend;
    private presenceBurst;
}
//# sourceMappingURL=tauri-ble.d.ts.map