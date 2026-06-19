import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';
export interface WebRtcOptions {
    /** STUN/TURN servers. Empty (default) = host/mDNS only (same-LAN, offline-friendly). */
    iceServers?: RTCIceServer[];
    /** Max ms to wait for ICE gathering before emitting the blob. */
    iceTimeoutMs?: number;
}
export declare function webRtcSupported(): boolean;
export declare class WebRtcTransport extends Emitter<TransportEvents> implements Transport {
    readonly name = "webrtc";
    private localNodeId;
    private iceServers;
    private iceTimeoutMs;
    private channels;
    private pcs;
    private pendingInitiator;
    constructor(localNodeId: string, opts?: WebRtcOptions);
    start(): void;
    stop(): void;
    neighbors(): string[];
    sendTo(peer: string, frame: Uint8Array): void;
    sendAll(frame: Uint8Array, opts?: {
        except?: string;
    }): void;
    /** HOST step 1: create an invite blob to hand to the other machine. */
    createInvite(): Promise<string>;
    /** GUEST: paste the host's invite, get back an answer blob to send to the host. */
    acceptInvite(inviteText: string): Promise<string>;
    /** HOST step 2: paste the guest's answer to finish the connection. */
    completeInvite(answerText: string): Promise<void>;
    private newPc;
    private bindChannel;
    /** Resolve once ICE gathering completes (or after a timeout) so the blob is self-contained. */
    private waitForIce;
}
//# sourceMappingURL=webrtc.d.ts.map