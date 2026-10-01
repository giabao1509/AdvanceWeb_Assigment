# Implementation and audit workflow

## Source precedence and conflict handling

1. Read the bundled PDF completely; it is the assignment authority.
2. Apply the requester's required stack and architecture additions where the PDF permits a library choice or is silent.
3. Inspect `openapi.yaml`, tests, Prisma schema/migrations/seed, application code, and README.
4. Build a short operation-to-contract comparison before editing.

If the PDF, `openapi.yaml`, tests, or code disagree, report the exact files, operation/path, conflicting values, and why they cannot both be satisfied. Do not guess, silently update one source to match another, or use tests as authority over the PDF. If the PDF omits a required contract detail, report the omission instead of filling it from HTTP convention.

## Contract-first order

When no unresolved conflict blocks the requested change:

1. Make the smallest necessary change to `openapi.yaml` first.
2. Ensure request validation is installed before routers/handlers, services, and Prisma access. Disable coercion that would accept `quantity: "2"`.
3. Mount Swagger UI at `/docs` from the same parsed contract.
4. Keep handlers thin; place business rules in services and database work behind a repository/persistence boundary using Prisma.
5. Normalize validator, domain, not-found, and unexpected errors in one error middleware.
6. Add request-ID middleware early enough that validation failures, 404s, and 500s all receive the header and structured logging context.
7. Configure pino/pino-http redaction for `Authorization`, password, token, and secret-bearing fields. Do not send stack or Prisma/SQL details to clients.
8. Use Prisma migrations for schema changes and a deterministic seed for the required fixture categories. Supply documented create/migrate/seed/reset commands.
9. Update only tests required by the PDF/request and run the single reproducible Jest + Supertest command.
10. Compare observed statuses, error codes, schemas, database non-access/non-mutation, request IDs, logs, and subtotal against the acceptance reference.

## Middleware invariant

The effective request flow must be:

`request ID + logging context -> OpenAPI request validation -> route/handler -> business service -> Prisma persistence -> response validation -> centralized error translation`

Exact Express wiring may vary with repository conventions, but no invalid contract request may invoke a handler, service, repository, or Prisma. Ensure centralized error translation can normalize failures from every preceding stage.

## Completion report

State:

- files changed and the contract behavior implemented
- relevant test command and result
- acceptance cases verified
- any untested scenario required by the PDF
- unresolved ambiguity or conflict

Do not claim completion while an acceptance row is failing, skipped, or unverifiable. Do not broaden the project to authentication, checkout, payment, or extra endpoints.
