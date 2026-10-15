import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const secretsDir = resolve(process.cwd(), 'secrets');
mkdirSync(secretsDir, { recursive: true });

const writeOnce = (name: string, value: string) => {
  const path = resolve(secretsDir, name);
  if (!existsSync(path)) writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
};

writeOnce('internal-hmac.b64', `${randomBytes(32).toString('base64url')}\n`);
writeOnce('access-jwt.b64', `${randomBytes(32).toString('base64url')}\n`);

for (const kid of ['ed-1', 'ed-2']) {
  const privatePath = resolve(secretsDir, `${kid}-private.pem`);
  const publicPath = resolve(secretsDir, `${kid}-public.pem`);
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
}

const envPath = resolve(process.cwd(), '.env');
if (!existsSync(envPath)) {
  const demoPassword = randomBytes(18).toString('base64url');
  writeFileSync(envPath, `NODE_ENV=development\nDEMO_USERNAME=demo\nDEMO_PASSWORD=${demoPassword}\nINTERNAL_HMAC_SECRET_FILE=secrets/internal-hmac.b64\nACCESS_JWT_SECRET_FILE=secrets/access-jwt.b64\nED25519_PRIVATE_ED1=secrets/ed-1-private.pem\nED25519_PRIVATE_ED2=secrets/ed-2-private.pem\nED25519_PUBLIC_ED1=secrets/ed-1-public.pem\nED25519_PUBLIC_ED2=secrets/ed-2-public.pem\nACCESS_TOKEN_TTL_SECONDS=120\nREFRESH_TOKEN_TTL_SECONDS=604800\nALLOWED_ORIGINS=http://127.0.0.1:3000,http://127.0.0.1:3002\n`, { flag: 'wx', mode: 0o600 });
}

console.log('Lab secrets and runtime credentials are ready in gitignored files. Existing files were preserved.');
