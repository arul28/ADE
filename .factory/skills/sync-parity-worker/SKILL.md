---
name: sync-parity-worker
description: Extends ADE desktop sync contracts, shared payloads, and iOS models/services when tab parity requires backend work
---

# Sync parity worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Use this skill when a feature requires changes outside pure SwiftUI/UI work, including:

- desktop ADE sync-host or main-process service changes under `apps/desktop/src/main/`
- desktop shared contract or payload changes under `apps/desktop/src/shared/`
- iOS `SyncService.swift`, `RemoteModels.swift`, or `Database.swift`
- cached projection or hydration changes needed for Work, Files, PRs, Settings, or Lanes parity
- backend support for mobile-only parity gaps such as missing actions, missing payload fields, or missing cross-tab navigation data

Do not use this skill for pure SwiftUI refactors or visual polish that can stay entirely inside the iOS app.

## Work Procedure

### 1. Understand the contract gap

Read the feature description, then:

- Read `mission.md` and `AGENTS.md`
- Read `.factory/library/architecture.md`, `.factory/library/tab-parity.md`, and `.factory/library/user-testing.md`
- Trace the full path for the feature: desktop service → shared types/payloads → iOS models/service → cached database projections → consuming UI
- Identify the smallest contract change that closes the parity gap

### 2. Plan all touched files before coding

List every file you expect to change, grouped by layer:

- desktop service / IPC / shared types
- iOS `RemoteModels` / `SyncService` / `Database`
- tests on both sides

Prefer additive, backwards-compatible payload changes unless the feature specifically requires replacement.

### 3. Write tests first (red)

Add or update the smallest targeted tests first:

- desktop Vitest tests for the service, mapper, or payload generator
- iOS `ADETests.swift` coverage for decoding, filtering, caching, or navigation-request logic

The new or changed tests should fail before implementation.

### 4. Implement the contract change (green)

Implement across all required layers:

- extend the desktop payload/service with the required data or action
- keep payloads explicit and stable for iOS decoding
- update `RemoteModels.swift` and `SyncService.swift` to match exactly
- update `Database.swift` projections/caching only when the feature needs offline or cached behavior
- make the minimum compile fixes in any dependent UI files, but leave major UI follow-up to the iOS worker

### 5. Preserve offline and capability behavior

Parity work must not break cached reading or offline gating.

- if the feature is live-only, expose that state explicitly so iOS can disable or message it cleanly
- if the feature should stay visible while offline, ensure the cached projection still hydrates
- if actions are capability-gated, preserve explicit capability checks instead of silent no-ops

### 6. Verify both stacks

Run the relevant desktop and iOS checks:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run test -- --maxWorkers=7
npm --prefix apps/desktop run build

xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet
xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet
```

If the feature only touches a narrow desktop surface, run the tightest relevant test subset first, then finish with the broader required checks.

### 7. Manual verification

Before handing off:

- prove the payload shape matches on both sides
- verify any new iOS gating/offline behavior is intentional
- confirm the consuming UI has enough data to complete the parity feature
- if practical, launch the desktop host and confirm the new data/action is observable from the iOS app or simulator path

### 8. Commit

Commit with a message describing the parity contract or sync-host extension that was added.

## Example handoff

```json
{
  "salientSummary": "Extended the desktop PR snapshot payload with ordered stack members and explicit live-action capability flags, then wired the new fields through RemoteModels/SyncService and iOS tests. Desktop and iOS validations passed, and the PRs tab now has the data needed for mobile stack visibility and clean offline gating.",
  "whatWasImplemented": "Added stack-member and capability metadata to the desktop PR hydration path, updated shared typings and the iOS RemoteModels decoder, taught SyncService to persist the new snapshot fields, and added targeted desktop/iOS tests covering snapshot generation and decoding. The UI was only touched enough to compile against the new payload shape; the remaining PR presentation work stays with the iOS worker.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {
        "command": "npm --prefix apps/desktop run typecheck",
        "exitCode": 0,
        "observation": "Desktop TypeScript contracts compile cleanly"
      },
      {
        "command": "npm --prefix apps/desktop run test -- --maxWorkers=7",
        "exitCode": 0,
        "observation": "Desktop Vitest suite passed with the new PR payload coverage"
      },
      {
        "command": "xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet",
        "exitCode": 0,
        "observation": "iOS tests passed with new decoding/caching assertions"
      }
    ],
    "interactiveChecks": [
      {
        "action": "Compared the desktop snapshot payload shape against RemoteModels and SyncService usage",
        "observed": "All new fields decode and persist cleanly; no silent capability fallthrough remains"
      }
    ]
  },
  "tests": {
    "added": [
      {
        "file": "apps/desktop/src/main/services/prs/prService.test.ts",
        "cases": [
          {
            "name": "includes ordered stack members in mobile PR snapshot",
            "verifies": "The desktop host emits stack-member metadata expected by the mobile PR surface"
          }
        ]
      },
      {
        "file": "apps/ios/ADETests/ADETests.swift",
        "cases": [
          {
            "name": "testPullRequestSnapshotDecodesStackMembersAndCapabilities",
            "verifies": "The iOS model and SyncService can decode the new PR snapshot fields"
          }
        ]
      }
    ]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- The requested parity behavior would require a new product scope beyond the current mission (for example dedicated CTO or Missions surfaces)
- The change would require a risky contract break instead of an additive extension
- Desktop or iOS tests fail in unrelated areas and cannot be repaired safely inside the feature boundary
- The feature needs UI redesign beyond minor compile-fix wiring; hand it back to the iOS worker after the contract change lands
