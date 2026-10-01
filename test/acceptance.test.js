const { Writable } = require('node:stream');
const pino = require('pino');
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../src/app');
const { seed } = require('../prisma/seed');
const { PRODUCTS, CHECKED_OUT_CART_ID } = require('../prisma/fixtures');

const prisma = new PrismaClient();
const silentLogger = pino({ level: 'silent' });

function expectRequestId(response) {
  expect(response.headers['x-request-id']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

function expectError(response, status, code) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({
    code,
    message: expect.any(String),
    details: expect.any(Array),
    request_id: response.headers['x-request-id'],
  });
  expectRequestId(response);
}

async function createCart(app) {
  const response = await request(app).post('/carts').expect(201);
  return response.body.id;
}

describe('Cart API acceptance matrix with PostgreSQL', () => {
  let app;

  beforeAll(async () => {
    await prisma.$connect();
    app = createApp({ logger: silentLogger });
  });

  beforeEach(async () => {
    await seed();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('serves Swagger UI from the API application', async () => {
    const response = await request(app).get('/docs/').expect(200);
    expect(response.text).toContain('Swagger UI');
    expectRequestId(response);
  });

  test('lists active products with deterministic default pagination', async () => {
    const response = await request(app).get('/products').expect(200);

    expect(response.body.limit).toBe(20);
    expect(response.body.offset).toBe(0);
    expect(response.body.items).toHaveLength(4);
    expect(response.body.items.map((item) => item.sku)).toEqual([
      'HEADSET-001',
      'KEYBOARD-001',
      'MONITOR-001',
      'MOUSE-001',
    ]);
    expect(response.body.items.every((item) => item.id !== PRODUCTS.legacyWebcam.id)).toBe(true);
    expectRequestId(response);
  });

  test.each(['0', '51'])('rejects limit=%s at the OpenAPI boundary', async (limit) => {
    const response = await request(app).get(`/products?limit=${limit}`);
    expectError(response, 400, 'VALIDATION_ERROR');
  });

  test('applies valid limit and offset values as integers', async () => {
    const response = await request(app).get('/products?limit=1&offset=1').expect(200);
    expect(response.body).toMatchObject({
      limit: 1,
      offset: 1,
      items: [{ sku: 'KEYBOARD-001' }],
    });
  });

  test('creates an empty cart with Location and the common cart schema', async () => {
    const response = await request(app).post('/carts').expect(201);

    expect(response.headers.location).toBe(`/carts/${response.body.id}`);
    expect(response.body).toEqual({
      id: expect.any(String),
      status: 'open',
      items: [],
      subtotal_cents: 0,
    });
    expectRequestId(response);
  });

  test.each([0, 11, '2'])(
    'rejects invalid quantity %p and identifies only quantity',
    async (quantity) => {
      const cartId = await createCart(app);
      const response = await request(app)
        .post(`/carts/${cartId}/items`)
        .send({ product_id: PRODUCTS.keyboard.id, quantity });

      expectError(response, 400, 'VALIDATION_ERROR');
      expect([...new Set(response.body.details.map((detail) => detail.field))]).toEqual([
        'quantity',
      ]);
    },
  );

  test('rejects a missing product_id without changing the cart', async () => {
    const cartId = await createCart(app);
    const response = await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ quantity: 1 });

    expectError(response, 400, 'VALIDATION_ERROR');
    expect(await prisma.cartItem.count({ where: { cartId } })).toBe(0);
  });

  test('rejects an unexpected field without changing the cart', async () => {
    const cartId = await createCart(app);
    const response = await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.keyboard.id, quantity: 1, price_cents: 1 });

    expectError(response, 400, 'VALIDATION_ERROR');
    expect(await prisma.cartItem.count({ where: { cartId } })).toBe(0);
  });

  test('returns CART_NOT_FOUND for a valid unknown cart UUID', async () => {
    const response = await request(app).get(
      '/carts/29999999-9999-4999-8999-999999999999',
    );
    expectError(response, 404, 'CART_NOT_FOUND');
  });

  test('calculates subtotal from two persisted product prices', async () => {
    const cartId = await createCart(app);
    await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.keyboard.id, quantity: 2 })
      .expect(201);
    await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.mouse.id, quantity: 3 })
      .expect(201);

    const response = await request(app).get(`/carts/${cartId}`).expect(200);
    const expected = PRODUCTS.keyboard.priceCents * 2 + PRODUCTS.mouse.priceCents * 3;
    expect(response.body.subtotal_cents).toBe(expected);
    expectRequestId(response);
  });

  test('returns PRODUCT_UNAVAILABLE for an inactive product', async () => {
    const cartId = await createCart(app);
    const response = await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.legacyWebcam.id, quantity: 1 });
    expectError(response, 422, 'PRODUCT_UNAVAILABLE');
  });

  test('returns INSUFFICIENT_STOCK for a schema-valid quantity above stock', async () => {
    const cartId = await createCart(app);
    const response = await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.mouse.id, quantity: PRODUCTS.mouse.stock + 1 });
    expectError(response, 409, 'INSUFFICIENT_STOCK');
  });

  test('returns CART_CLOSED when mutating the checked-out fixture cart', async () => {
    const response = await request(app)
      .post(`/carts/${CHECKED_OUT_CART_ID}/items`)
      .send({ product_id: PRODUCTS.keyboard.id, quantity: 1 });
    expectError(response, 409, 'CART_CLOSED');
  });

  test('returns ITEM_ALREADY_IN_CART when adding a duplicate product', async () => {
    const cartId = await createCart(app);
    const body = { product_id: PRODUCTS.keyboard.id, quantity: 1 };
    await request(app).post(`/carts/${cartId}/items`).send(body).expect(201);
    const response = await request(app).post(`/carts/${cartId}/items`).send(body);
    expectError(response, 409, 'ITEM_ALREADY_IN_CART');
  });

  test('updates quantity and returns the updated cart', async () => {
    const cartId = await createCart(app);
    await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.keyboard.id, quantity: 1 })
      .expect(201);

    const response = await request(app)
      .patch(`/carts/${cartId}/items/${PRODUCTS.keyboard.id}`)
      .send({ quantity: 3 })
      .expect(200);
    expect(response.body.items[0].quantity).toBe(3);
    expect(response.body.subtotal_cents).toBe(PRODUCTS.keyboard.priceCents * 3);
  });

  test('returns ITEM_NOT_FOUND when patching a missing item', async () => {
    const cartId = await createCart(app);
    const response = await request(app)
      .patch(`/carts/${cartId}/items/${PRODUCTS.keyboard.id}`)
      .send({ quantity: 1 });
    expectError(response, 404, 'ITEM_NOT_FOUND');
  });

  test('deletes an item with a bodyless 204 response', async () => {
    const cartId = await createCart(app);
    await request(app)
      .post(`/carts/${cartId}/items`)
      .send({ product_id: PRODUCTS.keyboard.id, quantity: 1 })
      .expect(201);

    const response = await request(app)
      .delete(`/carts/${cartId}/items/${PRODUCTS.keyboard.id}`)
      .expect(204);
    expect(response.text).toBe('');
    expectRequestId(response);
  });

  test('returns ITEM_NOT_FOUND when deleting a missing item', async () => {
    const cartId = await createCart(app);
    const response = await request(app).delete(
      `/carts/${cartId}/items/${PRODUCTS.keyboard.id}`,
    );
    expectError(response, 404, 'ITEM_NOT_FOUND');
  });
});

describe('boundary, outage, logging, and secrecy behavior', () => {
  test('successful response and log share the same request ID', async () => {
    const logLines = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ level: 'info' }, sink);
    const repository = { listProducts: async () => [] };
    const app = createApp({ repository, logger });

    const response = await request(app).get('/products').expect(200);
    expectRequestId(response);
    expect(logLines.join('')).toContain(response.headers['x-request-id']);
  });

  test('invalid cartId is rejected before any repository call', async () => {
    let repositoryCalls = 0;
    const repository = new Proxy(
      {},
      {
        get() {
          return async () => {
            repositoryCalls += 1;
            throw new Error('repository must not be called');
          };
        },
      },
    );
    const app = createApp({ repository, logger: silentLogger });

    const response = await request(app).get('/carts/not-a-uuid');
    expectError(response, 400, 'VALIDATION_ERROR');
    expect(repositoryCalls).toBe(0);
  });

  test('invalid request body is rejected before any repository call', async () => {
    let repositoryCalls = 0;
    const repository = new Proxy(
      {},
      {
        get() {
          return async () => {
            repositoryCalls += 1;
            throw new Error('repository must not be called');
          };
        },
      },
    );
    const app = createApp({ repository, logger: silentLogger });
    const response = await request(app)
      .post('/carts/20000000-0000-4000-8000-000000000002/items')
      .send({ product_id: PRODUCTS.keyboard.id, quantity: '2' });

    expectError(response, 400, 'VALIDATION_ERROR');
    expect(repositoryCalls).toBe(0);
  });

  test('database outage is translated without leaking stack, SQL, or secrets', async () => {
    const logLines = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ level: 'info' }, sink);
    const repository = {
      async listProducts() {
        throw new Error(
          'password=super-secret token=abc Authorization=Bearer SQL SELECT * FROM products',
        );
      },
    };
    const app = createApp({ repository, logger });

    const response = await request(app)
      .get('/products')
      .set('Authorization', 'Bearer client-secret');
    expectError(response, 500, 'INTERNAL_SERVER_ERROR');

    const clientBody = JSON.stringify(response.body);
    expect(clientBody).not.toMatch(/super-secret|client-secret|Bearer|SELECT|stack/i);
    const logs = logLines.join('');
    expect(logs).toContain(response.headers['x-request-id']);
    expect(logs).not.toMatch(/super-secret|client-secret|Bearer client-secret|SELECT \*/i);
  });
});
