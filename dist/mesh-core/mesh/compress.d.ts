export declare function compressionSupported(): boolean;
/**
 * Body codecs for the OPEN-mesh `zip` slot. The envelope's `zip:true` means
 * "body is compressed"; `zc` says HOW. Absent `zc` == 'gzip' so frames from
 * nodes that predate this stay readable.
 *  - 'gzip'  : JSON → gzip (the original; unchanged on the wire)
 *  - 'lp'    : levelpack bytecode only (best for small bodies where gzip's
 *              ~18B wrapper would cost more than it saves)
 *  - 'lpgz'  : levelpack bytecode → gzip (best when the body still has bulk)
 */
export type BodyCodec = 'gzip' | 'lp' | 'lpgz';
/** gzip a value → base64 string. */
export declare function gzipValue(value: unknown): Promise<string>;
/** Reverse of gzipValue. */
export declare function gunzipValue<T = unknown>(b64: string): Promise<T>;
/** Compress a body with the chosen codec → base64 string. */
export declare function packBody(value: unknown, codec?: BodyCodec): Promise<string>;
/** Reverse of packBody for the codec the envelope declared (`zc`, default gzip). */
export declare function unpackBody<T = unknown>(b64: string, codec?: BodyCodec): Promise<T>;
/** Smallest codec for a body: tries each, returns the winner (id + base64). */
export declare function packBodySmallest(value: unknown, codecs?: BodyCodec[]): Promise<{
    codec: BodyCodec;
    data: string;
}>;
/** Rough encoded size of a value, to decide whether compressing is worth it. */
export declare function encodedSize(value: unknown): number;
//# sourceMappingURL=compress.d.ts.map