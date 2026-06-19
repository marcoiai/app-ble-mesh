export interface JsonTransportEnvelope {
    kind: 'compact-json';
    v: 1;
    codec: 'json';
    zip: 'gzip';
    alg: 'AES-GCM';
    kdf: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;
    iv: string;
    data: string;
    stats?: {
        jsonBytes: number;
        gzipBytes: number;
    };
}
interface JsonTransportOptions {
    passphrase: string;
    iterations?: number;
}
export declare function packJsonForTransport(value: unknown, options: JsonTransportOptions): Promise<JsonTransportEnvelope>;
export declare function unpackJsonFromTransport<T = unknown>(envelope: JsonTransportEnvelope, options: JsonTransportOptions): Promise<T>;
export {};
//# sourceMappingURL=json-transport.d.ts.map