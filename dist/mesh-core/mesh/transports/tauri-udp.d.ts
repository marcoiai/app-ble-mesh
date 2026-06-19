import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface TauriUdpOptions {
    group?: string;
    port?: number;
    presenceMs?: number;
    peerTimeoutMs?: number;
}
export declare function tauriUdpSupported(): boolean;
export declare class TauriUdpTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "tauri-udp";
    readonly peerId: string;
    private group?;
    private port?;
    private peers;
    private presenceMs;
    private peerTimeoutMs;
    private timer;
    private unlisten;
    constructor(peerId: string, opts?: TauriUdpOptions);
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
//# sourceMappingURL=tauri-udp.d.ts.map