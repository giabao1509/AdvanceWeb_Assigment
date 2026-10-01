---
name: implement-cart-api-assignment
description: Implement, complete, or audit the contract-first Node.js Cart API assignment defined by the bundled course PDF. Use for repository changes involving this assignment's Express, PostgreSQL, Prisma, OpenAPI, validation, logging, or Jest/Supertest requirements; do not use for unrelated cart APIs.
---

# Implement Cart API Assignment

Treat [references/assignment-source.pdf](references/assignment-source.pdf) as the authoritative assignment source. Before changing an implementation, read the PDF completely, inspect the repository and its conventions, and then read all three references below:

1. [references/assignment-contract.md](references/assignment-contract.md) for the exact endpoints, data model, validation, errors, logging, and stated omissions.
2. [references/acceptance-tests.md](references/acceptance-tests.md) before creating, changing, or reviewing tests.
3. [references/implementation-workflow.md](references/implementation-workflow.md) before implementation or audit work.

Use only these required technologies: Node.js, Express.js, PostgreSQL, Prisma ORM, OpenAPI 3.1, `express-openapi-validator`, `swagger-ui-express`, `pino`/`pino-http`, and Jest + Supertest.

Preserve these invariants:

- `openapi.yaml` is the single contract source. Contract validation runs before business logic and every database access.
- Separate routing, contract validation, business logic, Prisma persistence, logging, and error translation.
- Real responses conform to the OpenAPI contract; `/docs` renders that same file.
- Every response has `X-Request-Id`; logs use the same ID; error bodies include it.
- Never expose or log passwords, tokens, `Authorization`, secrets, SQL details, or stack traces.
- Use Prisma migrations, seed data, reset commands, and persistence. Do not trust client-supplied price data.
- Make the smallest compliant change and run the relevant reproducible Jest + Supertest command.

Do not fill gaps by convention. If the PDF, `openapi.yaml`, tests, or code conflict, or if a requested implementation depends on a field/status/code the PDF leaves unspecified, stop and report the exact conflict or omission with file/operation evidence. Do not silently choose a winner or invent a requirement.
