# Automations (Legacy)

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-02-26

---

## Status

This document is retained for historical context only.

Beginning in Phase 4, ADE moves to an **agent-first** model where automation behavior is represented as an **Automation Agent** under the unified Agents system.

- Route: current runtime route is `/automations`; `/agents` is a compatibility alias.
- Config: current runtime key is `automations:`. `agents:` remains roadmap direction.
- Runtime: non-interactive automation executions run as agent runtimes with standard policy, memory, and audit semantics.

---

## Canonical References

- [docs/features/AGENTS.md](AGENTS.md)
- [docs/features/MISSIONS.md](MISSIONS.md)
- [docs/architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md)
- [docs/architecture/CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md)
- [docs/final-plan.md](../final-plan.md)
