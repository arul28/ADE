# Onboarding and settings

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

ADE now treats onboarding and settings as two different jobs:

- **onboarding** gets the project usable quickly
- **settings** controls long-lived behavior, integrations, and policy

The current runtime no longer assumes first-run setup should hydrate every service or require every integration before the user can move on.

---

## Repository onboarding

Repository onboarding still covers the initial ADE project bootstrap:

1. detect common stack signals
2. suggest config defaults
3. optionally import existing branches as lanes
4. prepare initial deterministic context state

The main difference now is **timing**: project open favors a cheap first pass and delays secondary hydration until after the app is interactive.

Current behavior:

- lanes load without expensive status first
- keybindings load immediately
- provider mode and full lane status warm later
- context generation can still happen, but it is no longer treated as part of "must finish before the app feels usable"

---

## CTO first-run setup

CTO onboarding is now a lightweight wizard focused on three things:

1. **identity**
2. **project context**
3. **optional Linear connection**

### Identity step

The user defines the CTO's name, provider/model preference, and persona. The system prompt preview is generated live but debounced so typing in the persona field does not spam preview requests or make the setup pane sticky.

### Project context step

The wizard can seed the CTO from repo-detected defaults or from existing CTO memory. The user can still edit:

- project summary
- conventions
- active focus areas

### Integrations step

Linear is optional during setup.

Current behavior:

- the primary action can finish onboarding even when Linear is disconnected
- the UI explicitly tells the user that Linear can be connected later
- the fastest supported path is a personal API key
- OAuth is still available, but it is not the default recommendation
- OpenClaw is intentionally excluded from first-run setup

The setup flow now favors completion over forced integration ceremony.

---

## Settings responsibilities

Settings owns durable configuration and infrastructure concerns, organized into tabs:

- **General** — AI mode, task routing, provider-specific permission policy, config reload, local/shared config boundaries
- **Context & Docs** — context doc management, skill files, deterministic context health
- **Memory** — consolidated memory management with two sub-tabs:
  - *Overview* — memory health, scope summaries, and promotion status
  - *Browse All* — full memory browser across all scopes (project, agent, mission) and tiers (Tier 1 Pinned, Tier 2 Active, Tier 3 Fading)
- **Integrations** — GitHub, Linear, and related connectivity state; automation defaults and credentials

Memory is no longer scattered across multiple surfaces (CTO tab, mission detail, etc.). All memory browsing and management is consolidated in the Settings > Memory tab.

Settings is not the primary authoring surface for automations, missions, or worker structure. It provides defaults and infrastructure for those features.

---

## AI mode and provider behavior

`effective.ai.mode` remains the source of truth for guest versus subscription behavior.

Current behavior:

- **guest mode** keeps local deterministic features usable
- **subscription mode** unlocks AI-powered orchestration, chat, narratives, summaries, and related features
- legacy `providers.mode` migration behavior is not part of the current contract

---

## Current UX contract

Onboarding and settings now follow a simpler product rule:

- do not block the user on optional integrations
- keep setup responsive
- show the fastest path first
- defer advanced or heavy configuration to the dedicated feature surface that owns it

That rule now shows up most clearly in CTO onboarding, where finishing setup without Linear is valid and OpenClaw is left for later.
