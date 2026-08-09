# ADR-002: Canonical SQL and provider projections

Status: accepted | Owner: architecture | Date: 2026-08-09

## Decision

D1 SQL is canonical. Airtable and Accelevents receive versioned outbound projections through an outbox and typed adapters. Provider data never silently overwrites canonical state.

## Consequences

Local/CI fakes are deterministic; delivery is observable and retryable; projection mapping has contract tests. Reverse synchronization needs a future ADR.
