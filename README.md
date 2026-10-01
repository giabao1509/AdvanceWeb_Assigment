# Contract-first Cart API

RESTful Cart API built with Node.js, Express, PostgreSQL, Prisma, OpenAPI 3.1,
`express-openapi-validator`, Pino, Jest, and Supertest. The API and PostgreSQL run in
Docker Compose.

The course PDF defines exactly six assignment endpoints. Team decisions for the response
schemas and the details left open by the PDF are explained in
[`CONTRACT_DECISIONS.md`](CONTRACT_DECISIONS.md). [`openapi.yaml`](openapi.yaml) is the
single executable contract used by request validation, response validation, and Swagger UI.

The final technical choices, rejected alternatives, and trade-offs are documented in
[`REPORT.md`](REPORT.md). A styled, print-friendly version is available in
[`REPORT.html`](REPORT.html).

## Requirements

- Git
- Docker Desktop, or Docker Engine with Docker Compose
- Node.js 20 or newer and npm when running tests or development commands on the host

## First-time setup

After cloning the repository, enter its directory and install the exact dependency versions
recorded in `package-lock.json`:

```bash
npm ci
cp .env.example .env
docker compose up --build -d
docker compose run --rm migrate npx prisma db seed
docker compose ps --all
```

On PowerShell, use the following command to create `.env`:

```powershell
Copy-Item .env.example .env
```

`npm ci` installs the host dependencies required by Jest, Supertest, Prisma CLI, and local
development commands. Do not commit `node_modules` or `.env`.

Docker also runs `npm ci` inside the image build. Therefore, if the API will only be run in
Docker and no tests or npm scripts will be executed on the host, the host-side `npm ci` step
may be skipped.

The startup sequence is:

```text
PostgreSQL becomes healthy -> migrations complete -> API starts -> seed command loads fixtures
```

Verify the installation:

```bash
curl -i "http://localhost:3000/products?limit=1&offset=0"
docker compose logs --tail 20 api
```

The API runs at `http://localhost:3000`. Swagger UI is available at
`http://localhost:3000/docs` and is rendered from the same `openapi.yaml` used by the
validator.

## Local development

With dependencies installed, `.env` created, and PostgreSQL running, start the API directly
on the host with automatic restart:

```bash
docker compose stop api
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

The first command prevents a port conflict: the host API and Compose `api` service both use
port `3000`. The `dev` and `start` scripts load `.env` through Node's `--env-file` option.

## Database commands

```bash
# Build and start PostgreSQL, apply migrations, and start the API
docker compose up --build -d
docker compose ps

# Apply committed migrations again if needed
docker compose run --rm migrate

# Load exactly five deterministic products and one checked-out cart
docker compose run --rm migrate npx prisma db seed

# Drop/recreate the schema, apply migrations, and seed again
docker compose run --rm migrate npx prisma migrate reset --force

# Stop the stack without deleting its database volume
docker compose down
```

The checked-out cart fixture is `20000000-0000-4000-8000-000000000001`. Product UUIDs,
prices, and stock used by evidence tests are in [`prisma/fixtures.js`](prisma/fixtures.js).

## Acceptance tests

With `npm ci` completed, `.env` configured, and PostgreSQL running:

```bash
npm run test:acceptance
```

This single command resets and seeds the database and then runs Jest/Supertest. The suite
covers request-boundary failures, no database access for invalid schema/path input, all
business error codes, two-product subtotal arithmetic, `Location`, bodyless `204`, request
IDs, structured logs, response validation against `openapi.yaml`, and a simulated database
outage at the repository boundary.

To reproduce the database-outage scenario manually:

1. Start the API and make one successful request.
2. Run `docker compose stop postgres`.
3. Call `GET /products` again.
4. Confirm the response is a `500` common error body without SQL, stack traces, or secrets.
5. Run `docker compose start postgres` before continuing.

## Request and logging behavior

Every response has `X-Request-Id`. Error bodies repeat the exact value as `request_id`, and
Pino logs include it as `request_id`. Authorization, cookies, passwords, tokens, and secrets
are redacted or never logged. Unexpected exception messages and stack traces are not written
to client responses or logs.

Every structured log entry is written to stdout. Docker Compose uses the `local` logging
driver, rotates each container log at 10 MB, and retains at most five files. This bounds
retained logs to approximately 50 MB per container before compression. The application does
not create or manage a separate log file.

### Viewing logs

Check service status before investigating logs:

```bash
docker compose ps --all
```

View logs for each service:

```bash
# API logs
docker compose logs api

# PostgreSQL logs
docker compose logs postgres

# Logs from the one-shot migration service
docker compose logs migrate

# Logs from all services
docker compose logs
```

Follow new API logs continuously, starting with the latest 100 lines:

```bash
docker compose logs --follow --tail 100 api
```

Press `Ctrl+C` to stop following the output. This does not stop the API container.

View recent logs with timestamps:

```bash
# API logs from the last 10 minutes
docker compose logs --since 10m --timestamps api

# Remove the Compose service prefix when raw JSON lines are needed
docker compose logs --no-log-prefix --tail 100 api
```

To trace one request, copy its `X-Request-Id` response header and search the API logs.
On Bash:

```bash
docker compose logs api | grep '<request-id>'
```

On PowerShell:

```powershell
docker compose logs api | Select-String '<request-id>'
```

For example, if a response returns
`X-Request-Id: 84c46c35-794f-4ec2-9b4f-e2624edff4f9`, run:

```powershell
docker compose logs api | Select-String '84c46c35-794f-4ec2-9b4f-e2624edff4f9'
```

Example invalid request:

```bash
curl -i -X POST http://localhost:3000/carts/20000000-0000-4000-8000-000000000002/items \
  -H "Content-Type: application/json" \
  -d '{"product_id":"10000000-0000-4000-8000-000000000001","quantity":11}'
```

## Scope

Authentication, checkout, payment, stock reservation, and additional endpoints are
intentionally excluded from this assignment.
