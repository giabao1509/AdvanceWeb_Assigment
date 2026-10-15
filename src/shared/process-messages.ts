import type { SigningAlgorithm } from './signing.js';

export type WorkerCommand =
  | { type: 'reset' }
  | { type: 'set-signing'; algorithm: SigningAlgorithm; kid?: 'ed-1' | 'ed-2' }
  | { type: 'set-verifier-mode'; algorithm: SigningAlgorithm }
  | { type: 'add-trusted-key'; kid: 'ed-1' | 'ed-2' }
  | { type: 'remove-trusted-key'; kid: 'ed-1' | 'ed-2' };

export interface WorkerState {
  type: 'state';
  service: string;
  activeAlgorithm?: SigningAlgorithm;
  activeSigningKid?: string;
  trustedKids?: string[];
}

export interface WorkerHttpExchange {
  type: 'http-exchange';
  traceId: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: { status: number; body: unknown };
}

export type WorkerMessage = WorkerState | WorkerHttpExchange;
