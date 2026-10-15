import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ReservationInput } from './contracts.js';

export type SigningAlgorithm = 'hmac-sha256' | 'ed25519';

export interface SignatureParts {
  algorithm: SigningAlgorithm;
  kid: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export const canonicalBody = (body: ReservationInput): string => JSON.stringify({
  sku: body.sku,
  quantity: body.quantity,
  orderId: body.orderId,
});

export const bodyHash = (body: ReservationInput): string =>
  createHash('sha256').update(canonicalBody(body), 'utf8').digest('hex');

export const canonicalRequest = (body: ReservationInput, parts: Omit<SignatureParts, 'signature'>): string => [
  'v1',
  'POST',
  '/internal/reservations',
  parts.algorithm,
  parts.kid,
  parts.timestamp,
  parts.nonce,
  bodyHash(body),
].join('\n');

export const signHmac = (canonical: string, key: Buffer): string =>
  createHmac('sha256', key).update(canonical, 'utf8').digest('base64url');

export const verifyHmac = (canonical: string, signature: string, key: Buffer): boolean => {
  try {
    const expected = Buffer.from(signHmac(canonical, key), 'base64url');
    const received = Buffer.from(signature, 'base64url');
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
};

export const loadPrivateKey = (path: string): KeyObject => createPrivateKey(readFileSync(path));
export const loadPublicKey = (path: string): KeyObject => createPublicKey(readFileSync(path));

export const signEd25519 = (canonical: string, key: KeyObject): string =>
  sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64url');

export const verifyEd25519 = (canonical: string, signature: string, key: KeyObject): boolean => {
  try {
    return verify(null, Buffer.from(canonical, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
};

export const createSignature = (
  body: ReservationInput,
  algorithm: SigningAlgorithm,
  kid: string,
  key: Buffer | KeyObject,
  overrides: Partial<Pick<SignatureParts, 'timestamp' | 'nonce'>> = {},
): SignatureParts => {
  const unsigned = {
    algorithm,
    kid,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    nonce: overrides.nonce ?? randomUUID(),
  };
  const canonical = canonicalRequest(body, unsigned);
  const signature = algorithm === 'hmac-sha256'
    ? signHmac(canonical, key as Buffer)
    : signEd25519(canonical, key as KeyObject);
  return { ...unsigned, signature };
};

export const signatureHeaders = (parts: SignatureParts): Record<string, string> => ({
  'x-auth-version': 'v1',
  'x-signature-alg': parts.algorithm,
  'x-key-id': parts.kid,
  'x-timestamp': parts.timestamp,
  'x-nonce': parts.nonce,
  'x-signature': parts.signature,
});
