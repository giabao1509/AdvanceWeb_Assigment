import type { DatabaseSync } from 'node:sqlite';

export type Mode = 'baseline' | 'saga';
// Historical DB metadata only; all Saga orders now use one execution policy.
type LegacySagaVersion = 'v1' | 'v2' | 'v3';
export type OperationStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type Scenario = 'H' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';
export type OrderStatus = 'PROCESSING' | 'AWAITING_PAYMENT' | 'RECOVERING' | 'COMPENSATING' | 'CONFIRMED' | 'CANCELLED' | 'FAILED' | 'REQUIRES_REVIEW';
export type Step = 'RESERVE_PENDING' | 'AWAIT_PAYMENT' | 'CHARGE_PENDING' | 'CONFIRM_PENDING' | 'REFUND_PENDING' | 'RELEASE_PENDING' | 'CANCEL_PENDING' | 'DONE';
export interface Order {
  mode: Mode;
  f4_downtime_ms: number;
  id: string; request_key: string; fingerprint: string; sku: string; product_name: string;
  quantity: number; unit_price: number; total: number; scenario: Scenario;
  status: OrderStatus; step: Step; reservation_id: string | null; payment_id: string | null;
  last_error: string | null; created_at: string; updated_at: string;
  version: LegacySagaVersion;
  checkout_mode: 'manual' | 'automatic'; wallet_id: string | null; failure_reason: string | null;
}
export interface Saga {
  order_id: string; operations: string; decision: 'FORWARD' | 'COMPENSATE';
  attempts: number; next_retry_at: number; last_error: string | null;
  resume_blocked: number;
  retry_count: number; retry_limit: number; retry_exhausted: number;
  charge_uncertain:number; last_payment_instance:string;
}
export interface Reservation { id: string; order_id: string; mode?: Mode; sku: string; quantity: number; status: 'HELD' | 'RELEASED' }
export interface Payment { id: string; order_id: string; mode?: Mode; amount: number; status: 'CHARGED' | 'REFUNDED'; wallet_id: string | null }
export interface Wallet { id: string; name: string; balance: number }
export interface LedgerEntry { id: string; payment_id: string; order_id?: string; mode?: Mode; wallet_id?: string | null; kind: 'CHARGE' | 'REFUND'; amount: number; operation_id: string; created_at: string }
export interface Stock { sku: string; available: number }
export interface Movement { id: string; order_id: string; reservation_id: string; sku?: string; mode?: Mode; kind: 'RESERVE' | 'RELEASE'; quantity: number; delta: number; available_after: number | null; operation_id: string; created_at: string; source: 'LIVE' | 'IMPORTED_OPERATION' | 'LEGACY_BASELINE' | 'LEGACY_SAGA' }
export interface Command { operationId: string; orderId: string; scenario?: Scenario; sku?: string; quantity?: number; amount?: number; walletId?: string; downtimeMs?:number }
export interface Operation { id: string; fingerprint: string; action: string; order_id: string; http_status: number; result: string; created_at: string; status: OperationStatus }
export interface ResultBody { error?: string; reservation?: Reservation; payment?: Payment; [key: string]: unknown }
export interface HttpResult { status: number | null; body: ResultBody | null; error?: string }
export interface StoredResult { status: number; body: ResultBody }

declare global {
  namespace Express {
    interface Request { mode: Mode; db: DatabaseSync }
  }
}
