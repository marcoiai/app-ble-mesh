// Tiny event emitter — works in browser and Node, no deps. Used by MeshNode and
// transports so we don't pull in Node's `events` (keeps the module browser-safe).

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners[event]?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[mesh] listener for "${String(event)}" threw`, err);
      }
    });
  }
}
