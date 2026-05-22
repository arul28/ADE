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

## Where this runs

Lane lifecycle (create / attach / rename / archive / delete / rebase /
branch-switch / port + proxy + OAuth + diagnostics) is owned by the **ADE
runtime daemon** (`ade serve` listening on `~/.ade/sock/ade.sock`), not by
the Electron main process. The renderer's `window.ade.lanes.*` calls go
through `apps/desktop/src/preload/preload.ts`, which routes every
runtime-backed method through `LocalRuntimeConnectionPool` for
local-bound windows or through `RemoteConnectionPool` (SSH-attached) for
remote-bound windows. The legacy in-process `laneService.ts` still exists
on the desktop main process as a fallback target so older callers and
tests keep working — preload calls the runtime first via
`callProjectRuntimeActionOr("lane", …)` and only invokes the local IPC
handler if no runtime is bound. When `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`
is set for local development/diagnostics, preload skips the local daemon
route entirely and goes straight to those in-process IPC fallbacks. For
remote-bound windows the worktree is created on the remote machine; the
desktop renders the same UX but the git operations, file watchers, PTYs,
and processes execute on the remote host. The desktop main process keeps
a thin `laneListSnapshotService.ts` helper for assembling per-window lane
snapshots that overlay sync presence on top of runtime-supplied lane
summaries. Multi-window: each desktop window has its own project binding,
so a lane-creation request in window A targets window A's runtime (local
or remote) regardless of what window B is bound to.

## Source file map

Core services. The canonical lane lifecycle now runs in the **ADE
runtime daemon**; the desktop main-process services below remain as
either fallback targets or thin desktop-side helpers.

Runtime services (`apps/ade-cli/src/services/lanes/` and friends):

- `apps/ade-cli/src/services/projects/projectRuntime.ts` exposes the
  `lane` action domain (CRUD, runtime isolation, branch switching,
  templates, diagnostics) over JSON-RPC; remote runtimes are reached
  over the SSH-tunneled equivalent.
- `apps/desktop/src/main/services/adeActions/registry.ts` mirrors
  lane lifecycle actions into the generic ADE action registry. The
  `lane.delete` action validates `laneId`, resolves the lane overlay
  context before teardown, injects lane environment cleanup when an
  env-init config applies, delegates to `laneService.delete`, and
  releases any leased port range for the deleted lane.

Desktop fallback services (`apps/desktop/src/main/services/lanes/`):

| File | Responsibility |
|------|---------------|
| `laneService.ts` | Lane CRUD, worktree creation/removal, status computation, stack chain traversal, rebase runs, reparent, mission role tagging, startup repair routines, and the multi-step lane teardown pipeline (`getDeleteRisk`, `delete`, `cancelDelete`) that streams `LaneDeleteProgress` events as it stops processes/PTYs/watchers, cancels auto-rebase, runs `git worktree remove` / `git branch -D` / optional `git push --delete origin`, verifies residual worktree files are gone before DB cleanup, and cleans the pack directory + DB rows. Deletes now run to completion once started, so `cancelDelete` reports that no active delete can be cancelled. `reparent` accepts an optional `stackBaseBranchRef` to pick a specific branch to stack onto (resolved in the project repo with `origin/` preferred); when both the parent link and the resolved base branch are unchanged the call short-circuits without touching git. |
| `autoRebaseService.ts` | Auto-rebase worker for stacked lanes, attention state, head-change handlers. Consults `resolvePrRebaseMode` to determine whether a lane with a linked PR should auto-rebase (`pr_target` strategy) or only surface manual attention (`lane_base` strategy). `listStatuses({ includeAll: true })` returns stored statuses without recomputing lane git status for PR workflow views. |
| `rebaseSuggestionService.ts` | Emits rebase suggestions when a parent lane advances, dismiss/defer lifecycle. Each suggestion may include up to 20 `RebaseTargetCommit` entries showing the behind commits the rebase would pull in. |
| `laneEnvironmentService.ts` | Environment init pipeline: env files, docker services, dependencies, mount points, copy paths (Phase 5 W1) |
| `laneTemplateService.ts` | Reusable lane init templates (Phase 5 W2) |
| `portAllocationService.ts` | Lease-based per-lane port ranges (Phase 5 W3) |
| `laneProxyService.ts` | `*.localhost` reverse proxy, per-lane routes, cookie isolation (Phase 5 W4) |
| `oauthRedirectService.ts` | OAuth callback routing for multi-lane (Phase 5 W5) |
| `runtimeDiagnosticsService.ts` | Aggregate lane health checks, fallback mode (Phase 5 W6) |
| `laneLaunchContext.ts` | Pure helper: resolves launch cwd/env for terminals and tools. Returns `{ laneWorktreePath, cwd, execStrategy: "local" \| "ssh", sshTarget? }`. For lanes whose `runtimePlacement` is `macos-vm`, the helper consults a pluggable `MacosVmLaunchProvider` (installed during main-process bootstrap) and routes the launch to an in-guest `ssh user@host` target under `/Volumes/My Shared Files`. When the VM is missing, not runtime-ready, or not yet fetched, it throws `VmNotReadyError` (`code: "macos-vm-not-ready"`) carrying the current `MacosVmPhaseNumber` so the renderer can prompt "Open VM tab". |
| `laneListSnapshotService.ts` | Desktop-side snapshot assembly: takes runtime-supplied lane summaries and decorates them with sync presence (`devicesOpen`), conflict status, rebase suggestions, auto-rebase status, and runtime session bucket counts. Used to build the lane list for the renderer without round-tripping every overlay separately. |

Renderer components:

| File | Responsibility |
|------|---------------|
| `renderer/components/app/App.tsx` | Project tab host and route keep-alive shell. Keeps the Work surface mounted after first visit and now does the same for `/lanes`, parking the inactive Lanes surface with `inert` / `aria-hidden` instead of unmounting it. During cold project switches it renders a transition veil over the old project surface until the target project hydrates. |
| `renderer/components/lanes/LanesPage.tsx` | 3-pane cockpit, tab management, dialog coordination. Each lane row in the lane list optionally renders a state-aware PR tag (`PR #N` / `DRAFT #N` / `MERGED #N` / `CLOSED #N`) when the lane's current branch matches an existing PR. The pure selectors in `lanePageModel.ts` prefer live same-branch GitHub repo inventory over terminal/stale ADE rows, then fall back to ADE-linked PR rows, so externally created PRs and open-after-closed branch reuse stay visible; linked PRs route to the PR workspace, while unlinked GitHub-only matches open externally. The page forces one GitHub snapshot refresh on project/branch-signature changes and otherwise uses cached snapshot/event refreshes to avoid repeated PR polling from the Lanes tab. Runtime activity refreshes use `refreshLanes({ includeStatus: false, includeSnapshots: true, ... })` so PTY/chat/process buckets update without recomputing git status. Expanding Git Actions suppresses the hidden inline duplicate pane via `shouldMountGitActionsPane` while keeping the fullscreen pane mounted. Lane delete kicks off optimistically: the page subscribes to `lanes.delete.event`, tracks per-lane `LaneDeleteProgress` through `useAppStore().laneDeleteProgressByLaneId`, immediately closes the manage dialog, and excludes deleting lanes from the selectable lane id sets used by keyboard navigation (`selectableFilteredLaneIds`, `sortedSelectableLaneIds`). On mount/project switch it hydrates active backend delete progress when available, but also keeps stored active delete progress long enough to move selection away and queue a refresh if the backend list is missing, stale, or temporarily failed. Batch deletes still run selected child lanes before their selected parents, but each batch deletes one lane at a time and records per-lane failures; a parent remains blocked if a selected descendant fails. Lane tabs for deleting lanes render a non-interactive overlay with a spinning `CircleNotch` and a `Deleting` / `Deleted` / `Deleted with warnings` label; selection / pinning / context menu / split / git-actions surfaces are all suppressed for those rows. `resolveLaneDeleteStartSelection` (also used by tests) computes a fallback selection so the user is moved to the next available lane the moment delete starts, and a top-bar lane action chip surfaces failures and non-fatal cleanup warnings through `laneActionError`. Work-tab action deeplinks scrub `action`, `laneId`, and `laneIds` after handling so modal routing cannot also rewrite split selection state. |
| `renderer/components/lanes/lanePageModel.ts` | Pure lane-page selectors and URL/deletion helpers used by `LanesPage` and unit tests. Owns lane branch/PR matching, same-repo GitHub PR guardrails for fork branch-name collisions, ADE-vs-GitHub PR tag precedence, terminal-state GitHub overrides for stale ADE PR rows, deep-link lane selection, action-deeplink query cleanup, create-lane request normalization, delete-start selection fallback, parent-before-child-safe batch delete planning, and `runLaneDeleteBatchSequentially` for serialized per-batch teardown. |
| `renderer/state/appStore.ts` | Shared renderer project/lane state. Stores `laneDeleteProgressByLaneId` so in-flight lane deletion UI survives local `LanesPage` remounts and project metadata updates; the map clears only when the project root changes or the project is closed/reset. Warm project-tab switches restore cached lanes/snapshots, lane selection, focused session, and loading state before the backend round trip finishes, and cache pruning retains Work/lane/session state for all open project tabs in addition to the active and recent projects. |
| `renderer/components/lanes/laneUtils.ts` | Pure lane list/filter helpers plus default pane trees, including the work-focused tiling tree used by parallel chat launch deep links. |
| `renderer/components/lanes/laneColorPalette.ts` | Curated lane color palette split into `LANE_CLASSIC_COLORS` and `LANE_RAINBOW_COLORS`, then combined as `LANE_COLOR_PALETTE`, plus helpers (`getLaneAccent`, `colorsInUse`, `nextAvailableColor`, `laneColorName`). The first 8 classic hexes form `LANE_FALLBACK_COLORS`, the legacy index-based fallback used for lanes that don't have an explicit color assigned. |
| `renderer/components/lanes/LaneAccentDot.tsx` | Tiny accent dot used everywhere a lane is mentioned (lane list, tabs, PR rows, AppShell PR toasts). Resolves color via `getLaneAccent` so a lane without an explicit color falls back to a deterministic fallback hex. |
| `renderer/components/lanes/LaneColorPicker.tsx` | Reusable grouped swatch picker used inside `CreateLaneDialog` and `ManageLaneDialog`. Shows Rainbow above Classic, disables swatches already in use by other lanes (passed in as `usedColors`), and offers a clear button. |
| `renderer/components/lanes/LaneContextMenu.tsx` | Right-click menu on the lane list. Hosts the inline grouped color swatches that call `lanes.updateAppearance` directly, "Reveal/Copy path", manage/adopt/open-in-Run actions, split-tab actions, and batch manage. |
| `renderer/components/lanes/LaneStackPane.tsx` | Stack graph sidebar, integration source chips, canvas jump |
| `renderer/components/lanes/LaneDiffPane.tsx` | Lane diff list + per-file stage/unstage/discard; file content uses shared `AdeDiffViewer` (commit comparisons read-only; working-tree file can be editable when unstaged) |
| `renderer/components/lanes/LaneGitActionsPane.tsx` | Commit, stash, fetch, sync, push, recent commits. Stashing includes untracked files when the unstaged set contains untracked paths, and stash restore uses the ordinal `stash@{N}` ref returned by `git stash list`. After commit/stash operations it refreshes changes, lane git status, and git metadata while skipping snapshot decorations (`refreshLanes({ includeStatus: true, includeSnapshots: false })`). Seeds its `autoRebaseStatus` from the `autoRebaseStatusSnapshot` prop that `LanesPage` passes from the lane list (`laneSnapshot.autoRebaseStatus`), so opening a lane does not trigger a per-lane probe. A fallback `refreshAutoRebaseStatus` runs only when the snapshot is `undefined`, after a 3.5 s delay, and only while the document is visible. |
| `renderer/components/lanes/LaneWorkPane.tsx` | Terminal/chat toggle work surface |
| `renderer/components/lanes/useLaneWorkSessions.ts` | Hook behind the lane Work pane's chat/session list. Tracks the latest lane id, project root, and scope key in refs so a refresh that was queued during a lane or project switch replays against the newest target and ignores stale rows from the old scope. |
| `renderer/components/lanes/LaneRebaseBanner.tsx` | Inline banner driven by `rebaseSuggestionService` |
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Env init step progress inside create dialog |
| `renderer/components/lanes/CreateLaneDialog.tsx`, `AttachLaneDialog.tsx`, `MultiAttachWorktreeDialog.tsx`, `LaneDialogShell.tsx` | Lane creation / attach dialogs and shared dialog chrome. `LaneDialogShell` is viewport-centered (`top-1/2 -translate-y-1/2`), capped at `min(92dvh, calc(100vh-1rem))`, and renders a sticky header strip plus a single scrollable body — every lane modal (create, attach, multi-attach, manage) inherits this layout so long content scrolls instead of overflowing the dialog. The "import existing branch" path inside `CreateLaneDialog` swaps the dialog body for `BranchPickerView` when the user opens the picker; the "Connect Linear issue" affordance in the always-open Advanced section swaps it for `LinearIssuePickerView`. The dialog title/description/icon switch in lockstep with the active sub-view, and connecting a Linear issue auto-flips the create mode out of `existing` (the import-branch tab is locked while an issue is attached). |
| `renderer/components/lanes/laneDialogTokens.ts` | Shared Tailwind class-name tokens for lane dialog sections: `SECTION_CLASS_NAME` (neutral), `SECTION_ACCENT_CLASS_NAME` (accent wash used by stack/integration callouts like the Stack position panel), `SECTION_HERO_CLASS_NAME` (the hero strip at the top of Manage Lane), `LABEL_CLASS_NAME`, `INPUT_CLASS_NAME`, `SELECT_CLASS_NAME`. |
| `renderer/components/lanes/BranchPickerView.tsx` | Filterable virtualized branch list rendered inside `CreateLaneDialog`. Each row shows branch name, last-commit author + relative date, and an inline PR pill (`#NNN`, dim for drafts) when the branch has an open PR. Loading/empty/error states are handled inline. Backed by `branchPickerSearch.ts`. |
| `renderer/components/lanes/branchPickerSearch.ts` | Pure parser + matcher. Tokens AND together: `pr:open` / `pr:none` / `pr:draft`, `author:NAME` (or `author:me` / `mine` resolved against the local git user), `stale:Nd` (older than N days), `#PRNUMBER` (exact match), and free text fuzzy-matched across branch name / PR title / author. Also exposes `formatRelativeTime` for the row subtitle. |
| `renderer/components/lanes/LinearIssuePicker.tsx` | Filterable Linear issue picker rendered inside `CreateLaneDialog`. Loads project / state / assignee filters from `ade.cto.getLinearIssuePickerData` and pages issues through `ade.cto.searchLinearIssues`. Shared row + label helpers (`LinearIssueRow`, `linearPriorityLabel`, `issueProjectLabel`, `issueUpdatedLabel`, `toLaneLinearIssue`, `branchExistsForLinearIssue`) are reused by `LinearIssueBrowser` (top-bar quick view) and the chat composer's Linear context dialog. Also exports a `LinearIssueSummaryCard` used by the dialog's "currently connected" state. |
| `renderer/components/lanes/LinearIssueBadge.tsx` | Compact lane-list badge that surfaces the lane's connected Linear issue (identifier + state + priority); clicking opens the issue in a new chat with the issue pre-attached as context, falling back to opening the issue in Linear when chat is unavailable. |
| `renderer/components/lanes/linearBrand.tsx` | Linear brand tokens (`LINEAR_BRAND` colour palette) plus the icon family used everywhere ADE references Linear: `LinearMark`, `LinearStateIcon`, `LinearPriorityIcon`. |
| `renderer/components/lanes/ManageLaneDialog.tsx` | Unified manage dialog covering stack position, appearance, adopt-attached, archive, and delete in both single-lane and batch (multi-select) modes. Single-lane mode opens with a "What each section does" info panel and a hero lane-info strip; batch mode swaps in a callout explaining that only archive/delete apply to multiple lanes (stack, color, and adopt are single-lane only). The `StackPositionSection` is single-lane and non-primary only: it shows a parent-lane select (filtered to exclude the lane itself and its descendants), an optional base-branch override input, and an inline "Runs git rebase" disclosure. Apply calls `lanes.reparent({ laneId, newParentLaneId, stackBaseBranchRef })`; the button is disabled while the lane is dirty or has a rebase in progress and while nothing has actually changed, and a parent-callback (`onStackReorganized`) refreshes the lane list. Delete still supports the three scopes (`worktree`, `local_branch`, `remote_branch`), the typed confirmation phrase, remote-branch name input, dirty-state warnings, and the live multi-step progress strip wired to `lanes.delete.event` (`git_status` when a worktree exists, then `cancel_auto_rebase` / `stop_processes` / `stop_ptys` / `stop_watchers` / `cleanup_env` / `git_worktree_remove` / `git_branch_delete` / `git_remote_branch_delete` / `pack_dir_remove` / `database_cleanup`). Optional branch cleanup steps can finish as warnings, allowing lane-owned worktree/database cleanup to complete while still showing the branch cleanup error inline. The dialog calls `lanes.getDeleteRisk` on open to surface dirty state, unpushed commits, running processes / PTYs / watchers, and remote-branch existence before the user confirms; running deletes are shown as non-cancellable because teardown runs to completion once started. |
| `renderer/components/lanes/MonacoDiffView.tsx` | Monaco diff editor used for editable working-tree views (invoked from `AdeDiffViewer`) |
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
  `LaneManageSheet.swift` mirrors desktop's single-lane Stack position
  section: parent-lane picker, optional base-branch override, "Runs git
  rebase" disclosure, dirty/rebase-in-progress guards, and
  `lanes.reparent` payloads that omit `stackBaseBranchRef` when the
  override is blank.
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
- `linearIssue?: LaneLinearIssue | null` — the Linear issue connected
  to the lane at create time (or null). Persisted in
  `lane_linear_issues` (project-scoped, keyed by `lane_id`) and
  hydrated by `laneService` on every `list`/`get`. Drives the
  `LinearIssueBadge` in the lane list, the auto-prefixed commit
  message in `gitOperationsService` (`Refs IDENT: <message>`), and
  the PR-creation flow in `prService` / `CreatePrModal` (default PR
  title `IDENT: title`, body magic-word `Fixes IDENT` /
  `Refs IDENT`).
- `linearIssueLinks?: LaneLinearIssueLink[]` — additional Linear
  issues that have been attached to the lane beyond the primary
  `linearIssue`. Each link carries `role`
  (`primary | worked | referenced | inferred`), `source`
  (`lane_create | lane_link | chat_attach | linear_open_issue |
  commit | pr_body | manual`), `includeInPr`, `closeOnMerge`, and an
  optional `evidence` blob (`chatSessionId` / `commitSha` / `prId`).
  Persisted in the `lane_linear_issue_links` table keyed by
  `(project_id, lane_id, issue_id)` and hydrated on every
  `list`/`get` like `linearIssue`. Populated by
  `laneService.linkLinearIssues({ laneId, issues, role, source,
  includeInPr, closeOnMerge, evidence })`; the chat service calls
  this whenever a user attaches a Linear issue through the chat
  composer (`source: "chat_attach"`, `role: "worked"`) so the next
  PR body picks the issue up. `prService.applyLinearPrLinkage`
  combines `linearIssue` and every `linearIssueLinks` entry with
  `includeInPr === true` into a single "Linked Linear issues"
  markdown block plus per-issue `Fixes` / `Refs` magic words, so
  PRs that touch multiple tickets get cross-linked automatically.
  See [features/linear-integration/README.md](../linear-integration/README.md)
  for the cross-feature picture.

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
   add`, inserts the lane row, and returns a `LaneSummary`. When
   `CreateLaneArgs.linearIssue` is supplied (from `CreateLaneDialog`
   via the Linear issue picker), the service derives the branch name
   from the issue (`linearIssueBranchName`: `ident-title-slug`,
   sanitised against git-ref rules) when no explicit `branchName` was
   provided, refuses to create the lane if the resolved branch already
   exists locally or under `origin/`, and writes the issue payload
   into `lane_linear_issues` so the PR / commit / chat surfaces can
   pick it up later. The same path runs for `createChild`.
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
   worktree managed by ADE. `CreateLaneDialog` drives this through
   `BranchPickerView`: the picker opens against `git.listBranches`
   (which now also returns `lastCommitSha` / `Date` / `Author` /
   `Message` from a single `for-each-ref` pass), enriches each row with
   any open PR coming from `prs.listOpenForRepo`, and resolves
   `mine` / `author:me` against the local git identity returned by
   `git.getUserIdentity`. PR fetch is fail-soft: when the GitHub call
   errors the picker still works, just without PR pills.
5. **Attach** — `attach` links an external worktree path (pre-existing
   outside ADE). `lane_type = 'attached'`.
6. **Rename / update appearance / reparent** — `rename`, `updateAppearance`,
   `reparent` edit the lane row. `reparent({ laneId, newParentLaneId,
   stackBaseBranchRef? })` refuses to move a lane under one of its own
   descendants and refuses to reparent the primary lane. When
   `stackBaseBranchRef` is supplied the service resolves it in the project
   repo (preferring `origin/<branch>`) and uses that as the rebase target
   and persisted base ref; otherwise it falls back to the new parent's
   current branch. When both the parent link and the resolved base ref are
   unchanged, reparent short-circuits without touching git so a redundant
   apply is a no-op rather than a stack rebase.
7. **Archive** — `archive` sets `archived_at` and `status = 'archived'`
   but keeps the worktree on disk. `unarchive` reverses it.
8. **Delete** — `delete({ laneId, deleteBranch?, deleteRemoteBranch?,
   remoteBranchName?, force? })` runs an explicit teardown pipeline
   and emits `lanes.delete.event` per step. Steps execute in order:
   `git_status` (when a worktree exists) → `cancel_auto_rebase` →
   `stop_processes` → `stop_ptys` → `stop_watchers` →
   `cleanup_env` → `git_worktree_remove` (when a worktree exists) →
   `git_branch_delete` (only when `deleteBranch`) →
   `git_remote_branch_delete` (only when `deleteRemoteBranch`) →
   `pack_dir_remove` → `database_cleanup`.
   `getDeleteRisk(laneId)` returns the preflight `LaneDeleteRisk`
   the dialog renders before confirmation. `cancelDelete(laneId)` is
   retained for contract compatibility but always returns
   `{ cancelled: false, reason }`; once a delete starts, teardown runs
   to completion.
   Teardown depends on optional injected services
   (`processService`, `ptyService`, `autoRebaseService`,
   `rebaseSuggestionService`, `fileWatcherService`); when one is not
   wired, the corresponding step is `skipped` rather than `failed`.
   The pipeline yields cooperatively (`setImmediate`) at the start of
   each step so a long-running step never blocks the IPC event loop,
   filesystem cleanup uses `fs.promises.rm` instead of synchronous
   `rmSync`, and `git_worktree_remove` checks the managed worktree path
   after a successful git removal so residual files are removed and
   `git worktree prune` runs before the lane row disappears. The
   `database_cleanup` step wraps every cascade delete inside a single
   `begin immediate` / `commit` transaction so a partial failure rolls
   back to a consistent DB state instead of leaving lane rows
   half-deleted. Generic ADE action calls
   (`lane.delete` through `ade actions run` / TUI `/ade`) use the same
   teardown path, including lane-environment cleanup and port lease
   release. The ADE Code TUI also surfaces this through a dedicated
   `/lane delete` slash command that opens a right-pane confirmation
   form (lane name + branch ref + dirty flag, with a force toggle when
   the lane is dirty) before issuing the action.

## Lane color

Each lane carries an optional `color` (a hex string). The color appears as
an accent dot wherever the lane is referenced — lane list, lane tabs, the
GitHub PR rows in `prs/tabs/GitHubTab.tsx`, the QueueTab member rows, and
the post-merge PR toast in `AppShell`. The palette and helpers live in
`renderer/components/lanes/laneColorPalette.ts`:

- `LANE_CLASSIC_COLORS` — 12 curated hexes, each with a human label
  (Violet / Blue / Emerald / Amber / Pink / Orange / Teal / Purple /
  Red / Lime / Cyan / Fuchsia).
- `LANE_RAINBOW_COLORS` — 7 bright rainbow hexes (red / orange /
  yellow / green / blue / indigo / violet).
- `LANE_COLOR_PALETTE` — the combined classic-then-rainbow palette used
  by helpers and compatibility fallbacks. `LANE_CLASSIC_COUNT` is
  derived from `LANE_CLASSIC_COLORS.length` so picker grouping cannot
  drift from the palette definition.
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

Registered as runtime actions on the `lane` domain (served by the local
or remote ADE runtime daemon) and as legacy in-process IPC handlers in
`apps/desktop/src/main/services/ipc/registerIpc.ts` for the fallback
path. Exposed through `apps/desktop/src/preload/preload.ts`, which
prefers the runtime route. Remote-bound desktop windows execute every
lane action on the remote machine — including `git worktree add`, the
delete teardown pipeline, env init, and template apply.

Lane management (selected):

| Channel | Signature |
|---------|-----------|
| `ade.lanes.list` | `(args: ListLanesArgs) => LaneSummary[]` |
| `ade.lanes.create` | `(args: CreateLaneArgs) => LaneSummary` |
| `ade.lanes.createChild` | `(args: CreateChildLaneArgs) => LaneSummary` |
| `ade.lanes.createFromUnstaged` | `(args: CreateLaneFromUnstagedArgs) => LaneSummary` |
| `ade.lanes.attach` | `(args: AttachLaneArgs) => LaneSummary` |
| `ade.lanes.importBranch` | `(args: { branchRef: string }) => LaneSummary` |
| `ade.lanes.rename` / `.updateAppearance` / `.reparent` / `.archive` / `.delete` | lane edit operations; `.delete` is also surfaced as `lane.delete` through the generic ADE action registry |
| `ade.lanes.delete.risk` | `(args: { laneId }) => LaneDeleteRisk` — preflight read for the manage dialog: dirty state, unpushed commit count, remote-branch existence, active processes/PTYs/watchers, env-init flag. |
| `ade.lanes.delete.cancel` | `(args: { laneId }) => { cancelled, reason? }` — cooperative cancel during the early teardown steps. After `git_worktree_remove` starts the lane is unrecoverable and cancel is a no-op. |
| `ade.lanes.delete.event` (push) | `LaneDeleteEvent` carrying `LaneDeleteProgress` — `steps[]` with per-step status (`pending` / `running` / `completed` / `failed` / `skipped`) plus `overallStatus` (`running` / `completed` / `failed` / `cancelled`) and `cancellable`. |
| `ade.lanes.delete.progress.list` | replay of the in-memory `LaneDeleteProgress` map. Active deletes plus a `LANE_DELETE_PROGRESS_HISTORY_TTL_MS = 60s` window of recently completed ones so a window that mounts mid-delete (or mounts immediately after one finished) can repaint the progress strip and the lane tab overlay without missing the live event stream. |
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
  `laneSnapshots`, `refreshLanes`) and from the per-lane
  `useLaneWorkSessions` hook. `refreshLanes` can refresh lane rows,
  git status, and snapshot overlays independently; statusless refreshes
  preserve the previous git status in store.
- `LaneRuntimeBar` (Run page) renders lane runtime state: health dot,
  proxy/preview status, OAuth callback URL, active processes. It
  keeps health/process refreshes separate from routing/port/OAuth
  refreshes, with independent sequence counters to ignore out-of-order
  responses.
- Multi-lane deep links can pass `laneIds=<id,id,...>` and
  `inspectorTab=<tab>`. `LanesPage` waits until all referenced lanes
  exist before consuming the link, selects the first lane, opens the
  lane set side-by-side, and clears pinned lanes for that focused view.
  This is used after parallel chat launch to open every newly-created
  model lane in the Work inspector.
- Action deep links such as `action=batch` are exclusive with bare
  selection links. `LanesPage` handles the action first, then removes
  `action`, `laneId`, and `laneIds` from the URL so the normal
  single-lane and multi-lane selection effects cannot re-apply stale
  selection state.
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
