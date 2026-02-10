# Conflict Resolution

Last updated: 2026-02-10

## 1. Goal

Turn conflicts into a guided, reversible workflow:

- detect early (radar)
- propose resolutions (hosted agent)
- apply locally with preview and undo
- validate locally with tests

## 2. UX Surface ("Conflicts Window")

The conflicts window should show:

- predicted conflicts (pre-sync)
- active conflicts (during sync/rebase)
- conflict pack viewer
- proposal runner status (hosted agent)
- patch proposals list:
  - explanation
  - files touched
  - confidence label
  - "apply" and "apply to new commit" options
- test run panel (local)
- undo timeline for the operation

## 3. Workflow (Predicted Conflicts)

1. User opens conflicts window from a lane with `conflict_predicted`.
2. ADE builds/updates a Conflict Pack deterministically.
3. User clicks "Generate proposals".
4. Hosted agent reads repo mirror + packs and returns one or more patch proposals.
5. User reviews diffs and chooses:
   - apply proposal
   - edit manually (quick edit or external editor)
6. ADE runs selected tests locally (suggested by conflict pack; user can override).
7. ADE updates packs (lane + conflict) with the resolution and test results.

## 4. Workflow (Active Conflicts During Sync)

1. User clicks "Sync lane with base".
2. ADE performs merge or rebase locally.
3. If conflicts occur:
   - operation pauses
   - Conflict Pack is built with exact conflict hunks/markers
4. User runs hosted proposals or resolves manually.
5. ADE continues the operation (merge completes / rebase continues).
6. Tests run locally; packs update.

## 5. Patch Application Rules (Safety)

MVP defaults:

- proposals are never auto-applied
- applying a proposal creates a new commit (recommended)
- every apply is recorded in operation timeline
- provide "undo" to return to `pre_head_sha`

V1 options (explicit opt-in):

- auto-apply proposals when:
  - only conflicted files touched
  - tests pass
  - user enabled "auto-apply for this lane"

## 6. Confidence Heuristics

Confidence should be UX-simple (not math-heavy):

- High:
  - patch touches only conflict files
  - tests pass
  - small diff
- Needs review:
  - wide-ranging changes
  - tests missing or failing
  - changes touch build config or critical modules

## 7. Stack Considerations

If lane is in a stack:

- resolve conflicts starting at the parent
- then restack children
- conflicts window should show "blocked lanes" downstream

## 8. Development Checklist

MVP:

- [ ] Conflict pack generation for predicted conflicts
- [ ] Conflict pack generation for active conflicts (merge/rebase stopped states)
- [ ] Hosted agent proposal request + streaming status
- [ ] Patch proposal viewer and apply (new commit)
- [ ] Local test run integration and results capture
- [ ] Undo operation for sync/apply flows

V1:

- [ ] Multiple proposals and compare mode
- [ ] Auto-apply opt-in per lane with guardrails
- [ ] rerere integration to reuse recorded resolutions

