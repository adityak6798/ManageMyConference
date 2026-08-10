# Testing strategy

Status: canonical | Owner: quality | IDs: `TST-001`–`TST-006` | Last verified: 2026-08-09

- `TST-001` Current unit tests cover event creation through the repository port, mapping, expiring/tamper-resistant signed demo sessions, production demo rejection, authorization behavior, and deterministic inputs. Domain-specific transitions/conflict rules are added with their features.
- `TST-002` Planned: repository and provider contract suites run against every fake/live implementation available in that environment.
- `TST-003` API tests cover shared request/response validation, demo-mode gating, signed session handling, distinct unauthenticated/forbidden behavior, safe error contracts, tenant-scoped event reads, and structured request logs with unexpected faults logged once. Miniflare proves existing-event migration, the D1 repository against the migrated database, and that applying reset twice restores the exact seed. Command idempotency expands with product capabilities.
- `TST-004` Playwright proves the identity/event shell: seeded persona sign-in, multi-event switching, authorized creation, persistence across reload, role-aware navigation, and visible denied/error behavior. Future P0 journeys add their own tagged scenarios.
- `TST-005` Context checks cover canonical domain assignments, IDs, links, routing by journey/acceptance/plan/path/symbol, trust-labeled generated backlinks/index drift, table ownership, cross-domain allowlists, dependency layers, and metadata. Generated/reference-untrusted backlinks cannot satisfy canonical proof. The AST error checker enforces error handling; shared-Zod OpenAPI generation has an independent drift check.
- `TST-006` Public-view Playwright coverage checks keyboard navigation, semantic structure, event-timezone rendering, and responsive overflow for `ACC-PUBLIC`. Production smoke, evaluator, broader accessibility auditing, and expanded security suites remain planned release or scheduled-build gates.

Acceptance tests declare their `ACC-*` identifier. Prefer public interfaces over implementation details. The browser suite uses deterministic local services and retains traces/screenshots/reports on CI failure. External provider suites will use deterministic fakes in PR CI. Flaky tests are fixed or quarantined with an owner and quality gap; blind retries are forbidden.
