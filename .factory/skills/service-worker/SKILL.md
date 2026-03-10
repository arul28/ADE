---
name: service-worker
description: Implements main-process services, DB schema, IPC handlers, and their tests for the ADE Electron app
---

# Service Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that are primarily main-process service layer work:
- Services in `apps/desktop/src/main/services/` (orchestrator, missions, conflicts, prs, lanes, memory, cto)
- Database schema changes in `kvDb.ts`
- IPC handler additions (registerIpc.ts, preload.ts, global.d.ts, ipc.ts)
- Shared types in `apps/desktop/src/shared/types/`
- Coordinator tools in `coordinatorTools.ts`
- State machine fixes in `orchestratorService.ts`, `aiOrchestratorService.ts`, `missionService.ts`

## Work Procedure

### Step 1: Understand the Feature

1. Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully.
2. Read `AGENTS.md` for mission boundaries and coding conventions.
3. Read `.factory/services.yaml` for test/build commands.
4. Read `.factory/library/architecture.md` for service patterns and key file locations.
5. If the feature extends existing code, read the relevant existing source files to understand patterns. Pay special attention to:
   - `orchestratorService.ts` — state machine, run/step management, attempt lifecycle
   - `aiOrchestratorService.ts` — coordinator lifecycle, worker spawning, steering, recovery
   - `coordinatorTools.ts` — all 40+ coordinator tools
   - `missionService.ts` — mission CRUD, interventions, state transitions
   - `coordinatorAgent.ts` — coordinator AI agent, system prompt, planning flow

### Step 2: Plan Implementation

1. Identify all files that need to be created or modified.
2. For IPC channels: you MUST update ALL FOUR files (ipc.ts, registerIpc.ts, preload.ts, global.d.ts).
3. For new services: follow the `createXxxService({...deps})` factory function pattern.
4. For DB changes: use `CREATE TABLE IF NOT EXISTS` in kvDb.ts's migrate() function.
5. For state machine changes: map out all affected transitions and ensure no illegal state combinations.
6. For coordinator tool changes: ensure tool descriptions are clear for AI consumption.

### Step 3: Write Tests First (TDD)

1. Create the test file FIRST (e.g., `myService.test.ts`).
2. Follow the `createFixture()` pattern from existing tests:
   - Create a temp directory
   - Open a real SQLite database via `openKvDb()`
   - Insert any seed data needed
   - Instantiate the service with real or mocked dependencies
   - Write test cases that exercise all expected behaviors
3. Run tests — they should FAIL (red phase): `cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --reporter=verbose <testfile>`
4. Each assertion from the feature's `expectedBehavior` should have at least one corresponding test case.
5. Cover edge cases: empty database, boundary values, error conditions, concurrent operations.

### Step 4: Implement

1. Make the minimal changes needed to pass the tests.
2. Follow existing patterns in the file you're modifying — match coding style, naming conventions, error handling patterns.
3. For state machine changes: add invariant checks that throw if illegal state combinations are detected.
4. For intervention changes: ensure deduplication logic exists (check for existing open intervention before creating).
5. For coordinator tool changes: update tool descriptions and parameter schemas.
6. Run tests — they should PASS (green phase).

### Step 5: Verify

1. Run your tests: `cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run --reporter=verbose <testfile>`
2. Run the full test suite: `cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run`
   - Your new tests must pass.
   - 2 pre-existing failures are expected (see AGENTS.md).
3. Run typecheck: `cd /Users/admin/Projects/ADE/apps/desktop && npx tsc --noEmit`
   - Must produce no NEW errors. Pre-existing errors may exist.
4. Review your changes for correctness, edge cases, and adherence to the spec.

### Step 6: Commit

Commit your changes with a descriptive message. Stage only the files you created/modified.

## Example Handoff

```json
{
  "salientSummary": "Fixed worktree isolation: workers now always execute in their lane's worktree_path, never falling back to projectRoot. Added state invariant check in transitionMissionStatus that rejects intervention_required when any run is active. Ran `npx vitest run src/main/services/orchestrator/worktreeIsolation.test.ts` — 8 tests passing. Full suite: 1013 pass, 2 pre-existing failures. Typecheck clean.",
  "whatWasImplemented": "Modified startAttempt() in orchestratorService.ts to resolve cwd from lane.worktree_path instead of falling back to projectRoot when worktree_path is null (now throws configuration_error). Added buildFullPrompt() worktree constraint injection. Added state invariant in transitionMissionStatus() that calls pauseRun() for any active runs before allowing intervention_required transition.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run src/main/services/orchestrator/worktreeIsolation.test.ts --reporter=verbose",
        "exitCode": 0,
        "observation": "8 tests passing: lane worktree as cwd, null worktree fails, prompt contains constraint, state invariant rejects active+intervention, parent step reflects variant failures"
      },
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run",
        "exitCode": 0,
        "observation": "102 files, 1013 tests pass, 2 pre-existing failures. No regressions."
      },
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx tsc --noEmit",
        "exitCode": 0,
        "observation": "No new type errors."
      }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "src/main/services/orchestrator/worktreeIsolation.test.ts",
        "cases": [
          { "name": "resolves cwd to lane worktree_path", "verifies": "VAL-ISO-001" },
          { "name": "fails attempt when worktree_path is null", "verifies": "VAL-ISO-001" },
          { "name": "prompt includes worktree constraint", "verifies": "VAL-ISO-002" },
          { "name": "rejects intervention_required with active run", "verifies": "VAL-STATE-001" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires modifying renderer components (use ui-worker instead)
- A dependency service referenced in preconditions doesn't exist or has a different API than expected
- The existing state machine has transitions you didn't expect that conflict with the feature
- Changes would affect more than 3 major service files (scope too large for one worker)
- You discover a bug that's not part of your feature but blocks your work
- Orchestrator insight: note any pattern you see about how the coordinator/orchestrator could work better
