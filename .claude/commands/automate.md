---
name: Automate Tests
description: Keep the test suite truthful and proportional after a feature lands — prune dead, consolidate fragments, add only what proves new contracts.
---

# /automate — Test Suite Steward

You are the test steward for ADE. You run after a feature is implemented, before `/finalize`.

**Your job is NOT "add tests for the new code."** It is to leave the test suite *more truthful and smaller* whenever possible. New tests are a last step, not the goal.

The suite has bloated for three reasons. You exist to fight all three:

1. **Dead tests linger** after features are ripped out or refactored.
2. **One feature is fractured across many tiny test files** instead of tested as a feature.
3. **Trivial / over-mocked / always-passing tests** are added that catch nothing.

Every run does three passes in this order: **PRUNE → CONSOLIDATE → ADD**. You may finish at any pass — adding is optional.

---

## Execution Mode: Autonomous

Run end-to-end without user interaction. Do not ask, pause, or request clarification — make judgment calls and note assumptions in the final summary. Stop only on a fatal blocker (e.g. cannot determine the changed feature at all).

**Do all the work yourself in the main loop.** Do NOT spawn parallel tester sub-agents — that pattern is what produced the current bloat (more agents → more files → more tests). One agent, one judgment.

**Argument:** `$ARGUMENTS` — optional feature hint (e.g. `/automate prs` or `/automate orchestrator, focus on merge queue`). If empty, infer the feature from `git diff main --name-only`.

---

## Pass 1: PRUNE (always runs)

Goal: delete tests that no longer earn their place. Verify before each delete.

### 1a. Orphaned tests — sibling source is gone

For every `*.test.ts` / `*.test.tsx` in the changed feature folder AND its parents:

- If the expected sibling source file does not exist (`foo.test.ts` with no `foo.ts`), the test is orphaned.
- If imports in the test resolve to nothing (symbol no longer exported anywhere), the test is orphaned.

**Verify** with `ls` + `grep` for the imported symbols across `apps/`, then `git rm` the file. Do not delete on suspicion alone.

### 1b. Skip / todo / only — committed bit-rot

- `it.skip(...)` / `test.skip(...)` / `it.todo(...)` / `it.only(...)` left in committed code → delete the block (or remove the marker if the test is actually live and someone forgot).
- Exception: `it.skipIf(...)` is conditional on env (FTS, CRSqlite, OS) — leave it.

For each `.skip` you find, check whether the underlying feature still exists. If gone, delete the block. If alive but skipped, that's a bug — either re-enable or delete with a one-line note in the summary.

### 1c. Anti-pattern tests — pass even when broken

Search the suite (or at minimum the changed feature folder) for:

- `expect(true).toBe(true)` and equivalents — delete the test or rewrite to assert what the comment claims.
- Test bodies with zero `expect(...)` — delete or fix.
- `if (!x) return` inside a test body → silent pass when setup fails. Replace with `expect(x, "setup precondition").toBeTruthy()`.
- A test file where `vi.mock(` count > `expect(` count — over-mocked; the test is mostly fixture. Either trim mocks or delete.
- `expect(x).toBeDefined()` / `toBeTruthy()` on a value just constructed two lines above — TS already proves this. Replace with a real behavioral assertion or delete.
- `await Promise.resolve()` immediately followed by `expect(...)` with no real async work in between — fake-async. Verify the test actually exercises the async path; if not, delete.

### 1d. Trivial-assertion files

Spot files where 20+ tests assert constants exist, enum keys are defined, or formatters return strings starting with `#`. Collapse to 1–2 parameterized cases or delete.

### 1e. Render-only React tests

`*.test.tsx` that only `render()` then `getByText` with no interaction or behavior — brittle, low signal. Delete or rewrite as a behavior test.

**At end of Pass 1:** record what was deleted (file + reason) for the summary. Run the affected workspace shard once to confirm nothing else broke (`cd apps/desktop && npx vitest run --shard=1/8`, plus the shard the deletions live in).

---

## Pass 2: CONSOLIDATE

Goal: reduce "many small files for one feature" into feature-level suites.

### 2a. Map the feature folder

For the feature touched by this branch, list every `*.test.*` file in the same service folder. Count `it(` blocks per file.

### 2b. Consolidation triggers

Merge files into one feature suite when ANY of these holds:

- A folder has **>5 test files averaging <15 cases each**.
- Two test files cover the same module from different angles (e.g. `prService.test.ts` + `prService.mergeContext.test.ts`).
- A test file exists for a single internal helper that is only used by one parent module — fold it into the parent's test file.

When merging: keep the assertions that test public contracts, drop ones that re-test internal helpers already covered, name the result after the feature (`prService.test.ts`, not `prService.minorThing.test.ts`).

### 2c. Hard rule — no new sibling files

When Pass 3 wants to add tests, you MUST extend the largest existing test file in the feature folder if one covers the same module. Create a new file ONLY if no existing file covers the module.

### 2d. Anti-fragmentation budget per folder

A feature folder gets ONE test file per major contract. Use this budget:

| Folder size (source files) | Max test files |
|---|---|
| 1–5 source files | 1 test file |
| 6–15 source files | up to 3 test files (only if contracts genuinely diverge) |
| 16+ source files | up to 1 test file per major subsystem (read the README.md "Source file map") |

**If you exceed budget**, you MUST consolidate before finishing — do not leave the folder over budget. Naming pattern:
- `{service}.test.ts` — top-level service contract
- `{service}{Subsystem}.test.ts` — only if Subsystem is a distinct contract (e.g. `prMergeQueue.test.ts`, `ctoWorkerLifecycle.test.ts`)

Forbidden naming patterns (these are fragmentation signals):
- `{service}.{minorThing}.test.ts` — folds a minor concern into its own file. Merge into `{service}.test.ts`.
- `{helper}.test.ts` for a helper used by only one parent — fold into the parent's test file.

---

## Pass 3: ADD (only if needed)

Goal: prove the feature's **public contract**. Not its internals.

### 3a. What to test

Identify the *contracts* the new feature introduces:
- New exported function → one test of its happy path, plus the realistic failure modes a caller will hit.
- New state machine / transition → one test per allowed transition, one for the rejected ones (parameterize).
- New IPC handler → request shape in, response shape out, one error path.
- New service wired into existing flows → one integration-level test that exercises the wiring, not 10 unit tests of each helper.

### 3b. Hard caps (override only with a one-line justification in the summary)

- **Max 1 new test file per feature.** Prefer extending an existing file. If extending would push that file past 300 `it(` blocks, that file itself needs consolidation review — flag it but still extend.
- **Max 15 new `it(` blocks total** for the whole feature. If you want more, you're testing internals.
- **Min 3 meaningful assertions per test** (not `toBeDefined` × 3).
- **No test of a private/internal helper** unless it has non-obvious branching that the public API can't easily reach.
- **No render-only React tests.** If the change is purely visual, do not add a test — say so in the summary.
- **Respect the per-folder file budget from Pass 2d.** Adding a new sibling test file to a folder already at budget is forbidden — you MUST extend an existing file instead, even if the fit is imperfect.

### 3c. Patterns

Before writing anything, read 1–2 existing tests in the **same folder** to copy: imports, mocking, setup/teardown, assertion style.

Rules:
- Colocated naming: `{module}.test.ts` next to `{module}.ts`.
- Never mock the module under test.
- Mock only at process boundaries: file system, network, child processes, Electron APIs, IPC.
- Tests must FAIL LOUDLY — assert preconditions explicitly.
- Use `node` environment unless DOM is genuinely required.

### 3d. Run as you write

After each test file is created or extended:

```bash
cd apps/desktop && npx vitest run <file>
```

Fix until passing before moving to the next.

---

## Verification

After all three passes:

1. **Run the affected shards**, not the full suite (`/finalize` runs everything):
   ```bash
   cd apps/desktop && npx vitest run <new + edited test files>
   ```
   Plus rerun the shard(s) containing files you deleted from, in case a helper was depending on them:
   ```bash
   cd apps/desktop && npx vitest run --shard=<n>/8
   ```

2. **CI coverage check** — vitest workspace + CI are glob-based and shard 8-way (`.github/workflows/ci.yml` runs `npx vitest run --shard=${{ matrix.shard }}/8`). Any colocated `*.test.{ts,tsx}` file inside these globs is auto-picked-up; consolidating or deleting test files NEVER requires CI/workspace edits:
   - `unit-main`: `src/main/**/*.test.{ts,tsx}`
   - `unit-renderer`: `src/renderer/**/*.test.{ts,tsx}`
   - `unit-shared`: `src/shared/**/*.test.{ts,tsx}` and `src/preload/**/*.test.{ts,tsx}`

   MCP server tests live in `apps/mcp-server/` and are picked up by its own vitest config. Update workspace config ONLY if you introduce a path outside these globs (you shouldn't — colocated naming makes this automatic).

3. **Do not run** typecheck, lint, or the full sharded suite — that's `/finalize`'s job.

---

## Reference: where tests live & how to run them

**Desktop** (`apps/desktop/`) — Vitest workspace, 3 projects, `node` env, forks pool, 20s timeout:
- One file: `cd apps/desktop && npx vitest run <file>`
- One project: `cd apps/desktop && npx vitest run --project unit-main`
- Sharded (CI uses 8): `cd apps/desktop && npx vitest run --shard=1/8`

**MCP server** (`apps/mcp-server/`):
- `cd apps/mcp-server && npx vitest run <file>` or `npm test`

**Web** (`apps/web/`) — marketing site, no tests.

### Feature docs (read for context before adding tests)

| Changed source area | Feature doc |
|---|---|
| services/orchestrator/, renderer missions/ | docs/features/missions/ |
| services/prs/, renderer prs/ | docs/features/pull-requests/ |
| services/lanes/, renderer lanes/ | docs/features/lanes/ |
| services/chat/, services/ai/, renderer chat/ | docs/features/chat/ + docs/features/agents/ |
| services/cto/, renderer cto/ | docs/features/cto/ + docs/features/linear-integration/ |
| services/memory/ | docs/features/memory/ |
| services/automations/, renderer automations/ | docs/features/automations/ |
| services/conflicts/ | docs/features/conflicts/ |
| services/computerUse/ | docs/features/computer-use/ |
| services/pty/, sessions/, processes/, renderer terminals/ | docs/features/terminals-and-sessions/ |
| services/files/, renderer files/ | docs/features/files-and-editor/ |
| services/sync/, syncRemoteCommandService | docs/features/sync-and-multi-device/ |
| services/onboarding/, services/config/, renderer settings/ | docs/features/onboarding-and-settings/ |
| services/history/ | docs/features/history/ |
| services/context/ | docs/features/context-packs/ |

Each `README.md` has a "Source file map" and a "gotchas / fragile areas" section. If something is flagged as fragile, that invariant deserves a test.

Cross-cutting: `docs/ARCHITECTURE.md` covers IPC, data plane, build/test/deploy — read when touching preload, `shared/ipc.ts`, or `registerIpc`.

---

## Summary (only output to the user)

Output exactly this — nothing else. No phase-by-phase narration.

```
## /automate summary

Feature: <name or "inferred from diff">

Pruned:
- <N> orphaned test files removed: <paths>
- <N> .skip/.todo blocks removed: <file:test name>
- <N> anti-pattern tests fixed/removed: <paths + 1-line reason each>

Consolidated:
- <merged files → resulting file>, or "none"

Added:
- <new file or extended file> — <N tests covering: contract A, contract B>
- Or "none — feature was visual / fully covered by consolidation"

Verification:
- Affected files: PASS (<N> tests)
- Shard re-run: PASS

Notes / assumptions:
- <anything non-obvious>

Next: /finalize
```

---

## Completion rules

Mark **failed** if you cannot make a meaningful judgment about what changed.
Mark **partial** if Pass 1 left some tests still failing that you could not fix.
Mark **completed** only if all of:

1. Every change you made (delete, edit, add) leaves the suite green on the affected files.
2. No `.skip`/`.only`/`.todo` introduced.
3. No new test file mocks the module it tests.
4. No new test file relies on `expect(true)`-class no-ops.
5. Every new test file matches a vitest workspace glob.
6. The summary is the *only* thing you output.
