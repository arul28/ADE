# Onboarding & Settings — Initialization, Trust, and AI Mode

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-05

---

## Overview

Onboarding initializes ADE in an existing repository. Settings controls ongoing behavior across config, automation defaults/integrations, context generation, and AI runtime mode.

This document reflects the current provider/config baseline, including `ai.mode`-driven behavior and removal of legacy `providers.mode` migration paths. It does **not** mean all historical context-pack/runtime compatibility paths are gone; those still exist where documented elsewhere. It also treats Automations as a separate first-class surface: Settings owns defaults and integrations, while `/automations` owns authoring and operations.

---

## Onboarding Flow (Current)

On first open (or when `.ade/` is missing), onboarding guides users through:

1. project defaults detection,
2. config review/edit,
3. optional existing-branch import as lanes,
4. initial context baseline preparation (project/lane summaries + conflict seeds),
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

### Initial context baseline generation

Onboarding prepares deterministic project/lane context summaries and seeds conflict prediction state.

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

Settings does not serve as the primary automation builder. Instead, it provides the defaults and infrastructure that power the dedicated `/automations` tab.

Settings-owned automation concerns include:

- default model/provider, budget, and approval policies for new automations
- connector auth and health for GitHub, Linear, and webhook integrations
- shared Night Shift defaults such as active window, notification delivery, and reserve policies
- team-shared templates and preset tool palettes

### Context controls

Settings expose context doc status, generation, and open flows tied to `.ade/context/PRD.ade.md` and `.ade/context/ARCHITECTURE.ade.md`.

---

## Operational Notes

- Onboarding can seed useful deterministic context even before AI generation is available.
- `ai.mode` is the authoritative knob for guest vs subscription behavior.
- Legacy provider mode keys are not part of the current contract.
