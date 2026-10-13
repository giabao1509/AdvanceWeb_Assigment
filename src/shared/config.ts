/** Fixture tồn kho xác định (PLAN §3). */
export const FIXTURE: Record<string, number> = { "SKU-001": 5 };

/** Deadline Order API đặt cho mọi lời gọi Inventory, REST lẫn gRPC (PLAN §6). */
export const DEADLINE_MS = 2000;
/** Độ trễ khi bật chế độ chậm ở Inventory. */
export const SLOW_MS = 5000;
/** Thời hạn giữ hàng (PLAN §3). */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

export const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
