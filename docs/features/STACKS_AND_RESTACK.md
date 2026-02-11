# Stacks and Restack

Last updated: 2026-02-11

## 1. User Value

Stacks let users break work into layered PRs and land safely with less conflict pain. Restack propagates parent changes into children predictably.

Stacks must work regardless of lane type:

- primary lane (main directory)
- worktree lane
- attached lane

## 2. Core Model

- A stacked lane has a parent lane.
- Child default base is parent branch ref.
- Stack graph is a dependency DAG but should be a tree in MVP (single parent).
- Parent/child links are logical lane relationships, not tied to a specific filesystem layout.

## 3. UX Surface

- Stack graph in dashboard:
  - parent/child lines
  - readiness indicators per lane
  - drift indicators relative to base (parent or main)
- Actions:
  - create stacked lane
  - attach existing lane as child
  - restack (selected subtree)
  - land stack (guided)
- PRs tab:
  - stacked PR chain view aligned to lane stack graph
  - blocked-by-parent indicators
- Merge simulation support:
  - preview parent -> child merge/rebase outcome before running restack

## 4. Functional Requirements

MVP:

- Create stacked lane: base = parent lane branch.
- Compute drift/conflicts against parent for child lanes.
- Restack (manual button):
  - update child lanes after parent changes
  - run in dependency order: parent -> child -> grandchild
- Support stacked PR metadata even when parent is a primary lane.

V1:

- Land stack flow:
  - determine merge order
  - ensure each lane is synced with its base
  - update PR base branches as necessary
- Retargeting assistant when branch relationships change.

## 5. Restack Strategy

Support both merge and rebase per child lane.

Default recommendation:

- merge parent into child (safer)
- allow rebase for users who prefer clean history

## 6. Edge Cases

- Parent lane deleted/archived while children exist.
- Child has uncommitted changes during restack.
- Conflicts during restack; must stop and produce conflict packs.
- Parent lane branch switched unexpectedly.
- Parent lane mapped to main directory with protected branch rules.

## 7. Development Checklist

MVP:

- [ ] Data model for parent/child relationship
- [ ] Create stacked lane flow
- [ ] Attach existing lane into stack
- [ ] Drift/conflict prediction against parent for children
- [ ] Restack action (manual)
- [ ] Pre-restack merge simulation

V1:

- [ ] Land stack flow (merge order + PR retargeting suggestions)
- [ ] Batch restack across multiple stacks
- [ ] Stack health dashboard (blocked subtrees, stale children)
