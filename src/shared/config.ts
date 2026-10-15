import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const cwd = process.cwd();
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const pathValue = (name: string, fallback: string): string => {
  const value = env(name, fallback);
  return isAbsolute(value) ? value : resolve(cwd, value);
};

const secretFile = (name: string, fallback: string): Buffer => {
  const value = readFileSync(pathValue(name, fallback), 'utf8').trim();
  return Buffer.from(value, 'base64url');
};

export const config = {
  host: '127.0.0.1',
  ports: {
    supervisor: 3000,
    baselineOrder: 3001,
    secureOrder: 3002,
    baselineInventory: 5001,
    secureInventory: 5002,
  },
  dataDir: resolve(cwd, 'data'),
  evidenceDir: resolve(cwd, 'evidence'),
  username: env('DEMO_USERNAME', 'demo'),
  password: env('DEMO_PASSWORD'),
  bcryptCost: Number(env('BCRYPT_COST', '12')),
  accessTtl: Number(env('ACCESS_TOKEN_TTL_SECONDS', '120')),
  refreshTtl: Number(env('REFRESH_TOKEN_TTL_SECONDS', '604800')),
  issuer: 'block04-order-api',
  audience: 'block04-client',
  origins: env('ALLOWED_ORIGINS', 'http://127.0.0.1:3000,http://127.0.0.1:3002').split(','),
  hmacSecret: () => secretFile('INTERNAL_HMAC_SECRET_FILE', 'secrets/internal-hmac.b64'),
  jwtSecret: () => secretFile('ACCESS_JWT_SECRET_FILE', 'secrets/access-jwt.b64'),
  privateKeyPath: (kid: 'ed-1' | 'ed-2') => pathValue(
    kid === 'ed-1' ? 'ED25519_PRIVATE_ED1' : 'ED25519_PRIVATE_ED2',
    `secrets/${kid}-private.pem`,
  ),
  publicKeyPath: (kid: 'ed-1' | 'ed-2') => pathValue(
    kid === 'ed-1' ? 'ED25519_PUBLIC_ED1' : 'ED25519_PUBLIC_ED2',
    `secrets/${kid}-public.pem`,
  ),
};

export const url = (port: number, path = '') => `http://${config.host}:${port}${path}`;
