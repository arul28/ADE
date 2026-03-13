# Missions

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

Missions are ADE's structured execution system for multi-step work. A mission creates durable run, step, attempt, intervention, and artifact state, while the orchestrator coordinates workers across the configured provider/runtime mix.

The mission runtime is feature-rich, but the launcher and page shell now follow a lighter loading model so the feature stays responsive.

---

## Runtime contract

### Planning is still mandatory

Planning remains the first-class initial phase. If a profile omits a planning phase, ADE injects one automatically before execution begins.

The coordinator is responsible for:

- gathering context
- optionally asking clarifying questions
- delegating to a planning worker
- explicitly advancing phases

The runtime is responsible for:

- durable run/step state
- dependency and validation gates
- intervention creation
- artifact persistence
- budget and permission enforcement

### Mission detail surface

Mission detail remains organized around:

- **Plan**
- **Chat**
- **Artifacts**
- **History**

The chat surface still distinguishes:

- a global summary thread
- worker/orchestrator detail threads

---

## Mission page loading model

The mission page no longer front-loads every piece of supporting state on mount.

Current loading behavior:

- mission list refreshes immediately
- dashboard load is delayed slightly
- mission settings load is delayed further
- model capability fetch is delayed further still
- create-dialog caches are prewarmed in the background

This staged approach keeps the missions tab interactive while slower metadata and summary queries warm up behind it.

---

## Mission creation flow

The mission launcher is now built around cached and conditional loading.

### Prewarmed data

The create dialog prewarms:

- phase profiles
- phase items
- AI auth/model availability

That reduces the "open dialog and wait for everything" feeling.

### Conditional budget telemetry

The launcher no longer fetches mission budget telemetry just because the dialog opened.

Current behavior:

- smart budget telemetry only loads when Smart Budget is enabled
- subscription budget telemetry only loads when relevant providers are selected
- API usage aggregation only loads when API-model budgeting is actually in play

This removes one of the biggest unnecessary launch-time stalls.

### Lazy advanced UI

Heavy sections such as budget, team runtime, permissions, and computer-use controls are mounted after the dialog settles instead of all at once on first paint.

### On-demand settings dialog

`MissionSettingsDialog` is only mounted when open, and the create-dialog host unmounts closed dialog content instead of leaving heavy hidden trees in the DOM.

---

## Mission preflight and knowledge sync

Mission preflight still checks the current project and runtime state before launch, including knowledge-sync concerns. Human work digest data is used to warn when human-authored code changed since the last digest.

That keeps missions aware of stale project knowledge without forcing the entire digest system into the critical path for normal page load.

---

## Context and persistence

Mission persistence still includes:

- run/step/attempt state
- interventions and approvals
- worker session lineage
- artifacts and outcomes
- mission-pack updates

Mission context remains task-centric rather than identity-centric:

- mission state is durable runtime state
- project memory is shared background knowledge
- worker context is assembled per run/attempt from the current frontier

---

## Current product contract

The current missions experience is built around these rules:

- keep the mission list usable immediately
- do not fetch launch-only metadata until the user is actually launching
- do not compute budget telemetry unless budget controls are active
- mount advanced launcher/settings UI only when needed
- preserve the same durable run/step/artifact model underneath the lighter UI shell

This lets the missions feature stay orchestration-heavy without feeling like the whole page must cold-boot the orchestrator before the user can click anything.
