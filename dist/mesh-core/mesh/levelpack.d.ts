export interface LevelPackStats {
    jsonBytes: number;
    levelPackBytes: number;
    savedBytes: number;
    ratio: number;
}
export declare function levelPack(value: unknown): Uint8Array;
export declare function levelUnpack(bytes: Uint8Array): unknown;
export declare function levelPackStats(value: unknown): LevelPackStats;
export declare function jsonSize(value: unknown): number;
//# sourceMappingURL=levelpack.d.ts.map