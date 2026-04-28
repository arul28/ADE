# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Platform
- iOS 26.0+ deployment target
- Swift 5.0
- Xcode 26.2+
- No external package dependencies (no SPM, CocoaPods, Carthage)
- Uses SQLite3 via system framework import (cr-sqlite for CRDT sync)

## Simulators
- Required: iOS 26.3.1 simulators
- Recommended: iPhone 17 Pro
- iOS 18.x simulators are older than the minimum deployment target (26.0), so they are incompatible.

## Build Notes
- Development team: configured in Xcode project settings
- Code signing disabled for tests (CODE_SIGNING_ALLOWED = NO)
- Asset catalog warning: BrandMark.imageset references missing logo.png (cosmetic only)

## Mission-specific environment notes
- Mission simulator target: `platform=iOS Simulator,name=iPhone 17 Pro,OS=26.3.1`
- Desktop parity work may also touch `apps/desktop/`; `npm` must be available in addition to `xcodebuild`
- Live synced-behavior validation may launch a local ADE desktop host and pair the simulator against it
- When ADE desktop is running locally for validation, the observed/default sync host port is `8787`

## Validation baseline
- The build path is executable locally
- The iOS test path is executable locally
- The mission starts with 2 baseline failing iOS tests and must fix them in the foundation milestone before treating the suite as green
