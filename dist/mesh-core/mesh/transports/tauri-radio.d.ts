import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface TauriRadioOptions {
    presenceMs?: number;
    peerTimeoutMs?: number;
}
export declare function tauriRadioSupported(): boolean;
export declare class TauriRadioTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "radio";
    readonly peerId: string;
    private peers;
    private presenceMs;
    private peerTimeoutMs;
    private timer;
    private unlisten;
    constructor(peerId: string, opts?: TauriRadioOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, _opts?: {
        except?: string;
    }): void;
    private onDatagram;
    private touch;
    private expire;
    private post;
}
//# sourceMappingURL=tauri-radio.d.ts.map