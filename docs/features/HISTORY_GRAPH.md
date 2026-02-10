# History Graph (ADE Work Graph)

Last updated: 2026-02-10

This feature is an ADE-native history view, not a generic `git log`.

## 1. Goals

- Provide a single place to understand “what happened” across lanes.
- Make ADE operations explainable and reversible:
  - syncs, merges, rebases, conflict episodes, proposal applications, PR actions
- Support debugging:
  - “why is this lane behind?”
  - “when did conflicts start?”
  - “which session introduced this change?”

## 2. Data Sources

- operations table (undo timeline)
- terminal session metadata
- pack update events (deterministic + narrative timestamps)
- git refs/SHAs (as anchors)
- PR linkage events (create/update/merge)

## 3. UX Surface

History tab should provide:

- timeline view (default):
  - chronological events with filters (lane, event type)
- graph view (V1):
  - lane nodes + dependency edges (stack)
  - conflict episodes as markers
  - operations as edges (sync -> pre/post SHA)

Event detail panel:

- show the underlying operation record
- show links to:
  - affected lane
  - conflict pack
  - proposal diffs
  - PR
- “undo” action when applicable

## 4. Development Checklist

MVP:

- [ ] Record all key operations in `operations` table
- [ ] History tab timeline view with filters
- [ ] Event detail panel with links/jump actions

V1:

- [ ] Graph view (stack + operations)
- [ ] Search across events and artifacts

