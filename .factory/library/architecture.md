# Architecture

Architectural decisions, patterns discovered, and conventions.

**What belongs here:** Design patterns, module boundaries, data flow, naming conventions.

---

## iOS App Structure
- Entry: `ADEApp.swift` → creates SyncService → passes to ContentView
- ContentView: TabView with 5 tabs (Lanes, Files, Work, PRs, Settings)
- SyncService: `@MainActor` `ObservableObject`, Bonjour discovery + pairing + `ws://` socket transport to the desktop host, CRDT sync via cr-sqlite
- Database: SQLite with cr-sqlite for local caching
- Models: RemoteModels.swift (Codable structs for all API types)
- Host discovery: Bonjour browser maintains discovered LAN hosts, while Settings also supports manual host/port entry and QR pairing payloads with candidate addresses
- Authentication: pairing exchanges a short-lived host code for a shared secret, stores that secret in Keychain, and persists host identity/device metadata in `HostConnectionProfile`
- Transport security: the current implementation uses plain `ws://` on the trusted local network or saved address set; host trust is enforced by the pairing secret plus host-identity checks, not TLS or certificate pinning

## Data Flow
1. `SyncService` discovers or reuses the host address, opens a `ws://` socket, and sends `hello` with either bootstrap auth or paired-device auth
2. Commands sent (for example `lanes.refreshSnapshots`) are decoded into local models, while `changeset_batch` payloads are applied into the SQLite cache
3. Data is cached in SQLite tables including `lane_list_snapshots` and `lane_detail_snapshots`, and cached rows remain readable when the host is offline
4. Views observe `syncService.localStateRevision` via `.task(id:)`; when live refresh fails they keep the last cached state visible and surface a user-facing error banner or reconnect CTA instead of blanking the screen
5. Pull-to-refresh triggers `reload(refreshRemote: true)`: the remote refresh runs first, then the view reloads from SQLite; on failure the view keeps cached rows, records the localized `SyncUserFacingError`, and offers retry/reconnect UI
6. Disconnects and send/receive failures tear down the active socket, fail pending requests, and schedule automatic reconnect with exponential backoff (1s, 2s, 4s, 8s, 16s; immediate retry for heartbeat close code `4001`)
7. Session lifecycle is stateful: a successful `hello` refreshes the saved host profile and starts relay/hydration tasks, `auth_failed` invalidates the saved pairing, and manual disconnect stops reconnect attempts until the user reconnects or pairs again

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

## Mission parity architecture

This mission is about bringing the existing iOS tabs to mobile-first parity with desktop behavior for the surfaces that already exist on iOS.

### Scope boundaries
- In scope tabs: `Lanes`, `Work`, `Files`, `PRs`, `Settings`
- Out of scope product surfaces: dedicated `CTO`, dedicated `Missions`
- `Files` is read-only mobile parity, not Monaco editing parity
- `Settings` is core mobile settings only, not full desktop settings parity

### Worker boundary split
- `ios-worker`: SwiftUI/UI-only work inside `apps/ios/ADE/`
- `sync-parity-worker`: desktop sync-host/shared payload work plus iOS `SyncService` / `RemoteModels` / `Database` changes when parity requires it

### Current tab state snapshot
- `Lanes` is the benchmark tab and should be used as the quality reference for structure, state handling, and shared component patterns
- `Work` is the weakest major tab: feature-rich but extremely monolithic and currently the biggest performance/UX problem
- `Files` is functionally deep but still monolithic and must end as a read-only mobile browsing/search/diff surface
- `PRs` is functionally broad but monolithic; mobile list/detail/workflow adaptation is required
- `Settings` currently centers on sync/pairing + appearance and needs to become a coherent mobile settings shell

### Shared parity pressure points
- `ContentView.swift` owns root tab selection and cross-tab navigation requests (`settingsPresented`, `requestedFilesNavigation`, `requestedLaneNavigation`, `requestedPrNavigation`)
- Many parity gaps are contract gaps, not just renderer gaps; backend expansion is allowed when it is needed to support the existing iOS tabs
- Preserve cached/offline readability and explicit live-action gating when extending contracts

### Quality bar for this mission
- Prefer shared `Views/Components/` primitives over tab-local duplication
- Keep large SwiftUI files split into focused files under per-tab folders
- Preserve source-tab context when navigating away and back
- Avoid expensive derived work in SwiftUI `body`; cache or precompute where possible
