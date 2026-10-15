import { z } from 'zod';

export const reservationSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(1000),
  orderId: z.string().min(1).max(100),
}).strict();

export const orderSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().positive().max(1000),
}).strict();

export const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
}).strict();

export type ReservationInput = z.infer<typeof reservationSchema>;
export type OrderInput = z.infer<typeof orderSchema>;

export const unauthorized = { code: 'UNAUTHORIZED', message: 'Authentication failed' } as const;
