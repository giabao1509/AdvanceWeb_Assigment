import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPair, exportJWK } from 'jose';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { config, dataRoot, scopes, type Mode } from '../shared/config.js';
import { random } from '../shared/crypto.js';
import { database, commonSchema } from '../shared/db.js';

export async function setup() {
  for (const mode of ['baseline', 'secure'] as Mode[]) {
    const dir = resolve(dataRoot, mode); mkdirSync(dir, { recursive: true });
    if (!existsSync(resolve(dir, 'config.json'))) {
      const pair = await generateKeyPair('ES256', { extractable: true }); const kid = random();
      writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ kid, privateJwk: await exportJWK(pair.privateKey),
        publicJwk: { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' },
        clients: { 'taxi-web': random(), 'taxi-m2m': random() }, vaultKey: randomBytes(32).toString('hex'),
        alicePassword: 'Alice-demo-2026!', bobPassword: 'Bob-demo-2026!' }, null, 2), { mode: 0o600 });
    }
    const c = config(mode), as = database(c, 'as');
    as.exec(commonSchema + `
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, redirect_uri TEXT, grants TEXT NOT NULL, scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_requests(id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, params TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, scope TEXT NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS auth_codes(code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, consent_id TEXT NOT NULL, grant_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_families(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, consent_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS refresh_tokens(token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES refresh_families(id), client_id TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER, replaced_by TEXT);
      CREATE TABLE IF NOT EXISTS issued_tokens(jti TEXT PRIMARY KEY, grant_id TEXT NOT NULL, family_id TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_trace_steps(id INTEGER PRIMARY KEY AUTOINCREMENT,trace_id TEXT NOT NULL,detail TEXT NOT NULL);
    `);
    for (const [id, password] of [['alice', c.alicePassword], ['bob', c.bobPassword]]) {
      if (!as.prepare('SELECT id FROM users WHERE id=?').get(id)) as.prepare('INSERT INTO users VALUES(?,?)').run(id, await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }));
    }
    for (const id of ['taxi-web', 'taxi-m2m']) {
      const grants = id === 'taxi-web' ? 'authorization_code refresh_token' : 'client_credentials';
      as.prepare('INSERT INTO clients VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET redirect_uri=excluded.redirect_uri')
        .run(id, await argon2.hash(c.clients[id], { type: argon2.argon2id }), id === 'taxi-web' ? `${c.taxi}/oauth/callback` : null, grants, id === 'taxi-web' ? scopes.join(' ') : 'rates:read');
    }
    as.close();
    const revocations = database(c, 'revocations'); revocations.exec('CREATE TABLE IF NOT EXISTS revoked_grants(grant_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL, reason TEXT NOT NULL)'); revocations.close();
    const api = database(c, 'wallet');
    api.exec(commonSchema + `CREATE TABLE IF NOT EXISTS wallets(user_id TEXT PRIMARY KEY,balance INTEGER NOT NULL CHECK(balance>=0));
      CREATE TABLE IF NOT EXISTS charges(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,client_id TEXT NOT NULL,amount INTEGER NOT NULL,trip_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,at TEXT NOT NULL, UNIQUE(user_id,client_id,idempotency_key));`);
    for (const user of ['alice', 'bob']) api.prepare('INSERT OR IGNORE INTO wallets VALUES(?,1000000)').run(user);
    api.close();
    const taxi = database(c, 'taxi');
    taxi.exec(commonSchema + `CREATE TABLE IF NOT EXISTS attempts(state_hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS links(user_id TEXT PRIMARY KEY,wallet_sub TEXT NOT NULL,vault TEXT NOT NULL,token_exp INTEGER NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,trip_id TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL,detail TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);`);
    taxi.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_intents(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_hash TEXT NOT NULL,payment_mode TEXT NOT NULL,status TEXT NOT NULL,job_id TEXT,trace TEXT NOT NULL DEFAULT '[]',expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS booking_attempts(state_hash TEXT PRIMARY KEY,intent_id TEXT NOT NULL);`);
    taxi.exec(`CREATE TABLE IF NOT EXISTS bookings(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL UNIQUE,trip_id TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,origin TEXT NOT NULL,destination TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,intent_id TEXT NOT NULL UNIQUE REFERENCES booking_intents(id));`);
    taxi.exec(`CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY,origin TEXT NOT NULL,destination TEXT NOT NULL,fare INTEGER NOT NULL CHECK(fare>0));`);
    if (!(taxi.prepare('PRAGMA table_info(booking_intents)').all() as any[]).some(column => column.name === 'trip_id')) taxi.exec("ALTER TABLE booking_intents ADD COLUMN trip_id TEXT NOT NULL DEFAULT 'ben-thanh-airport'");
    taxi.prepare('INSERT OR IGNORE INTO trips VALUES(?,?,?,?)').run('ben-thanh-airport', 'Bến Thành', 'Sân bay Tân Sơn Nhất', 45000);
    taxi.prepare('INSERT OR IGNORE INTO trips VALUES(?,?,?,?)').run('ben-thanh-mien-dong', 'Bến Thành', 'Bến xe Miền Đông', 35000);
    for (const user of ['alice', 'bob']) {
      if (!taxi.prepare('SELECT id FROM users WHERE id=?').get(user)) taxi.prepare('INSERT INTO users VALUES(?,?)').run(user, await argon2.hash(`Taxi-${user}-2026!`, { type: argon2.argon2id }));
    }
    taxi.close();
  }
  console.log(`Local lab initialized at ${dataRoot}. Existing keys, balances and jobs preserved.`);
}
if (process.argv[1]?.endsWith('setup.ts')) await setup();
