# Project Greenroom

An open conference-operations platform for the Kill My SaaS competition. Greenroom follows the complete lifecycle from CFP and review through speakers, agenda, communications, CRM, and public publishing.

The repository is deliberately organized as an agent-readable context graph. Start with [AGENTS.md](AGENTS.md), browse the [documentation system of record](docs/README.md), or open the self-contained [interactive prototype](prototype.html).

## Reference slice

The executable harness currently proves the first vertical slice: an authenticated organizer creates an event through React and Hono, Zod validates the contract, D1 persists it, and authorization failures use the standard correlation-aware error envelope.

```bash
npm ci
uv sync --locked
npm run setup:local
npm run context -- map
npm run reset
npm run dev
```

Run `npm run check` and `npm run build` before opening a pull request. Product behavior and the implementation roadmap live under `docs/`; this README is only an entrypoint.
