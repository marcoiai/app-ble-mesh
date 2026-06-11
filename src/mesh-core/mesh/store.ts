// ── Store-and-forward (DTN) ───────────────────────────────────────────────────
// The mesh already reconnects in *space* on its own: density means there's almost
// always another neighbour to reroute through (see the stress suite). This adds
// reconnection in *time* — a node holds recent frames and replays them to peers that
// show up later, so a message "waits in the crowd" and reaches someone who was out of
// range when it was first sent. The off-grid "some e volta": the message rides from
// pocket to pocket, across people and across minutes, until it finds its target.
//
// Safe by construction: the receiver's router dedups by message id, so replaying a
// frame someone already has is a harmless no-op. Bounded by a hold time + capacity so
// the buffer never grows without limit. Epidemic by nature (each carrier re-offers what
// it holds) — that's the resilience; the cost is some redundant offers, capped here.

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

export class ForwardStore {
  private holdMs: number;
  private capacity: number;
  // Insertion-ordered (Map) so eviction drops the oldest first.
  private frames = new Map<string, StoredFrame>();

  constructor(opts: StoreOptions = {}) {
    this.holdMs = opts.holdMs ?? 300_000; // 5 min
    this.capacity = opts.capacity ?? 512;
  }

  get enabled(): boolean {
    return this.holdMs > 0;
  }

  /** Hold a frame for later replay. First write wins (re-offering the same id is a no-op). */
  put(id: string, frame: Uint8Array, to: string | null, now: number): void {
    if (!this.enabled || this.frames.has(id)) return;
    this.frames.set(id, { id, frame, to, expiresAt: now + this.holdMs });
    if (this.frames.size > this.capacity) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }

  /** Drop expired frames. */
  prune(now: number): void {
    for (const [id, f] of this.frames) {
      if (f.expiresAt <= now) this.frames.delete(id);
    }
  }

  /** Non-expired frames worth replaying to a peer that just appeared. */
  pending(now: number): StoredFrame[] {
    this.prune(now);
    return [...this.frames.values()];
  }

  size(): number {
    return this.frames.size;
  }

  clear(): void {
    this.frames.clear();
  }
}
