---
name: 'finalize'
description: 'Final gate before pushing: audit docs, verify task-tracking parity, and run local checks'
---

# Finalize Command

This command is the final gate before pushing and opening a PR.

It must guarantee three outcomes:
1. all documentation is tracked and up-to-date,
2. task-tracking in feature docs matches the actual implementation state,
3. local checks pass.

**Usage:** `/finalize`

## Pipeline Overview

```
Phase 1: Determine scope of changes
Phase 2: Task-tracking audit (docs)
Phase 3: Documentation update
Phase 4: Local verification (typecheck + build)
Phase 5: Final summary
```

---

## Phase 1: Determine Scope of Changes

### 1a. Identify what changed

```bash
git diff main --name-only
git diff main --stat | tail -30
git log main..HEAD --oneline
```

### 1b. Categorize changes

Separate changed files into:
- **Code** — `apps/desktop/src/**/*.{ts,tsx}`
- **Docs** — `docs/**/*.md`
- **Config** — `package.json`, `tsconfig.json`, `vite.config.ts`, `tsup.config.ts`, `tailwind.config.cjs`
- **New untracked files** — check `git status` for files that should be staged

---

## Phase 2: Task-Tracking Audit

### 2a. Build impacted doc set

Collect candidate docs from:
- changed docs in `docs/features/**` and `docs/architecture/**`,
- feature docs that correspond to changed code areas (use mapping below),
- `docs/IMPLEMENTATION_PLAN.md` when feature scope or phase progress changed.

**Code-to-doc mapping:**

| Code Path Pattern | Feature Doc |
|---|---|
| `src/main/services/lanes/`, `src/renderer/components/lanes/` | `docs/features/LANES.md` |
| `src/main/services/pty/`, `src/main/services/sessions/`, `src/renderer/components/terminals/` | `docs/features/TERMINALS_AND_SESSIONS.md` |
| `src/main/services/processes/`, `src/main/services/tests/`, `src/renderer/components/project/` | `docs/features/PROJECT_HOME.md` |
| `src/main/services/files/`, `src/renderer/components/files/` | `docs/features/FILES_AND_EDITOR.md` |
| `src/main/services/packs/`, `src/renderer/components/packs/` | `docs/features/PACKS.md` |
| `src/main/services/diffs/`, `src/renderer/components/conflicts/` | `docs/features/CONFLICTS.md` |
| `src/renderer/components/prs/` | `docs/features/PULL_REQUESTS.md` |
| `src/main/services/history/`, `src/renderer/components/history/` | `docs/features/HISTORY.md` |
| `src/renderer/components/app/` (settings) | `docs/features/ONBOARDING_AND_SETTINGS.md` |
| `src/main/services/jobs/` | `docs/architecture/JOB_ENGINE.md` |
| `src/main/services/git/` | `docs/architecture/GIT_ENGINE.md` |
| `src/main/services/config/`, `src/main/services/state/` | `docs/architecture/CONFIGURATION.md` |
| `src/main/services/ipc/`, `src/preload/` | `docs/architecture/DESKTOP_APP.md` |
| `src/shared/types.ts`, `src/shared/ipc.ts` | `docs/architecture/DATA_MODEL.md` |

### 2b. Validate task-tracking in each impacted doc

For each impacted feature doc, ensure:
- tasks are clearly marked done/not done (`[x]` / `[ ]`),
- open tasks include implementation steps and/or acceptance checks,
- completed tasks reflect what was actually implemented in this branch,
- contradictory or stale statuses are corrected.

If a doc lacks task tracking, add a `## Task Tracking` section.

Minimum acceptable task item quality:
- one clear outcome,
- one or more concrete steps,
- at least one acceptance condition.

### 2c. Validate implementation plan

Check `docs/IMPLEMENTATION_PLAN.md`:
- current phase progress is accurate,
- completed items match what's actually built,
- next-up items are still relevant.

### 2d. Record audit results

Prepare an audit note for the final summary:
- docs audited,
- docs fixed,
- task-tracking gaps found and resolved,
- implementation plan updates made.

---

## Phase 3: Documentation Update

### 3a. Update impacted feature docs

For each doc identified in Phase 2:
- update descriptions to match current implementation,
- add new sections for newly implemented capabilities,
- remove or mark as deferred any planned items that were descoped,
- ensure code examples and file references point to real paths.

### 3b. Update architecture docs if needed

If the changes touch architecture-level concerns (new services, IPC channels, data model changes):
- update the relevant architecture doc,
- ensure `docs/architecture/SYSTEM_OVERVIEW.md` still reflects reality.

### 3c. Update implementation plan

In `docs/IMPLEMENTATION_PLAN.md`:
- check off completed deliverables,
- note any scope changes or newly discovered work,
- update phase status if a phase milestone was reached.

### 3d. Verify doc consistency

Spot-check that:
- no doc references files or features that don't exist,
- terminology is consistent across updated docs,
- no orphaned docs (docs for removed features).

---

## Phase 4: Local Verification

### 4a. Install dependencies

```bash
cd /Users/arul/ADE/apps/desktop && npm install
```

### 4b. Typecheck

```bash
cd /Users/arul/ADE/apps/desktop && npm run typecheck
```

### 4c. Build

```bash
cd /Users/arul/ADE/apps/desktop && npm run build
```

All checks must pass. If typecheck or build fails, fix the issues before proceeding.

---

## Phase 5: Final Summary

Output a summary including:

```markdown
## Finalize Summary

### Changes Overview
- [branch name]
- [X files changed, Y insertions, Z deletions]
- [brief description of what was done]

### Documentation Audit
- Docs audited: [list]
- Docs updated: [list]
- Task-tracking gaps resolved: [count + details]
- Implementation plan updated: [yes/no + details]

### Local Verification
- Typecheck: [pass/fail]
- Build: [pass/fail]

### Ready to Push
- [ ] All docs current and tracked
- [ ] Task-tracking accurate in all impacted docs
- [ ] Implementation plan reflects current state
- [ ] Typecheck passes
- [ ] Build succeeds
```

---

## Completion Checklist

- [ ] Scope of changes identified
- [ ] Task-tracking lists audited and corrected in impacted docs
- [ ] Required steps/acceptance present for open tasks
- [ ] Implementation plan updated
- [ ] Architecture docs updated if needed
- [ ] Feature docs updated if needed
- [ ] Typecheck passes
- [ ] Build succeeds
