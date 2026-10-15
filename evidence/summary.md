# Block 04 evidence summary

Generated: 2026-10-15T04:29:50.359Z

Passed: 10/10

| ID | Request sender → receiver | Response sender → receiver | Objective | Expected | Actual | Result |
|---|---|---|---|---:|---:|---|
| B03 | External caller → Inventory v1 | Inventory v1 → External caller | Direct baseline inventory call without signature mutates stock | 201 | 201 | PASS |
| S01 | External caller → Inventory v2 | Inventory v2 → External caller | Secure inventory rejects a missing signature without mutation | 401 | 401 | PASS |
| S04 | External caller → Inventory v2 | Inventory v2 → External caller | An accepted signed request can only consume its nonce once | [201,401] | [201,401] | PASS |
| B04 | Client → Order v1 | Order v1 → Client | Baseline order accepts no access JWT | 201 | 201 | PASS |
| J04 | Client → Order v2 | Order v2 → Client | Secure order rejects no access JWT | 401 | 401 | PASS |
| J01 | Browser → Order v2 /auth/login | Order v2 → Browser | Login returns a 120-second access JWT and an HttpOnly refresh cookie | 200 | 200 | PASS |
| J10 | Client → Order v2 | Order v2 → Client | A valid access JWT reaches a service-signed inventory reservation | 201 | 201 | PASS |
| J11 | Browser → Order v2 /auth/refresh | Order v2 → Browser | Refresh A rotates to refresh B | 200 | 200 | PASS |
| J12 | Browser → Order v2 /auth/refresh | Order v2 → Browser | Reusing refresh A revokes the family | 401 | 401 | PASS |
| J13 | Browser → Order v2 /auth/refresh | Order v2 → Browser | Refresh B is invalid after family revocation | 401 | 401 | PASS |
