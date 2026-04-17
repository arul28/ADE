# User Testing

Testing surface, tools, setup steps, isolation notes, known quirks.

**What belongs here:** How to manually test the app, what surfaces to check, tools available.

---

## Testing Surface
- iOS Simulator (iPhone 17 Pro, iOS 26.3.1)
- Build + run in simulator via xcodebuild or Xcode
- App requires pairing with a desktop ADE host for full runtime testing (WebSocket connection)

## Limitations
- Cannot do full runtime/integration testing without a paired desktop host
- Validation focuses on: build success, unit tests, code review
- SwiftUI previews may be available for individual views but are not set up in the current codebase

## Testing Commands
- Build: `xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet`
- Test: `xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet`
- Line count check: `find apps/ios/ADE -name '*.swift' -exec wc -l {} + | sort -rn | head -20`

## Test Coverage
- Unit tests in ADETests.swift cover: sync protocol, database CRDT, lane hydration, PR workflows, syntax highlighting, work tab, utilities
- Tests use @testable import ADE

## Mission live-validation procedure

### Simulator target
- Use `iPhone 17 Pro` on `iOS 26.3.1`

### Baseline automated checks
- `xcodebuild build -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet`
- `xcodebuild test -project apps/ios/ADE.xcodeproj -scheme ADE -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1' -quiet`
- If desktop/shared sync-host code changed, also run desktop `typecheck`, `test`, and `build`

### Live synced-behavior validation
1. Launch local ADE desktop from `apps/desktop/`
2. Ensure the desktop app opens the project at `/Users/admin/Projects/ADE/.ade/worktrees/mobile-droid-attempt-bbdcd095`
3. Wait for the desktop sync host to be available (observed/default local host port is `8787`)
4. In iOS `Settings`, pair/reconnect the simulator to the desktop host
5. Validate the relevant mobile tab against real synced data

### What to validate manually when a feature affects navigation
- `Lanes ↔ Files`
- `Work ↔ Files`
- `Work ↔ PRs`
- `Work ↔ Lanes`
- disconnected state → `Settings` → reconnect/pair → return to originating area

### Accepted limitation
- If the desktop host is not running, the ADE desktop app cannot be brought up reliably, or simulator pairing is flaky, workers should still validate build/test/simulator-only behavior and continue implementation work instead of spending excessive time on setup recovery
- Any assertion that depends on live synced data should then be left unverified and escalated back to the orchestrator so the full live validation pass can happen near the end of the mission
