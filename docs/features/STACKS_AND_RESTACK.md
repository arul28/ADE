# Stacks and Restack

Last updated: 2026-02-10

## 1. User Value

Stacks let users break work into layered PRs and land safely with less conflict pain. Restack propagates parent changes into children predictably.

## 2. Core Model

- A stacked lane has a parent lane.
- The child's base ref is the parent's branch ref.
- The stack graph is a dependency DAG but should be a tree in MVP (single parent).

## 3. UX Surface

- Stack graph in dashboard:
  - parent/child lines
  - readiness indicators per lane
  - drift indicators relative to base (parent or main)
- Actions:
  - create stacked lane
  - restack (selected subtree)
  - land stack (guided)
 - PRs tab:
   - stacked PR chain view aligned to the lane stack graph
   - “blocked by parent” indicators

## 4. Functional Requirements

MVP:

- Create stacked lane: base = parent lane branch.
- Compute drift/conflicts against parent for children lanes.
- Restack (manual button):
  - update child lanes after parent changes
  - run in dependency order: parent -> child -> grandchild

V1:

- Land stack flow:
  - determine merge order
  - ensure each lane is synced with its base
  - update PR base branches as necessary

## 5. Restack Strategy

Support both merge and rebase per child lane.

Default recommendation:

- merge parent into child (safer)
- allow rebase for users who prefer clean history

## 6. Edge Cases

- Parent lane deleted/archived while children exist.
- Child has uncommitted changes during restack.
- Conflicts during restack; must stop and produce conflict packs.

## 7. Development Checklist

MVP:

- [ ] Data model for parent/child relationship
- [ ] Create stacked lane flow
- [ ] Drift/conflict prediction against parent for children
- [ ] Restack action (manual)

V1:

- [ ] Land stack flow (merge order + PR retargeting suggestions)
- [ ] Batch restack across multiple stacks
