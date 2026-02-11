# Conflict Radar

Last updated: 2026-02-11

## 1. Goal

Surface integration risk early so users do not discover conflicts at merge time.

Conflict radar must work in near real time across:

- base vs lane
- parent vs child (stacked lanes)
- lane vs lane (peer active lanes)

## 2. UX Surface

Lane indicators:

- Merge-ready
- Behind base
- Conflict predicted
- Conflict active
- Unknown (prediction failed)

Realtime chips:

- `new overlap` (recent staged/dirty overlap detected)
- `high risk` (line-level overlap exceeds threshold)

Conflict summary panel:

- file list
- coarse type (same lines, rename/delete) where possible
- "what changed in base" since lane started
- "what currently overlaps with other active lanes"

Batch view:

- "Assess all lanes" report (sorted by severity)
- pairwise risk matrix for active lanes

Merge simulation panel:

- pick source lane and target lane/branch
- dry-run result: clean, auto-merge, conflicts
- predicted conflict files before executing merge/rebase

## 3. Functional Requirements

MVP:

- Determine behind/ahead counts vs base.
- Predict conflicts via dry-run analysis without mutating worktrees.
- Display predicted conflict files and a severity heuristic:
  - number of files
  - number of overlapping touched lines (if available)
  - stack depth impact (parent conflict blocks children)
- Compute pairwise lane-lane risk snapshot on session end and commit.

V1:

- Realtime prediction refresh from staged/dirty changes:
  - subscribe to index/worktree changes
  - update risk signals within seconds
- Lane-lane overlap heatmap and edge coloring in workspace graph.
- Continuous batch assess on base updates and branch switches.

## 4. Realtime Trigger Strategy

Trigger prediction refresh on:

- session end
- commit created
- staged set changed (`git add`, `git restore --staged`, etc.)
- dirty set changed (bounded debounce)
- branch switch in any lane
- base branch update

Coalescing:

- per lane: one in-flight + one pending prediction run
- global pairwise pass: coalesced with short debounce

## 5. Integration With Conflict Resolution

When conflict is predicted:

- provide a "Resolve" button that opens `CONFLICT_RESOLUTION.md` workflow
- show merge simulation and pairwise overlap evidence
- do not automatically run hosted proposals by default

## 6. "GitButler-Like" Conflict Badges In Lanes

Conflicts must be visible in the Lanes tab at a glance:

- lane row/card shows:
  - conflict predicted (badge + count)
  - conflict active (badge)
  - behind/ahead counts
  - overlap risk score vs peers
- selecting lane shows:
  - conflict files list
  - pairwise at-risk lanes
  - "open conflicts window" CTA
  - link to conflict pack

## 7. Development Checklist

MVP:

- [ ] Predict conflicts per lane vs base
- [ ] Predict pairwise overlap risk for active lanes
- [ ] Surface predicted conflicts in lane cards
- [ ] Build "assess all lanes" report

V1:

- [ ] Realtime updates from staged/dirty changes
- [ ] Merge simulation panel (lane -> lane/branch)
- [ ] Overlap heatmap in workspace graph
- [ ] Continuous batch assess on base updates
