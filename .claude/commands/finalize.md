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
Phase 1: Analyze code changes and batch simplification work  (lead)
Phase 2: Parallel execution (simplify + docs + mobile + cli)  (agents)
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

### 1e. Snapshot pre-Phase-2 file list (used by 3i drift check)

```bash
git diff main --name-only | sort > /tmp/finalize-branch-files.txt
```

---

## Phase 2: Parallel Execution

**Preferred orchestration: `TeamCreate`.** Spawn the four agents below as one team so progress is tracked, inboxes catch cross-agent messages, and a single completion event surfaces the whole batch. Per the global git-worktrees policy, do **not** pass worktree isolation — all agents work in the main directory.

Fallback: if `TeamCreate` is unavailable in the current harness (or if running outside Claude entirely), spawn them as parallel `Agent` calls in a single tool-call round and aggregate their reports manually before Phase 3.

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
| apps/desktop/src/main/services/projects/           | docs/features/project-home/                        |
| apps/desktop/src/main/services/proof/              | docs/features/proof.md                             |
| apps/desktop/src/main/services/review/             | docs/features/pull-requests/                       |
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
| apps/ade-cli/                                      | docs/ARCHITECTURE.md (ADE CLI / Build/Test/Deploy) + docs/features/agents/ |
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

Step 4: Run doc validation
  node scripts/validate-docs.mjs

This validator only covers the Mintlify site. For internal docs, self-check:
  - Every features/<name>/README.md still has a "Source file map" section.
  - PRD.md links resolve (grep for broken relative links).

Report what docs were updated and what was changed.
```

### Mobile parity agent

Spawn a general-purpose agent with this prompt:

```
You are the mobile parity reviewer for the ADE project.

Analyze all work on the current branch vs main, including changes that are
already under review and any simplifications made during `/finalize`. Determine
whether the iOS companion app under `apps/ios/` needs matching updates.

Step 1: Get branch context
  git diff main --name-only
  git diff main --stat | tail -30
  git log main..HEAD --oneline

Step 2: Identify cross-platform changes
- Shared contracts: apps/desktop/src/shared/**, preload IPC types, sync payloads,
  PR mobile snapshots, chat/session models, lane summaries, config schemas.
- Desktop behavior with a mobile surface: PR workflows, lanes, Work chat,
  files, sync/multi-device, settings exposed on iOS, model/session controls.
- Renderer-only desktop preferences are only mobile-applicable when the iOS app
  has the same user-facing concept and a native implementation path.

Step 3: Inspect iOS equivalents
- Search `apps/ios/ADE` and `apps/ios/ADETests` for the affected model, view,
  service, or workflow names.
- If the branch adds or changes a host/mobile contract, update Swift Codable
  models and iOS tests as needed.
- If the branch changes user-facing behavior that iOS already exposes, update
  the SwiftUI view using native iOS controls and existing ADE design patterns.
- If the change is not applicable to iOS, explain why in the report.

Step 4: Apply required iOS updates
- Keep edits scoped to `apps/ios/` unless a shared contract fix is required.
- Prefer existing SwiftUI patterns and native controls.
- Preserve Dynamic Type, VoiceOver labels, and 44x44 tap targets.
- Add or update targeted tests in `apps/ios/ADETests` for contract changes.

Step 5: Validate what you touched
- At minimum: `xcrun swiftc -parse <changed swift files>` when a full Xcode
  build/test run is unavailable.
- Prefer an iOS build/test when the local simulator/runtime environment supports it.

Report:
- iOS files changed, or "No iOS changes required"
- Why each desktop/shared change was applicable or not applicable to mobile
- Validation run and any environment limitations
```

### CLI parity agent

The `apps/ade-cli/` package is the agent-facing surface for ADE. Every desktop
action should be reachable either through a typed subcommand (`ade lanes …`,
`ade prs …`, `ade chat …`, `ade tests …`, `ade run …`, `ade proof …`) or
through the generic `ade actions run <domain.action>` registry exposed by
`adeRpcServer.ts`. When a feature branch adds, renames, or removes a desktop
feature, the CLI silently drifts unless someone updates it in the same PR.
This agent closes that gap.

Spawn a general-purpose agent with this prompt:

```
You are the ADE CLI parity reviewer.

The ADE CLI (apps/ade-cli) is the primary agent-facing interface to the ADE
desktop app. Its goal is to surface every meaningful action inside ADE
desktop — either as a typed subcommand or via the generic
`ade actions run <domain.action>` registry. When desktop changes, the CLI
must change with it. Your job is to detect drift on this branch and patch
apps/ade-cli/ so the CLI stays in lockstep with desktop.

Step 1: Get branch context
  git diff main --name-only
  git diff main --stat | tail -30
  git log main..HEAD --oneline

Step 2: Identify CLI-relevant desktop changes
Treat anything under these paths as a candidate for new / changed / removed
CLI surface:
- apps/desktop/src/main/services/**  (each service is a candidate action
  domain — lanes, prs, chat, tests, proof, run, git, files, missions,
  automations, computerUse, context, conflicts, history, memory, onboarding,
  pty, sessions, processes, sync, config, cto, ai)
- apps/desktop/src/preload/**  and  apps/desktop/src/shared/**  (IPC and
  shared contracts the CLI ultimately calls through)
- New domains/actions registered with the action registry on either side

Step 3: Map each candidate to the CLI
- Typed subcommands live in apps/ade-cli/src/cli.ts (~3300 lines), a
  case-based dispatcher. Existing cases include lanes, git-status, prs-list,
  chat-list, tests-runs, proof-list, actions-list, action-result, etc.
  Locate the closest existing case block and either extend it or add a
  sibling case alongside it.
- The RPC + actions-registry surface lives in
  apps/ade-cli/src/adeRpcServer.ts (~6500 lines), with a no-desktop fallback
  in apps/ade-cli/src/headlessLinearServices.ts. New service actions usually
  need wiring in one or both so `ade actions run <domain.action>` resolves
  them whether or not the desktop socket is up.
- The user-facing inventory lives in apps/ade-cli/README.md under
  "CLI surface". Keep it accurate whenever a typed command is added,
  renamed, or removed.

Step 4: Apply auto-fix edits — scoped to apps/ade-cli/ only
- New feature: add a typed subcommand if the desktop feature is a distinct
  user-facing workflow (lane / PR / chat / test / run / proof / mission /
  automation / etc.). If it is just a new low-level service action, ensure
  it is reachable via the actions registry and skip a typed wrapper.
- Renamed or behavior-changed feature: update the existing case to match
  new parameters, IPC names, or output shape. Keep flag names stable when
  possible — flag any breaking renames in the report.
- Removed feature: delete the dead case and any registry wiring. Do NOT
  leave a stub. Drop the corresponding README line.
- Reuse existing patterns: match surrounding cases for argv parsing,
  --text / --json output mode, error formatting, and --lane / --project-root
  argument handling. Do not invent new dispatch styles.

Step 5: Validate locally before reporting
  cd apps/ade-cli && npm run typecheck
  cd apps/ade-cli && npm test

If tests fail in files you did not touch, leave them — Phase 3 handles
test-suite drift. Do not rewrite unrelated tests.

Out of scope:
- Do NOT edit anything under apps/desktop/.
- Do NOT touch docs/ — the docs agent owns that.
- Do NOT refactor unrelated CLI code.

Report:
- apps/ade-cli/ files changed (or "no CLI changes required")
- For each branch change: desktop change → CLI change, or why not applicable
- Any breaking flag / command renames
- typecheck and test results
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

### Documentation:
- Docs updated: [list]
- Docs checked but unchanged: [list]
- Doc validation: PASS

### Mobile Parity:
- iOS changes: [list or "none required"]
- Applicability notes: [brief list]
- Validation: PASS / blocked with reason

### CLI Parity:
- apps/ade-cli files changed: [list or "none required"]
- Desktop change → CLI change mapping: [brief list]
- Breaking flag/command renames: [list or "none"]
- Validation (typecheck + tests): PASS / blocked with reason

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

Before marking complete: every Phase 3 step (3a–3j) must report PASS in the Phase 4 summary, and all four Phase 2 agents (simplify, docs, mobile, cli) must have reported back. Remote PR review is **not** declared clean by `/finalize` — handoff to `/shipLane` (Phase 3j) is mandatory after push.
