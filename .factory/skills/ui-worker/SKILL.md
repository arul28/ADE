---
name: ui-worker
description: Implements renderer components, Settings UI, IPC handlers, and component tests for the ADE Electron app
---

# UI Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that involve renderer-side UI work:
- React components in `apps/desktop/src/renderer/components/`
- Settings page additions/modifications
- Memory Inspector UI changes
- Component tests (`.test.tsx`)
- IPC handler additions needed to support UI features

## Work Procedure

### Step 1: Understand the Feature

1. Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully.
2. Read `AGENTS.md` for mission boundaries and coding conventions.
3. Read `.factory/services.yaml` for test/build commands.
4. Read `.factory/library/user-testing.md` for the testing surface.
5. Investigate the EXISTING UI patterns:
   - Read `src/renderer/components/settings/` to understand Settings page structure (11-section sidebar: Profile, Providers, AI Features, Diagnostics, etc.)
   - Read `src/renderer/components/settings/MemoryInspector.tsx` (~22KB) to understand the current Memory Inspector
   - Read `src/renderer/components/settings/AiFeaturesSection.tsx` for the feature model override pattern
   - Read `src/renderer/components/settings/ProvidersSection.tsx` for the model selector pattern
   - Check `src/renderer/state/appStore.ts` for relevant state

### Step 2: Plan Implementation

1. Identify all files to create or modify.
2. For new Settings sections: follow the existing section pattern (component receives props from SettingsPage).
3. For IPC channels: update ALL FOUR files (ipc.ts, registerIpc.ts, preload.ts, global.d.ts).
4. For new components: use TypeScript with explicit prop types, TailwindCSS for styling, tailwind-merge for class management.
5. Plan empty states, loading states, and error states for every interactive element.

### Step 3: Write Component Tests First (TDD)

1. Create the test file FIRST (e.g., `MemoryHealthTab.test.tsx`).
2. Use `@testing-library/react` with vitest:
   ```typescript
   import { render, screen, fireEvent } from '@testing-library/react';
   import { describe, it, expect, vi } from 'vitest';
   ```
3. Mock `window.ade` methods used by the component.
4. Write test cases for:
   - Initial render with various data states (empty, populated, loading)
   - User interactions (button clicks, toggle switches)
   - Error states
   - Loading states during async operations
5. Run tests — they should FAIL (red phase).

### Step 4: Implement

1. Create React components following existing patterns.
2. Use TailwindCSS classes consistent with the rest of the Settings page.
3. Implement proper loading states (disabled buttons, spinners) during async operations.
4. Implement empty states (meaningful messages when no data exists).
5. Implement error states (show error message, re-enable controls).
6. Add IPC handlers if needed (all four files).
7. Wire into existing Settings/MemoryInspector structure.
8. Run tests — they should PASS (green phase).

### Step 5: Verify

1. Run your component tests: `cd apps/desktop && npx vitest run <testfile> --reporter=verbose`
2. Run the full test suite: `cd apps/desktop && npx vitest run`
   - Your new tests must pass.
   - Pre-existing failures in orchestrator tests (~31 failures) are expected — ignore them.
3. Run typecheck: `cd apps/desktop && npx tsc --noEmit`
   - Your new code must not introduce new errors.
   - Pre-existing errors in orchestrator code (~10 errors) are expected — ignore them.
4. If the app can be started (`npm run dev`), manually verify the UI renders correctly:
   - Navigate to Settings > Memory > Health
   - Check that all sections render without blank areas or errors
   - Verify buttons are clickable and show loading states
   - Check dark mode compatibility if possible

### Step 6: Commit

Commit your changes with a descriptive message. Stage only the files you created/modified.

## Example Handoff

```json
{
  "salientSummary": "Implemented the Memory Health Dashboard tab in Settings > Memory. Shows entry counts by scope/tier, sweep and consolidation logs, hard limit usage bars, and manual action buttons with loading states. Ran `npx vitest run MemoryHealthTab.test.tsx` — 12 component tests passing. Verified UI renders correctly via npm run dev: navigated to Settings > Memory, confirmed all sections render with mock data, buttons show loading state when clicked.",
  "whatWasImplemented": "Created MemoryHealthTab.tsx with four sections: entry counts grid (scope x tier), last sweep/consolidation summaries with timestamps, hard limit progress bars per scope, and 'Run Sweep Now'/'Run Consolidation Now' buttons with loading/disabled states. Added IPC handlers for memory:health-stats in all four IPC files (ipc.ts, registerIpc.ts, preload.ts, global.d.ts). Wired into SettingsPage as a new section under Memory. Added empty state ('No sweeps yet') and error state (shows failure reason, re-enables button).",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "cd apps/desktop && npx vitest run src/renderer/components/settings/MemoryHealthTab.test.tsx --reporter=verbose",
        "exitCode": 0,
        "observation": "12 tests passing: renders entry counts, renders sweep log, renders consolidation log, renders hard limit bars, Run Sweep Now triggers IPC, button disabled during sweep, empty state shows 'No sweeps yet', error state shows message, consolidation button triggers IPC, loading state during consolidation"
      },
      {
        "command": "cd apps/desktop && npx vitest run",
        "exitCode": 1,
        "observation": "88 files passed, 4 failed (pre-existing orchestrator). My 12 new tests pass."
      },
      {
        "command": "cd apps/desktop && npx tsc --noEmit",
        "exitCode": 1,
        "observation": "10 pre-existing errors. No new errors from my changes."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started app with npm run dev, navigated to Settings > Memory > Health",
        "observed": "Health section renders with entry count grid, sweep/consolidation summary cards, and hard limit bars. All showing zero/empty state since no sweeps have run."
      },
      {
        "action": "Clicked 'Run Sweep Now' button",
        "observed": "Button showed loading spinner and 'Running...' text, then updated to show sweep results after completion."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "src/renderer/components/settings/MemoryHealthTab.test.tsx",
        "cases": [
          { "name": "renders entry counts by scope and tier", "verifies": "VAL-HEALTH-001" },
          { "name": "shows empty state on first visit", "verifies": "VAL-HEALTH-009" },
          { "name": "Run Sweep Now button triggers sweep IPC", "verifies": "VAL-HEALTH-005" },
          { "name": "buttons disabled during active operation", "verifies": "VAL-HEALTH-008" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The Settings page structure has changed significantly from what was expected (sections reorganized, different component pattern)
- Required IPC handlers from service-worker features don't exist yet (dependency not met)
- The MemoryInspector component is too complex to modify safely without risking regressions
- Dark mode issues that require design system changes beyond this feature's scope
- The existing component patterns conflict with the feature requirements
