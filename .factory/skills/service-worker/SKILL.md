---
name: service-worker
description: Implements main-process services, DB schema, IPC handlers, and their tests for the ADE Electron app
---

# Service Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that are primarily main-process service layer work:
- New services in `apps/desktop/src/main/services/`
- Database schema changes in `kvDb.ts`
- IPC handler additions (registerIpc.ts, preload.ts, global.d.ts, ipc.ts)
- Unit/integration tests for services
- AI feature key additions (config.ts, aiIntegrationService.ts)

## Work Procedure

### Step 1: Understand the Feature

1. Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully.
2. Read `AGENTS.md` for mission boundaries and coding conventions.
3. Read `.factory/services.yaml` for test/build commands.
4. Read `.factory/library/architecture.md` for service patterns and IPC architecture.
5. Read `.factory/library/memory-engine.md` for algorithm details and data formats.
6. If the feature extends existing code, read the relevant existing source files to understand patterns.

### Step 2: Plan Implementation

1. Identify all files that need to be created or modified.
2. For IPC channels: you MUST update ALL FOUR files (ipc.ts, registerIpc.ts, preload.ts, global.d.ts).
3. For new services: follow the `createXxxService({...deps})` factory function pattern.
4. For DB changes: use `CREATE TABLE IF NOT EXISTS` in kvDb.ts's migrate() function.

### Step 3: Write Tests First (TDD)

1. Create the test file FIRST (e.g., `myService.test.ts`).
2. Follow the `createFixture()` pattern from `unifiedMemoryService.test.ts`:
   - Create a temp directory
   - Open a real SQLite database via `openKvDb()`
   - Insert any seed data needed
   - Instantiate the service with real dependencies
   - Write test cases that exercise all expected behaviors
3. Run tests — they should FAIL (red phase): `cd apps/desktop && npx vitest run --reporter=verbose <testfile>`
4. Each assertion from the feature's `expectedBehavior` should have at least one corresponding test case.
5. Cover edge cases: empty database, boundary values, error conditions.

### Step 4: Implement

1. Create the service file following the factory function pattern.
2. Add DB schema changes to `kvDb.ts` → `migrate()`.
3. Add IPC handlers if needed (all four files).
4. Wire the service into `main.ts` → `initContextForProjectRoot()` following the existing instantiation pattern. Add as minimal a change as possible — just the service creation call and adding it to AppContext.
5. Run tests — they should PASS (green phase).

### Step 5: Verify

1. Run the full test suite: `cd apps/desktop && npx vitest run`
   - Your new tests must pass.
   - Pre-existing failures in orchestrator tests (~31 failures) are expected — ignore them.
2. Run typecheck: `cd apps/desktop && npx tsc --noEmit`
   - Your new code must not introduce new errors.
   - Pre-existing errors in orchestrator code (~10 errors) are expected — ignore them.
3. Review your changes for correctness, edge cases, and adherence to the spec.

### Step 6: Commit

Commit your changes with a descriptive message. Stage only the files you created/modified.

## Example Handoff

```json
{
  "salientSummary": "Implemented memoryLifecycleService with temporal decay (half-life=30d), tier demotion (Tier2→3 at 90d, Tier3→archived at 180d), candidate auto-promotion/archival, hard limit enforcement (2000/500/200 per scope), and orphan cleanup. Added memory_sweep_log table. Ran `npx vitest run src/main/services/memory/memoryLifecycleService.test.ts` — 18 tests passing. Typecheck clean (no new errors).",
  "whatWasImplemented": "Created memoryLifecycleService.ts with temporal decay using half-life formula, tier demotion logic, candidate sweep, hard limit enforcement per scope, orphan cleanup for deleted missions, evergreen exemptions for preference/convention categories, and sweep scheduling on startup. Added memory_sweep_log table to kvDb.ts. Added IPC handlers for memory:run-sweep and memory:sweep-status in registerIpc.ts, preload.ts, global.d.ts, and ipc.ts.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "cd apps/desktop && npx vitest run src/main/services/memory/memoryLifecycleService.test.ts --reporter=verbose",
        "exitCode": 0,
        "observation": "18 tests passing: temporal decay formula, Tier 1 exempt, evergreen exempt, Tier 2 demotion at 90d, Tier 3 archival at 180d, candidate promotion, candidate archival, hard limits for project/agent/mission, orphan cleanup, sweep log recording, startup scheduling"
      },
      {
        "command": "cd apps/desktop && npx vitest run",
        "exitCode": 1,
        "observation": "88 files passed, 4 failed (all pre-existing orchestrator failures). My 18 new tests all pass."
      },
      {
        "command": "cd apps/desktop && npx tsc --noEmit",
        "exitCode": 1,
        "observation": "10 pre-existing errors in orchestrator code. No new errors from my changes."
      }
    ],
    "interactiveChecks": []
  },
  "tests": {
    "added": [
      {
        "file": "src/main/services/memory/memoryLifecycleService.test.ts",
        "cases": [
          { "name": "decays accessScore by half-life formula", "verifies": "VAL-SWEEP-001" },
          { "name": "Tier 1 entries exempt from decay", "verifies": "VAL-SWEEP-002" },
          { "name": "evergreen categories exempt from decay", "verifies": "VAL-SWEEP-003" },
          { "name": "demotes Tier 2 entries after 90 days", "verifies": "VAL-SWEEP-004" },
          { "name": "archives Tier 3 entries after 180 days", "verifies": "VAL-SWEEP-005" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires modifying orchestrator services (off-limits per AGENTS.md)
- A dependency service referenced in preconditions doesn't exist or has a different API than expected
- The existing `unifiedMemoryService` API doesn't support what's needed and modifying it would be a large change
- The `kvDb.ts` migration pattern doesn't support what's needed (e.g., need to ALTER existing columns)
- `onnxruntime-node` or `@huggingface/transformers` won't install or compile against Electron
