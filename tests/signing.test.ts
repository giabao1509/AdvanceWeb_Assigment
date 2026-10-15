import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { canonicalBody, canonicalRequest, createSignature, verifyHmac } from '../src/shared/signing.js';

describe('request signing contract', () => {
  const body = { sku: 'SKU-001', quantity: 2, orderId: 'order-test' };

  it('serializes signed business fields in a fixed order', () => {
    expect(canonicalBody(body)).toBe('{"sku":"SKU-001","quantity":2,"orderId":"order-test"}');
  });

  it('does not append a newline to the canonical request', () => {
    const value = canonicalRequest(body, {
      algorithm: 'hmac-sha256', kid: 'hmac-lab-1', timestamp: '100', nonce: '00000000-0000-4000-8000-000000000000',
    });
    expect(value.split('\n')).toHaveLength(8);
    expect(value.endsWith('\n')).toBe(false);
  });

  it('accepts the original HMAC and rejects a changed body', () => {
    const key = randomBytes(32);
    const parts = createSignature(body, 'hmac-sha256', 'hmac-lab-1', key);
    expect(verifyHmac(canonicalRequest(body, parts), parts.signature, key)).toBe(true);
    expect(verifyHmac(canonicalRequest({ ...body, quantity: 3 }, parts), parts.signature, key)).toBe(false);
  });
});
