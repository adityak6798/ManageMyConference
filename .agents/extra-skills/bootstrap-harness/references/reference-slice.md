# Reference slice and functional evidence

## Choose the slice

Pick one thin, representative job that exercises the intended architecture. It should be important enough to expose real boundaries but small enough to finish before parallel feature work.

Include:

1. A real caller or UI action.
2. Boundary parsing and semantic validation.
3. The explicit product trust boundary. For protected behavior, enforce authentication and authorization in the application layer; for intentionally public behavior, record and review that decision.
4. One domain/application operation behind a typed port.
5. Real local persistence with a migration.
6. Readback or reload proving persistence.
7. A visible expected failure and a safe unexpected failure.
8. Correlation-aware structured telemetry.
9. Deterministic seed/reset and fake external providers.

## Minimum evidence

- Unit/application tests for business and capability behavior.
- API/contract tests for valid, invalid, unauthorized, forbidden, not-found, and unexpected outcomes.
- Storage integration against the real local database emulator/engine.
- Migration and idempotent reset evidence.
- Component/UI tests for visible failures.
- One browser or consumer test crossing the full deployed-local shape.
- Production compilation/build.

When authorization exists, test that denied mutations do not write. Test semantic invalidity, not only malformed syntax. Assert error bodies are safe, not only their status. Test session/cookie security if authentication is part of the slice.

Do not pursue universal line coverage. Add tests that would fail for credible regressions in the public behavior and boundaries.

## Readiness distinction

A polished prototype can clarify interfaces and scope but cannot satisfy functional acceptance. Documentation can define the harness but cannot prove it. The reference slice is the executable proof that parallel agents will work against real conventions rather than aspirational diagrams.
