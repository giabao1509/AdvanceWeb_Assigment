import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JWK } from 'jose';

export type Mode = 'baseline' | 'secure';
export interface Config {
  mode: Mode; dir: string; as: string; api: string; taxi: string;
  ports: { as: number; api: number; taxi: number };
  privateJwk: JWK; publicJwk: JWK; kid: string;
  clients: Record<string, string>; vaultKey: string; alicePassword: string; bobPassword: string;
}
export const dataRoot = resolve(process.env.LAB_DATA_ROOT || '.local');
export function config(mode: Mode): Config {
  const saved = JSON.parse(process.env.LAB_CONFIG || readFileSync(resolve(dataRoot, mode, 'config.json'), 'utf8'));
  const start = (mode === 'baseline' ? 4100 : 5100) + Number(process.env.LAB_PORT_OFFSET || 0);
  return { ...saved, mode, dir: resolve(dataRoot, mode), ports: { as: start + 1, api: start + 2, taxi: start + 3 },
    as: `http://localhost:${start + 1}`, api: `http://localhost:${start + 2}`, taxi: `http://localhost:${start + 3}` };
}
export function modeFromEnv(): Mode {
  const value = process.env.LAB_MODE || 'secure';
  if (value !== 'secure' && value !== 'baseline') throw new Error('LAB_MODE must be baseline or secure');
  return value;
}
export const scopes = ['wallet:read', 'wallet:charge', 'offline_access'];
export const now = () => Math.floor(Date.now() / 1000);
export const hasScope = (scope: string, required: string) => scope.split(' ').includes(required);
export const subset = (scope: string, allowed: string) => scope.split(' ').filter(Boolean).every(s => allowed.split(' ').includes(s));
export const normalizeScope = (scope: string) => [...new Set(scope.split(' ').filter(Boolean))].sort().join(' ');
