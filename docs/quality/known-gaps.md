# Known gaps

Status: canonical | Owner: quality | Last verified: 2026-08-11

- `GAP-002` Competition interpretations are based on reviewed local/external evidence but must be revalidated if the evaluator changes. Owner: product. Trigger: evaluator revision.
- `GAP-003` GitHub branch-protection settings and successful execution of the configured gitleaks job are external to the repository and have not been verified from a run artifact. This is an operational-verification gap, not a failure of locally testable `ACC-HARNESS` behavior. The local competition evaluator and accessibility/performance smoke gates are implemented; deployment preview/smoke/rollback and live-provider contracts remain blocked on declared production systems. Owner: platform. Governing ID: `ENG-CI-001`. Closure: inspect a successful required-check run, verify protection settings, and add deployment/live-provider gates when those systems are declared.
- `GAP-004` API/web ports are environment-overridable but not automatically allocated per worktree. R2 bootstrap and an expanded readiness report are not implemented. Owner: developer experience. Governing ID: `ENG-DEV-001`. Closure: concurrent worktrees can start without manual port assignment and readiness reports resource/provider state without secrets.

- `GAP-005` The browser acceptance suite is not idempotent: it depends on the reset its own Playwright `webServer` step performs, and several specs assert seeded counts or consume terminal state. Run against already-running servers, so the reset is skipped, 6 of 19 failed on 2026-08-11. Impact: a contributor reusing dev servers sees false failures. Owner: quality. Governing ID: `ACC-DEMO-SMOKE`. Closure: issue #72 — the suite passes twice consecutively against a fixture it has already mutated.

Do not use this register to normalize failing tests, security defects, or ambiguous ownership. Each gap requires impact, owner, evidence, governing ID, and closure test.
