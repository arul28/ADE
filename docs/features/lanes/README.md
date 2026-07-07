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
ADE runtime** (`ade serve` listening on `~/.ade/sock/ade.sock`), not by
the Electron main process. The renderer's `window.ade.lanes.*` calls go
through `apps/desktop/src/preload/preload.ts`, which routes every
runtime-backed method through `LocalRuntimeConnectionPool` for
local-bound windows or through `RemoteConnectionPool` (SSH-attached) for
remote-bound windows. The legacy in-process `laneService.ts` still exists
on the desktop main process for tests and desktop-only call paths —
preload calls the runtime via `callProjectRuntimeActionOr("lane", …)` and
only invokes the local IPC handler if no runtime is bound. For
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
ADE runtime**; the desktop main-process services below remain as
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
| `laneService.ts` | Lane CRUD, worktree creation/removal, status computation, stack chain traversal, rebase runs, reparent, startup repair routines, branch switching, lane + session Linear issue linkage, and the multi-step lane teardown pipeline (`getDeleteRisk`, `delete`, `cancelDelete`) that streams `LaneDeleteProgress` events as it stops processes/PTYs/watchers, cancels auto-rebase, runs `git worktree remove` / `git branch -D` / optional `git push --delete origin`, verifies residual worktree files are gone before DB cleanup, records retryable residual-cleanup debt when manual deletion fails, and cleans the pack directory + DB rows. It also emits one-shot `LaneLifecycleEvent` notifications after successful create/rename/archive/unarchive/delete transitions so renderer surfaces can toast completed lifecycle changes and invalidate lane-list reads without polling. Lane creation is wrapped so that any failure after the worktree is on disk routes through `cleanupCreatedWorktreeLaneAfterCreateFailure`, which removes the orphaned checkout rather than leaving a worktree no lane row references. Independent deletes can progress through teardown concurrently; only the `git_worktree_remove` step enters the shared worktree-mutation guard, so lane creation is not held behind unrelated stop/cleanup steps but still avoids concurrent edits to Git's worktree registry. Deletes run to completion once started, so `cancelDelete` reports that no active delete can be cancelled. `list()` also runs the residual-worktree cleanup retry sweep before duplicate/stale worktree repair so previous delete warnings can self-heal without blocking lane row cleanup. `getSummary(laneId, { includeStatus })` is the scoped summary path used by mobile detail commands so opening a lane does not rebuild the full lane list; `refreshSnapshots` honors `includeStatus` for light runtime-bucket refreshes. `upsertLaneStateSnapshot` guards its `lane_state_snapshots` write with a `where` clause that only touches the row when a field actually changed (`dirty`/`ahead`/`behind`/`remote_behind`/`rebase_in_progress`, and `agent_summary_json` only when the caller passed an `agentSummary`), so a status recompute that yields identical values no longer authors a redundant CRR row — which otherwise fans an empty update out to every synced device and triggers a full mobile lane-list reload for nothing. `reparent` accepts an optional `stackBaseBranchRef` to pick a specific branch to stack onto (resolved in the project repo with `origin/` preferred); when both the parent link and the resolved base branch are unchanged the call short-circuits without touching git. Branch switching rolls git checkout back to the previous branch when the database update fails. **Linear issue linkage:** `linkLinearIssues` / `unlinkLinearIssues` manage lane-scoped links in `lane_linear_issue_links` (never touching the primary `lane_linear_issues` row); `attachLinearIssueToSession` / `detachLinearIssueFromSession` / `listLinearIssuesForSession` / `listLinearIssuesForLaneSessions` manage session-scoped links in `session_linear_issues`. `attachLinearIssueToSession` resolves the session's lane from `claude_sessions` / `terminal_sessions` and mirrors each issue into the lane's `chat_attach` links when a lane exists, without ever promoting the lane's primary issue. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). |
| `worktreeResidualCleanup.ts` | Machine-local retry worker for managed worktree directories that survive lane deletion. It stores cleanup debt in `local_worktree_residual_cleanups`, retries during `laneService.list()`, drops unsafe records, skips registered Git worktrees, active lane paths, and pending creations, removes old empty untracked directories under the managed worktrees directory, and leaves unknown non-empty directories alone unless they were explicitly recorded from the delete path. |
| `autoRebaseService.ts` | Auto-rebase worker for stacked lanes, attention state, head-change handlers. Consults `resolvePrRebaseMode` to determine whether a lane with a linked PR should auto-rebase (`pr_target` strategy) or only surface manual attention (`lane_base` strategy). `listStatuses({ includeAll: true })` returns stored statuses without recomputing lane git status for PR workflow views. |
| `rebaseSuggestionService.ts` | Emits rebase suggestions when a parent lane advances, dismiss/defer lifecycle. Each suggestion may include up to 20 `RebaseTargetCommit` entries showing the behind commits the rebase would pull in. |
| `laneEnvironmentService.ts` | Environment init pipeline: env files, docker services, dependencies, mount points, copy paths (Phase 5 W1) |
| `laneTemplateService.ts` | Reusable lane init templates (Phase 5 W2) |
| `portAllocationService.ts` | Lease-based per-lane port ranges (Phase 5 W3) |
| `laneProxyService.ts` | `*.localhost` reverse proxy, per-lane routes, cookie isolation (Phase 5 W4) |
| `oauthRedirectService.ts` | OAuth callback routing for multi-lane (Phase 5 W5) |
| `runtimeDiagnosticsService.ts` | Aggregate lane health checks, fallback mode (Phase 5 W6) |
| `laneLaunchContext.ts` | Pure helper: resolves launch cwd/env for terminals and tools. Returns `{ laneWorktreePath, cwd, execStrategy: "local" }`, validates that requested working directories stay inside the lane worktree unless the caller explicitly opts into an external absolute cwd, and surfaces clear errors for missing worktrees. |
| `laneListSnapshotService.ts` | Desktop-side snapshot assembly: takes runtime-supplied lane summaries and decorates them with sync presence (`devicesOpen`), conflict status, rebase suggestions, auto-rebase status, and runtime session bucket counts. Used to build the lane list for the renderer without round-tripping every overlay separately. |

Renderer components:

| File | Responsibility |
|------|---------------|
| `renderer/components/app/App.tsx` | Project tab host and route keep-alive shell. Keeps the Work surface mounted after first visit and now does the same for `/lanes`, parking the inactive Lanes surface with `inert` / `aria-hidden` instead of unmounting it. Surfaces are keyed by runtime binding (`local:<root>` or the remote binding key) so local and remote views of the same root do not share lane/work state. During cold project switches it renders a transition veil over the old project surface until the target project hydrates. |
| `renderer/components/app/toast/{toastStore.ts,ToastStack.tsx,useLaneEventToasts.ts}` | Shared renderer toast primitive mounted from `AppShell`. `useLaneEventToasts` subscribes to `lanes.onLifecycleEvent` and `lanes.rebaseSubscribe`, turning lane-created/archive/delete and final automated rebase outcomes into compact global notices; created-lane toasts include a `View` action that routes to `/lanes?laneId=...&focus=single`. |
| `renderer/components/lanes/LanesPage.tsx` | 3-pane cockpit, tab management, dialog coordination. Create-lane state lives in `CreateLaneDialogHost`; `LanesPage` owns only open/prefill routing, blocks forced close while the host is busy, and focuses the new lane after the host refreshes the lane list while the dialog stays open for setup progress. Each lane row in the lane list optionally renders a state-aware PR tag (`PR #N` / `DRAFT #N` / `MERGED #N` / `CLOSED #N`) when the lane's current branch matches an existing PR. The pure selectors in `lanePageModel.ts` prefer live same-branch GitHub repo inventory over terminal/stale ADE rows, then fall back to ADE-linked PR rows, so externally created PRs and open-after-closed branch reuse stay visible; linked PRs route to the PR workspace, while unlinked GitHub-only matches open externally. The page forces one GitHub snapshot refresh on project/branch-signature changes and otherwise uses cached snapshot/event refreshes to avoid repeated PR polling from the Lanes tab. Runtime activity refreshes use `refreshLanes({ includeStatus: false, includeSnapshots: true, ... })` so PTY/chat/process buckets update without recomputing git status. Expanding Git Actions suppresses the hidden inline duplicate pane via `shouldMountGitActionsPane` while keeping the fullscreen pane mounted. Lane delete kicks off optimistically: the page subscribes to `lanes.delete.event`, tracks per-lane `LaneDeleteProgress` through `useAppStore().laneDeleteProgressByLaneId`, immediately closes the manage dialog, and excludes deleting lanes from the selectable lane id sets used by keyboard navigation (`selectableFilteredLaneIds`, `sortedSelectableLaneIds`). On mount/project switch it hydrates active backend delete progress when available, but also keeps stored active delete progress long enough to move selection away and queue a refresh if the backend list is missing, stale, or temporarily failed. Batch deletes still run selected child lanes before their selected parents; within each dependency-safe batch the page dispatches up to two lane deletes at a time and records per-lane failures, and a parent remains blocked if a selected descendant fails. Lane tabs for deleting lanes render a non-interactive overlay with a spinning `CircleNotch` and a `Deleting` / `Deleted` / `Deleted with warnings` label; selection / pinning / context menu / split / git-actions surfaces are all suppressed for those rows. `resolveLaneDeleteStartSelection` (also used by tests) computes a fallback selection so the user is moved to the next available lane the moment delete starts, and a top-bar lane action chip surfaces failures and non-fatal cleanup warnings through `laneActionError`. Work-tab action deeplinks scrub `action`, `laneId`, and `laneIds` after handling so modal routing cannot also rewrite split selection state. |
| `renderer/components/lanes/lanePageModel.ts` | Pure lane-page selectors and URL/deletion helpers used by `LanesPage` and unit tests. Owns lane branch/PR matching, same-repo GitHub PR guardrails for fork branch-name collisions, ADE-vs-GitHub PR tag precedence, terminal-state GitHub overrides for stale ADE PR rows, deep-link lane selection, action-deeplink query cleanup, create-lane request normalization, delete-start selection fallback, parent-before-child-safe batch delete planning, and `runLaneDeleteBatchWithConcurrency` for limited parallel teardown inside each dependency-safe batch. |
| `renderer/hooks/useLaneListInvalidation.ts` | Shared lane-list invalidation hook used by Lanes, Graph, and Run. It subscribes to `window.ade.lanes.onLifecycleEvent`, clears renderer read coalescing immediately, debounces a decorated `refreshLanes` call, runs one delayed follow-up refresh to cover daemon/write-to-read races, and self-heals stale visible lists on focus/visibility without polling. Hidden lifecycle events are replayed when the surface becomes visible. |
| `renderer/lib/laneReadCache.ts` | Renderer-side in-flight coalescing for lane list/snapshot/keybinding reads. Lane lifecycle invalidation clears lane list/snapshot requests and bumps a generation token so a newly requested read never reuses an older in-flight lane snapshot. |
| `renderer/state/appStore.ts` | Shared renderer project/lane state. Stores `laneDeleteProgressByLaneId` so in-flight lane deletion UI survives local `LanesPage` remounts and project metadata updates; the map clears only when the project root changes or the project is closed/reset. Warm project-tab switches restore cached lanes/snapshots, lane selection, focused session, and loading state before the backend round trip finishes, and cache pruning retains Work/lane/session state for all open project tabs in addition to the active and recent projects. `refreshLanes` discards stale responses with a version token so older lane-list reads cannot overwrite a newer refresh. |
| `renderer/components/lanes/laneUtils.ts` | Pure lane list/filter helpers plus default pane trees, including the work-focused tiling tree used by parallel chat launch deep links. |
| `renderer/components/lanes/laneColorPalette.ts` | Curated lane color palette split into `LANE_CLASSIC_COLORS` and `LANE_RAINBOW_COLORS`, then combined as `LANE_COLOR_PALETTE`, plus helpers (`getLaneAccent`, `colorsInUse`, `nextAvailableColor`, `laneColorName`). The first 8 classic hexes form `LANE_FALLBACK_COLORS`, the legacy index-based fallback used for lanes that don't have an explicit color assigned. |
| `renderer/components/lanes/LaneAccentDot.tsx` | Tiny accent dot used everywhere a lane is mentioned (lane list, tabs, PR rows, AppShell PR toasts). Resolves color via `getLaneAccent` so a lane without an explicit color falls back to a deterministic fallback hex. |
| `renderer/components/lanes/LaneColorPicker.tsx` | Reusable grouped swatch picker used inside `CreateLaneDialog` and `ManageLaneDialog`. Shows Rainbow above Classic, disables swatches already in use by other lanes (passed in as `usedColors`), and offers a clear button. |
| `renderer/components/lanes/LaneContextMenu.tsx` | Right-click menu on the lane list. Hosts the inline grouped color swatches that call `lanes.updateAppearance` directly, "Reveal/Copy path", manage/adopt/open-in-Run actions, split-tab actions, and batch manage. |
| `renderer/components/lanes/LaneStackPane.tsx` | Stack graph sidebar, integration source chips, canvas jump |
| `renderer/components/lanes/LaneDiffPane.tsx` | Lane diff list + per-file stage/unstage/discard; file content uses shared `AdeDiffViewer` (commit comparisons read-only; working-tree file can be editable when unstaged) |
| `renderer/components/lanes/LaneGitActionsPane.tsx` | Commit, stash, fetch, sync, push, recent commits. Stashing includes untracked files when the unstaged set contains untracked paths, and stash restore uses the ordinal `stash@{N}` ref returned by `git stash list`. After commit/stash operations it refreshes changes, lane git status, and git metadata while skipping snapshot decorations (`refreshLanes({ includeStatus: true, includeSnapshots: false })`). Seeds its `autoRebaseStatus` from the `autoRebaseStatusSnapshot` prop that `LanesPage` passes from the lane list (`laneSnapshot.autoRebaseStatus`), so opening a lane does not trigger a per-lane probe. A fallback `refreshAutoRebaseStatus` runs only when the snapshot is `undefined`, after a 3.5 s delay, and only while the document is visible. |
| `renderer/components/lanes/LaneWorkPane.tsx` | Terminal/chat toggle work surface |
| `renderer/components/lanes/useLaneWorkSessions.ts` | Hook behind the lane Work pane's chat/session list. Tracks the latest lane id, project root, and scope key in refs so a refresh that was queued during a lane or project switch replays against the newest target and ignores stale rows from the old scope. `launchPtySession` accepts `WorkPtyLaunchArgs` (including `disposition` and `startupDelayMs`) and returns `WorkPtyLaunchResult`; background disposition skips `selectLane`/`focusSession`/`openSessionTab`. The launcher creates an optimistic `TerminalSessionSummary` snapshot from the `ptyCreate` result and upserts it into the session list immediately, then fires the forced session-list refresh as fire-and-forget so the tab and session card appear without waiting for the IPC round-trip. |
| `renderer/components/lanes/LaneRebaseBanner.tsx` | Inline banner driven by `rebaseSuggestionService` |
| `renderer/components/lanes/LaneEnvInitProgress.tsx` | Env init step progress inside create dialog |
| `renderer/components/lanes/CreateLaneDialogHost.tsx`, `CreateLaneDialog.tsx`, `AttachLaneDialog.tsx`, `MultiAttachWorktreeDialog.tsx`, `LaneDialogShell.tsx` | Lane creation / attach dialogs and shared dialog chrome. `CreateLaneDialogHost` owns create-form state, base-branch loading, template/default-template selection, Linear prefill, submit orchestration, appearance save, lane-list refresh, and env setup. It has two post-create behaviors: `stay-open-setup` keeps the Lanes-tab dialog open and streams `LaneEnvInitProgress`; `close-on-create` closes the Work-tab dialog after the lane record exists and runs env setup detached, surfacing a sticky retry toast if setup fails. `CreateLaneDialog` renders the fields and branch/Linear picker subviews; `LaneDialogShell` is viewport-centered (`top-1/2 -translate-y-1/2`), capped at `min(92dvh, calc(100vh-1rem))`, and renders a sticky header, single scrollable body, and optional footer so long content scrolls instead of overflowing the dialog. Selecting a branch seeds the editable lane name from the branch name until the user customizes it. The "Connect Linear issue" affordance in the always-open Advanced section swaps it for `LinearIssuePickerView`. The dialog title/description/icon switch in lockstep with the active sub-view, and connecting a Linear issue auto-flips the create mode out of `existing` (the import-branch tab is locked while an issue is attached). |
| `renderer/components/lanes/laneDialogTokens.ts` | Shared Tailwind class-name tokens for lane dialog sections: `SECTION_CLASS_NAME` (neutral), `SECTION_ACCENT_CLASS_NAME` (accent wash used by stack/integration callouts like the Stack position panel), `SECTION_HERO_CLASS_NAME` (the hero strip at the top of Manage Lane), `LABEL_CLASS_NAME`, `INPUT_CLASS_NAME`, `SELECT_CLASS_NAME`. |
| `renderer/components/lanes/BranchPickerView.tsx` | Filterable virtualized branch list rendered inside `CreateLaneDialog`. Each row shows branch name, last-commit author + relative date, and an inline PR pill (`#NNN`, dim for drafts) when the branch has an open PR. Loading/empty/error states are handled inline. Backed by `branchPickerSearch.ts`. |
| `renderer/components/lanes/branchPickerSearch.ts` | Pure parser + matcher. Tokens AND together: `pr:open` / `pr:none` / `pr:draft`, `author:NAME` (or `author:me` / `mine` resolved against the local git user), `stale:Nd` (older than N days), `#PRNUMBER` (exact match), and free text fuzzy-matched across branch name / PR title / author. Also exposes `formatRelativeTime` for the row subtitle. |
| `renderer/components/lanes/LinearIssuePicker.tsx` | Filterable Linear issue picker rendered inside `CreateLaneDialog`. Loads project / state / assignee filters from `ade.cto.getLinearIssuePickerData` and pages issues through `ade.cto.searchLinearIssues`. Shared row + label helpers (`LinearIssueRow`, `linearPriorityLabel`, `issueProjectLabel`, `issueUpdatedLabel`, `toLaneLinearIssue`, `branchExistsForLinearIssue`) are reused by `LinearIssueBrowser` (top-bar quick view) and the chat composer's Linear context dialog. Also exports a `LinearIssueSummaryCard` used by the dialog's "currently connected" state. |
| `renderer/components/lanes/LinearIssueBadge.tsx` | Compact lane-list badge that surfaces the lane's connected Linear issue (identifier + state + priority); clicking opens the issue in a new chat with the issue pre-attached as context, falling back to opening the issue in Linear when chat is unavailable. The project label falls back through `projectName` -> `projectSlug` -> `teamKey` so issues without a project assignment still render a meaningful label. |
| `renderer/components/lanes/linearBrand.tsx` | Linear brand tokens (`LINEAR_BRAND` colour palette) plus the icon family used everywhere ADE references Linear: `LinearMark`, `LinearStateIcon`, `LinearPriorityIcon`. |
| `renderer/components/lanes/laneAgents.ts` | Pure model + hook for the per-lane agent dashboard. `LaneAgent` is a unified row over a lane's ADE chat sessions and CLI agent sessions (plain shells / run-shells and child terminals of a chat are excluded), each with a glanceable `activity` (`working` / `awaiting-input` / `idle` / `ended`), provider/model label, and last-activity hint. `buildLaneAgents(chatSessions, cliSessions)` merges and sorts (live first, ended last; most-recent within a bucket). `useLaneAgents(laneIds)` returns the merged list keyed by laneId, refreshing on agent-chat + terminal-session change events (debounced 350ms). |
| `renderer/components/lanes/LaneAgentList.tsx` | Inline per-lane agent dashboard built on `laneAgents.ts`. `LaneAgentList` renders one `LaneAgentRow` per agent (dead ones dimmed) with a live `ActivityPulse` (spinner while working/awaiting, static dot otherwise) and a click-to-open handler. Shared by the Lanes stack drawer (`LaneStackPane`), the graph lane cards (`LaneNode`), and the lane list rows; `highlightedSessionIds` pulses the agents that a batch launch just created (fed from `launchedLanesHighlight`). |
| `renderer/lib/launchedLanesHighlight.ts` | One-shot renderer signal used when another surface creates agent sessions and then routes into Lanes. It only publishes lane ids when session ids are present, so lane-only creates do not enter the Lanes tab's agent-loading overlay path. |
| `renderer/components/lanes/ManageLaneDialog.tsx` | Unified manage dialog covering stack position, appearance, adopt-attached, archive, and delete in both single-lane and batch (multi-select) modes. Single-lane mode opens with a "What each section does" info panel and a hero lane-info strip; batch mode swaps in a callout explaining that only archive/delete apply to multiple lanes (stack, color, and adopt are single-lane only). The `StackPositionSection` is single-lane and non-primary only: it shows a parent-lane select (filtered to exclude the lane itself and its descendants), an optional base-branch override input, and an inline "Runs git rebase" disclosure. Apply calls `lanes.reparent({ laneId, newParentLaneId, stackBaseBranchRef })`; the button is disabled while the lane is dirty or has a rebase in progress and while nothing has actually changed, and a parent-callback (`onStackReorganized`) refreshes the lane list. Delete still supports the three scopes (`worktree`, `local_branch`, `remote_branch`), the typed confirmation phrase, remote-branch name input, dirty-state warnings, and the live multi-step progress strip wired to `lanes.delete.event` (`git_status` when a worktree exists, then `cancel_auto_rebase` / `stop_processes` / `stop_ptys` / `stop_watchers` / `cleanup_env` / `git_worktree_remove` / `git_branch_delete` / `git_remote_branch_delete` / `pack_dir_remove` / `database_cleanup`). Optional branch cleanup steps can finish as warnings, allowing lane-owned worktree/database cleanup to complete while still showing the branch cleanup error inline. The dialog calls `lanes.getDeleteRisk` on open to surface dirty state, unpushed commits, running processes / PTYs / watchers, and remote-branch existence before the user confirms; running deletes are shown as non-cancellable because teardown runs to completion once started. |
| `renderer/components/lanes/MonacoDiffView.tsx` | Monaco diff editor used for editable working-tree views (invoked from `AdeDiffViewer`) |
| `renderer/components/run/LaneRuntimeBar.tsx` | Compact lane runtime status bar (health, preview, port, proxy, oauth) |
| `renderer/components/run/RunPage.tsx`, `RunNetworkPanel.tsx` | Runtime dashboards that consume lane runtime services |
| `renderer/components/ui/PaneTilingLayout.tsx` | Persisted split-pane layout engine for lane panes. Validates saved pane trees against expected pane ids and falls back to the supplied tree when the saved layout is stale. |
| `renderer/components/settings/ProxyAndPreviewSection.tsx`, `DiagnosticsDashboardSection.tsx`, `LaneTemplatesSection.tsx`, `LaneBehaviorSection.tsx` | Settings-side management UIs |

Shared code:

- `src/shared/laneBaseResolution.ts` — `shouldLaneTrackParent`, `branchNameFromLaneRef`, `resolveStableLaneBaseBranch`. Used by `laneService`, `conflictService`, `autoRebaseService`, `rebaseSuggestionService`, `prService`, and renderer helpers so base-ref resolution stays consistent.
- `src/shared/defaultRemoteLaneBase.ts` — remote-first default-base resolution for new lanes: `remoteLaneBaseCandidate` (`main` → `origin/main`; SHAs yield `""`), `selectRemoteLaneBaseRef` (prefers the local base branch's configured upstream), and `resolveDefaultRemoteLaneBase` (bounded fetch + selection, null on any failure so creation falls back to the local default). Consumed by the renderer's `newLaneBaseSource.ts` (which re-exports `remoteLaneBaseCandidate` under its historical `remoteNewLaneBaseFallback` name) and by the sync command layer's `lanes.create` default-base path in `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`.
- `src/shared/prStrategy.ts` — `resolvePrRebaseMode(creationStrategy)` maps a PR's `PrCreationStrategy` to `"auto" | "manual"`. Used by `autoRebaseService` and `conflictService` to decide whether drift against a linked PR's base branch should trigger auto-rebase (`pr_target`) or only surface as manual attention (`lane_base`).
- `src/shared/laneLinearIssue.ts` — `parseLaneLinearIssueValue`, `parseLaneLinearIssueJson`, `finalizeLaneLinearIssue`, `laneLinearIssueMissingFields`, `isLinkableLaneLinearIssue`. Validates, normalizes, and checks completeness of `LaneLinearIssue` payloads. Used by `laneService` (create, link), `chatContextAttachments` (attachment hydration), and the TUI/CLI.
- `src/shared/chatContextAttachments.ts` — Chat context attachment helpers for Linear issues. Delegates Linear issue parsing to `laneLinearIssue.ts`.
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
  setup progress polling. The create form has a **Remote/Local
  base-source picker defaulting to Remote** (desktop parity): Remote
  lists remote-tracking refs, preselects the primary base branch's
  upstream (then `origin/<base>`), and freshens refs once via
  `SyncService.fetchGitAdvisory` — a `git.fetch` with its own short
  timeout that is never queued, so a slow remote just falls back to the
  already-listed refs; Local keeps the previous local-branch behavior
  as an explicit opt-in.
- `AddLaneSheet.swift`, `LaneAttachSheet.swift`,
  `LaneMultiAttachSheet.swift` — mobile add/attach entry points,
  including discovery and batch attachment of unregistered worktrees
  via `lanes.listUnregisteredWorktrees`.
- `LaneStackGraphSheet.swift` — mobile stack graph projection for
  parent-child lane chains.
- `LaneDetailScreen.swift`, `LaneDetailGitSection.swift`,
  `LaneDetailGitActionsPane.swift`, `LaneDetailRebaseBanner.swift`,
  `LaneDiffScreen.swift`, `LaneSyncDetailScreen.swift`,
  `LaneActionsCard.swift`, `LaneManageSheet.swift`,
  `LaneBatchManageSheet.swift`, `LaneChatLaunchSheet.swift`,
  `LaneDeeplinkHelpers.swift`, `LaneTreeView.swift`,
  `LaneFileTreeComponents.swift` — mobile detail, git, rebase, diff,
  stash, sync, manage, chat-launch, and file-tree parity surfaces.
  `LaneDetailGitActionsPane.swift` is the single git surface embedded
  in the lane detail (a port of desktop's `LaneGitActionsPane`):
  commit message + amend with an AI "Suggest message" button (calls
  `aiCommitMessages.generate` and shows an inline setup hint when the
  host reports AI commit messages aren't configured), pull/push/fetch,
  staged and unstaged files with per-file and bulk stage / unstage /
  discard / restore / open-diff / open-files affordances, stash
  push/apply/pop/drop, recent-commit history with revert / cherry-pick
  context actions, and a "more actions" menu carrying switch branch
  plus the destructive escape hatches (rebase lane, rebase +
  descendants, rebase and push, force push). It replaced the former
  `LaneAdvancedScreen`, `LaneCommitSheet`, `LaneCommitHistoryScreen`,
  `LaneStashesScreen`, and `LaneDetailContentSections` files.
  `LaneManageSheet.swift` is now a tabbed manage dialog (delete /
  appearance / stack / archive) mirroring desktop's `ManageLaneDialog`;
  its stack tab keeps the parent-lane picker, optional base-branch
  override, "Runs git rebase" disclosure, dirty/rebase-in-progress
  guards, and `lanes.reparent` payloads that omit `stackBaseBranchRef`
  when the override is blank. `LaneDeeplinkHelpers.swift` mints the
  shareable `ade://lane/<id>` and
  `ade://repo/<owner>/<repo>/branch/<branch>` links the lane options
  menu copies to the pasteboard.
- `apps/ios/ADE/Views/Work/WorkNewChatScreen.swift` — mobile
  auto-create (the "Auto-create lane" sentinel) names the new lane with
  the host's small AI model using desktop's background-rename pattern
  (`startBackgroundLaneNaming` in `AgentChatPane`): `submit()` creates
  the lane instantly with the deterministic
  `autoCreatedLaneName(opener:)`, launches the chat/CLI session, then
  fires a fire-and-forget task that calls `SyncService.suggestLaneName`
  (the non-queueable `lanes.suggestName` sync command →
  `agentChatService.suggestLaneNameFromPrompt` on the host) and applies
  the result via `lanes.rename` only when it differs from the
  deterministic fallback. Naming never blocks or fails lane creation or
  session launch — any failure / timeout / offline / host-disabled
  state simply keeps the deterministic name. The host command is
  deliberately not queueable so an offline phone fails fast to the
  deterministic name instead of queueing a stale suggestion. Covers
  both the Chat and CLI auto-create paths; the all-projects hub
  composer (`HubComposerDrawer.swift`) runs the same background naming
  with `targetProjectId`/`targetProjectRootPath` scope so it works for
  foreign-project launches.

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
and reparent operations. A set of repair routines normalize older data:

- `repairPrimaryParentedRootLanes` — detaches non-primary lanes whose
  `parent_lane_id` was mistakenly set to the primary lane and resets
  `base_ref` to the project's default branch.
- `repairLegacyPrimaryBaseRootLanes` — normalizes `base_ref` on root
  worktree lanes that still point to a stale or non-default branch.
  Lanes with open PRs are excluded from repair.
- `repairDuplicateManagedWorktreeLanes` — removes duplicate lane rows
  that share one managed worktree path (artifacts of the historical
  create/recover race, see gotchas). Keeps the row whose id matches the
  8-char suffix embedded in the worktree directory name (the lane that
  created the worktree), falling back to the oldest row; sessions, child
  lanes, and Linear issue links on the duplicate are re-pointed to the
  keeper before the duplicate cascades away, so no user-visible data is
  lost. Runs in the `list()` repair block alongside
  `recoverManagedWorktreeRows`.

These routines run inside `listLanes` (i.e. on every `lanes.list`), not at
`createLaneService()` construction time.

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

## Lane lifecycle

1. **Create** — `laneService.create()` resolves the base ref (explicit
   or parent's branch), normalizes the branch name, computes a unique
   worktree path under `.ade/worktrees/<slug>/`, runs `git worktree
   add`, inserts the lane row, and returns a `LaneSummary`.

   **Default base is remote-first.** The base a new unparented lane
   branches from when the user didn't pick one is governed by the
   project's `git.newLaneBaseSource` config (`"remote"` — the effective
   default — or `"local"`). Desktop's create-lane dialog resolves this
   renderer-side (`renderer/components/lanes/newLaneBaseSource.ts`):
   with the remote source it defaults the picker to the primary base
   branch's remote-tracking ref (upstream first, then `origin/<base>`)
   after a bounded fetch. Callers with no picker UI go through the sync
   command layer instead: `lanes.create` commands that omit
   `baseBranch` / `startPoint` / `parentLaneId` (mobile hub-composer
   auto-create, the iOS create sheet default, headless CLI) get the
   same remote-first default resolved host-side via
   `resolveDefaultRemoteLaneBase` in
   `src/shared/defaultRemoteLaneBase.ts` — bounded fetch (4 s), map the
   primary base branch to its remote-tracking ref, and fall back to the
   legacy local primary tip when the source is `"local"`, the fetch
   fails, or no remote ref exists. This keeps a phone-created lane from
   silently branching off a stale local checkout. The iOS
   `LaneCreateSheet` additionally exposes the choice as a Remote/Local
   base-source picker defaulting to Remote.

   When
   `CreateLaneArgs.startPoint` is supplied (e.g. from the History
   tab's "Create lane here" affordance on a commit), the service
   verifies the ref with `git rev-parse --verify` in the parent
   worktree (or the project root for unparented creates), uses the
   resolved SHA as the worktree's start point, and skips the
   `fetch + reset` step that primary-derived lanes normally run.
   When `CreateLaneArgs.linearIssue` is supplied (from
   `CreateLaneDialog` via the Linear issue picker), the service
   derives the branch name from the issue (`linearIssueBranchName`:
   `ident-title-slug`, sanitised against git-ref rules) when no
   explicit `branchName` was provided, refuses to create the lane if
   the resolved branch already exists locally or under `origin/`,
   and writes the issue payload into `lane_linear_issues` so the PR
   / commit / chat surfaces can pick it up later. The same path runs
   for `createChild`. Successful create/import paths emit a
   `LaneLifecycleEvent` with the created `LaneSummary` so the renderer
   can show a global success toast and invalidate lane-list snapshots
   without waiting for another list poll.
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
   `reparent` edit the lane row. `rename` trims the name, rejects empty
   values, blocks primary-lane renames, and rejects duplicate display
   names among active lanes (case-insensitive). The desktop **Manage Lane**
   dialog exposes rename via a pencil control beside the lane name in the
   header. `reparent({ laneId, newParentLaneId,
   stackBaseBranchRef? })` refuses to move a lane under one of its own
   descendants and refuses to reparent the primary lane. When
   `stackBaseBranchRef` is supplied the service resolves it in the project
   repo (preferring `origin/<branch>`) and uses that as the rebase target
   and persisted base ref; otherwise it falls back to the new parent's
   current branch. When both the parent link and the resolved base ref are
   unchanged, reparent short-circuits without touching git so a redundant
   apply is a no-op rather than a stack rebase.
7. **Archive** — `archive` sets `archived_at` and `status = 'archived'`
   but keeps the worktree on disk, then emits a `lane-archived`
   lifecycle event. `unarchive` reverses the database state.
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
   After successful cleanup, the service emits a `lane-deleted`
   lifecycle event. This is separate from `lanes.delete.event`: delete
   progress streams every teardown step, while the lifecycle event is a
   single final-state notification for toast consumers.
   Teardown depends on optional injected services
   (`processService`, `ptyService`, `autoRebaseService`,
   `rebaseSuggestionService`, `fileWatcherService`); when one is not
   wired, the corresponding step is `skipped` rather than `failed`.
   The pipeline yields cooperatively (`setImmediate`) at the start of
   each step so a long-running step never blocks the IPC event loop,
   filesystem cleanup uses `fs.promises.rm` instead of synchronous
   `rmSync`, and `git_worktree_remove` checks the managed worktree path
   after a successful git removal so residual files are removed and
   `git worktree prune` runs before the lane row disappears. If an
   unregistered residual directory cannot be removed, the delete still
   completes with a warning and records a local retry row so the next
   lane-list sweep can remove the directory once the filesystem allows
   it. Multiple delete calls can progress through non-Git teardown independently;
   the shared worktree-mutation guard is held only while
   `git_worktree_remove` mutates Git's worktree registry, so lane
   creation can start while another lane is still stopping processes,
   PTYs, watchers, or environment resources. The
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
| `laneService.switchBranch(args)` | Performs the checkout: refuses dirty trees, refuses duplicate-owner branches, requires `acknowledgeActiveWork` if active sessions/processes exist, then `git checkout` (or `checkout -b` in `mode: "create"`), updates the lane row, upserts the branch profile, and prunes stale `pull_requests` rows whose `head_branch` no longer matches the new branch. (`pull_requests.lane_id` is `not null`, so stale rows are deleted along with their child rows in `pr_group_members`.) |
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
or remote ADE runtime) and as legacy in-process IPC handlers in
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
| `ade.lanes.linkLinearIssues` | `(args: { laneId, issues, role?, source?, includeInPr?, closeOnMerge?, evidence? }) => LaneLinearIssueLink[]` — link one or more Linear issues to an existing lane post-creation. Also surfaced as `lane.linkLinearIssues` through the ADE action registry and the `ade lanes link-linear-issue` CLI command. |
| `ade.lanes.unlinkLinearIssues` | `(args: { laneId, issueId? }) => boolean` — lane-level detach counterpart to `linkLinearIssues`. Omit `issueId` to remove every non-primary link; never touches the lane's primary issue (stored in `lane_linear_issues`). |
| `ade.lanes.attachLinearIssueToSession` | `(args: { chatSessionId, issues, role?, source?, includeInPr?, closeOnMerge?, evidence? }) => SessionLinearIssueLink[]` — attach Linear issues to a chat or CLI session (works even when the session has no lane). Persists into `session_linear_issues`; when the session resolves to a lane, also mirrors each issue into `lane_linear_issue_links` (source `chat_attach`) without promoting the lane's primary issue. |
| `ade.lanes.detachLinearIssueFromSession` | `(args: { chatSessionId, issueId? }) => boolean` — detach one issue (or all when `issueId` is omitted) from a session; removes the mirrored `chat_attach` lane links too. |
| `ade.lanes.listLinearIssuesForSession` | `(args: { chatSessionId }) => SessionLinearIssueLink[]` — issues attached to a single session. |
| `ade.lanes.listLinearIssuesForLaneSessions` | `(args: { laneId }) => SessionLinearIssueLink[]` — every session-scoped link across all chat + CLI sessions in a lane; used by `prService` on PR-open to fan out session → lane → Linear. |
| `ade.lanes.delete.risk` | `(args: { laneId }) => LaneDeleteRisk` — preflight read for the manage dialog: dirty state, unpushed commit count, remote-branch existence, active processes/PTYs/watchers, env-init flag. |
| `ade.lanes.delete.cancel` | `(args: { laneId }) => { cancelled, reason? }` — cooperative cancel during the early teardown steps. After `git_worktree_remove` starts the lane is unrecoverable and cancel is a no-op. |
| `ade.lanes.delete.event` (push) | `LaneDeleteEvent` carrying `LaneDeleteProgress` — `steps[]` with per-step status (`pending` / `running` / `completed` / `failed` / `skipped`) plus `overallStatus` (`running` / `completed` / `failed` / `cancelled`) and `cancellable`. |
| `ade.lanes.lifecycle.event` (push) | `LaneLifecycleEvent` - one-shot `lane-created`, `lane-renamed`, `lane-archived`, `lane-unarchived`, or `lane-deleted` event. Local desktop paths emit this IPC channel directly; runtime-backed paths push `lane_lifecycle_event`, and preload merges both sources behind `window.ade.lanes.onLifecycleEvent`. |
| `ade.lanes.delete.progress.list` | replay of the in-memory `LaneDeleteProgress` map for currently running deletes. Completed delete results are delivered through the live event stream; a remount after completion refreshes the lane list instead of replaying historical progress. |
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
- Lane lifecycle invalidation is event-driven. `useLaneListInvalidation`
  listens to local and daemon/remote lifecycle events via preload,
  clears lane read coalescing immediately, refreshes decorated snapshots
  with a short debounce, and does one delayed follow-up refresh for
  out-of-process writes that settle just after the first read.
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
- **Half-created worktrees must stay invisible to recovery.** A new
  worktree is visible to `git worktree list` the moment `worktree add`
  registers it, but its lane row only lands after checkout completes.
  `recoverManagedWorktreeRows` (run by every `lanes.list`) would adopt
  that half-created worktree as a duplicate lane, so `createWorktreeLane`
  and `importBranch` hold a pending-creation marker
  (`trackPendingWorktreeCreation`) across the add→insert window, and
  recovery/unregistered-worktree listings skip pending paths/branches.
  Any new code path that runs `git worktree add` under `worktreesDir`
  and inserts a lane row afterwards must do the same. The lanes table is
  a cr-sqlite CRR, so a unique index cannot enforce this at the DB
  layer; `repairDuplicateManagedWorktreeLanes` dedupes any rows that
  slip through (e.g. from a second process).
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
