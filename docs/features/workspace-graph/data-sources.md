# Graph data sources and hydration

The graph does not own data. It projects lane, PR, conflict,
session, and operation state into `GraphNodeData` / `GraphEdgeData`.
The renderer stages data loading in layers so the canvas is
interactive before every overlay finishes.

Source: `apps/desktop/src/renderer/components/graph/WorkspaceGraphPage.tsx`.

## Data feeds

| Source | Feeds | IPC / store path |
|--------|-------|------------------|
| Lane list | Node positions, node data (`lane`) | `appStore.lanes`, `appStore.refreshLanes()` |
| Conflict status + risk matrix | Node `status`, edge `riskLevel`, matrix | `ade.conflicts.getBatchAssessment` |
| Sync status | Node `remoteSync` badge | `ade.git.getLaneUpstreamSync` (batched) |
| Auto-rebase status | Node `autoRebaseStatus` badge | `ade.lanes.listAutoRebaseStatuses` |
| Sessions | Active session counts, activity score, last-activity timestamps | `renderer/lib/sessionListCache.ts` (cached list + PTY event stream) |
| Operations | Activity score (git commits) | `ade.history.listOperations` |
| PRs | Node `pr` overlay, PR edges | `ade.prs.listWithConflicts` |
| Integration proposals | Proposal nodes | `ade.prs.listProposals` |
| Environment mappings | Environment coloring per lane | `ade.project.listEnvironmentMappings` |

## Initial hydration sequence

When the user opens the `/graph` route:

1. **Immediate** — lane list refresh (`refreshLanes`). Topology
   loading indicator is visible until this resolves.
2. **+800 ms** — schedule activity refresh (sessions + operations).
3. **+1.5 s** — risk batch refresh (`refreshRiskBatch` →
   `ade.conflicts.getBatchAssessment`).
4. **+2.5 s** — lane sync statuses (`refreshLaneSyncStatuses`).
5. **+3.5 s** — auto-rebase statuses (`refreshAutoRebaseStatuses`).
6. **+4.0 s** — PR list (`refreshPrs` →
   `ade.prs.listWithConflicts`).

Every timer checks `document.visibilityState === "visible"` and
`!cancelled` before firing. Navigating away or hiding the window
cancels deferred loads.

Rationale: topology loads first so the user can see and interact
with the graph. Overlays (risk, sync, auto-rebase, PRs) backfill
without blocking the first paint.

## In-flight guards

Every refresh has three refs:

```ts
const syncRefreshInFlightRef = React.useRef(false);
const syncRefreshQueuedRef = React.useRef(false);
// same pattern for autoRebase, activity, PR
```

Behavior when a refresh is requested while one is already running:

- Set the queued flag and return.
- The in-flight refresh's `finally` block checks the queued flag
  and schedules exactly one follow-up.

Prevents refresh storms when multiple events arrive in bursts
(common on lane updates and PR webhook deliveries).

## Activity scoring

`refreshActivity({ includeOperations? })` computes per-lane scores:

```
sessions (capped at GRAPH_ACTIVITY_SESSION_LIMIT = 150):
  - running session → +50, mark activity at startedAt
  - ended within last hour → +20, mark at endedAt
  - started within last hour → +10, mark at startedAt

operations (capped at GRAPH_ACTIVITY_OPERATION_LIMIT = 150):
  - only kind === "git_commit"
  - started within last 24 h → +10, mark at startedAt
```

Outputs:

- `activeSessionsByLaneId: Record<string, number>` — drives "N running" badges
- `activityScoreByLaneId: Record<string, number>` — sort key for
  activity view mode; also drives `activityBucket`
- `lastActivityByLaneId: Record<string, string>` — ISO timestamps
  for "last activity" tooltip

`activityBucket` mapping (in `graphHelpers.ts`): score >
threshold → `"high"`, then medium/low/min. Node shadows and sizes
react to bucket.

## Session list caching

Sessions flow through `renderer/lib/sessionListCache.ts` which:

- Maintains an in-memory cached list keyed by a last-fetched
  timestamp.
- Applies PTY stdout / state events directly to the cached list
  (no re-fetch per event).
- Exposes `listSessionsCached({ limit })` for consumers that want
  bounded sets.

The graph reads via `listSessionsCached({ limit: 150 })` and filters
out run-owned sessions with `isRunOwnedSession`. This is
intentional: run-owned sessions should not inflate a lane's
activity — the Run page tracks those separately.

## History-backed activity refresh

Reading operations from `ade.history.listOperations` is more
expensive than reading sessions. The graph defers it when possible:

- `scheduleRefreshActivity(delayMs, { includeOperations })` uses a
  ref (`activityRefreshNeedsOperationsRef`) to batch requests.
  Callers that explicitly don't need operations (e.g., a PTY chunk
  arrived) pass `includeOperations: false`.
- The next scheduled refresh will include operations only if any
  caller has requested them since the last run.

This keeps live PTY output from triggering a full operations fetch
on every chunk.

## Event-driven refreshes

The page subscribes to several main-process event streams and
schedules refreshes accordingly:

- `ade.prs.onEvent(event)` — when `event.type === "prs-updated"` →
  `scheduleRefreshPrs()`.
- Lane events — when `onLaneChanged` fires (reparent, create,
  archive) → `refreshLanes()` via app store → which triggers a
  graph re-render.
- Conflict events (`prediction-progress`, `prediction-complete`,
  `prediction-updated`) — update local `batch` / `batchProgress`
  state without a full re-fetch.

Node drag events do not trigger refreshes; position updates are
stored in the session snapshot and persisted via
`updateGraphSnapshot`.

## Derived state

Several derived maps are memoized:

- `laneById` — `Map<string, LaneSummary>` built from `lanes`.
- `primaryHierarchyMeta` — `laneHierarchyFromPrimary(lanes)`;
  returns `{ primary, depthByLaneId, parentNameByLaneId }`. Used
  both by node data (hierarchyDepth / parentLaneName) and by
  edge derivation (primary spokes, risk edges). Handles the
  empty-lanes case by returning `primary: null` with empty maps
  so derivation can short-circuit safely.
- `overlapFilesByPair` — `Map<pairKey, string[]>` from
  `batch.overlaps`; used by `ConflictPanel`.
- `integrationSourcesByLaneId` — built via
  `buildIntegrationSourcesByLaneId(lanes)` from
  `renderer/lib/integrationLanes.ts`; used to annotate integration
  nodes with their feed sources.
- `prByLaneId` — `Map<string, PrWithConflicts>` for quick node
  overlay lookups.

## Node derivation pipeline

Per lane:

```
lane (from appStore.lanes)
  + batch.lanes (ConflictStatus[] keyed by laneId) → node.status
  + syncByLaneId[laneId] → node.remoteSync
  + autoRebaseByLaneId[laneId] → node.autoRebaseStatus
  + activeSessionsByLaneId[laneId] → node.activeSessions
  + activityScoreByLaneId[laneId] → node.activityBucket
  + lastActivityByLaneId[laneId] → node.lastActivityAt
  + environmentByLaneId[laneId] → node.environment
  + prByLaneId[laneId] → node.pr (via buildGraphPrOverlay)
  + integrationSourcesByLaneId[laneId] → node.integrationSources
  + primaryHierarchyMeta.depthByLaneId[laneId] → node.hierarchyDepth
  + primaryHierarchyMeta.parentNameByLaneId[laneId] → node.parentLaneName
  + collapsed state (session snapshot) → node.collapsedChildCount
  + current filters → node.dimmed / node.highlight
  + merge/rebase animation refs → rebasePulse, mergeInProgress, etc.
```

## Edge derivation

Topology edges:

- For each lane with `parentLaneId`, emit a `stack` edge
  parent → child. Dimmed if either endpoint is filtered out.
- In Overview + Dependencies modes, a "primary → lane" spoke is
  emitted for lanes that have no workspace parent. Lanes that
  already have a parent inside the workspace skip the spoke
  (the stack-edge chain already communicates the tree).

Risk edges:

- For each non-zero `RiskMatrixEntry`, emit a `risk` edge between
  the two lanes with `riskLevel`, `overlapCount`, and `stale`
  metadata.
- Render gating:
  `viewMode === "risk" || (viewMode === "all" && showOverviewRiskEdges)`.
  The `riskPairsWithVisibleEdge` set (used to let PR overlays
  piggyback on an existing risk/stack edge) is populated with the
  same gate, so PR overlays in Overview consistently stick to
  the visible topology/stack edge when the overlap web is
  hidden.

Proposal edges:

- Virtual proposal nodes connect to their source lanes via
  `proposal` edges carrying `proposalConflict` for coloring.

PR edges:

- PR-aware edges use `getPrEdgeColor(pr)` to color by PR state
  (green for ready, red for checks failing, amber for needs
  changes, etc).

## Persistence

Two storage paths:

- **Per-view session snapshot** (`GraphSessionState`): node
  positions, collapsed state, filters. Persisted per view mode so
  switching modes preserves the user's layout.
- **Global preferences** (`GraphPersistedState`): `lastViewMode`
  only. Written via `ade.workspace.saveGraphPreferences` (or
  similar IPC name — consult `preload.ts`).

`normalizeGraphPreferences(state)` reads either the current or
legacy (`presets: […]`) format. If `migrated: true`, the caller
rewrites on next save.

## Interactions that trigger refresh

| Action | Refresh |
|--------|---------|
| Reparent a lane | `refreshLanes`, `scheduleRefreshActivity(_, {includeOperations:false})` |
| Create/delete lane | `refreshLanes`, re-run auto-layout for fresh node |
| Apply AI proposal | `refreshRiskBatch`, `refreshLanes` |
| Run merge simulation | No refresh (inline panel state only) |
| Change view mode | Recompute auto-layout if positions missing; resets `showOverviewRiskEdges` to `false` |
| Toggle "Show overlap web" (Overview only) | No IPC; local boolean drives risk-edge render gate |
| Change filters | No refresh; local dimmed/highlight recalculation |
| PR update event | `scheduleRefreshPrs()` |

## What does NOT trigger refresh

Intentional omissions:

- Pan and zoom — React Flow local state only.
- Hover over a matrix cell — `setHoveredPair` is local state, no
  IPC.
- Selecting a node — local state only; the sidebar reads from
  already-loaded data.

## Gotchas

- **Initial hydration timers must all check `visibilityState`.**
  If the user switches away from the graph tab before a deferred
  load fires, skipping the work saves cycles and avoids laying
  down stale state behind the user's back.
- **`activityRefreshNeedsOperationsRef` is a ref, not state.**
  Using state would cause extra renders per request; the ref is
  read inside the timer callback where React doesn't see the
  change.
- **`listSessionsCached` is the shared cache.** Avoid calling
  `ade.sessions.list` directly in the graph — it bypasses the
  cache and causes redundant IPC traffic.
- **Do not assume `batch.overlaps` covers every pair.** In
  prefilter mode (over 15 lanes), only likely-conflict pairs are
  in the map. `overlapFilesByPair` falls back to an empty list
  for missing pairs and the `ConflictPanel` handles the empty
  case gracefully.
- **PR refresh is intentionally delayed 4 s.** Earlier than that
  and PR data blocks topology paint on slow projects. Later than
  that and the user perceives "PR overlays never load." Keep
  this window.
- **Graph preferences use `GraphPersistedState.lastViewMode`
  only.** Anything richer (presets, shared views) is intentionally
  out of scope for the current iteration.
- **Session cache retains run-owned sessions.** The graph filters
  them out; other consumers may want them. Don't conflate the
  two.
