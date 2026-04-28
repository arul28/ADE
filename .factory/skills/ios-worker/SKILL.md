---
name: ios-worker
description: Implements and tests SwiftUI views, navigation flows, and shared iOS design-system work for ADE
---

# iOS Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for features that are primarily iOS UI work inside `apps/ios/ADE/`, including:

- SwiftUI screen extraction and file splitting
- mobile information architecture changes inside existing tabs
- shared iOS design-system and Liquid Glass component work
- accessibility and motion-polish work
- iOS-side performance cleanup in view code
- iOS tests in `apps/ios/ADETests/`

Do not use this skill for desktop sync-host, shared contract, `SyncService`, `RemoteModels`, or database features. Those belong to a sync/backend worker.

## Work Procedure

### 1. Understand the Feature

Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully. Then:

- Read `mission.md` for overall mission context
- Read `AGENTS.md` for boundaries and conventions
- Read `.factory/library/architecture.md` for app architecture and patterns
- Read `.factory/library/tab-parity.md` and `.factory/library/performance.md` when the feature touches parity or lag-sensitive flows
- Read the existing code files you'll be modifying in full
- If the feature touches a tab other than Lanes, still read the relevant Lanes benchmark components to match the established mobile quality bar

### 2. Plan the Changes

Before writing any code:
- List every file you'll create or modify
- Identify which existing code to preserve vs. rewrite
- Note which existing `syncService` methods the views need to call
- Identify which shared components should be promoted into `Views/Components/` instead of duplicated inside a tab
- Check that your plan stays on the iOS/UI side of the boundary; if the feature needs `SyncService`, `RemoteModels`, `Database`, or desktop host changes, stop and return to the orchestrator

### 3. Write Tests First (Red)

For any testable logic (filters, computed properties, data transformations, directory grouping):
- Add test cases to `ADETests.swift` (the single test file)
- Tests should fail initially (red phase)
- Use `@testable import ADE` and XCTest patterns matching existing tests
- Focus on logic tests, not UI rendering tests

### 4. Implement (Green)

Write the SwiftUI code:
- **File organization**: Each major screen or slice gets its own file under the relevant tab folder (`Views/Lanes/`, `Views/Files/`, `Views/Work/`, `Views/PRs/`, `Views/Settings/`). Keep files under 500 lines; if a feature leaves a file bigger than that, split again before handing off.
- **Design system**: Use `ADEColor.*`, `ADEMotion.*`, `.adeGlassCard()`, `.adeInsetField()`, `.adeNavigationGlass()`, `.adeScreenBackground()`, `ADENoticeCard`, `ADEStatusPill`, `ADEEmptyStateView`, `ADESkeletonView`, `ADECardSkeleton`, and shared glass helpers instead of ad-hoc styling.
- **Liquid Glass**: Prefer shared glass primitives and matched navigation transitions over one-off background/stroke recipes. When adding repeated chips or buttons, prefer reusable shared components instead of tab-local copies.
- **Accessibility**: Add `.accessibilityLabel` to all interactive elements. Use `ADEMotion` which respects `reduceMotion`. Preserve `.sensoryFeedback` on appropriate interactions.
- **Data access**: Use `@EnvironmentObject var syncService: SyncService`. Call existing SyncService methods — never add new ones.
- **State management**: Use `@State` for local state. Prefer debounced `.task(id: syncService.localStateRevision)` patterns matching the Lanes benchmark when reloading cached projections.
- **Performance**: Use lazy containers for large lists, avoid heavy parsing/computation in `body`, cache expensive derived values in state/view-model helpers, and preserve source-tab context on return navigation.
- **Boundary**: No changes to `SyncService.swift`, `RemoteModels.swift`, `Database.swift`, desktop services, or shared sync contracts from this skill.

### 5. Update Xcode Project

When creating new Swift files, you MUST add them to the Xcode project:
- Edit `apps/ios/ADE.xcodeproj/project.pbxproj` to add file references and build phase entries
- Follow the existing pattern in the pbxproj for file references (PBXFileReference, PBXBuildFile, PBXGroup children)
- Alternatively, if the project uses folder references, ensure files are in the correct directory

### 6. Verify

Run these commands and fix any issues:

```bash
# Mission simulator target
DESTINATION="platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1"

# Build / test / analyzer
xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination "$DESTINATION" -quiet
xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination "$DESTINATION" -quiet
xcodebuild -project apps/ios/ADE.xcodeproj -scheme ADE -destination "$DESTINATION" -derivedDataPath /tmp/ade-build analyze

# Check file sizes (no file should exceed 500 lines)
find apps/ios/ADE -name '*.swift' -exec wc -l {} + | sort -rn | head -20
```

All must pass for the touched surface. If build or tests fail, fix immediately. If a failure is clearly pre-existing and outside the feature boundary, return to the orchestrator with evidence instead of hand-waving past it.

### 7. Manual Verification

Do the strongest manual verification the feature allows:

- Trace the full data flow from `SyncService` through the view hierarchy
- Verify `syncService` method calls and model property names match the existing API exactly
- If the feature can be checked in the simulator without a live host, do so
- If the feature depends on live sync data, validate against the paired desktop host when that service is available in the mission
- Check that navigation back/return preserves the source context for mobile triage flows
- Ensure no unused imports, dead code, placeholder copy, or TODO markers remain

### 8. Commit

Commit with a clear message describing what was implemented.

## Example Handoff

```json
{
  "salientSummary": "Split the Work tab into mobile-first subviews, added a reusable glass section/chip stack in Views/Components, and stabilized session list/detail navigation so filters and context survive round-trips. Build, tests, and analyzer passed on the mission simulator target.",
  "whatWasImplemented": "Refactored WorkTabView.swift into focused files under Views/Work/, promoted reusable glass chips/section containers into Views/Components/, and updated the Work list/detail flows to preserve lane/search/filter context when opening sessions and returning. The new UI keeps chat/terminal sessions readable on iPhone, uses shared glass styling, and removes several hot-path computations from SwiftUI body evaluation.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet",
        "exitCode": 0,
        "observation": "Build succeeded with no errors or warnings"
      },
      {
        "command": "xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet",
        "exitCode": 0,
        "observation": "The iOS test suite passed on the mission destination"
      },
      {
        "command": "xcodebuild -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -derivedDataPath /tmp/ade-build analyze",
        "exitCode": 0,
        "observation": "Static analysis completed without blocking diagnostics"
      },
      {
        "command": "find apps/ios/ADE -name '*.swift' -exec wc -l {} + | sort -rn | head -20",
        "exitCode": 0,
        "observation": "New and modified Swift files stayed within the file-size limit after extraction"
      }
    ],
    "interactiveChecks": [
      {
        "action": "Traced session list → session detail → back navigation on the refactored Work surface",
        "observed": "The source lane/filter/search context remained intact after returning from detail"
      },
      {
        "action": "Reviewed all promoted shared components and the new Work subviews against the existing SyncService API",
        "observed": "All property and method accesses remained within the existing iOS/UI boundary and matched current signatures"
      }
    ]
  },
  "tests": {
    "added": []
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The feature requires changes to `SyncService`, `RemoteModels`, `Database`, desktop services, or shared sync contracts
- The existing API/data shape cannot support the feature without backend or contract work
- Xcode project state becomes corrupted or unrecoverable
- Build/test/analyzer failures are outside the touched iOS surface and cannot be repaired safely inside the feature boundary
- A file still exceeds 500 lines after a reasonable split attempt
