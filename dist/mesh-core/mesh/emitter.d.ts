export type Listener<T> = (payload: T) => void;
export declare class Emitter<Events extends Record<string, unknown>> {
    private listeners;
    on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void;
    off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void;
    emit<K extends keyof Events>(event: K, payload: Events[K]): void;
}
//# sourceMappingURL=emitter.d.ts.map