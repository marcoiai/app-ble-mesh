/** A frame held for later replay. We keep the exact on-wire bytes we'd have sent. */
export interface StoredFrame {
    id: string;
    frame: Uint8Array;
    /** Destination node id, or null for a broadcast (replay to everyone new). */
    to: string | null;
    expiresAt: number;
}
export interface StoreOptions {
    /** How long to hold a frame for replay (ms). 0 disables store-and-forward. */
    holdMs?: number;
    /** Max frames held; oldest evicted past this. */
    capacity?: number;
}
export declare class ForwardStore {
    private holdMs;
    private capacity;
    private frames;
    constructor(opts?: StoreOptions);
    get enabled(): boolean;
    /** Hold a frame for later replay. First write wins (re-offering the same id is a no-op). */
    put(id: string, frame: Uint8Array, to: string | null, now: number): void;
    /** Drop expired frames. */
    prune(now: number): void;
    /** Non-expired frames worth replaying to a peer that just appeared. */
    pending(now: number): StoredFrame[];
    size(): number;
    clear(): void;
}
//# sourceMappingURL=store.d.ts.map