# Acceptance and test requirements

Use Jest + Supertest. Tests must run reproducibly with one documented command and must exercise the real middleware order and response validation. Reset and seed the test database deterministically.

Do not add behaviors that are absent from the PDF. Test each stated case independently so ambiguous error precedence does not become an invented contract.

## PDF acceptance matrix

Cover every row below:

1. `quantity: 0`, `quantity: 11`, and `quantity: "2"` each return `400 VALIDATION_ERROR`; `details` identifies only `quantity`.
2. Missing `product_id` returns `400 VALIDATION_ERROR` and does not change the database.
3. A body with an unexpected field returns `400 VALIDATION_ERROR` and does not change the database.
4. A non-UUID `cartId` returns `400 VALIDATION_ERROR` without reaching Prisma/database access.
5. A valid but nonexistent `cartId` returns `404 CART_NOT_FOUND`.
6. Add two products, then get the cart; `subtotal_cents` equals the manually calculated sum from seed prices and quantities.
7. An inactive/unavailable product returns `422 PRODUCT_UNAVAILABLE`.
8. Quantity above the selected product's stock returns `409 INSUFFICIENT_STOCK` while remaining schema-valid (therefore use a seeded stock below 10).
9. A mutation against the seeded checked-out cart returns `409 CART_CLOSED`.
10. With PostgreSQL unavailable, an API call returns 500 in the common error shape without stack trace, SQL information, or secrets.
11. Every real response exercised by these two acceptance tables conforms to `openapi.yaml`.

## Other directly stated contract coverage

Within the six endpoints and without inventing payload fields, cover the explicit success statuses/results, `Location` on cart creation, `204` with no body on delete, `ITEM_ALREADY_IN_CART`, and `ITEM_NOT_FOUND`. Exercise the `limit` lower/upper bounds and default only to the degree exactly documented. Do not assert an unspecified `offset` range/default, GET success status, 500 code, message wording, or success-response fields.

## Request ID and secrecy assertions

For success and error responses, assert `X-Request-Id` is present. For error responses, assert body `request_id` exactly matches the header. Capture the corresponding structured log and assert it uses that same request ID. Assert client-visible 500 output does not contain stack traces, SQL text/details, passwords, tokens, `Authorization`, or secrets.

## Proving validation does not reach the database

For invalid schema and path cases, spy on or substitute the repository/Prisma boundary and assert zero calls. Also compare relevant database state before/after for the two explicitly stated mutation-safety cases. Do not rely only on unchanged rows: a rejected request must not issue a read query either.

## Response conformance

Enable `express-openapi-validator` response validation in the test environment or validate captured responses against the same `openapi.yaml`. Do not maintain a second hand-written response schema. A library validation failure must be translated into the common error contract, never leaked in library-native format.

## Reproducibility

Document one command that prepares/reset-seeds the test database and runs the Jest + Supertest suite. The command may invoke package scripts, but it must not depend on test ordering or undeclared manual setup. Keep the database-outage case isolated and restore availability after it runs.
