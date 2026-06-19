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
export class ForwardStore {
    constructor(opts = {}) {
        Object.defineProperty(this, "holdMs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "capacity", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        // Insertion-ordered (Map) so eviction drops the oldest first.
        Object.defineProperty(this, "frames", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        this.holdMs = opts.holdMs ?? 300000; // 5 min
        this.capacity = opts.capacity ?? 512;
    }
    get enabled() {
        return this.holdMs > 0;
    }
    /** Hold a frame for later replay. First write wins (re-offering the same id is a no-op). */
    put(id, frame, to, now) {
        if (!this.enabled || this.frames.has(id))
            return;
        this.frames.set(id, { id, frame, to, expiresAt: now + this.holdMs });
        if (this.frames.size > this.capacity) {
            const oldest = this.frames.keys().next().value;
            if (oldest !== undefined)
                this.frames.delete(oldest);
        }
    }
    /** Drop expired frames. */
    prune(now) {
        for (const [id, f] of this.frames) {
            if (f.expiresAt <= now)
                this.frames.delete(id);
        }
    }
    /** Non-expired frames worth replaying to a peer that just appeared. */
    pending(now) {
        this.prune(now);
        return [...this.frames.values()];
    }
    size() {
        return this.frames.size;
    }
    clear() {
        this.frames.clear();
    }
}
