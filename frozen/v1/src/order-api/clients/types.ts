export interface Reservation {
  reservationId: string;
  /** Chỉ có khi client build từ proto v2 và server gửi field; undefined = vắng. */
  reservationExpiresAt?: Date;
}

export interface InventoryClient {
  transport: "rest" | "grpc";
  target: string;
  reserve(sku: string, quantity: number): Promise<Reservation>;
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
