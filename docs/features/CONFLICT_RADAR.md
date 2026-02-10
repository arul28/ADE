# Conflict Radar

Last updated: 2026-02-10

## 1. Goal

Surface integration risk early so users do not discover conflicts at merge time.

## 2. UX Surface

Lane indicators:

- Merge-ready
- Behind base
- Conflict predicted
- Conflict active
- Unknown (prediction failed)

Conflict summary panel:

- file list
- coarse type (same lines, rename/delete) where possible
- "what changed in base" since lane started

Batch view:

- "Assess all lanes" report (sorted by severity)

## 3. Functional Requirements

MVP:

- Determine behind/ahead counts vs base.
- Predict conflicts via dry-run analysis without mutating worktrees.
- Display predicted conflict files and a severity heuristic:
  - number of files
  - number of overlapping touched lines (if available)
  - stack depth impact (parent conflict blocks children)

V1:

- Lane-lane overlap heatmap (not the same as conflicts; indicates risk).
- Batch assess on base update.

## 4. Integration With Conflict Resolution

When conflict is predicted:

- provide a "Resolve" button that opens `CONFLICT_RESOLUTION.md` workflow
- do not automatically run hosted proposals by default

## 5. “GitButler-Like” Conflict Badges In Lanes

Conflicts must be visible in the Lanes tab at a glance:

- lane row/card shows:
  - conflict predicted (badge + count)
  - conflict active (badge)
  - behind/ahead counts
- selecting lane shows:
  - conflict files list
  - “open conflicts window” CTA
  - link to conflict pack

## 6. Development Checklist

MVP:

- [ ] Predict conflicts per lane vs base
- [ ] Surface predicted conflicts in lane cards
- [ ] Build "assess all lanes" report

V1:

- [ ] Overlap heatmap
- [ ] Batch assess on base updates
