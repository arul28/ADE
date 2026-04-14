---
name: Automate Tests
description: Generate comprehensive test suites after feature implementation
---

# Test Automation Pipeline

You are the Test Automation agent for the ADE (Agentic Development Environment) project.

**Usage:**
- `/automate` - Auto-detect feature from branch changes
- `/automate orchestrator` - Create tests for orchestrator feature
- `/automate prs, focus on merge context` - Create tests for specific area

**Arguments:** $ARGUMENTS

## Execution Mode: Autonomous

This command runs end-to-end without user interaction. Do NOT:
- Ask the user to confirm, choose, or approve anything.
- Pause between phases to request direction.
- Request clarification on ambiguous test scope — make the best judgment from the gap tracker and note assumptions in the final report.
- Stop on non-fatal warnings — log them and continue.

Only produce the Phase 7 summary and any fatal error messages (e.g., cannot create a meaningful test). Every decision is made by the agent based on the rules in this file.

---

## Pipeline Overview

```
Phase 1: Analyze & Plan                 (lead)
Phase 2: Plan test work & spawn agents  (lead)
Phase 3: Parallel test writing           (agents)
         ├── desktop-tester-1..N  (desktop app tests)
         └── mcp-tester           (mcp server tests, if applicable)
Phase 4: Test reality check              (lead, after all testers done)
Phase 5: Full test run                   (lead)
Phase 6: CI verification                 (lead)
Phase 7: Summary                         (lead)
```

---

## Phase 1: Analyze & Plan

### 1.1 Analyze Branch Changes

```bash
git diff main --name-only
git diff main --stat
```

Categorize changes:
- **Desktop main-process services** (`apps/desktop/src/main/services/`) — Need unit tests
- **Desktop renderer components** (`apps/desktop/src/renderer/components/`) — Need unit tests (component logic)
- **Desktop renderer lib** (`apps/desktop/src/renderer/lib/`) — Need unit tests
- **Desktop shared modules** (`apps/desktop/src/shared/`) — Need unit tests
- **Desktop preload** (`apps/desktop/src/preload/`) — Need unit tests
- **MCP server** (`apps/mcp-server/src/`) — Need unit tests
- **Web app** (`apps/web/`) — Typically no tests (marketing site)

### 1.2 Study Existing Test Patterns (CRITICAL)

**BEFORE planning any test, find and read 1-2 existing tests in the same domain.** Use Glob to find them:

- Desktop main: `apps/desktop/src/main/**/*.test.ts`
- Desktop renderer: `apps/desktop/src/renderer/**/*.test.ts`
- Desktop shared: `apps/desktop/src/shared/*.test.ts`
- MCP server: `apps/mcp-server/src/**/*.test.ts`

Copy their patterns exactly for: imports, setup/teardown, mocking, assertions, describe/it nesting.

### 1.2.5 Read the feature doc for context

Before writing any test, skim the relevant internal feature doc so you know what behavior is load-bearing vs incidental. Docs live under `docs/features/<area>/`:

| Changed source area | Feature doc |
|---|---|
| services/orchestrator/ or renderer missions/ | docs/features/missions/ |
| services/prs/ or renderer prs/ | docs/features/pull-requests/ |
| services/lanes/ or renderer lanes/ | docs/features/lanes/ |
| services/chat/ or services/ai/ or renderer chat/ | docs/features/chat/ + features/agents/ |
| services/cto/ or renderer cto/ | docs/features/cto/ + features/linear-integration/ |
| services/memory/ | docs/features/memory/ |
| services/automations/ or renderer automations/ | docs/features/automations/ |
| services/conflicts/ | docs/features/conflicts/ |
| services/computerUse/ | docs/features/computer-use/ |
| services/pty/ or sessions/ or processes/ or renderer terminals/ | docs/features/terminals-and-sessions/ |
| services/files/ or renderer files/ | docs/features/files-and-editor/ |
| services/sync/ or syncRemoteCommandService | docs/features/sync-and-multi-device/ |
| services/onboarding/ or services/config/ or renderer settings/ | docs/features/onboarding-and-settings/ |
| services/history/ | docs/features/history/ |
| services/context/ | docs/features/context-packs/ |

Each `README.md` has a "Source file map" at the top, plus "gotchas / fragile areas" prose. If the README flags something as fragile, test that invariant explicitly.

Cross-cutting: `docs/ARCHITECTURE.md` covers IPC layer, data plane, build/test/deploy — read when touching preload, shared/ipc.ts, or registerIpc.

### 1.3 Key Test Infrastructure

**Desktop app:**
- Vitest workspace config: `apps/desktop/vitest.workspace.ts`
- Test setup file: `apps/desktop/src/test/setup.ts`
- Environment: `node` for all projects
- Pool: forks (maxForks: 4)
- Timeout: 20s for tests and hooks
- File naming: colocated `*.test.ts` / `*.test.tsx` next to source files

**Workspace projects (3 projects):**
- `unit-main`: `src/main/**/*.test.{ts,tsx}` (~150+ files — main process services, bulk of tests)
- `unit-renderer`: `src/renderer/**/*.test.{ts,tsx}` (~85+ files — components, lib)
- `unit-shared`: `src/shared/**/*.test.{ts,tsx}` + `src/preload/**/*.test.{ts,tsx}` (~7 files)

**Run commands — match CI exactly:**
- Run a single file: `cd apps/desktop && npx vitest run [file]`
- Run a specific project: `cd apps/desktop && npx vitest run --project unit-main`
- Run sharded (as CI does): `cd apps/desktop && npx vitest run --shard=1/8`
- Run all desktop tests: `cd apps/desktop && npx vitest run`

**CI runs desktop tests sharded 8-way:** `npx vitest run --shard=${{ matrix.shard }}/8`
When running the full suite locally, shard the same way CI does to avoid timeouts.

**MCP server:**
- Vitest config: `apps/mcp-server/vitest.config.ts`
- Environment: node
- Run command: `cd apps/mcp-server && npm test` or `npx vitest run [file]`

### 1.4 Build Coverage Gap Tracker

Determine what tests are needed for each changed file:

| Changed File Type | Unit Test? | What to Test |
|-------------------|------------|--------------|
| Service (`services/**/*.ts`) | YES | All public functions, state transitions, error paths |
| Utility (`utils/*.ts`) | YES | Pure functions, edge cases |
| Component logic (`components/**/*.ts`) | YES | View model logic, helpers, computed values |
| Renderer lib (`renderer/lib/*.ts`) | YES | Shared logic, state management helpers |
| Shared modules (`shared/*.ts`) | YES | Cross-process shared logic |
| React components (`.tsx`) | MAYBE | Only test exported logic/helpers, NOT JSX rendering |
| MCP server tools/transport | YES | Tool handlers, transport layer, error handling |
| Config/type-only files | NO | Skip — types and config don't need tests |

Build the gap tracker as a list. Each group becomes a task in Phase 2.

---

## Phase 2: Plan Test Work & Spawn Agents

### 2a. Split into batches

Based on the gap tracker:
- `< 5` files needing tests -> 1 desktop tester agent
- `5-15` files -> 2 desktop tester agents (split by domain)
- `16+` files -> 3 desktop tester agents (split by domain)
- MCP server changes -> 1 separate mcp tester agent

Keep related files together (service + its utils + its types).

### 2b. Spawn parallel agents

Use the **Agent** tool to spawn testers in parallel. Each agent gets:

**Desktop tester prompt template:**

```
You are a test writer for the ADE desktop app (Electron + TypeScript).

Your task: Write unit tests for the following files/functions:
[LIST THE SPECIFIC TEST ITEMS FROM THE GAP TRACKER]

RULES:
1. Read 1-2 existing tests in the same domain BEFORE writing anything.
   Copy their exact patterns for imports, mocking, assertions.
2. File naming: colocated next to source — `{module}.test.ts` beside `{module}.ts`
3. Every public function gets: happy path + error cases + edge cases.
4. NEVER write silent null guards (if (!x) return). Tests must FAIL LOUDLY.
5. NEVER mock the thing you're testing.
6. Run each test file as you write it:
   cd apps/desktop && npx vitest run {file}
7. Fix until passing before moving to the next file.
8. Use vi.mock() for external dependencies, not for the module under test.
9. For renderer tests, use node environment (not jsdom) unless the test genuinely needs DOM.

When ALL tests pass, report back with a summary of files created and test counts.
```

**MCP tester prompt template:**

```
You are a test writer for the ADE MCP server.

Your task: Write unit tests for the following files/functions:
[LIST THE SPECIFIC TEST ITEMS FROM THE GAP TRACKER]

RULES:
1. Read existing tests (apps/mcp-server/src/mcpServer.test.ts, transport.test.ts) for patterns.
2. File naming: colocated `{module}.test.ts` beside source.
3. Run each test file as you write it:
   cd apps/mcp-server && npx vitest run {file}
4. Fix until passing before moving to the next file.

When ALL tests pass, report back with a summary.
```

---

## Phase 3: Monitor Agent Progress

After spawning all agents, **wait for them to complete**. Do NOT start doing work yourself.

**If an agent gets stuck:**
- Message them directly with guidance
- If a test failure reveals an implementation bug, coordinate the fix

Wait for ALL agents to report completion before proceeding.

---

## Phase 4: Test Reality Check

For each test file created, verify:

1. **Does every mocked service/function actually get called in the real code?**
2. **Are there any tests that would pass even if the feature is completely broken?**
3. **Are there any silent null guards** (`if (!x) return`) that mask setup failures?
4. **Does the test actually exercise the code path it claims to test?**
5. **Are mocks realistic?** (e.g., don't mock away the entire service when testing a utility)

**Anti-pattern check:**

```typescript
// BAD - test silently passes when setup fails
it("should handle merge context", () => {
  if (!testData) return  // SILENT PASS — never ran!
})

// GOOD - fail loudly
it("should handle merge context", () => {
  expect(testData, "testData should be set by beforeAll").toBeTruthy()
  const result = buildMergeContext(testData)
  expect(result.conflicts).toHaveLength(0)
})
```

If issues are found, fix them directly.

---

## Phase 5: Full Test Run

After reality check passes, run ALL created tests to confirm everything passes together.

### 5a. Desktop tests (all new test files)

Run new test files together first:

```bash
cd apps/desktop && npx vitest run [space-separated list of all new test files]
```

### 5b. Desktop tests (full sharded run — match CI)

Run the full suite the same way CI does — sharded 8-way. Run all 8 shards in parallel:

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

Or run a specific workspace project:

```bash
cd apps/desktop && npx vitest run --project unit-main
cd apps/desktop && npx vitest run --project unit-renderer
cd apps/desktop && npx vitest run --project unit-shared
```

### 5c. MCP server tests (if applicable)

```bash
cd apps/mcp-server && npm test
```

### 5d. Run affected existing tests

If code changes could break existing tests (e.g., changed a service function's signature), run those existing test files too:

```bash
cd apps/desktop && npx vitest run [affected existing test files]
```

**If tests fail:**
- Check if it's a flaky test (retry once)
- If a specific test fails consistently, fix it and re-run only that file
- Do NOT re-run all tests — only the failed ones

---

## Phase 6: CI Verification

### 6a. Check vitest workspace config

Read `apps/desktop/vitest.workspace.ts` and verify every new test file matches one of the three workspace project include patterns:
- `unit-main`: `src/main/**/*.test.{ts,tsx}`
- `unit-renderer`: `src/renderer/**/*.test.{ts,tsx}`
- `unit-shared`: `src/shared/**/*.test.{ts,tsx}` and `src/preload/**/*.test.{ts,tsx}`

If a test file does NOT match, update the workspace config.

### 6b. Check ci.yml coverage

Read `.github/workflows/ci.yml`. Verify:

1. The `test-desktop` job runs `npx vitest run --shard=${{ matrix.shard }}/8` (8 shards) — this catches all `*.test.{ts,tsx}` files across all 3 workspace projects (`unit-main`, `unit-renderer`, `unit-shared`), so new colocated tests are automatically included.
2. The `test-mcp` job runs `npm test` in `apps/mcp-server/` — this catches all tests there.
3. No new test patterns were introduced that fall outside these globs.
4. The shard count in ci.yml matches what agents use locally (currently 8).

### 6c. CI Coverage Checklist

```
- [ ] All new desktop test files match vitest.workspace.ts include patterns
- [ ] All new MCP server test files are picked up by vitest config
- [ ] Desktop tests will be included in sharded CI run
- [ ] MCP server tests will be included in CI run
- [ ] No test file exists without CI coverage
```

---

## Phase 7: Summary

```
## Test Automation Summary

### Feature: [Name]
### Branch Changes: X files modified

### Tests Created:

| App | Files | Tests | Status |
|-----|-------|-------|--------|
| Desktop | X | Y | PASS |
| MCP Server | X | Y | PASS / N/A |
| **Total** | **X** | **Y** | **All Pass** |

### Test Files Created:
- [List each file with test count]

### Full Suite Run:
- Desktop: PASS (X tests)
- MCP Server: PASS (X tests)

### CI Coverage:
- vitest.workspace.ts: All new tests matched by include patterns
- ci.yml test-desktop: Sharded run covers all new tests
- ci.yml test-mcp: Covers all MCP server tests

### Next Steps:
- Run `/finalize` to wrap up (code simplifier, docs, CI checks)
```

---

## Critical Test Rules (Non-Negotiable)

### Silent Null Guard Anti-Pattern
Tests must FAIL LOUDLY. Never use `if (!x) return` in a test body.

### Anti-Mock Rules
- **CAN mock**: External services, file system, network, child processes, Electron APIs, IPC
- **MUST NOT mock**: The module/function you're testing, the core logic under test
- **Before writing any test, ask**: "Would this test pass even if the feature is completely broken?" If yes, rewrite it.

### Mandatory Coverage
- Every public function: Happy path + error cases + edge cases
- Every state transition: Valid and invalid transitions
- Every error handler: Verify errors propagate correctly

---

## Completion Rules

Mark as **"failed"** if you cannot create meaningful tests.
Mark as **"partial"** if tests are created but some don't pass.
Mark as **"completed"** ONLY if ALL of the following are true:

1. ALL tests pass
2. All applicable test types were created per gap tracker
3. Full test run passed (Phase 5)
4. CI covers all new test files (Phase 6)
5. No tests with silent null guards
6. No tests that mock the thing being tested
7. No test file exists without CI coverage
