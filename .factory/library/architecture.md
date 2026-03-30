# Architecture

Architectural decisions, patterns discovered, and conventions.

**What belongs here:** Design decisions, patterns, component structure, data flow patterns.

---

## iOS App Architecture

### View Layer
- Pure SwiftUI (no UIKit storyboards/xibs)
- Custom glass morphism design system in `ADEDesignSystem.swift`
- Key components: `adeGlassCard()`, `adeInsetField()`, `ADEStatusPill`, `ADENoticeCard`, `ADEEmptyStateView`, `ADECardSkeleton`
- Semantic colors via `ADEColor` (pageBackground, surfaceBackground, accent, success, warning, danger)
- Accessibility-aware animations via `ADEMotion`
- Matched geometry transitions with zoom navigation (iOS 26 APIs)

### Navigation
- Root: `TabView` with 5 tabs (Lanes, Files, Work, PRs, Settings)
- Per-tab: `NavigationStack` with programmatic `NavigationPath` routing
- Detail screens: Push navigation via `navigationDestination(for:)` with typed route values
- Modals: `.sheet()` for wizards and overlays
- Cross-tab: `SyncService` publishes `requestedFilesNavigation`, `requestedLaneNavigation`, `requestedPrNavigation`

### Data Layer
- Local-first SQLite with cr-sqlite (CRDT) for sync
- WebSocket connection to desktop host
- Models in `RemoteModels.swift` (~80+ Codable structs)
- Database queries in `Database.swift` (DatabaseService)
- Sync commands in `SyncService.swift` (remote command execution)

### Sync Architecture
- Bonjour discovery + WebSocket connection
- Four sync domains: `.lanes`, `.files`, `.work`, `.prs`
- Each domain: `disconnected → syncingInitialData → hydrating → ready`
- Commands sent to desktop host, results received via WebSocket
- Offline queueing via `PendingOperation` in `UserDefaults`

### PR Data Models (key types)
- `PrSummary` — basic PR record
- `PullRequestListItem` — enriched list item with adeKind, group info, workflow state
- `PullRequestSnapshot` — full detail: status, checks, reviews, comments, files
- `IntegrationProposal` — integration workflow with steps, resolution state
- `QueueLandingState` — queue state with entries, config
- `RebaseSuggestion` — rebase recommendation per lane

### PR Remote Commands
- `prs.refresh`, `prs.createFromLane`, `prs.land`, `prs.close`, `prs.reopen`
- `prs.requestReviewers`, `prs.draftDescription`, `prs.rerunChecks`, `prs.addComment`
- `lanes.rebaseStart`, `lanes.archive`, `lanes.delete`
- `lanes.dismissRebaseSuggestion`, `lanes.deferRebaseSuggestion`
