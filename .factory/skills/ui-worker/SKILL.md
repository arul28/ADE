---
name: ui-worker
description: Implements renderer components, zustand stores, IPC handlers, and component tests for the ADE Electron app missions tab
---

# UI Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that involve renderer-side UI work:
- React components in `apps/desktop/src/renderer/components/missions/`
- Zustand store creation/modification for missions
- Component tests (`.test.tsx`)
- IPC handler additions needed to support UI features
- Design token changes in `laneDesignTokens.ts`
- View model functions in `missionControlViewModel.ts`
- Helper functions in `missionHelpers.ts`

## Work Procedure

### Step 1: Understand the Feature

1. Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully.
2. Read `AGENTS.md` for mission boundaries and coding conventions.
3. Read `.factory/services.yaml` for test/build commands.
4. Read `.factory/library/user-testing.md` for the testing surface.
5. Investigate the EXISTING UI patterns:
   - Read the existing missions components you'll be modifying
   - Read `src/renderer/components/missions/missionHelpers.ts` for constants, types, utilities
   - Read `src/renderer/components/missions/missionControlViewModel.ts` for derived view models
   - Check `laneDesignTokens.ts` for the design token system (COLORS, fonts, button styles)
   - If extracting to zustand: read existing zustand stores (e.g., `appStore.ts`, `missionCreateDialogStore.ts`) for patterns

### Step 2: Plan Implementation

1. Identify all files to create or modify.
2. For component decomposition: plan the component tree first — which state goes where, what props flow down.
3. For zustand stores: define the store shape with TypeScript types BEFORE implementation.
4. For IPC channels: update ALL FOUR files (ipc.ts, registerIpc.ts, preload.ts, global.d.ts).
5. For styling: use TailwindCSS classes. Follow the 4px spacing grid. Max 4 font sizes.
6. Plan empty states, loading states, and error states for every interactive element.

### Step 3: Write Tests (Zustand stores only — skip component tests)

**For zustand stores:** Write unit tests for the store (actions, selectors, derived state) using vitest. These are pure logic tests and high-value.

**For React components:** Do NOT write @testing-library/react component tests unless the feature explicitly requires them. UI correctness is verified via agent-browser (Step 5) which is more reliable than mocking window.ade. Focus your effort on making the code correct, not on test scaffolding for UI components.

**For pure utility functions** (e.g., collapseFeedMessages, computeProgress, classifyErrorSource): Write unit tests — these are high-value, fast tests.

### Step 4: Implement

1. Create React components following existing patterns.
2. Use TailwindCSS classes consistent with design tokens.
3. For component decomposition:
   - Extract one component at a time
   - Verify existing behavior is preserved after each extraction
   - Keep MissionsPage.tsx as a thin shell that composes sub-components
4. For zustand:
   - Define the store type first
   - Create selectors for each data slice
   - Use `useShallow` or individual selectors to prevent unnecessary re-renders
5. Implement proper loading, empty, and error states.
6. Run tests — they should PASS (green phase).

### Step 5: Verify

1. Run any tests you wrote: `cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run <testfile> --reporter=verbose`
2. Run the full test suite: `cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run`
   - Your new tests must pass.
   - 2 pre-existing failures are expected (see AGENTS.md).
3. Run typecheck: `cd /Users/admin/Projects/ADE/apps/desktop && npx tsc --noEmit`
   - Must produce no NEW errors.
4. **IMPORTANT — agent-browser verification is the PRIMARY UI validation method:**
   - Start the app: `cd /Users/admin/Projects/ADE/apps/desktop && npm run dev`
   - Connect: `agent-browser connect 9222`
   - Navigate to Missions tab and verify your changes render correctly
   - Take screenshots as evidence
   - This is MORE important than unit tests for UI features

### Step 6: Commit

Commit your changes with a descriptive message. Stage only the files you created/modified.

## Example Handoff

```json
{
  "salientSummary": "Extracted zustand mission store from MissionsPage's 45 useState hooks. MissionsPage is now 380 lines (down from 2437). Created MissionSidebar, MissionDetailView, MissionHeader, MissionTabContainer, InterventionPanel as separate components. Ran `npx vitest run src/renderer/components/missions/` — 28 tests passing including 16 new store/component tests. Typecheck clean.",
  "whatWasImplemented": "Created useMissionsStore.ts with all domain state (missions, selectedMissionId, runGraph, dashboard, activeTab, loading, error, interventions). Split MissionsPage into 6 focused components each under 400 lines. MissionsPage is now a thin shell composing sub-components. All IPC calls moved to store actions. Event subscriptions registered in store middleware.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run src/renderer/components/missions/ --reporter=verbose",
        "exitCode": 0,
        "observation": "28 tests passing: store initial state, store selectors, MissionSidebar renders list, MissionHeader shows status, InterventionPanel shows actions, tab switching, IPC consolidation"
      },
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx vitest run",
        "exitCode": 0,
        "observation": "106 files, 1045 tests pass, 2 pre-existing failures. No regressions."
      },
      {
        "command": "cd /Users/admin/Projects/ADE/apps/desktop && npx tsc --noEmit",
        "exitCode": 0,
        "observation": "No new type errors."
      },
      {
        "command": "wc -l src/renderer/components/missions/MissionsPage.tsx",
        "exitCode": 0,
        "observation": "380 lines (was 2437)"
      }
    ],
    "interactiveChecks": [
      {
        "action": "Started app with npm run dev, navigated to Missions tab via agent-browser",
        "observed": "Missions tab renders with sidebar list, detail view, tabs. Selecting a mission loads detail. No visual regressions."
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "src/renderer/components/missions/useMissionsStore.test.ts",
        "cases": [
          { "name": "initial state has empty missions array", "verifies": "VAL-ARCH-001" },
          { "name": "setSelectedMissionId updates store", "verifies": "VAL-ARCH-001" },
          { "name": "selectors return correct slices", "verifies": "VAL-ARCH-008" }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires modifying main-process services (use service-worker instead)
- Required IPC handlers from service-worker features don't exist yet
- The existing component patterns conflict with the feature requirements
- Component decomposition reveals circular dependencies that need architectural decision
- Existing tests break in unexpected ways after refactoring
- Orchestrator insight: note any UX pattern you think the ADE missions UI should adopt
