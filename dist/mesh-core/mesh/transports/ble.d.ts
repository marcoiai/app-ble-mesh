import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface BleOptions {
    peerId?: string;
    presenceMs?: number;
    peerTimeoutMs?: number;
}
export declare class BleTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "ble";
    readonly peerId: string;
    private peers;
    private presenceMs;
    private peerTimeoutMs;
    private timer;
    private unlisten;
    private sendSeq;
    private rxbuf;
    private chunkPayload;
    private restarting;
    private sendQueue;
    constructor(opts?: BleOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, _opts?: {
        except?: string;
    }): void;
    private refreshPayloadSize;
    private onDatagram;
    private handleWire;
    private touch;
    private expire;
    private post;
    private trySend;
    private presenceBurst;
}
//# sourceMappingURL=ble.d.ts.map