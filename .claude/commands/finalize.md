---
name: 'finalize'
description: 'End-of-cycle documentation audit: scan codebase, verify docs, update implementation plan, and run local checks'
---

# Finalize Command

This command is the end-of-cycle gate. It performs a comprehensive scan of the codebase and documentation to ensure everything is synchronized, then runs local verification checks.

**Usage:** `/finalize`

## Pipeline Overview

```
Phase 1: Codebase scan (build ground truth)
Phase 2: Documentation audit (compare docs vs reality)
Phase 3: Implementation plan update
Phase 4: Documentation fixes
Phase 5: Local verification (typecheck + build)
Phase 6: Final summary
```

---

## Phase 1: Codebase Scan

### 1a. Service inventory
Scan the main process services directory to build a ground truth inventory:

```bash
# List all service directories
ls -d apps/desktop/src/main/services/*/

# Count files per service
find apps/desktop/src/main/services -type d -mindepth 1 -maxdepth 1 | sort | xargs -I {} sh -c 'echo -n "$(basename {}): "; find {} -name "*.ts" -not -name "*.test.ts" | wc -l'
```

### 1b. IPC channel count
```bash
# Count IPC channels
grep -c ":" apps/desktop/src/shared/ipc.ts
```

### 1c. Type export count
```bash
# Count exported types
grep -cE "^export type |^export interface " apps/desktop/src/shared/types.ts
```

### 1d. Renderer component inventory
```bash
# List all page/component directories
ls -d apps/desktop/src/renderer/components/*/
```

### 1e. Identify what changed (vs main branch)
```bash
git diff main --name-only
git diff main --stat | tail -30
git log main..HEAD --oneline
```

Categorize changed files into: Code, Docs, Config, New untracked files.

---

## Phase 2: Documentation Audit

### 2a. Feature docs task tracking
For each feature doc in `docs/features/`, extract:
- Total task count (task IDs like TERM-001, LANES-001, etc.)
- Count DONE vs TODO vs PARTIAL
- Tasks that reference future phases or are marked deferred
- Any inconsistencies between doc status and actual code

**Feature docs to audit:**
| Doc | Code Areas |
|-----|-----------|
| `AUTOMATIONS.md` | `services/automations/` |
| `CONFLICTS.md` | `services/conflicts/`, `components/conflicts/` |
| `FILES_AND_EDITOR.md` | `services/files/`, `components/files/` |
| `HISTORY.md` | `services/history/`, `components/history/` |
| `LANES.md` | `services/lanes/`, `components/lanes/` |
| `ONBOARDING_AND_SETTINGS.md` | `services/onboarding/`, `services/keybindings/` |
| `PACKS.md` | `services/packs/`, `components/packs/` |
| `PROJECT_HOME.md` | `services/processes/`, `services/tests/`, `components/project/` |
| `PULL_REQUESTS.md` | `services/prs/`, `components/prs/` |
| `TERMINALS_AND_SESSIONS.md` | `services/pty/`, `services/sessions/`, `components/terminals/` |
| `WORKSPACE_GRAPH.md` | `components/graph/` |

### 2b. Architecture docs status check
For each architecture doc in `docs/architecture/`, verify:
- Implementation status sections are accurate
- Services referenced actually exist
- IPC channels referenced are registered
- No features listed as "planned" that are actually done

**Architecture docs to audit:**
- `CLOUD_BACKEND.md`, `CONFIGURATION.md`, `CONTEXT_CONTRACT.md`
- `DATA_MODEL.md`, `DESKTOP_APP.md`, `GIT_ENGINE.md`
- `HOSTED_AGENT.md`, `JOB_ENGINE.md`, `SECURITY_AND_PRIVACY.md`
- `SYSTEM_OVERVIEW.md`, `UI_FRAMEWORK.md`

### 2c. Cross-reference validation
- Verify task IDs in implementation plan match task IDs in feature docs
- Verify services listed in implementation plan match services in code
- Verify IPC channel counts match between docs and shared/ipc.ts
- Flag any orphaned docs (docs for features that don't exist)

---

## Phase 3: Implementation Plan Update

Check `docs/IMPLEMENTATION_PLAN.md`:
- Phase summary table accuracy
- Completed phase descriptions match reality
- Current/upcoming phase task lists are accurate
- No items listed as "done" that aren't implemented
- No items listed as "upcoming" that are already done
- Future phase references are consistent

---

## Phase 4: Documentation Fixes

### 4a. Update feature docs
For each doc identified with issues in Phase 2:
- Update task statuses to match implementation
- Add sections for newly implemented capabilities
- Mark deferred items clearly
- Ensure file path references point to real paths

### 4b. Update architecture docs
If status sections are stale:
- Update implementation status tables
- Mark completed features as DONE
- Verify service names match actual service file names

### 4c. Update implementation plan
- Check off completed deliverables
- Update phase status if milestones were reached
- Note scope changes or newly discovered work

### 4d. Consistency check
- No doc references non-existent files or features
- Terminology is consistent across docs
- No orphaned docs

---

## Phase 5: Local Verification

### 5a. Install dependencies
```bash
cd /Users/arul/ADE/apps/desktop && npm install
```

### 5b. Typecheck
```bash
cd /Users/arul/ADE/apps/desktop && npm run typecheck
```

### 5c. Build
```bash
cd /Users/arul/ADE/apps/desktop && npm run build
```

All checks must pass. If typecheck or build fails, fix the issues before proceeding.

---

## Phase 6: Final Summary

Output a summary:

```markdown
## Finalize Summary

### Codebase Snapshot
- Services: [count] categories, [count] .ts files
- IPC channels: [count]
- Type exports: [count]
- Renderer components: [count] page directories

### Changes (vs main)
- Branch: [name]
- [X files changed, Y insertions, Z deletions]
- Brief description of what was done

### Documentation Audit
- Feature docs audited: [count]/11
- Architecture docs audited: [count]/11
- Task tracking gaps found: [count + details]
- Status corrections made: [count + details]

### Implementation Plan
- Current phase: [phase]
- Phase status: [status]
- Updates made: [yes/no + details]

### Local Verification
- Typecheck: [pass/fail]
- Build: [pass/fail]

### Ready State
- [ ] All docs current and tracked
- [ ] Task tracking accurate in all feature docs
- [ ] Architecture docs reflect implementation reality
- [ ] Implementation plan matches current state
- [ ] Typecheck passes
- [ ] Build succeeds
```

---

## Parallel Agent Strategy

For maximum efficiency, launch parallel agents:
1. **Codebase scanner**: Scan services, IPC, types, components
2. **Feature doc auditor**: Read all 11 feature docs, extract task status
3. **Architecture doc auditor**: Read all 11 architecture docs, check staleness

Then synthesize findings and make updates sequentially.

---

*This command ensures documentation stays synchronized with the codebase after every work cycle.*
