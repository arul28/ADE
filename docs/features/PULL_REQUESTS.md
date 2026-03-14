# Pull requests

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

ADE's PR surface manages lane-backed pull requests, queue workflows, integration proposals, and GitHub inspection. The current implementation still centers on local git truth for simulation and merge planning, but the UI data-loading model is now much lighter than the earlier eager version.

---

## Core model

The PR feature still supports:

- lane-to-PR mapping
- stacked PRs through lane parent/child relationships
- queue automation state
- integration proposals backed by local simulation
- GitHub detail, checks, reviews, and comments

Integration and conflict prediction still rely on local git primitives rather than a remote-only simulator.

---

## GitHub data-loading model

The GitHub tab is now built around cached snapshots instead of repeated cold remote fetches.

### Current behavior

- the main process caches the GitHub snapshot for a short TTL
- the renderer also caches the snapshot so revisiting the tab can render immediately
- manual sync explicitly forces a refresh
- repeated in-flight snapshot requests are deduplicated

This keeps revisits from paying the full GitHub fetch cost every time while preserving a clear force-refresh path when the user asks for fresh data.

### What the snapshot contains

The snapshot still includes:

- repo pull requests
- external pull requests involving the current user
- lane linkage and ADE workflow metadata

The GitHub tab remains the read-only inspection and import/linking surface for remote PRs.

---

## PR context loading

The broader PR page no longer assumes every tab needs every workflow query.

Current behavior:

- queue state and queue rehearsal state only load for workflow-oriented tabs
- merge contexts load lazily
- selected PR detail still loads status, checks, reviews, and comments on demand
- background PR refresh only updates a small stale subset instead of every PR on every cycle

This keeps the default PR surface from paying for queue/integration orchestration when the user is just browsing ordinary PRs.

---

## Integration proposals

ADE still supports saved integration proposals and committed integration workflows, but the interaction model is now more explicit.

### Manual simulation

Integration simulation is no longer auto-triggered just because the user entered the Integration tab or selected a PR.

Current behavior:

- simulation state resets when the selected PR changes
- actual simulation runs only when the user triggers it
- the rerun path remains available through the existing explicit actions

This avoids surprise expensive local simulation work and prevents stale proposals from silently re-running in the background.

### Local simulation path

Simulation continues to use local git operations such as:

- `git rev-parse`
- `git merge-tree`
- diff-based overlap checks

That keeps PR readiness and conflict prediction aligned with the actual local repo state.

---

## Queue and workflow state

Queue automation, rehearsals, and committed integration workflows are still first-class PR concepts. The important change is that those states are now treated as **workflow-only data**, not data every PR screen must preload.

That is the main reason the normal PR and GitHub views feel less heavy than before.

---

## Current product contract

The current PR experience follows these rules:

- use local git state for merge/integration truth
- load normal PR browsing data first
- load workflow state only when the user is actually in a workflow view
- never auto-run expensive integration simulation just from tab selection
- make GitHub revisits warm through layered caching

That preserves the full PR feature set while keeping the common browse-and-review path much cheaper.
