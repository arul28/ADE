# Architecture

Architectural decisions, patterns discovered, and conventions.

**What belongs here:** Design patterns, module boundaries, data flow, naming conventions.

---

## iOS App Structure
- Entry: `ADEApp.swift` → creates SyncService → passes to ContentView
- ContentView: TabView with 5 tabs (Lanes, Files, Work, PRs, Settings)
- SyncService: @MainActor ObservableObject, WebSocket to desktop host, CRDT sync via cr-sqlite
- Database: SQLite with cr-sqlite for local caching
- Models: RemoteModels.swift (Codable structs for all API types)

## Data Flow
1. SyncService connects to desktop ADE host via WebSocket
2. Commands sent (e.g., `lanes.refreshSnapshots`) → responses decoded
3. Data cached in SQLite (lane_list_snapshots, lane_detail_snapshots tables)
4. Views observe `syncService.localStateRevision` via `.task(id:)` for reactive updates
5. Pull-to-refresh triggers `reload(refreshRemote: true)`

## Design System (ADEDesignSystem.swift)
- Colors: ADEColor (pageBackground, surfaceBackground, accent, success, warning, danger, etc.)
- Motion: ADEMotion (standard, quick, emphasis, pulse - all respect reduceMotion)
- Components: ADENoticeCard, ADEStatusPill, ADEEmptyStateView, ADESkeletonView, ADECardSkeleton
- Modifiers: .adeGlassCard(), .adeScreenBackground(), .adeNavigationGlass(), .adeInsetField(), .adeListCard()
- Image caching: ADEImageCache with memory + disk cache

## Coding Conventions
- Private views as nested structs within the parent file
- @EnvironmentObject for SyncService access
- @State for local view state
- Computed properties for filtered/derived data
- .task(id:) for reactive data loading
- .sensoryFeedback for haptics
- accessibilityLabel on all interactive elements
- ADEMotion helpers for all animations (respects reduceMotion)

## Lane Types
- `LaneListSnapshot`: List item (lane + runtime + rebaseSuggestion + autoRebase + conflict + stateSnapshot + adoptable)
- `LaneDetailPayload`: Full detail (lane + runtime + stack + children + state + suggestions + conflicts + commits + changes + stashes + sessions)
- Lane types: "primary", "worktree", "attached"
- Runtime buckets: "running", "awaiting-input", "ended", "none"
