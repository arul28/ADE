# Onboarding & Settings — Initialization, Trust, and AI Mode

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-03

---

## Overview

Onboarding initializes ADE in an existing repository. Settings controls ongoing behavior across config, automations, context generation, and AI runtime mode.

This document reflects the current no-legacy baseline, including `ai.mode`-driven provider behavior and removal of legacy `providers.mode` migration paths.

---

## Onboarding Flow (Current)

On first open (or when `.ade/` is missing), onboarding guides users through:

1. project defaults detection,
2. config review/edit,
3. optional existing-branch import as lanes,
4. initial project/lane pack refresh,
5. optional initial context doc generation.

### Defaults detection

Detection includes common stack indicators (`package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Makefile`, docker compose files) plus `.github/workflows/*` command extraction.

### Suggested config output

Suggested config writes into ADE config structure with:

- processes,
- test suites,
- stack buttons,
- automations,
- provider context tool generators.

### Initial pack/context generation

Onboarding always refreshes project and selected lane packs.

Initial context doc generation runs only when effective provider mode is not guest.

---

## Trust and Config Boundaries

ADE keeps shared vs local config split:

- shared: `.ade/ade.yaml`
- local: `.ade/local.yaml`

Shared config is intended for team-visible defaults. Local config stores machine/user-specific overrides.

---

## AI Mode and Provider Behavior (No Legacy Migration)

### Source of truth

Effective provider mode is derived from `effective.ai.mode`:

- `subscription` -> provider mode `subscription`
- any other/missing value -> provider mode `guest`

### Legacy key handling

`providers.mode` is ignored during config coercion and removed on save.

Current behavior does **not** migrate legacy provider-mode keys from `providers.mode`.

### Practical impact

- Guest mode: deterministic/non-AI features continue working.
- Subscription mode: AI features (planning, narrative, PR drafting, orchestrator usage, context generation) can run based on task routing and feature toggles.

---

## Settings Areas

### AI routing and feature toggles

Settings persist AI task routing (`ai.taskRouting`) and per-feature toggles (`ai.features`) for surfaces such as:

- mission planning/orchestrator,
- narratives,
- conflict proposals,
- PR descriptions,
- terminal summaries,
- initial context generation.

### Permissions and execution policy

Provider-specific execution permissions are controlled from `ai.permissions` and applied by runtime services.

### Automations

Automations are configured from effective config (`effective.automations`) and run trigger-action flows (`session-end`, `commit`, `schedule`, `manual`) with actions like:

- `update-packs`
- `predict-conflicts`
- `run-tests`
- `run-command`

### Context controls

Settings expose context doc generation and install flows tied to `.ade/context/PRD.ade.md` and `.ade/context/ARCHITECTURE.ade.md`.

---

## Operational Notes

- Onboarding can seed useful deterministic context even before AI narratives are available.
- `ai.mode` is the authoritative knob for guest vs subscription behavior.
- Legacy provider mode keys are not part of the current contract.
