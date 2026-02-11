# History Graph (ADE Work Graph)

Last updated: 2026-02-11

This feature is an ADE-native history view, not a generic `git log`.

## 1. Goals

- Provide a single place to understand "what happened" across lanes, features, and plans.
- Make ADE operations explainable and reversible:
  - syncs, merges, rebases, conflict episodes, proposal applications, PR actions
- Support debugging:
  - "why is this lane behind?"
  - "when did conflicts start?"
  - "which session introduced this change?"
  - "how did this feature evolve over time?"

## 2. Data Sources

- operations table (undo timeline)
- terminal session metadata
- session checkpoints (immutable execution context)
- pack events (append-only lifecycle log)
- pack versions and pack head changes
- plan versions and plan feedback messages
- git refs/SHAs (anchors)
- PR and issue linkage events

## 3. UX Surface

History tab should provide:

- timeline view (default):
  - chronological events with filters (project, lane, feature, event type)
- feature history view:
  - groups all checkpoints/pack versions/plan versions for one feature key or issue key
  - highlights major milestones and regressions
- graph view (V1):
  - lane nodes + dependency edges (stack)
  - conflict episodes as markers
  - operations as edges (sync -> pre/post SHA)
  - feature nodes linked to related lanes/checkpoints

Event detail panel:

- show the underlying operation/checkpoint/version record
- show links to:
  - affected lane
  - feature pack
  - conflict pack
  - plan versions
  - proposal diffs
  - PR and issue
- "replay context" action when applicable:
  - restore selected checkpoint/plan prompt context to a new session
- "undo" action when applicable

## 4. Query Scenarios

History graph must answer:

- "show all sessions that touched `src/foo.ts`"
- "show me checkpoints between two SHAs"
- "show when plan v4 replaced plan v3 and why"
- "show full history for feature `PAY-123`"

## 5. Development Checklist

MVP:

- [ ] Record all key operations, checkpoints, pack events, and plan versions
- [ ] Timeline view with filters and event detail panel
- [ ] Feature history view (by feature key or issue key)
- [ ] Jump links to packs, checkpoints, and plan versions

V1:

- [ ] Graph view (stack + operations + feature links)
- [ ] Search across events/artifacts/files
- [ ] Context replay entrypoint from checkpoint detail
