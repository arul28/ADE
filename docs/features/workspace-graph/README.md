# Workspace graph

The workspace graph is ADE's visual topology canvas for lanes and
the relationships between them: stack structure, pairwise conflict
risk, sync state, PR overlays, merge simulation entry points, and
integration proposals. It's rendered with React Flow (`@xyflow/react`)
in `renderer/components/graph/`.

The graph is not a separate data layer — it projects the same lane,
conflict, PR, and git service state the rest of the app uses into a
spatial view. Data flows in staged layers so the canvas becomes
usable before every overlay finishes loading.

## Source file map

Core renderer files (`apps/desktop/src/renderer/components/graph/`):

| File | Responsibility |
|------|---------------|
| `WorkspaceGraphPage.tsx` | Top-level page (4.4k lines). Owns state, staged loading, refresh scheduling, interaction handlers |
| `graphTypes.ts` | Node/edge data shapes, graph PR overlay, dialog state types |
| `graphHelpers.ts` | View-mode metadata, icon/color palettes, proposal helpers, risk-edge coloring, `laneSummaryConflictsWith` |
| `graphLayout.ts` | Auto-layout per view mode, filter defaults, session/preferences persistence, legacy migration |
| `graphPrData.ts` | `buildGraphPrOverlay` — derives `GraphPrOverlay` from a `PrSummary` + optional live detail bundle |
| `graphNodes/LaneNode.tsx` | Lane node rendering (badges, status, PR overlay) |
| `graphNodes/ProposalNode.tsx` | Integration proposal node rendering |
| `graphEdges/RiskEdge.tsx` | Edge renderer with risk-level coloring and animations |
| `graphDialogs/ConflictPanel.tsx` | Inline conflict resolution panel for edge clicks |
| `shared/RiskMatrix.tsx` | Project-wide pairwise risk grid with animations |
| `shared/RiskTooltip.tsx` | Hover detail for a matrix cell |

Detail doc in this folder:

- [`data-sources.md`](./data-sources.md) — how lane/PR/mission state feeds the graph and what the hydration stages look like.

## What the graph shows

```
Lane topology (parent-child stack relationships)
+ Primary-to-worktree relationships
+ Conflict-risk overlays (edges colored by pairwise risk)
+ PR overlays (per-lane badges, edge coloring)
+ Sync and activity signals (dots/chips)
+ Merge simulation entry points (edge clicks open ConflictPanel)
+ Integration proposal nodes (with "Fed By" source chips)
```

## View modes

`GraphViewMode` — one of:

| Mode | Label | Layout |
|------|-------|--------|
| `all` | Overview | Concentric rings around primary, split into core (environment-tagged) and others |
| `stack` | Dependencies | Tree by stack depth, children arranged beneath parents |
| `risk` | Conflict Risk | Circular layout, all lanes equidistant for cleaner overlap edges |
| `activity` | Activity | Grid sorted by activity score (most active first) |

`computeAutoLayout(lanes, viewMode, activityScoreByLaneId,
environmentByLaneId)` returns positions for each lane id. User
drags override auto-positions and persist in the session layout
snapshot.

## Persisted state

`GraphSessionState` per view mode:

```ts
type GraphLayoutSnapshot = {
  nodePositions: Record<string, { x: number; y: number }>;
  collapsedLaneIds: string[];
  viewMode: GraphViewMode;
  filters: GraphFilterState;
  updatedAt: string;
};
```

`GraphFilterState` — status filters, lane type filters, tag
filters, `hidePrimary`, `hideAttached`, `hideArchived`,
`rootLaneId`, `search`.

`GraphPersistedState.lastViewMode` is saved globally so the user
returns to their preferred view across sessions.
`normalizeGraphPreferences(state)` migrates legacy schemas (including
the older `presets: […]` shape) to the current format.

## Node data (`GraphNodeData`)

Every lane node carries enough derived state to render without
additional IPC calls during drag/interaction:

```ts
type GraphNodeData = {
  lane: LaneSummary;
  status: ConflictStatus["status"] | "unknown";
  remoteSync: GitUpstreamSyncStatus | null;
  autoRebaseStatus: AutoRebaseLaneStatus | null;
  activeSessions: number;
  collapsedChildCount: number;
  dimmed: boolean;
  activityBucket: "min" | "low" | "medium" | "high";
  viewMode: GraphViewMode;
  lastActivityAt: string | null;
  environment: { env: string; color: string | null } | null;
  highlight: boolean;
  rebaseFailed: boolean;
  rebasePulse: boolean;
  mergeInProgress: boolean;
  mergeDisappearing: boolean;
  isIntegration: boolean;
  focusGlow: boolean;
  isVirtualProposal: boolean;
  integrationSources: Array<{ laneId: string; laneName: string }>;
  pr: GraphPrOverlay | null;
  proposalOutcome?: "clean" | "conflict" | "blocked";
  proposalId?: string;
};
```

The `LaneNode` renderer chooses sync/PR badges entirely from this
data — see `syncBadge` / `prBadge` IIFEs in
`graphNodes/LaneNode.tsx`.

## Edge data (`GraphEdgeData`)

```ts
type GraphEdgeData = {
  edgeType: "topology" | "stack" | "risk" | "integration" | "proposal";
  riskLevel?: "none" | "low" | "medium" | "high";
  overlapCount?: number;
  stale?: boolean;
  dimmed?: boolean;
  highlight?: boolean;
  proposalConflict?: boolean;
  pr?: GraphPrOverlay;
};
```

`RiskEdge` (in `graphEdges/RiskEdge.tsx`) renders edges with colors
from `getPrEdgeColor` (PR-aware edges) or from the risk level
palette (conflict edges). Stale edges render at reduced opacity.

## Core interactions

- **Pan/zoom** — React Flow default.
- **Node drag** — positions persist to the session layout snapshot
  keyed by view mode.
- **Node click** — select lane; context-dependent side panel
  updates.
- **Edge click** — open `ConflictPanel` with merge simulation +
  overlapping file list + AI proposal apply flow.
- **Right-click / context menu** — reparent, archive, delete,
  create child, view diff, open terminal.
- **Collapse/expand** — `collapsedLaneIds[]` hides descendants; the
  parent node shows `collapsedChildCount` so the user sees there's
  hidden depth.
- **Filter bar** — status (`GraphStatusFilter`), lane type, tag
  chips, search. Active filter count drives `Funnel` icon badge.

## Minimap and background

`ReactFlow` is wrapped with:

- `<MiniMap />` — standard React Flow minimap.
- `<Background variant={BackgroundVariant.Dots} />` for the dot grid.
- Custom `<Panel />` regions for filters, zoom controls, and the
  active `ConflictPanel` / `PrDetailPane` overlays.

## Refresh cadence

`WorkspaceGraphPage` owns several refresh paths with different
intervals and in-flight guards:

| What | Who | Cadence |
|------|-----|---------|
| Lane list (`useAppStore.refreshLanes`) | `refreshLanes` | On focus, on explicit action |
| Sync status (`getLaneUpstreamSync`) | `refreshLaneSyncStatuses` | Every 60 s |
| Auto-rebase status | `refreshAutoRebaseStatuses` | Every 60 s |
| Risk matrix batch | `refreshRiskBatch` | Staged after first paint; on explicit action |
| Activity (recent sessions) | `refreshActivity` | Debounced, coalesced with in-flight guard; bounded limits |
| PRs | `refreshPrs` | Debounced, scheduled after first paint; 60 s background |

In-flight guards:

```ts
const syncRefreshInFlightRef = React.useRef(false);
const syncRefreshQueuedRef = React.useRef(false);
// …repeat for autoRebase, activity, PR
```

When a refresh is requested mid-flight, the queue flag is set so
exactly one follow-up runs after the current one completes. This
prevents refresh storms when several events arrive in quick
succession.

## Activity scoring

`GRAPH_ACTIVITY_SESSION_LIMIT = 150` — only the 150 most recent
sessions are inspected when computing per-lane activity scores.
`GRAPH_ACTIVITY_OPERATION_LIMIT = 150` — same for operations.

This is the intentional bound documented in
[`data-sources.md`](./data-sources.md). It keeps scoring O(150)
regardless of project history depth.

Activity scoring prioritizes:

- running sessions > awaiting-input > ended
- recent operations > old operations
- session-derived signals over history-backed recompute (the latter
  is reserved for slower timers and focus/visibility return)

`activityBucket` (on each node): `"min" | "low" | "medium" | "high"`.
Drives node size and shadow intensity in `LaneNode`.

## Conflict panel

`graphDialogs/ConflictPanel.tsx` is the inline resolution UI:

- Header with lane A ↔ lane B names.
- Merge simulation outcome (clean / conflict / count).
- Overlapping files list (from `overlapFilesByPair` map).
- "Apply to" lane selector (target branch chooser).
- AI proposal flow: prepare → request → apply with mode selector
  (`unstaged | staged | commit`) + optional commit message.

Data wiring:

```ts
props: {
  conflictPanel: ConflictPanelState;
  setConflictPanel: React.Dispatch<…>;
  laneById: Map<string, LaneSummary>;
  overlapFilesByPair: Map<string, string[]>;
  refreshRiskBatch: () => Promise<void>;
  refreshLanes: () => Promise<void>;
}
```

The panel issues IPC calls directly to `ade.conflicts.simulateMerge`,
`.prepareProposal`, `.requestProposal`, `.applyProposal`.

## Risk matrix

`shared/RiskMatrix.tsx` renders the pairwise matrix as a grid.
Cells:

- Color-coded by risk (`high/medium/low/none`).
- Selected cell rings in accent color.
- Stale cells at reduced opacity with a clock icon and "Last
  computed N min ago" tooltip.
- Animated change effects: `increased` and `decreased` flashes when
  a cell's risk level transitions between polls.
- Entry animation on first appearance.
- Progress indicator driven by `prediction-progress` events
  (`completedPairs / totalPairs`).

`pairKey(a, b)` and `hasSamePair` normalize ordered pairs so matrix
lookups are symmetric.

## PR-to-graph navigation

The renderer's `buildGraphPrOverlay(args)` converts a PR summary +
live detail into `GraphPrOverlay` so the graph can show PR state
without every PR detail loaded:

- `number`, `title`, `url`, `state`, `checksStatus`, `reviewStatus`
- `pendingCheckCount`, `approvedCount`, `changeRequestCount`,
  `commentCount`, `reviewCount`
- `isMergeable`, `mergeConflicts`, `behindBaseBy`
- `lastActivityAt` (max of `updatedAt`, `lastSyncedAt`, check
  times, review times, comment times)
- `activityState` (derived via `derivePrActivityState`)
- `detailLoaded` — whether the live detail bundle was present

Nodes render PR badges via `prBadge` IIFE; edges can carry PR
metadata via `GraphEdgeData.pr`.

## Layout migration

Older versions of the graph persisted state under `presets: […]`
with nested `byViewMode` maps and an `activePreset` name.
`normalizeGraphPreferences(state)` reads both shapes and produces
`createGraphPreferences(lastViewMode)` as the canonical form.
`migrated: true` is returned so the caller knows to rewrite
persistence on next save.

## Current product contract

Per the design doc in `docs/features/WORKSPACE_GRAPH.md`:

- Make topology visible first.
- Stage non-essential overlays (risk, PR, sync) after first paint.
- Bound activity and polling work.
- Avoid history-backed activity recompute on every terminal event;
  use the live PTY signal instead.
- Keep risk, PR, and sync overlays fresh enough without constant
  churn.

See [`data-sources.md`](./data-sources.md) for the hydration
sequence in detail.

## Gotchas

- **`GraphInner` has >100 hooks.** The module sets
  `// @refresh reset` so HMR forces a clean remount. Do not remove
  this directive — partial HMR in this component causes hook-order
  crashes.
- **ReactFlow requires `ReactFlowProvider`.** The page wraps
  `GraphInner` in `<ReactFlowProvider>`; child components that use
  `useReactFlow()` must be inside that provider.
- **Node dimensions change with activity bucket.** `nodeDimensions`
  scales with activity to surface busy lanes; layout computations
  must account for variable node sizes.
- **`GRAPH_ACTIVITY_SESSION_LIMIT` is load-bearing.** Raising it
  makes activity scans O(N) in session history and regresses the
  "canvas becomes interactive first" contract.
- **Refresh coalescing.** Direct `refresh*` calls bypass the
  in-flight guard; prefer `scheduleRefresh*` variants from the
  refresh-scheduling section.
- **Node positions persist per view mode.** Switching modes can
  show a dramatically different layout if the user has not yet
  moved nodes in the new mode. Auto-layout runs when no persisted
  positions exist.
- **Integration lane nodes use distinctive styling** (purple
  gradient, dashed integration badge). `isIntegration` is set via
  `isIntegrationLaneFromMetadata(lane)` from
  `renderer/lib/integrationLanes.ts`.
