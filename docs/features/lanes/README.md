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
| `autoRebaseService.ts` | Auto-rebase worker for stacked lanes, attention state, head-change handlers. Consults `resolvePrRebaseMode` to determine whether a lane with a linked PR should auto-rebase (`pr_target` strategy) or only surface manual attention (`lane_base` strategy). |
| `rebaseSuggestionService.ts` | Emits rebase suggestions when a parent lane advances, dismiss/defer lifecycle. Each suggestion may include up to 20 `RebaseTargetCommit` entries showing the behind commits the rebase would pull in. |
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
| `renderer/components/lanes/laneUtils.ts` | Pure lane list/filter helpers plus default pane trees, including the work-focused tiling tree used by parallel chat launch deep links. |
| `renderer/components/lanes/laneColorPalette.ts` | Curated 12-swatch lane color palette (`LANE_COLOR_PALETTE`) plus helpers (`getLaneAccent`, `colorsInUse`, `nextAvailableColor`, `laneColorName`). The first 8 hexes form `LANE_FALLBACK_COLORS`, the legacy index-based fallback used for lanes that don't have an explicit color assigned. |
| `renderer/components/lanes/LaneAccentDot.tsx` | Tiny accent dot used everywhere a lane is mentioned (lane list, tabs, PR rows, AppShell PR toasts). Resolves color via `getLaneAccent` so a lane without an explicit color falls back to a deterministic fallback hex. |
| `renderer/components/lanes/LaneColorPicker.tsx` | Reusable swatch-row picker used inside `CreateLaneDialog` and `ManageLaneDialog`. Disables swatches already in use by other lanes (passed in as `usedColors`) and offers a clear button. |
| `renderer/components/lanes/LaneContextMenu.tsx` | Right-click menu on the lane list. Hosts the inline color swatch row that calls `lanes.updateAppearance` directly, "Reveal/Copy path", manage/adopt/open-in-Run actions, split-tab actions, and batch manage. |
| `renderer/components/lanes/LaneStackPane.tsx` | Stack graph sidebar, integration source chips, canvas jump |
| `renderer/components/lanes/LaneDiffPane.tsx` | Diff viewer, per-file stage/unstage/discard |
| `renderer/components/lanes/LaneGitActionsPane.tsx` | Commit, stash, fetch, sync, push, recent commits |
| `renderer/components/lanes/LaneWorkPane.tsx` | Terminal/chat toggle work surface |
| `renderer/components/lanes/LaneRebaseBanner.tsx` | Inline banner driven by `rebaseSuggestionService` |
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Env init step progress inside create dialog |
| `renderer/components/lanes/CreateLaneDialog.tsx`, `AttachLaneDialog.tsx`, `MultiAttachWorktreeDialog.tsx`, `LaneDialogShell.tsx` | Lane creation / attach dialogs and shared dialog chrome |
| `renderer/components/lanes/ManageLaneDialog.tsx` | Unified delete / archive / adopt-attached dialog. Supports single-lane and batch (multi-select) modes, three delete modes (`worktree`, `local_branch`, `remote_branch`) with a typed confirmation phrase, remote-branch name input, dirty-state warnings, and a busy/status/error triplet threaded through from `LanesPage`. Covered by `ManageLaneDialog.test.tsx`. |
| `renderer/components/lanes/MonacoDiffView.tsx` | Monaco-based side-by-side file diff |
| `renderer/components/run/LaneRuntimeBar.tsx` | Compact lane runtime status bar (health, preview, port, proxy, oauth) |
| `renderer/components/run/RunPage.tsx`, `RunNetworkPanel.tsx` | Runtime dashboards that consume lane runtime services |
| `renderer/components/ui/PaneTilingLayout.tsx` | Persisted split-pane layout engine for lane panes. Validates saved pane trees against expected pane ids and falls back to the supplied tree when the saved layout is stale. |
| `renderer/components/settings/ProxyAndPreviewSection.tsx`, `DiagnosticsDashboardSection.tsx`, `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Settings-side management UIs |

Shared code:

- `src/shared/laneBaseResolution.ts` — `shouldLaneTrackParent`, `branchNameFromLaneRef`, `resolveStableLaneBaseBranch`. Used by `laneService`, `conflictService`, `autoRebaseService`, `rebaseSuggestionService`, `prService`, and renderer helpers so base-ref resolution stays consistent.
- `src/shared/prStrategy.ts` — `resolvePrRebaseMode(creationStrategy)` maps a PR's `PrCreationStrategy` to `"auto" | "manual"`. Used by `autoRebaseService` and `conflictService` to decide whether drift against a linked PR's base branch should trigger auto-rebase (`pr_target`) or only surface as manual attention (`lane_base`).
- `src/shared/types.ts` — `LaneSummary`, `LaneStatus`, `StackChainItem`, `CreateLaneArgs`, rebase args/results, `RebaseTargetCommit`, overlay types, port/proxy/OAuth/diagnostics types.
- `src/shared/laneOverlayMatcher.ts` — last-wins/deep-merge evaluator for per-lane overlay policies.

iOS companion (`apps/ios/ADE/Views/Lanes/`):

- `LaneColorPalette.swift`, `LaneColorSwatchPicker.swift` — iOS
  mirror of the desktop lane palette and swatch picker, used by the
  create/manage sheets.
- `LanesTabView.swift` — mobile lane list shell, stack-canvas sheet
  routing, search/filter state, selected-lane navigation.
- `LaneCreateSheet.swift` and `LaneEnvInitProgressView.swift` —
  create/import/rescue flows plus template-backed host environment
  setup progress polling.
- `AddLaneSheet.swift`, `LaneAttachSheet.swift`,
  `LaneMultiAttachSheet.swift` — mobile add/attach entry points,
  including discovery and batch attachment of unregistered worktrees
  via `lanes.listUnregisteredWorktrees`.
- `LaneStackCanvasScreen.swift` and `LaneStackGraphSheet.swift` —
  mobile stack graph/canvas projection for parent-child lane chains.
- `LaneDetailScreen.swift`, `LaneDetailGitSection.swift`,
  `LaneDetailContentSections.swift`, `LaneDetailRebaseBanner.swift`,
  `LaneDiffScreen.swift`, `LaneCommitSheet.swift`,
  `LaneCommitHistoryScreen.swift`, `LaneStashesScreen.swift`,
  `LaneSyncDetailScreen.swift`, `LaneActionsCard.swift`,
  `LaneAdvancedScreen.swift` (single Advanced page that hosts Manage,
  Switch branch, Stash, and the four destructive git escape hatches —
  rebase lane, rebase descendants, rebase + push, force push — with a
  description per row and an offline disabled banner),
  `LaneManageSheet.swift`, `LaneBatchManageSheet.swift`,
  `LaneChatLaunchSheet.swift`, `LaneTreeView.swift`,
  `LaneFileTreeComponents.swift` — mobile detail, git, rebase, diff,
  stash, sync, manage, chat-launch, and file-tree parity surfaces.
  `LaneCommitSheet.swift` is now a "review & commit" sheet: staged
  and unstaged files render with per-file stage / unstage / discard /
  restore / open-diff / open-files affordances, plus a "Suggest"
  button that calls `aiCommitMessages.generate` and shows an inline
  setup hint when the host reports AI commit messages aren't
  configured.

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
- `devicesOpen?: LaneDevicePresence[]` — decoration added by
  `syncHostService` on response paths (`lanes.list`, `lanes.getDetail`,
  `lanes.create`, `lanes.attach`, etc.) from the in-memory lane
  presence map. Each entry carries `{ deviceId, displayName,
  deviceType }` and expires 60 s after the last
  `lanes.presence.announce`. Controllers announce on a 30 s
  heartbeat; the desktop host calls `ade.sync.setActiveLanePresence`
  from `LanesPage` whenever the visible lane list changes and clears
  it on unmount.

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
   base ref defaults to the parent's branch ref. Callers can override
   with `baseBranchRef` on `CreateChildLaneArgs` to fork from any local
   or remote branch (the service resolves/tracks remote refs via
   `resolveImportBranchTarget` before creating the worktree).
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

## Lane color

Each lane carries an optional `color` (a hex string). The color appears as
an accent dot wherever the lane is referenced — lane list, lane tabs, the
GitHub PR rows in `prs/tabs/GitHubTab.tsx`, the QueueTab member rows, and
the post-merge PR toast in `AppShell`. The palette and helpers live in
`renderer/components/lanes/laneColorPalette.ts`:

- `LANE_COLOR_PALETTE` — 12 curated hexes, each with a human label
  (Violet / Blue / Emerald / Amber / Pink / Orange / Teal / Purple /
  Red / Lime / Cyan / Fuchsia).
- `LANE_FALLBACK_COLORS` — first 8 of the palette, kept stable for the
  index-based fallback used by `getLaneAccent(lane, fallbackIndex)` for
  lanes without an explicit color.
- `colorsInUse(lanes, excludeLaneId?)` — case-insensitive set of hexes
  in active (non-archived) lanes. Used to disable already-taken
  swatches in `LaneColorPicker` and `LaneContextMenu`'s color row.
- `nextAvailableColor(lanes)` — picks the first palette hex not in use.
  `CreateLaneDialog` calls this when the dialog opens so a new lane
  gets a unique color by default.

Color is enforced at the service layer: `laneService.updateAppearance`
rejects a color already used by another non-archived lane in the same
project with `Error("Color already in use by lane "<name>"")`. Pickers
should pre-filter against `colorsInUse` to surface conflicts before the
user attempts to save, but the service is the canonical guard.

The iOS companion mirrors the desktop palette in
`apps/ios/ADE/Views/Lanes/LaneColorPalette.swift` and exposes a
`LaneColorSwatchPicker.swift` for parity with `LaneColorPicker`. The
iOS create/manage sheets seed and edit the same `lanes.color` field.

## Branch switching inside a lane

A lane can swap its checked-out branch without being deleted/recreated.
The `lane_branch_profiles` table remembers per-(lane, branch) state
(`base_ref`, `parent_lane_id`, `source_branch_ref`, last checkout time)
so that toggling between branches preserves stack relationships and
fork points.

| Method | Purpose |
|--------|---------|
| `laneService.listBranchProfiles(laneId)` | Returns every branch profile recorded for the lane plus the active branch (auto-upserts a profile for the lane's current `branch_ref` so the active branch is always present). |
| `laneService.previewBranchSwitch(args)` | Pure read: dirty-tree probe, duplicate-owner detection (another lane already on that branch), active terminal/process inventory, base-ref/parent inference, remote-prefix stripping. Used to drive the iOS/desktop branch picker confirmation UI. |
| `laneService.switchBranch(args)` | Performs the checkout: refuses dirty trees, refuses duplicate-owner branches, requires `acknowledgeActiveWork` if active sessions/processes exist, then `git checkout` (or `checkout -b` in `mode: "create"`), updates the lane row, upserts the branch profile, and prunes stale `pull_requests` rows whose `head_branch` no longer matches the new branch. (`pull_requests.lane_id` is `not null`, so stale rows are deleted along with their child rows in `pr_convergence_state`, `pr_pipeline_settings`, `pr_issue_inventory`, and `pr_group_members`.) |
| `laneService.updateBranchRef(laneId, branchRef)` | Internal helper used after rename/import paths to keep the active profile and `lanes.branch_ref` in sync. |

IPC channels (registered in `services/ipc/registerIpc.ts`, exposed via
`preload.ts`):

- `ade.lanes.listBranchProfiles`
- `ade.lanes.previewBranchSwitch`
- `ade.lanes.switchBranch`

The desktop renderer surfaces this in `LaneStackPane.tsx` and
`LanesPage.tsx` (branch dropdown + confirmation dialog wired to
`previewBranchSwitch` / `switchBranch`). The iOS companion mirrors it in
`apps/ios/ADE/Views/Lanes/LaneBranchPickerSheet.swift` and is exercised
through `SyncRemoteCommandService` (`branchProfiles.list`,
`branchSwitch.preview`, `branchSwitch.commit`).

The ade-cli `git checkout <branch>` command also flows through the same
service so headless workers see identical guards (uncommitted-changes
refusal, duplicate-owner refusal, stale-PR cleanup).

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
- Multi-lane deep links can pass `laneIds=<id,id,...>` and
  `inspectorTab=<tab>`. `LanesPage` waits until all referenced lanes
  exist before consuming the link, selects the first lane, opens the
  lane set side-by-side, and clears pinned lanes for that focused view.
  This is used after parallel chat launch to open every newly-created
  model lane in the Work inspector.
- Parallel chat launch links use `LANES_TILING_WORK_FOCUS_TREE` and a
  `layoutId` suffix so newly-created comparison lanes emphasize the
  Work pane without overwriting the user's normal lane cockpit layout.

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
