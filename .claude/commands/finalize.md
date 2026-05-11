---
name: finalize
description: 'Final gate: simplify code, validate docs, and run local CI checks before pushing'
---

# Finalize Command

This command is the final gate before pushing and opening a PR.

It guarantees three outcomes:
1. Code quality cleanup is complete
2. Docs changed by `/automate` are still valid
3. Local CI checks pass

It does **not** guarantee that remote PR review is complete after a push. GitHub's
first visible check list can look quiet before delayed checks, bot reviews, and
inline comments arrive. After pushing a finalized branch, hand off to
`/shipLane` or an equivalent PR poll loop. Use the ship-lane cadence: poll
immediately after a push, wait 270s if CI has not registered, wait 720s while CI
is running, and wait 1800s only when CI is done and the PR is just waiting on
review.

**Usage:** `/finalize`

## Execution Mode: Autonomous

This command runs end-to-end without user interaction. Do NOT:
- Ask the user to confirm, choose, or approve anything.
- Pause between phases to request direction.
- Stop on non-fatal warnings — log them and continue.
- Request clarification on ambiguous simplifications — skip the risky ones and note in the final report.
- Ask before reverting your own work (e.g., Phase 3i drift check reverts simplifier edits silently).

Outputs are exactly two things: the Phase 4 summary, and fatal-error messages (typecheck, lint, build, or self-caused test failures). Every other decision is made by the agent based on the rules in this file.

## Guardrails (read once, apply everywhere)

- Do NOT touch the public Mintlify site: `docs.json` and any root-level `*.mdx`, plus the root-level dirs `chat/`, `tools/`, `missions/`, `changelog/`, `configuration/`, `computer-use/`, `context-packs/`, `getting-started/`, `guides/`, `automations/`, `lanes/`, `cto/`. Internal docs under `docs/` are in scope.
- Do NOT modify `docs/OPTIMIZATION_OPPORTUNITIES.md` — append-only, human-curated.
- Do NOT run `apps/mcp-server` checks; the MCP server was removed. The agent surface is `apps/ade-cli`.
- Do NOT skip the sharded test run or substitute project-subset runs for it. `/finalize` is the gate that runs the full suite.
- Do NOT use bare `pkill -f vitest` / `pkill -f node`. Always scope to `apps/desktop`, `apps/ade-cli`, or `apps/web`.
- Do NOT declare remote PR review clean from `/finalize` alone — see Phase 3j handoff.

## Pipeline Overview

```
Phase 1: Analyze & Prepare Code Simplification         (lead)
Phase 2: Code Simplification                           (agents)
Phase 3: CI sync + local verification                  (lead)
Phase 4: Summary                                       (lead)
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

### 1e. Snapshot pre-Phase-2 file list (used by 3i drift check)

```bash
git diff main --name-only | sort > /tmp/finalize-branch-files.txt
```

---

## Phase 2: Code Simplification

Spawn 1–3 simplifier agents based on batch size from Phase 1c. Use TeamCreate when available; parallel Agent calls otherwise. Per the global git-worktrees policy, do **not** pass worktree isolation — all agents work in the main directory.

Use `subagent_type: "code-simplifier:code-simplifier"` for each batch (note the full namespaced form — plain `"code-simplifier"` is not a valid agent type).

Prompt each with:
- The list of files in their batch
- Branch context (what feature/area was changed)
- Instructions: focus on recently modified code, don't refactor untouched code
- **Explicit safety rule**: before removing code that looks dead (unused helpers, "unused" local components, stale state), grep for references **including the file's colocated `*.test.ts(x)` neighbor**. Test expectations often lag behind feature refactors — removing "unused" code can silently break a test suite that will only light up in Phase 3e. When in doubt, leave it and note in the report.
- **Diff-only scope**: `git diff main -- <file>` first; if zero diff, do not edit (a previous run tried to simplify files it thought were modified, and wasted time on unchanged code).
- **Typecheck after every file**: `cd apps/desktop && npx tsc --noEmit -p . 2>&1 | head -20`.

Wait for all simplifier agents to complete before moving to Phase 3.

Docs, mobile, CLI, and TUI parity reviewers have moved to `/automate` — they should run before `/finalize`. Do not re-spawn them here.

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
cd apps/ade-cli && npm install
cd apps/web && npm install
```

After install, check for uncommitted lock file changes — a dirty lock file means `package.json` was modified without regenerating the lock, which will break CI's `npm ci`:

```bash
git diff --name-only -- '*/package-lock.json'
```

This is a **hard gate**: if any lock file is dirty, stage it (`git add <path>`) and report it in the Phase 4 summary so the user commits it before pushing. Do not proceed past 3b with dirty lock files.

### 3c. Typecheck all apps

Run in parallel to match CI jobs (`typecheck-desktop`, `typecheck-ade-cli`, `typecheck-web`):

```bash
cd apps/desktop && npm run typecheck
cd apps/ade-cli && npm run typecheck
cd apps/web && npm run typecheck
```

### 3d. Lint desktop

```bash
cd apps/desktop && npm run lint
```

### 3e. Tests — desktop sharded 8-way + ade-cli, ALL 9 commands in one parallel round

`/finalize` is the gate that runs the whole test suite. Issue these **9 commands as concurrent Bash tool calls in a single message**. Do not chain with `&&`/`;`, do not run them sequentially — that takes 9× longer and masks real CI wall-clock behavior. Mirrors `.github/workflows/ci.yml` jobs `test-desktop` (matrix 1–8) and `test-ade-cli`:

```bash
cd apps/desktop && npx vitest run --shard=1/8
cd apps/desktop && npx vitest run --shard=2/8
cd apps/desktop && npx vitest run --shard=3/8
cd apps/desktop && npx vitest run --shard=4/8
cd apps/desktop && npx vitest run --shard=5/8
cd apps/desktop && npx vitest run --shard=6/8
cd apps/desktop && npx vitest run --shard=7/8
cd apps/desktop && npx vitest run --shard=8/8
cd apps/ade-cli  && npm test
```

The desktop workspace has 3 projects (`unit-main`, `unit-renderer`, `unit-shared`); sharding distributes across all three automatically.

If a shard fails, **re-run ONLY the failing test file(s)** — not the whole shard, and never the full sharded run. Sharding is a wall-clock optimization for the *initial* gate; once you've isolated which file failed, the cheapest signal is `npx vitest run <path/to/file.test.tsx>`. A 90-second shard rerun to verify a 5-second one-file fix is wasted time and burns the prompt cache.

Anti-pattern (do NOT do this):
- "Shard 1 had failures, let me rerun shard 1" → wrong; rerun just the failing file.
- "I fixed the failing file, let me rerun the whole shard to be sure" → wrong; rerun just that file. The other tests in the shard already passed and didn't change.
- "Let me rerun all 8 shards after a one-file fix" → wrong; this is the worst option.

Only run the full sharded suite once at the start of Phase 3e. After that, narrow scope to failing files until they pass, then move on.

Workspace-project subsets exist for debugging only; they are NOT a substitute for the sharded run:

```bash
cd apps/desktop && npx vitest run --project unit-main       # ~150+ main-process tests
cd apps/desktop && npx vitest run --project unit-renderer   # ~85+ renderer tests
cd apps/desktop && npx vitest run --project unit-shared     # ~7 shared/preload tests
```

### 3f. Build all apps

```bash
cd apps/desktop && npm run build
cd apps/ade-cli && npm run build
cd apps/web && npm run build
```

### 3g. Validate docs

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

### 3h. Test-simplifier drift check (catch Phase 2 over-reach)

If Phase 3e fails only in files the simplifier touched (or their `*.test.ts(x)` siblings), treat it as drift, not a real failure. The pre-Phase-2 snapshot lives at `/tmp/finalize-branch-files.txt` (written in 1e); compare against current diff to see what the simplifier added on top:

```bash
git diff --name-only | sort > /tmp/finalize-session-files.txt
comm -13 /tmp/finalize-branch-files.txt /tmp/finalize-session-files.txt
```

Revert the simplifier's edits to the offending files and re-run **only the failing test file** (not the full shard). Do NOT rewrite the test suite in Phase 3 unless the user explicitly asks — tests that drift because the feature branch refactored UI are a separate follow-up by default.

### 3i. Cleanup lingering processes

The parallel shards, typecheck, lint, and build commands in Phase 3 sometimes leave worker processes hanging after the phase exits — most commonly vitest worker pools from the 8-shard run, and tsup/esbuild workers from `npm run build`. They don't fail the CI check, but they sit in memory, can hold file locks, and pile up across repeated `/finalize` runs.

After Phase 3 passes, kill orphaned workers. Always scope to ADE app paths (see Guardrails):

```bash
PATTERN='(vitest|tsup|tsc --noEmit|eslint).*apps/(desktop|ade-cli|web)'

# 1. List what's lingering before killing anything
pgrep -fa "$PATTERN" || echo "  (no orphans)"

# 2. SIGTERM, wait 2s, then SIGKILL stragglers
pgrep -f  "$PATTERN" | xargs -r kill    2>/dev/null
sleep 2
pgrep -f  "$PATTERN" | xargs -r kill -9 2>/dev/null || true
```

Also watch for orphaned node-pty or Electron helper processes if the tests spawned subprocesses (rare, but happens):

```bash
pgrep -fa "node-pty|Electron Helper" | grep -E "apps/desktop" | head
```

Kill selectively only if the parent is clearly gone (PPID == 1 on macOS/Linux).

Report killed PIDs in the Phase 4 summary under "Cleanup" so the user can see what happened.

### 3j. Remote PR poll handoff

If this finalize run is followed by a push or PR update, do not treat the first
`gh pr checks` result as authoritative proof that remote review is done. Some
checks and bot review systems appear late or post comments after the initial CI
surface looks complete. In particular:

- `gh pr checks` can omit delayed or still-registering provider checks.
- Bot reviewers can post inline comments after CI jobs have already gone green.
- The absence of new comments immediately after a push is not evidence that no
  more comments are coming.

Handoff rule:

```bash
# After the branch is pushed, continue with /shipLane or equivalent:
# - poll PR checks, status rollup, review comments, issue comments, and reviews
# - poll immediately after a push so early CI registration/failures are visible
# - if CI has not started yet, wait 270s
# - if any check is QUEUED/IN_PROGRESS/PENDING, wait 720s
# - if CI is done and the PR is only waiting on review, wait 1800s
# - poll again before declaring the PR clean or ready for human merge
```

If `/finalize` is running as a sub-step inside `/shipLane`, return a summary that
explicitly says remote checks/comments still require the ship-lane poll loop.
Do not report "PR clean" from `/finalize` alone.

---

## Phase 4: Summary

```
## Finalize Summary

### Code Simplification:
- Files simplified: X
- Key changes: [brief list]

### CI Verification:
- Lock files in sync: PASS
- Typecheck (desktop): PASS
- Typecheck (ade-cli): PASS
- Typecheck (web): PASS
- Lint (desktop): PASS
- Tests (desktop): PASS (X tests across 8 shards)
- Tests (ade-cli): PASS (X tests)
- Build (all apps): PASS
- Doc validation: PASS

### Cleanup:
- Orphan processes killed: N (PIDs: [list] or "none")

### Remote PR Handoff:
- Post-push polling required: YES
- Poll loop: `/shipLane` branch-specific cadence
- Reason: delayed checks and bot comments may arrive after first visible green state

### Status: Ready to push / Issues found
```

---

## Completion Checklist

Before marking complete: every Phase 3 step (3a–3j) must report PASS in the Phase 4 summary, and Phase 2 simplifier agents must have reported back. Remote PR review is **not** declared clean by `/finalize` — handoff to `/shipLane` (Phase 3j) is mandatory after push.
