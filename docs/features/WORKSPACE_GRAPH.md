# Workspace graph

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

The Workspace Graph is ADE's visual topology canvas for lanes, stack relationships, conflict risk, sync state, and PR overlays. The graph still exposes the same topology and risk model, but it now hydrates that information in stages so the page becomes usable before every overlay finishes loading.

---

## What the graph shows

The graph still combines several concepts in one canvas:

- lane topology and stack structure
- primary-to-worktree relationships
- conflict-risk overlays
- PR overlays
- sync and activity signals
- merge-simulation entry points

The feature is still powered by the same underlying lane, conflict, PR, and git services. What changed is how that data arrives in the renderer.

---

## Staged hydration model

The graph now loads in layers instead of trying to mount everything immediately.

### Initial load

The first useful render favors topology:

- lane list and layout state load first
- the basic canvas becomes interactive
- richer overlays are scheduled behind that initial render

### Deferred overlays

The following layers warm in after the canvas exists:

- conflict-risk batch data
- recent activity scoring
- sync status
- auto-rebase status
- PR overlay refresh

This staged approach prevents the graph from feeling like one giant blocking fetch every time the tab opens.

---

## Activity and polling behavior

Recent-activity scoring is now intentionally bounded.

Current behavior:

- activity uses the shared renderer session-list cache
- the graph only inspects a bounded recent session set
- activity emphasizes recent ended and active sessions instead of scanning everything forever

Periodic refresh is also calmer:

- lane refresh interval is 60 seconds
- sync refresh interval is 60 seconds
- overlay refreshes are scheduled and coalesced instead of stacked blindly

This reduces background pressure while keeping the graph reasonably fresh.

---

## PR and conflict overlays

Risk and PR overlays are still first-class graph features:

- risk overlays come from conflict service batch assessment
- PR overlays reflect lane-linked PR and workflow state
- edge clicks can still open simulation or related workflow actions

The graph now delays initial PR refresh slightly instead of treating it as required for first paint.

---

## Interaction model

The canvas still supports:

- panning and zooming
- node drag and persisted layout
- reparenting and lane actions
- overlay detail panels
- graph-to-PR and PR-to-graph navigation

The difference is that these interactions no longer depend on every derived overlay finishing before the user can act.

---

## Current product contract

The graph now follows these rules:

- make topology visible first
- stage non-essential overlays after first interaction
- bound activity and polling work
- keep risk, PR, and sync overlays fresh enough without constant churn

That keeps the graph valuable as a rich coordination surface without letting the canvas become one of the renderer's heaviest mount paths.
