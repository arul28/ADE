# CTO

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

The CTO is ADE's always-on, project-aware agent. It owns persistent identity, shared project understanding, worker management, Linear workflow coordination, and the operator-facing chat surface for project-level requests.

The current runtime is optimized around a simple rule: **make the CTO usable before every optional subsystem is fully hydrated**.

---

## What the CTO owns

The CTO combines several responsibilities:

- persistent project-facing chat
- worker/team management
- shared memory and knowledge browsing
- Linear workflow sync and dispatch
- optional OpenClaw bridge configuration
- budget and runtime visibility for the CTO org

The CTO is still a persistent agent, but the UI and runtime no longer assume that every one of those subsystems must fully boot the moment the tab opens.

---

## First-run setup

CTO onboarding now focuses on:

1. identity
2. project context
3. optional Linear connection

Important current behavior:

- the prompt preview for identity/persona is debounced
- setup can finish without Linear
- the UI recommends a personal Linear API key as the fastest path
- OAuth stays available when configured
- OpenClaw is intentionally left out of first-run setup

This keeps CTO onboarding short and removes the earlier failure mode where disconnected integrations made the setup feel broken or blocked completion.

---

## Current tab behavior

### Chat-first entry

The default CTO entry path is optimized for the chat surface.

Current behavior:

- chat session boot is lighter in locked single-session mode
- the page avoids unnecessary rediscovery when the CTO session is already known
- renderer-side session/chat hydration is reduced on first entry

### Lazy team/settings work

The CTO page now splits heavy state into smaller loads:

- summary loads immediately
- history loads only when Team or Settings needs it
- budget snapshot loads later and is freshness-guarded
- external MCP registry loads only when Settings or worker editors need it
- worker revisions/details load only on Team

That keeps the default chat entry path from paying for every management surface up front.

### Sidebar behavior

The sidebar is now treated like a stable renderer leaf:

- the worker tree is precomputed instead of re-filtered on every render
- the sidebar is memoized
- the budget footer is isolated so budget refreshes do not rerender the full tree

---

## Linear integration model

ADE now treats Linear as two related but distinct capabilities:

1. **sync and dispatch**
2. **optional realtime ingress**

### Connection model

The connection panel supports:

- personal API key connection
- OAuth connection when `.ade/secrets/linear-oauth.v1.json` is configured

The current product recommendation is API key first, OAuth second.

### Sync loop

Linear sync starts as a normal background service, but it now short-circuits aggressively when the project is effectively idle:

- if no workflows are enabled and there are no active runs, the sync cycle is skipped
- if no credentials exist and there are no active runs, the sync cycle is skipped
- new runs are only dispatched when workflows are enabled and credentials exist
- issue updates also short-circuit when credentials are missing and nothing active needs reconciliation

This means disconnected Linear no longer burns CPU just because the feature exists.

### Realtime ingress

Linear ingress is the optional realtime path that can accept relay or webhook events and feed them back into sync processing.

Current behavior:

- ingress only auto-starts when realtime configuration is actually present
- unconfigured ingress stays dormant
- realtime is optional; polling/sync is the baseline path

This is closer to a "boring first, advanced later" model and avoids surprise background startup work in unconfigured projects.

---

## OpenClaw integration

OpenClaw is still supported as an external bridge, but it is now explicitly an advanced configuration surface rather than part of first-run CTO setup.

That reduces setup complexity and keeps the core CTO workflow independent of external agent routing.

---

## Memory and identity

The CTO still owns persistent identity and long-lived project knowledge. The important runtime distinction is that this memory persists even when the UI is not keeping every supporting panel warm.

Current system behavior separates:

- CTO identity and core memory
- shared project knowledge
- worker-specific core memory
- recent subordinate activity and session logs

The UI can browse and edit that state without forcing the chat surface to rehydrate every other subsystem.

---

## Current product contract

The current CTO experience is built around these rules:

- the default chat path should be light
- setup should not require optional integrations
- Linear should be useful in polling mode before realtime ingress is configured
- idle/disconnected integrations should stay quiet
- management surfaces can hydrate lazily without weakening the CTO's persistent identity model

That contract is what makes the CTO tab usable as a daily control surface rather than a heavy admin screen that happens to contain a chat box.
