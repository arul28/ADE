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

| Mode | Label | What changes |
|------|-------|--------------|
| `all` | Overview | Primary-centric tree. Stack edges are shown; risk "overlap web" is hidden by default behind a "Show overlap web" toggle. |
| `stack` | Dependencies | Same tree layout as Overview. Emphasis on parent-child stack edges; drag to reparent. |
| `risk` | Conflict Risk | Same tree layout, risk edges always drawn between overlapping lanes. Matrix panel available for file-level detail. |
| `activity` | Activity | Same row grid, but siblings within a row sort by activity score (high → low) before stack depth and name. |

All view modes share a single primary-centric row layout. The
primary lane sits at the top, each descendant appears on row
`depth * Y_STEP` below it, and row members are spaced at
`X_PITCH` centered horizontally. Lanes that can't be traced back
to the workspace primary via parent links are bucketed into a
single "orphan" row at the bottom (`depthByLaneId = 10_000`).

Implementation:

- `laneHierarchyFromPrimary(lanes)` returns
  `{ primary: LaneSummary | null, depthByLaneId, parentNameByLaneId }`.
  Returns an empty shape when `lanes` is empty — callers must
  handle `primary: null` (this matters during project open/switch
  when the lane list briefly empties out).
- `layoutPrimaryCentricRows(lanes, activityScoreByLaneId, tieBreak)`
  produces the actual positions. `tieBreak` is `"activity"` in
  activity mode, `"stack"` everywhere else.
- `computeAutoLayout(lanes, viewMode, activityScoreByLaneId, _environmentByLaneId)`
  is the public entry point the page calls. The environment map
  parameter is accepted for signature stability but no longer
  influences layout — lanes aren't split into "core" vs "others"
  any more.

User drags override auto-positions and persist in the session
layout snapshot per view mode.

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
  /** Steps from the workspace primary lane along parent links (0 = primary). */
  hierarchyDepth: number;
  /** Immediate parent lane name when parent exists in the workspace. */
  parentLaneName: string | null;
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

`hierarchyDepth` and `parentLaneName` come from
`laneHierarchyFromPrimary(lanes)` (memoized once per lane list as
`primaryHierarchyMeta`) and are threaded into every lane node
during derivation. Orphan lanes (not under primary) use the
sentinel `10_000`; `LaneNode` treats anything `>= 1000` as an
orphan and suppresses the depth badge.

The `LaneNode` renderer:

- Chooses sync/PR badges entirely from this data — see `syncBadge`
  / `prBadge` IIFEs in `graphNodes/LaneNode.tsx`.
- Renders a role-label chip top-right using lane terminology:
  `"Primary lane"` for `laneType === "primary"`,
  `"Attached lane"` for `"attached"`, and `"Lane"` for
  `"worktree"`. Integration lanes get a distinctive purple
  `Integration` badge instead.
- Shows the custom `lane.icon` glyph when set; the primary lane
  falls back to a `House` icon if no custom icon is configured.
- Renders an `L{depth}` badge next to the branch ref
  (`TreeStructure` icon) when the lane sits under primary. For
  orphans, the badge is replaced with an amber "Not stacked under
  the workspace primary" hint.
- Renders a parent-lane breadcrumb ("On <parentName>") underneath
  the header when `parentLaneName` is non-null.

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

### Risk edges and the overview overlap web

The page has a `showOverviewRiskEdges` boolean (toggled by the
"Show overlap web" / "Hide overlap web" button in the filter bar,
shown only when `viewMode === "all"`). It resets to `false` on
any view-mode change.

Risk edges render when:

```
viewMode === "risk"
|| (viewMode === "all" && showOverviewRiskEdges)
```

Both the render pass and the `riskPairsWithVisibleEdge`
population (used to decide whether PR overlays get their own edge
or piggyback on an existing risk/stack edge) use this same gate,
so PR overlays in Overview consistently stick to the visible
topology/stack edge when the overlap web is hidden.

In Overview, redundant "primary → lane" spokes are also
suppressed when the lane already has a parent within the
workspace — the stack edge chain already communicates the tree,
so the extra spoke would just add clutter.

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

- Make topology visible first: one shared primary-centric row
  layout across Overview / Dependencies / Conflict Risk /
  Activity so switching modes doesn't rearrange the canvas.
- Stage non-essential overlays (risk, PR, sync) after first
  paint.
- Hide the overlap web by default in Overview — stack edges are
  enough on their own; the overlap web is one click away.
- Bound activity and polling work.
- Avoid history-backed activity recompute on every terminal
  event; use the live PTY signal instead.
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
- **Node positions persist per view mode.** Every view mode
  auto-layouts to the same primary-centric rows, so the canvas
  stays stable when switching modes as long as the user hasn't
  dragged nodes. Once the user drags in a given mode, that
  mode's snapshot diverges and auto-layout stops applying until
  "Reset View" clears it.
- **`laneHierarchyFromPrimary` can return `primary: null`.** The
  workspace briefly has zero lanes during project open/switch;
  callers (layout, edge derivation, node data) must tolerate the
  null primary rather than dereference it. Regression coverage
  lives in `graphLayout.test.ts`.
- **Integration lane nodes use distinctive styling** (purple
  gradient, dashed integration badge). `isIntegration` is set via
  `isIntegrationLaneFromMetadata(lane)` from
  `renderer/lib/integrationLanes.ts`.
