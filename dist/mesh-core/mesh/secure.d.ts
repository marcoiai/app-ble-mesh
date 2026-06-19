import { type JsonTransportEnvelope } from '../json-transport.js';
export interface SecureChannel {
    /** Encrypt a value into a transport envelope (safe to send as a message body). */
    seal(value: unknown): Promise<JsonTransportEnvelope>;
    /** Decrypt an envelope back into the original value. */
    open<T = unknown>(envelope: JsonTransportEnvelope): Promise<T>;
}
export declare function createSecureChannel(passphrase: string, iterations?: number): SecureChannel;
//# sourceMappingURL=secure.d.ts.map