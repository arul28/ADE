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

## Execution Mode: Autonomous

This command runs end-to-end without user interaction. Do NOT:
- Ask the user to confirm, choose, or approve anything.
- Pause between phases to request direction.
- Stop on non-fatal warnings — log them and continue.
- Request clarification on ambiguous simplifications — skip the risky ones and note in the final report.
- Ask before reverting your own work (e.g., Phase 3i drift check reverts simplifier edits silently).

The only outputs are the Phase 4 summary and any error messages for genuinely fatal failures (typecheck/lint errors, build crashes, test failures the agent itself caused). Every decision is made by the agent based on the rules in this file.

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

Use `subagent_type: "code-simplifier:code-simplifier"` for each batch (note the full namespaced form — plain `"code-simplifier"` is not a valid agent type).

Prompt each with:
- The list of files in their batch
- Branch context (what feature/area was changed)
- Instructions: focus on recently modified code, don't refactor untouched code
- **Explicit safety rule**: before removing code that looks dead (unused helpers, "unused" local components, stale state), grep for references **including the file's colocated `*.test.ts(x)` neighbor**. Test expectations often lag behind feature refactors — removing "unused" code can silently break a test suite that will only light up in Phase 3e. When in doubt, leave it and note in the report.
- **Diff-only scope**: `git diff main -- <file>` first; if zero diff, do not edit (a previous run tried to simplify files it thought were modified, and wasted time on unchanged code).
- **Typecheck after every file**: `cd apps/desktop && npx tsc --noEmit -p . 2>&1 | head -20`.

### Doc updater agent

The internal docs live under `docs/` with this structure (rebuilt; do NOT confuse with the public Mintlify site at repo root `docs.json` + `*.mdx`):

```
docs/
├── README.md                          # navigation map
├── PRD.md                             # product entry point — links to every feature
├── ARCHITECTURE.md                    # consolidated system architecture
├── OPTIMIZATION_OPPORTUNITIES.md      # backlog (append-only)
└── features/
    ├── agents/              ├── memory/
    ├── automations/         ├── missions/
    ├── chat/                ├── onboarding-and-settings/
    ├── computer-use/        ├── project-home/
    ├── conflicts/           ├── pull-requests/
    ├── context-packs/       ├── sync-and-multi-device/
    ├── cto/                 ├── terminals-and-sessions/
    ├── files-and-editor/    └── workspace-graph/
    ├── history/
    ├── lanes/
    └── linear-integration/
```

Each `features/<name>/` contains a `README.md` (overview + source file map at top) plus 1–4 detail `*.md` files.

Spawn a general-purpose agent with this prompt:

```
You are the documentation updater for the ADE project.

Analyze all changes on the current branch vs main and update relevant internal
docs under `docs/`. The public Mintlify site (docs.json + root-level .mdx files)
is out of scope — do NOT touch it.

Step 1: Get changed files
  git diff main --name-only
  git diff main --stat | tail -30

Step 2: Map changed source to internal docs

| Source Directory                                   | Doc Location                                       |
|----------------------------------------------------|----------------------------------------------------|
| apps/desktop/src/main/services/orchestrator/       | docs/features/missions/                            |
| apps/desktop/src/main/services/prs/                | docs/features/pull-requests/                       |
| apps/desktop/src/main/services/lanes/              | docs/features/lanes/                               |
| apps/desktop/src/main/services/memory/             | docs/features/memory/                              |
| apps/desktop/src/main/services/cto/                | docs/features/cto/ (+ linear-integration/)         |
| apps/desktop/src/main/services/ai/                 | docs/features/chat/ + features/agents/             |
| apps/desktop/src/main/services/chat/               | docs/features/chat/                                |
| apps/desktop/src/main/services/automations/        | docs/features/automations/                         |
| apps/desktop/src/main/services/computerUse/        | docs/features/computer-use/                        |
| apps/desktop/src/main/services/context/            | docs/features/context-packs/                       |
| apps/desktop/src/main/services/conflicts/          | docs/features/conflicts/                           |
| apps/desktop/src/main/services/files/              | docs/features/files-and-editor/                    |
| apps/desktop/src/main/services/history/            | docs/features/history/                             |
| apps/desktop/src/main/services/onboarding/         | docs/features/onboarding-and-settings/             |
| apps/desktop/src/main/services/pty/                | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/sessions/           | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/processes/          | docs/features/terminals-and-sessions/              |
| apps/desktop/src/main/services/sync/               | docs/features/sync-and-multi-device/               |
| apps/desktop/src/main/services/config/             | docs/features/onboarding-and-settings/             |
| apps/desktop/src/main/services/ipc/                | docs/ARCHITECTURE.md (IPC section)                 |
| apps/desktop/src/main/services/git/                | docs/ARCHITECTURE.md (Git engine section) + lanes/ |
| apps/desktop/src/preload/                          | docs/ARCHITECTURE.md (IPC contract)                |
| apps/desktop/src/shared/                           | docs/ARCHITECTURE.md + touching feature's doc      |
| apps/desktop/src/renderer/components/<area>/       | docs/features/<same-area>/                         |
| apps/desktop/src/renderer/state/                   | docs/ARCHITECTURE.md (UI framework)                |
| apps/mcp-server/                                   | docs/ARCHITECTURE.md + features/linear-integration/|
| .github/workflows/                                 | docs/ARCHITECTURE.md (Build/Test/Deploy)           |
| apps/ios/                                          | docs/features/sync-and-multi-device/ios-companion.md |
| apps/web/                                          | docs/ARCHITECTURE.md (Apps & Processes)            |

Step 3: Update docs in place
- Prefer editing existing docs over creating new ones.
- If a feature gets a genuinely new sub-concept worth its own page, add a new detail doc inside the existing features/<name>/ folder.
- Keep each README.md's "Source file map" section current — it is the primary way an agent orients itself.
- Rewrite prose to reflect current reality (not a changelog of what changed).
- Remove outdated information.
- Do NOT add changelog sections, "Updated on X" notes, or dated markers.
- Do NOT modify docs/OPTIMIZATION_OPPORTUNITIES.md via this agent — it is append-only and human-curated.

Step 4: Append-only — NEVER touch the public Mintlify site
- Do NOT modify docs.json or any *.mdx file at repo root.
- Do NOT modify ./chat/, ./tools/, ./missions/, ./changelog/, ./configuration/, ./computer-use/, ./context-packs/, ./getting-started/, ./guides/, ./automations/, ./lanes/, ./cto/ (these are Mintlify pages).

Step 5: Run doc validation
  node scripts/validate-docs.mjs

This validator only covers the Mintlify site. For internal docs, self-check:
  - Every features/<name>/README.md still has a "Source file map" section.
  - PRD.md links resolve (grep for broken relative links).

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
cd apps/desktop && npm install
cd apps/mcp-server && npm install
cd apps/web && npm install
```

After install, check for uncommitted lock file changes — if any lock file is dirty, it means package.json was modified without regenerating the lock file, which will break CI's `npm ci`:

```bash
git diff --name-only -- '*/package-lock.json'
```

If lock files changed, warn and include them in the commit.

### 3c. Typecheck all apps

Run in parallel to match CI jobs (`typecheck-desktop`, `typecheck-mcp`, `typecheck-web`):

```bash
cd apps/desktop && npm run typecheck
cd apps/mcp-server && npm run typecheck
cd apps/web && npm run typecheck
```

### 3d. Lint desktop

```bash
cd apps/desktop && npm run lint
```

### 3e. Desktop tests (sharded — match CI exactly)

Shard like CI (8 shards in parallel) to avoid timeout. The workspace has 3 projects (`unit-main`, `unit-renderer`, `unit-shared`) — sharding runs across all of them automatically:

```bash
cd apps/desktop && npx vitest run --shard=1/8
cd apps/desktop && npx vitest run --shard=2/8
cd apps/desktop && npx vitest run --shard=3/8
cd apps/desktop && npx vitest run --shard=4/8
cd apps/desktop && npx vitest run --shard=5/8
cd apps/desktop && npx vitest run --shard=6/8
cd apps/desktop && npx vitest run --shard=7/8
cd apps/desktop && npx vitest run --shard=8/8
```

Or run specific projects when you only need a subset:

```bash
cd apps/desktop && npx vitest run --project unit-main       # ~150+ main-process tests
cd apps/desktop && npx vitest run --project unit-renderer    # ~85+ renderer tests
cd apps/desktop && npx vitest run --project unit-shared      # ~7 shared/preload tests
```

### 3f. MCP server tests

```bash
cd apps/mcp-server && npm test
```

### 3g. Build all apps

```bash
cd apps/desktop && npm run build
cd apps/mcp-server && npm run build
cd apps/web && npm run build
```

### 3h. Validate docs

```bash
node scripts/validate-docs.mjs
```

This only validates the public Mintlify site (`docs.json` + `.mdx`). Also run these automated checks for the internal `docs/` tree:

```bash
# Every features/<name>/README.md has a "Source file map" section.
for d in docs/features/*/README.md; do
  grep -q "Source file map" "$d" || echo "MISSING map: $d"
done

# PRD.md links resolve.
grep -oE "\[.*\]\([^)]+\.md\)" docs/PRD.md | \
  sed -E 's/.*\(([^)]+)\).*/\1/' | \
  while read -r p; do
    test -f "docs/$p" || echo "BROKEN LINK: $p"
  done
```

Both commands should produce empty output. Any `MISSING map:` or `BROKEN LINK:` line is a failure — fix the offending doc and re-run. Do not prompt the user; resolve autonomously.

All checks must pass. If any fail, fix and re-run only the failed step.

### 3i. Test-simplifier drift check (catch Phase 2 over-reach)

When a simplifier agent removed "unused" code, the colocated test may still reference it — the test will only light up in Phase 3e. If a test failure appears **only in a file the simplifier touched (or its test sibling)**, treat it as suspect:

```bash
# Files the simplifier touched this run:
# (Run once before Phase 2; diff after to see what changed.)
git diff main --name-only | sort > /tmp/finalize-branch-files.txt

# After Phase 2, list what changed in this session on top of the prior branch state:
git diff --name-only | sort > /tmp/finalize-session-files.txt
```

If Phase 3e fails only inside files the simplifier touched, revert the simplifier's edits to those files and re-run. Do NOT rewrite the test suite in Phase 3 — tests that drift because the feature branch refactored UI are a separate follow-up.

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
- Tests (desktop): PASS (X tests across 8 shards)
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
- [ ] All tests passed (desktop sharded 8-way + mcp-server)
- [ ] All apps build successfully
- [ ] Doc validation passed
