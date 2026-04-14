# Lanes

Lanes are ADE's unit of parallel work. Each lane wraps a git branch and an
isolated worktree directory, providing a self-contained workspace where
changes, terminals, chat sessions, processes, and runtime state do not
interfere with any other lane. Everything that can be scoped to a lane
(dev servers, ports, proxy hostnames, OAuth callbacks, health checks,
environment init, chat sessions) is scoped to one.

This folder documents the Lanes feature: data model, worktree mechanics,
stack dependency graphs, the runtime isolation subsystem, and the OAuth
redirect service that makes multi-lane auth practical.

## Source file map

Core services (`apps/desktop/src/main/services/lanes/`):

| File | Responsibility |
|------|---------------|
| `laneService.ts` | Lane CRUD, worktree creation/removal, status computation, stack chain traversal, rebase runs, reparent, mission role tagging, startup repair routines |
| `autoRebaseService.ts` | Auto-rebase worker for stacked lanes, attention state, head-change handlers |
| `rebaseSuggestionService.ts` | Emits rebase suggestions when a parent lane advances, dismiss/defer lifecycle |
| `laneEnvironmentService.ts` | Environment init pipeline: env files, docker services, dependencies, mount points, copy paths (Phase 5 W1) |
| `laneTemplateService.ts` | Reusable lane init templates (Phase 5 W2) |
| `portAllocationService.ts` | Lease-based per-lane port ranges (Phase 5 W3) |
| `laneProxyService.ts` | `*.localhost` reverse proxy, per-lane routes, cookie isolation (Phase 5 W4) |
| `oauthRedirectService.ts` | OAuth callback routing for multi-lane (Phase 5 W5) |
| `runtimeDiagnosticsService.ts` | Aggregate lane health checks, fallback mode (Phase 5 W6) |
| `laneLaunchContext.ts` | Pure helper: resolves launch cwd/env for terminals and tools |

Renderer components:

| File | Responsibility |
|------|---------------|
| `renderer/components/lanes/LanesPage.tsx` | 3-pane cockpit, tab management, dialog coordination |
| `renderer/components/lanes/LaneStackPane.tsx` | Stack graph sidebar, integration source chips, canvas jump |
| `renderer/components/lanes/LaneDiffPane.tsx` | Diff viewer, per-file stage/unstage/discard |
| `renderer/components/lanes/LaneGitActionsPane.tsx` | Commit, stash, fetch, sync, push, recent commits |
| `renderer/components/lanes/LaneWorkPane.tsx` | Terminal/chat toggle work surface |
| `renderer/components/lanes/LaneRebaseBanner.tsx` | Inline banner driven by `rebaseSuggestionService` |
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Env init step progress inside create dialog |
| `renderer/components/lanes/CreateLaneDialog.tsx`, `AttachLaneDialog.tsx`, `ManageLaneDialog.tsx`, `MultiAttachWorktreeDialog.tsx`, `LaneDialogShell.tsx` | Lane creation/attach/edit dialogs |
| `renderer/components/lanes/MonacoDiffView.tsx` | Monaco-based side-by-side file diff |
| `renderer/components/run/LaneRuntimeBar.tsx` | Compact lane runtime status bar (health, preview, port, proxy, oauth) |
| `renderer/components/run/RunPage.tsx`, `RunNetworkPanel.tsx` | Runtime dashboards that consume lane runtime services |
| `renderer/components/settings/ProxyAndPreviewSection.tsx`, `DiagnosticsDashboardSection.tsx`, `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Settings-side management UIs |

Shared code:

- `src/shared/laneBaseResolution.ts` — `shouldLaneTrackParent`, `branchNameFromLaneRef`, `resolveStableLaneBaseBranch`. Used by `laneService`, `conflictService`, `autoRebaseService`, `rebaseSuggestionService`, `prService`, and renderer helpers so base-ref resolution stays consistent.
- `src/shared/types.ts` — `LaneSummary`, `LaneStatus`, `StackChainItem`, `CreateLaneArgs`, rebase args/results, overlay types, port/proxy/OAuth/diagnostics types.
- `src/shared/laneOverlayMatcher.ts` — last-wins/deep-merge evaluator for per-lane overlay policies.

Detail docs in this folder:

- [`worktree-isolation.md`](./worktree-isolation.md) — git worktree mechanics and per-lane state directories.
- [`stacking.md`](./stacking.md) — parent-child lanes, rebase propagation, base-ref resolution.
- [`runtime.md`](./runtime.md) — runtime diagnostics, proxy, preview, port allocation, env init, LaneRuntimeBar.
- [`oauth-redirect.md`](./oauth-redirect.md) — OAuth redirect service (new on this branch) and `http.request` mocking strategy.

## Lane types

The `LaneType` column on the `lanes` table is one of:

| Type | Worktree | Use |
|------|----------|-----|
| `primary` | Repo root itself, no worktree created | Main branch, always exists, edit-protected |
| `worktree` | `.ade/worktrees/<name>/` managed by ADE | Default for new lanes |
| `attached` | User-supplied external path | Link a worktree created outside ADE |

Primary lanes are created by `laneService.ensurePrimaryLane()` on project
open and never rebuilt. Their `is_edit_protected = 1` flag prevents delete
and reparent operations. Two startup repair routines normalize older data:

- `repairPrimaryParentedRootLanes` — detaches non-primary lanes whose
  `parent_lane_id` was mistakenly set to the primary lane and resets
  `base_ref` to the project's default branch.
- `repairLegacyPrimaryBaseRootLanes` — normalizes `base_ref` on root
  worktree lanes that still point to a stale or non-default branch.
  Lanes with open PRs are excluded from repair.

Both routines run at `createLaneService()` time.

## Lane status

`LaneStatus` is computed fresh on list/get calls by running git inside the
worktree:

```ts
type LaneStatus = {
  dirty: boolean;          // git status has changes
  ahead: number;           // commits ahead of base ref
  behind: number;          // commits behind base ref
  remoteBehind: number;    // commits behind `origin/<branch>`, -1 if unknown
  rebaseInProgress: boolean;
};
```

Status is cached for 10 s (`LANE_LIST_CACHE_TTL_MS`). The base ref used
for ahead/behind is chosen by `shouldLaneTrackParent`: a child tracks its
parent only when the parent is a non-primary lane; otherwise the child
compares against its own `baseRef`. This avoids the degenerate case where
a lane parented to primary would always show zero behind.

`LaneSummary` adds:

- `parentStatus: LaneStatus | null` — parent's status at this snapshot (used to decide whether a rebase is needed)
- `stackDepth: number`
- `childCount: number`
- `tags: string[]`, `color`, `icon`, `folder`
- `missionId`, `laneRole` (nullable; see mission roles)

## Mission lane roles

Lanes may belong to a mission via `missionId` + `laneRole`. Roles:

| Role | Meaning |
|------|---------|
| `mission_root` | Base lane the mission launched from |
| `worker` | Lane for an individual worker agent |
| `integration` | Merge target (legacy, retained for compatibility) |
| `result` | Single output lane holding consolidated changes |

`laneService.setMissionOwnership()` tags or re-tags a lane after
creation. `createChildLane` also accepts these fields so worker/result
lanes are tagged at birth. Mission-owned worker lanes are hidden by
default from the Lanes list (see `isMissionLaneHiddenByDefault` in
`renderer/components/lanes/laneUtils.ts`).

## Lane lifecycle

1. **Create** — `laneService.create()` resolves the base ref (explicit
   or parent's branch), normalizes the branch name, computes a unique
   worktree path under `.ade/worktrees/<slug>/`, runs `git worktree
   add`, inserts the lane row, and returns a `LaneSummary`.
2. **Create child** — same as create but with `parentLaneId`. Child's
   base ref defaults to the parent's branch ref.
3. **Create from unstaged** — `createFromUnstaged` rescues uncommitted
   work into a new child lane via `git stash` in the source worktree
   plus `git stash apply` in the child. Rolls back the child if apply
   fails. Rejects when the source has staged changes or an
   in-progress merge/rebase.
4. **Import branch** — `importBranch` attaches an existing branch to a
   worktree managed by ADE.
5. **Attach** — `attach` links an external worktree path (pre-existing
   outside ADE). `lane_type = 'attached'`.
6. **Rename / update appearance / reparent** — `rename`, `updateAppearance`,
   `reparent` edit the lane row. `reparent` refuses to move a lane
   under one of its own descendants and refuses to reparent the
   primary lane.
7. **Archive** — `archive` sets `archived_at` and `status = 'archived'`
   but keeps the worktree on disk. `unarchive` reverses it.
8. **Delete** — `deleteLane` removes the worktree and the row. Can
   optionally delete the branch too.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts` and
exposed through `apps/desktop/src/preload/preload.ts`.

Lane management (selected):

| Channel | Signature |
|---------|-----------|
| `ade.lanes.list` | `(args: ListLanesArgs) => LaneSummary[]` |
| `ade.lanes.create` | `(args: CreateLaneArgs) => LaneSummary` |
| `ade.lanes.createChild` | `(args: CreateChildLaneArgs) => LaneSummary` |
| `ade.lanes.createFromUnstaged` | `(args: CreateLaneFromUnstagedArgs) => LaneSummary` |
| `ade.lanes.attach` | `(args: AttachLaneArgs) => LaneSummary` |
| `ade.lanes.importBranch` | `(args: { branchRef: string }) => LaneSummary` |
| `ade.lanes.rename` / `.updateAppearance` / `.reparent` / `.archive` / `.delete` | lane edit operations |
| `ade.lanes.getStackChain` | `(args: { laneId: string }) => StackChainItem[]` |
| `ade.lanes.rebaseStart` / `.rebaseAbort` / `.rebaseRollback` / `.rebasePush` | rebase run lifecycle |
| `ade.lanes.listRebaseSuggestions` / `.dismissRebaseSuggestion` / `.deferRebaseSuggestion` | rebase suggestion lifecycle |

Runtime isolation (Phase 5):

- `ade.lanes.initEnv`, `ade.lanes.getEnvStatus`, `ade.lanes.getOverlay`, `ade.lanes.env.event`
- `ade.lanes.templates.*`
- `ade.lanes.port.*` (`getLease`, `listLeases`, `listConflicts`, `acquire`, `release`, `recoverOrphans`, `event`)
- `ade.lanes.proxy.*` (`getStatus`, `start`, `stop`, `addRoute`, `removeRoute`, `getPreviewInfo`, `openPreview`, `event`)
- `ade.lanes.oauth.*` (`getStatus`, `updateConfig`, `generateRedirectUris`, `encodeState`, `decodeState`, `listSessions`, `event`)
- `ade.lanes.diagnostics.*` (`getStatus`, `getLaneHealth`, `runHealthCheck`, `runFullCheck`, `activateFallback`, `deactivateFallback`, `event`)

## Renderer wiring

`LanesPage` uses `PaneTilingLayout` to host `LaneStackPane` (left),
`LaneDiffPane`, `LaneGitActionsPane`, `LaneWorkPane`, and an inspector
sidebar. Pane sizes persist via `DockLayoutState`. Tabs hold multiple
open lanes; primary lanes render with a home icon.

- `LaneRebaseBanner` subscribes to `rebase-suggestions-updated` events
  and surfaces dismiss/defer/rebase buttons.
- `LaneStackPane` shows a mini stack graph with a one-click "Open
  Canvas" action that navigates to `/graph` — the full
  [workspace graph](../workspace-graph/README.md).
- `LaneWorkPane` toggles between an xterm.js terminal view
  (`LaneTerminalsPanel`) and an agent chat view (`AgentChatPane`).
  Chat sessions inherit `cwd = lane.worktreePath`.
- The Lanes page reads pane overlay data from `appStore` (`lanes`,
  `refreshLanes`) and from the per-lane `useLaneWorkSessions` hook.
- `LaneRuntimeBar` (Run page) renders lane runtime state: health dot,
  proxy/preview status, OAuth callback URL, active processes. It
  parallelizes six IPC calls and debounces via an in-flight sequence
  counter to ignore out-of-order responses.

## Gotchas and fragile areas

- **Base-ref math must go through `laneBaseResolution.ts`.** Any
  consumer that recomputes "is this lane behind its base" without
  `shouldLaneTrackParent` will produce wrong behind-counts for lanes
  parented to the primary lane.
- **Primary lane edit protection.** `is_edit_protected = 1` is enforced
  in `laneService` rather than the DB. Code paths that update rows
  directly must check this flag (delete, reparent, rebase start).
- **Rebase run deduplication.** `rebaseStart` refuses to begin a new
  run if another run in the same root stack is currently `running`.
  Root stack is computed via `resolveRootAncestorId` walking up
  `parent_lane_id`.
- **Startup repair runs every boot.** If you introduce a new lane
  field that can drift, handle it in the repair routines too.
- **Lane list cache.** `LANE_LIST_CACHE_TTL_MS = 10_000`. Services
  that need fresh status after a git operation must call
  `laneService.list({ refresh: true })` or mutate through the
  service rather than another path.
- **OAuth redirect service is particularly fragile** — see
  [`oauth-redirect.md`](./oauth-redirect.md). Incoming callbacks
  involve three state machines (pending-start, pending-finalize,
  live session) and HMAC-signed state parameters.
- **Worktree paths must remain absolute.** `laneService` stores
  resolved absolute paths. Relative paths persisted by a bad caller
  break `git -C` across shells.
- **Mission lanes hidden by default.** If a test expects a mission
  worker lane to be visible, it must explicitly include mission
  lanes via `isMissionLaneHiddenByDefault` filter bypass.
