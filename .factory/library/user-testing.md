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
- 50 existing unit tests in ADETests.swift
- Tests cover: sync protocol, database CRDT, lane hydration, PR workflows, syntax highlighting, work tab, utilities
- Tests use @testable import ADE
