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
- iOS 18.x simulators cannot be used (deployment target is 26.0)

## Build Notes
- Development team: VQ372F39G6
- Code signing disabled for tests (CODE_SIGNING_ALLOWED = NO)
- Asset catalog warning: BrandMark.imageset references missing logo.png (cosmetic only)
