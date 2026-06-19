// Tiny event emitter — works in browser and Node, no deps. Used by MeshNode and
// transports so we don't pull in Node's `events` (keeps the module browser-safe).
export class Emitter {
    constructor() {
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {}
        });
    }
    on(event, fn) {
        var _a;
        ((_a = this.listeners)[event] ?? (_a[event] = new Set())).add(fn);
        return () => this.off(event, fn);
    }
    off(event, fn) {
        this.listeners[event]?.delete(fn);
    }
    emit(event, payload) {
        this.listeners[event]?.forEach((fn) => {
            try {
                fn(payload);
            }
            catch (err) {
                console.error(`[mesh] listener for "${String(event)}" threw`, err);
            }
        });
    }
}
