// Canonical Level Pack secure channel. Legacy compact-json remains readable.
import {
  packLevelPackForTransport,
  unpackLevelPackFromTransport,
  unpackJsonFromTransport,
  type SecureTransportEnvelope,
} from '../json-transport.js';

export interface SecureChannel {
  seal(value: unknown): Promise<SecureTransportEnvelope>;
  open<T = unknown>(envelope: SecureTransportEnvelope): Promise<T>;
}

export function createSecureChannel(passphrase: string, iterations?: number): SecureChannel {
  const options = { passphrase, iterations };
  return {
    seal: (value) => packLevelPackForTransport(value, options),
    open: <T>(envelope: SecureTransportEnvelope) => {
      if (envelope.kind === 'level-pack') return unpackLevelPackFromTransport<T>(envelope, options);
      if (envelope.kind === 'compact-json') return unpackJsonFromTransport<T>(envelope, options);
      return Promise.reject(new Error('secure_envelope_unsupported'));
    },
  };
}
