import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

export const createLoggerOptions = (service: string) => ({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'password', 'token'],
    censor: '[REDACTED]',
  },
});

export const registerCommonHooks = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (request) => {
    request.id = String(request.headers['x-trace-id'] ?? randomUUID());
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({ event: 'HTTP_RESPONSE', traceId: request.id, method: request.method, path: request.url, status: reply.statusCode });
  });
};

export const duplicateHeader = (request: FastifyRequest, headerName: string): boolean => {
  const lower = headerName.toLowerCase();
  let count = 0;
  const raw = request.raw.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === lower) count += 1;
  }
  return count > 1;
};

export const jsonFetch = async <T>(input: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> => {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({})) as T;
  return { status: response.status, body, headers: response.headers };
};
