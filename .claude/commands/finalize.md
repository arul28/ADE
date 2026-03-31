---
name: finalize
description: 'Final gate: simplify code, update docs, and run local CI checks before pushing'
---

# Finalize Command

This command is the final gate before pushing and opening a PR.

It guarantees three outcomes:
1. Code quality cleanup is complete
2. Docs are current
3. Local CI checks pass

**Usage:** `/finalize`

## Pipeline Overview

```
Phase 1: Analyze code changes and batch simplification work  (lead)
Phase 2: Parallel execution (simplify + docs)                (agents)
Phase 3: CI sync + local verification                        (lead)
Phase 4: Summary                                             (lead)
```

---

## Phase 1: Analyze & Prepare Code Simplification

### 1a. Get changed source files

```bash
git diff main --name-only | grep -E '\.(ts|tsx)$'
```

### 1b. Pre-filter for simplification

```bash
git diff main --numstat | awk '$1+$2 > 10 {print $3}' | grep -E '\.(ts|tsx)$'
```

Exclude from simplification:
- Tiny changes (<10 lines added+removed)
- Test files (`*.test.ts`, `*.test.tsx`)
- Config files (`*.config.*`, `*.cjs`)
- Generated files, lock files

### 1c. Split into simplifier batches

- `< 5` files -> 1 batch
- `5-15` files -> 2 batches
- `16+` files -> 3 batches

Keep related files together (service + its types + its callers).

### 1d. Capture branch context for agents

```bash
git diff main --stat | tail -20
git log main..HEAD --oneline
```

---

## Phase 2: Parallel Execution

Spawn agents in parallel using the **Agent** tool:

### Simplifier agents (1-3 based on batch size)

Use `subagent_type: "code-simplifier"` for each batch.

Prompt each with:
- The list of files in their batch
- Branch context (what feature/area was changed)
- Instructions: focus on recently modified code, don't refactor untouched code

### Doc updater agent

Spawn a general-purpose agent with this prompt:

```
You are the documentation updater for the ADE project.

Analyze all changes on the current branch vs main and update relevant documentation.

Step 1: Get changed files
  git diff main --name-only
  git diff main --stat | tail -30

Step 2: Identify affected docs

Map changed source directories to documentation:

| Source Directory | Doc Location |
|-----------------|--------------|
| apps/desktop/src/main/services/orchestrator/ | docs/architecture/, docs/features/ |
| apps/desktop/src/main/services/prs/ | docs/features/ (PR-related) |
| apps/desktop/src/main/services/lanes/ | docs/features/ (lanes-related) |
| apps/desktop/src/main/services/memory/ | docs/features/ (memory-related) |
| apps/desktop/src/main/services/cto/ | docs/features/ (CTO/Linear-related) |
| apps/desktop/src/main/services/ai/ | docs/architecture/ (AI integration) |
| apps/desktop/src/renderer/components/ | docs/features/ (UI-related) |
| apps/mcp-server/ | docs/ (MCP-related) |
| .github/workflows/ | docs/ (CI/CD-related) |

Step 3: Update docs
- Rewrite sections to reflect current reality (not what changed)
- Remove outdated information
- Update code examples, file paths, API references
- Do NOT add changelog sections or "Updated on X" notes
- Do NOT create new doc files unless absolutely necessary

Step 4: Run doc validation
  node /Users/admin/Projects/ADE/scripts/validate-docs.mjs

Report what docs were updated and what was changed.
```

Wait for all agents to complete.

---

## Phase 3: CI Sync + Local Verification

### 3a. CI sync

Read `.github/workflows/ci.yml` and verify:
- Any new source directories are covered by existing test patterns
- Any new apps/packages would need new CI jobs (unlikely for typical changes)
- The `ci-pass` gate job includes all required jobs in its `needs` array

### 3b. Install dependencies (all apps)

Run in parallel — ensures lock files are in sync with package.json (mirrors CI's `npm ci`):

```bash
cd /Users/admin/Projects/ADE/apps/desktop && npm install
cd /Users/admin/Projects/ADE/apps/mcp-server && npm install
cd /Users/admin/Projects/ADE/apps/web && npm install
```

After install, check for uncommitted lock file changes — if any lock file is dirty, it means package.json was modified without regenerating the lock file, which will break CI's `npm ci`:

```bash
git diff --name-only -- '*/package-lock.json'
```

If lock files changed, warn and include them in the commit.

### 3c. Typecheck all apps

Run in parallel to match CI jobs (`typecheck-desktop`, `typecheck-mcp`, `typecheck-web`):

```bash
cd /Users/admin/Projects/ADE/apps/desktop && npm run typecheck
cd /Users/admin/Projects/ADE/apps/mcp-server && npm run typecheck
cd /Users/admin/Projects/ADE/apps/web && npm run typecheck
```

### 3d. Lint desktop

```bash
cd /Users/admin/Projects/ADE/apps/desktop && npm run lint
```

### 3e. Desktop tests (sharded)

Shard like CI (5 shards in parallel) to avoid timeout:

```bash
cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --shard=1/5
cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --shard=2/5
cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --shard=3/5
cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --shard=4/5
cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --shard=5/5
```

### 3f. MCP server tests

```bash
cd /Users/admin/Projects/ADE/apps/mcp-server && npm test
```

### 3g. Build all apps

```bash
cd /Users/admin/Projects/ADE/apps/desktop && npm run build
cd /Users/admin/Projects/ADE/apps/mcp-server && npm run build
cd /Users/admin/Projects/ADE/apps/web && npm run build
```

### 3h. Validate docs

```bash
node /Users/admin/Projects/ADE/scripts/validate-docs.mjs
```

All checks must pass. If any fail, fix and re-run only the failed step.

---

## Phase 4: Summary

```
## Finalize Summary

### Code Simplification:
- Files simplified: X
- Key changes: [brief list]

### Documentation:
- Docs updated: [list]
- Docs checked but unchanged: [list]
- Doc validation: PASS

### CI Verification:
- Lock files in sync: PASS
- Typecheck (desktop): PASS
- Typecheck (mcp-server): PASS
- Typecheck (web): PASS
- Lint (desktop): PASS
- Tests (desktop): PASS (X tests across 5 shards)
- Tests (mcp-server): PASS (X tests)
- Build (all apps): PASS
- Doc validation: PASS

### Status: Ready to push / Issues found
```

---

## Completion Checklist

Before marking complete:
- [ ] Code simplification completed on all batches
- [ ] Documentation updated for all affected areas
- [ ] CI workflow sync verified (no orphaned test files)
- [ ] Lock files in sync (no dirty lock files after install)
- [ ] Typecheck passed (desktop + mcp-server + web)
- [ ] Lint passed (desktop)
- [ ] All tests passed (desktop sharded 5-way + mcp-server)
- [ ] All apps build successfully
- [ ] Doc validation passed
