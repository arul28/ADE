---
name: ios-worker
description: Implements and tests SwiftUI views and components for the iOS app
---

# iOS Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use for any feature that involves creating or modifying Swift/SwiftUI code in the iOS app at `apps/ios/ADE/`. This includes view extraction, UI redesign, component creation, and performance optimization.

## Work Procedure

### 1. Understand the Feature

Read the feature description, preconditions, expectedBehavior, and verificationSteps carefully. Then:

- Read `mission.md` for overall mission context
- Read `AGENTS.md` for boundaries and conventions
- Read `.factory/library/architecture.md` for app architecture and patterns
- Read the existing code files you'll be modifying
- If the feature modifies or replaces existing views, read the FULL original `LanesTabView.swift` to understand the complete existing implementation before making changes

### 2. Plan the Changes

Before writing any code:
- List every file you'll create or modify
- Identify which existing code to preserve vs. rewrite
- Note which SyncService methods the views need to call
- Check that your plan doesn't violate any boundary (no changes to SyncService, RemoteModels, Database)

### 3. Write Tests First (Red)

For any testable logic (filters, computed properties, data transformations, directory grouping):
- Add test cases to `ADETests.swift` (the single test file)
- Tests should fail initially (red phase)
- Use `@testable import ADE` and XCTest patterns matching existing tests
- Focus on logic tests, not UI rendering tests

### 4. Implement (Green)

Write the SwiftUI code:
- **File organization**: Each major view gets its own file under `apps/ios/ADE/Views/Lanes/`. Keep files under 500 lines.
- **Design system**: Use `ADEColor.*` for colors, `ADEMotion.*` for animations, `.adeGlassCard()` for card surfaces, `.adeInsetField()` for inputs, `ADENoticeCard` for notices, `ADEStatusPill` for badges, `ADEEmptyStateView` for empty states, `ADESkeletonView`/`ADECardSkeleton` for loading.
- **Accessibility**: Add `.accessibilityLabel` to all interactive elements. Use `ADEMotion` which respects `reduceMotion`. Preserve `.sensoryFeedback` on appropriate interactions.
- **Data access**: Use `@EnvironmentObject var syncService: SyncService`. Call existing SyncService methods — never add new ones.
- **State management**: Use `@State` for local view state. Use `.task(id: syncService.localStateRevision)` for reactive data loading.
- **Lazy loading**: Use `LazyVStack` for lists with many items (file changes, commits, lane list).
- **No changes** to SyncService.swift, RemoteModels.swift, Database.swift, or DatabaseBootstrap.sql.

### 5. Update Xcode Project

When creating new Swift files, you MUST add them to the Xcode project:
- Edit `apps/ios/ADE.xcodeproj/project.pbxproj` to add file references and build phase entries
- Follow the existing pattern in the pbxproj for file references (PBXFileReference, PBXBuildFile, PBXGroup children)
- Alternatively, if the project uses folder references, ensure files are in the correct directory

### 6. Verify

Run these commands and fix any issues:

```bash
# Pick an available simulator pair on the current machine first.
xcrun simctl list runtimes
xcrun simctl list devices available
DESTINATION="platform=iOS Simulator,name=<available iPhone>,OS=<available iOS runtime>"

# Build
xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination "$DESTINATION" -quiet

# Test
xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination "$DESTINATION" -quiet

# Check file sizes (no file should exceed 500 lines)
find apps/ios/ADE -name '*.swift' -exec wc -l {} + | sort -rn | head -20
```

All must pass. If build fails, fix immediately. If tests fail, fix immediately. If any file exceeds 500 lines, split it.

### 7. Manual Verification

Since the app requires a paired desktop host for runtime testing:
- Review your code for correctness by tracing data flow from SyncService through to the view
- Verify all SyncService method calls match the existing API exactly (check method signatures)
- Verify all RemoteModels properties are accessed correctly (check property names and types)
- Ensure no unused imports, dead code, or TODO placeholders remain
- Confirm view hierarchy is correct (NavigationStack, sheets, navigation links)

### 8. Commit

Commit with a clear message describing what was implemented.

## Example Handoff

```json
{
  "salientSummary": "Extracted LaneDetailScreen, LaneCreateSheet, LaneAttachSheet, LaneDiffScreen, LaneBatchManageSheet, LaneStackGraphSheet, and shared components from the monolithic LanesTabView.swift into 12 separate files under Views/Lanes/. Created LaneTypes.swift for shared enums/structs and LaneHelpers.swift for utility functions. All 50 existing tests pass. No file exceeds 500 lines. Build succeeds.",
  "whatWasImplemented": "Split LanesTabView.swift (3,749 lines) into 12 files: LanesTabView.swift (thin coordinator, ~300 lines), LaneDetailScreen.swift (~450 lines), LaneCreateSheet.swift (~180 lines), LaneAttachSheet.swift (~90 lines), LaneDiffScreen.swift (~200 lines), LaneBatchManageSheet.swift (~150 lines), LaneStackGraphSheet.swift (~80 lines), LaneChatLaunchSheet.swift (~120 lines), LaneSessionTranscriptView.swift (~100 lines), LaneChatSessionView.swift (~100 lines), LaneComponents.swift (~350 lines, shared small components), LaneTypes.swift (~80 lines, enums and model structs), LaneHelpers.swift (~120 lines, search/format helpers). Updated project.pbxproj with all new file references.",
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
        "observation": "All 50 tests passed"
      },
      {
        "command": "find apps/ios/ADE -name '*.swift' -exec wc -l {} + | sort -rn | head -20",
        "exitCode": 0,
        "observation": "Largest file is LaneDetailScreen.swift at 448 lines. All files under 500 line limit."
      }
    ],
    "interactiveChecks": [
      {
        "action": "Traced data flow from SyncService.fetchLaneListSnapshots through LanesTabView to LaneListRow",
        "observed": "All property accesses match RemoteModels.LaneListSnapshot fields. No missing or renamed properties."
      },
      {
        "action": "Verified all SyncService method calls in extracted views match original signatures",
        "observed": "All 35 service calls preserved with correct parameter names and types."
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

- SyncService method signatures don't match what the view expects (API contract issue)
- RemoteModels properties are missing or have different types than expected
- Xcode project file is corrupted or in an unrecoverable state
- Build fails due to issues outside the lanes tab code
- A feature requires changes to SyncService, RemoteModels, or Database (boundary violation)
- File exceeds 500 lines and cannot be reasonably split without changing the feature boundary
