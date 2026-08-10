# Coding standards

Status: canonical | Owner: engineering | ID: `ENG-CODE-001` | Last verified: 2026-08-09

- TypeScript is strict. Validate untrusted data at boundaries with Zod; use domain types internally.
- Biome owns TS/JS/JSON/CSS formatting and linting. Do not add overlapping formatters.
- The Python `uv` workspace is tooling-only; Ruff owns its formatting and linting.
- Prefer small named application services and explicit mapping functions over framework coupling.
- No deep imports across domains, cross-domain table access, floating promises, bare console calls, empty catches, hidden fallback, or mutation of inputs.
- Return typed expected results. Add context when rethrowing unexpected faults without duplicating logs.
- Comments explain intent/invariant and cite stable spec IDs at critical boundaries; they do not narrate syntax.
- Every change includes tests and updates governing documentation in the same pull request.

Temporary work must be visible as a tracked plan/gap. Suppression uses the narrowest mechanism, a reason, and `ERROR-INTENT:` when it intentionally discards a failure.
