# Pull Requests — Lane PRs, Stacks, and Integration Simulation

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-03

---

## Overview

The PR feature maps ADE lanes to GitHub pull requests and supports both single-lane and stacked workflows.

Current behavior uses:

- GitHub APIs for remote PR lifecycle operations,
- **local git-only simulation** for integration/conflict prediction and merge planning.

There is no legacy VCS adapter/backfill path in the simulation pipeline.

---

## Core Concepts

### Lane-to-PR mapping

Each lane can be linked to one PR record in ADE state. PR status, checks, and review signals are synced from GitHub.

### Stacked PRs

Parent/child lane relationships define stacked PR base targeting. Landing logic merges in dependency order and updates local state accordingly.

### Integration proposals

For multi-lane merges, ADE can simulate and persist an integration proposal with pairwise conflict analysis and ordered merge steps.

---

## Git-Only Simulation Path (Current Baseline)

PR integration simulation is computed from local git primitives:

- `git rev-parse` for base/head resolution,
- `git merge-tree --write-tree --messages` for dry merge/conflict signals,
- `git diff --name-only` and `git diff --numstat` for overlap and diff stats,
- optional heuristic overlap fallback when merge-tree output has no parsable conflict paths.

This path runs directly against local repository state and does not depend on legacy remote-only simulators.

---

## Conflict Path Integration

Conflict service and PR service share the same modern merge prediction assumptions:

- merge-base and head SHAs resolved via git,
- merge outcomes predicted with `runGitMergeTree(...)`,
- conflicted file sets and marker previews extracted from git output,
- integration lane/rebase helpers using local worktree state.

This keeps PR readiness and conflict prediction consistent across `/prs`, Graph risk workflows, and lane-level conflict surfaces.

---

## User Workflow

### Single lane PR

1. work in lane,
2. create or link PR,
3. monitor checks/reviews,
4. update description if needed,
5. land when merge-ready.

### Stacked lane PRs

1. create stacked lanes,
2. create PRs with correct parent base targeting,
3. review incrementally,
4. land in order (or land parent first and retarget descendants as needed).

### Integration simulation

1. choose source lanes and base branch,
2. run simulation,
3. inspect clean/conflict outcomes,
4. create integration lane when appropriate,
5. resolve remaining conflicts and proceed to commit/PR.

---

## Data and Persistence

PR data persists in local ADE state (pull request rows, group rows/members, integration proposal records, resolution state). Simulation artifacts are derived from git and stored in proposal state for follow-up actions.

---

## Practical Guidance

- Treat local git history/state as the source of truth for simulation outputs.
- Refresh lane packs before drafting PR descriptions for better summaries.
- Use integration proposals for multi-lane merges instead of ad hoc manual ordering.
