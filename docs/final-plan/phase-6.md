# Phase 6: Integration Sandbox + Merge Readiness

## Phase 6 -- Integration Sandbox + Merge Readiness (3-4 weeks)

Goal: Validate lane combinations before merge/land.

### Reference docs

- [features/CONFLICTS.md](../features/CONFLICTS.md) — conflict prediction, merge simulation, risk matrix, proposal workflows
- [features/PULL_REQUESTS.md](../features/PULL_REQUESTS.md) — PR readiness gates, land stack flow
- [features/WORKSPACE_GRAPH.md](../features/WORKSPACE_GRAPH.md) — graph overlays for merge readiness
- [features/LANES.md](../features/LANES.md) — stack workflows, rebase operations

### Dependencies

- Phase 5 complete.
- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).

### Workstreams

- Data/contracts:
  - Define integration sandbox run records and PR gate signals.
- Main process:
  - Add `integrationSandboxService` for ephemeral lane-set composition.
  - Wire conflict merge plans to sandbox execution hooks.
  - Wire PR readiness/landing gates to sandbox results.
- Renderer:
  - Lane-set selection and sandbox run UX in Play/Conflicts.
  - Merge-readiness overlays in PRs and Graph.
- Validation:
  - Lane-set compose/teardown reliability tests.
  - Gate enforcement tests for PR landing flows.

### Exit criteria

- Users can run pre-merge lane-set verification flows.
- PR and conflict readiness signal one shared truth.
- Optional gate enforcement blocks unsafe land operations.
