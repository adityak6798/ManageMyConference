# Integration architecture

Status: canonical | Owner: platform | IDs: `PORT-EMAIL`, `PORT-CALENDAR`, `PORT-AIRTABLE`, `PORT-ACCELEVENTS`, `PORT-AI` | Last verified: 2026-08-09

Application services call typed provider-neutral ports. Each port has a deterministic fake and contract suite; live implementations are credential-gated and cannot be required for pull-request CI.

- Email: enqueue template/version plus recipient reference; adapter reports provider message reference and normalized result.
- Calendar: generate deterministic ICS from scheduled canonical content; native Google/Microsoft OAuth is out of scope.
- Airtable/Accelevents: outbound, versioned, idempotent projections. SQL remains canonical.
- AI: suggestion/draft only, with provenance, explicit acceptance, timeouts, and deterministic manual fallback.

Provider calls originate from outbox workers, not open database transactions. Adapters normalize retryable versus terminal errors and never leak SDK types inward.
