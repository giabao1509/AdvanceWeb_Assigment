# Authoritative assignment contract

This reference is a faithful operational extraction of `assignment-source.pdf`. The PDF remains authoritative. Requirements added by the skill requester are labeled **Required stack/architecture addition**. Anything under **Explicitly unspecified** must not be invented.

## Scope

Users can list products, create a cart, get a cart, add an item, change its quantity, and remove it. Authentication, checkout, and payment are out of scope. A cart is identified by `cartId`.

## Required stack and architecture additions

- Node.js and Express.js
- PostgreSQL with Prisma ORM for access, migrations, seed, reset, and persistence
- Contract-first OpenAPI 3.1 in `openapi.yaml`, the single contract source
- `express-openapi-validator` before handlers/business logic/database access
- `swagger-ui-express` serving a working `/docs`
- `pino` and/or `pino-http`
- Jest + Supertest
- Clear separation of routing, contract validation, business logic, persistence, logging, and error handling

## Database model

Represent the following SQL semantics in Prisma and migrations:

```sql
CREATE TABLE products (
  id          uuid PRIMARY KEY,
  sku         text UNIQUE NOT NULL,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  stock       integer NOT NULL CHECK (stock >= 0),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE carts (
  id     uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'open'
         CHECK (status IN ('open', 'checked_out'))
);

CREATE TABLE cart_items (
  cart_id    uuid REFERENCES carts(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (cart_id, product_id)
);
```

Seed exactly five products by category: three active products with stock, one product with `stock = 0`, and one product with `is_active = false`. Also seed one cart with `status = 'checked_out'`. The PDF does not prescribe UUIDs, SKUs, names, prices, stock quantities above zero, or whether the zero-stock product is active; choose deterministic values only as fixture mechanics, not as assignment requirements.

## Endpoints

There are exactly six assignment endpoints.

| Method and path | Explicit behavior | Explicit success result |
|---|---|---|
| `GET /products?limit=&offset=` | Return products that are currently for sale. `limit` is 1-50 and defaults to 20. | Status and complete response schema are not stated. |
| `POST /carts` | Create an empty cart. | `201`; include `Location`. Complete body schema is not stated. |
| `GET /carts/{cartId}` | Return the cart, its items, and `subtotal_cents`. | Status and complete response schema are not stated. |
| `POST /carts/{cartId}/items` | Add an item using `{ product_id, quantity }`. | `201`; return the cart. |
| `PATCH /carts/{cartId}/items/{productId}` | Change quantity using `{ quantity }`. | `200`; return the cart. |
| `DELETE /carts/{cartId}/items/{productId}` | No request body. | `204`; no response body. |

`cartId` is a UUID. The PDF shows `product_id` as a UUID in the add-item request. It does not explicitly state the OpenAPI format for the `productId` path parameter.

## Explicit request validation

The add-item request body is an object with `additionalProperties: false`, required `product_id` and `quantity`, `product_id` as `string`/`uuid`, and `quantity` as an integer from 1 through 10. The update body contains `quantity`; apply the same stated quantity boundary (integer, 1-10) and reject unknown fields at the boundary.

Reject schema/URL failures before business logic and database access with `400 VALIDATION_ERROR`. Explicit invalid examples are:

- `quantity` equal to `0` or `11`
- `quantity` equal to string `"2"` (do not coerce it)
- missing `product_id`
- any unexpected body field
- a non-UUID `cartId`

For the three invalid quantity values, `details` identifies only `quantity`. A missing `product_id` or an unknown field must not change the database. Do not allow a database constraint failure to substitute for boundary validation.

## Business rules and application error codes

| Rule | Failure response |
|---|---|
| Referenced product exists and is for sale | `422 PRODUCT_UNAVAILABLE` |
| Requested quantity does not exceed stock | `409 INSUFFICIENT_STOCK` |
| Product is not already in the cart when adding | `409 ITEM_ALREADY_IN_CART` |
| Mutations apply only to an open cart | `409 CART_CLOSED` |
| A valid `cartId` identifies an existing cart | `404 CART_NOT_FOUND` |
| A targeted cart item exists | `404 ITEM_NOT_FOUND` |

Read prices from the database. `subtotal_cents` is the sum of each item's database `price_cents * quantity`; adding two products and then getting the cart must equal a manual calculation from the deterministic seed.

The PDF does not define precedence when one request violates multiple business rules. Do not invent a precedence rule; tests and implementation must use scenarios that isolate one rule unless another source explicitly resolves it without conflict.

## Error contract

Every error, including validator errors and 500 errors, uses one JSON shape:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Request body khong hop le",
  "details": [{ "field": "quantity", "issue": "must be <= 10" }],
  "request_id": "7f3c2a9e-1b4d-4c8a-9e21-5d6f0a3b8c10"
}
```

The structural fields are `code`, `message`, `details`, and `request_id`. `code` is stable for client branching; `message` is display text. Translate library/validator errors into this shape. A 500 body must use the same shape and contain no stack trace, SQL text/details, or secrets.

## Request ID and logging

Generate a request ID for every request. Return the same value in response header `X-Request-Id`; include it in every error body; and attach the same value to logs for that request. The requester additionally requires the header on success responses. Do not log passwords, tokens, or the `Authorization` header. Redact secrets and avoid SQL details and stack traces in client responses.

## Documentation and deliverables

- `README` documents commands to create the database, run migrations, seed, reset the database, and start the server.
- `openapi.yaml` is OpenAPI 3.1, documents all six endpoints and every supported status, and includes examples.
- `/docs` works from `openapi.yaml`.
- Request validation and response conformance use the same contract.
- A reproducible evidence/test command covers every acceptance-matrix row.
- Presentation expectations from the PDF: explain the problem, explain contract-first versus code-first plus library choice/reason, demo an invalid request from `/docs` with the error response and matching log `request_id`, and report acceptance-matrix evidence plus untested scenarios.

## Explicitly unspecified

Do not invent these details. Report them if implementation cannot proceed without an existing, non-conflicting project contract decision:

- complete success-response schemas and exact response fields beyond `items` and `subtotal_cents` for a cart
- success statuses for `GET /products` and `GET /carts/{cartId}`
- the 500 application error `code`
- `offset` type, range, and default
- `productId` path format
- exact `Location` value shape
- exact success response body for `POST /carts`
- exact error messages and most `details` contents/types beyond the shown shape and the quantity-only acceptance assertion
- ordering/pagination semantics for products
- business-rule precedence for requests with multiple simultaneous failures
- transaction/concurrency behavior or stock decrement semantics

If an existing `openapi.yaml` defines any of these, treat it as a project decision only when it does not conflict with the PDF or requester constraints. Otherwise report the conflict.
