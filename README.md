# Project Greenroom

An open conference-operations platform for the Kill My SaaS competition. Greenroom follows the complete lifecycle from CFP and review through speakers, agenda, communications, CRM, and public publishing.

The repository is deliberately organized as an agent-readable context graph. Start with [AGENTS.md](AGENTS.md), browse the [documentation system of record](docs/README.md), or open the self-contained [interactive prototype](prototype.html).

## Reference slice

The executable product now composes the complete proposal-to-publication lifecycle across organizer, reviewer, speaker, and public roles. Follow the [competition demo runbook](docs/demo-runbook.md) for the deterministic evaluator path.

```bash
npm ci
uv sync --locked
npm run setup:local
npm run context -- map
npm run reset
npm run dev
```

Run `npm run check` and `npm run build` before opening a pull request. Product behavior and the implementation roadmap live under `docs/`; this README is only an entrypoint.
