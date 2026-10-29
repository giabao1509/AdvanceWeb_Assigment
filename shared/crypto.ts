import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
export const random = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
export function equal(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value: unknown, key: string, aad: string) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [nonce, cipher.getAuthTag(), bytes].map(b => b.toString('base64url')).join('.');
}
export function decrypt<T>(value: string, key: string, aad: string): T {
  const [nonce, tag, bytes] = value.split('.').map(b => Buffer.from(b, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString());
}
