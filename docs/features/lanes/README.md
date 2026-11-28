# Lanes

A lane is DAEX's unit of parallel work: one git branch in its own worktree
folder, with its own chats, terminals, ports, proxy hostname, OAuth callbacks,
environment setup and health checks. The project's own folder is the primary
lane. Its stored name is "Primary"; every screen calls it **Main checkout**
through `laneDisplayName(lane)` (`apps/desktop/src/shared/laneDisplayName.ts`).
Write new copy as "main checkout", never "Primary lane", and never change the
stored name or `laneType: "primary"`.

Commands below use `daex`; `ade` still works as an alias.

Detail docs in this folder:

- [worktree-isolation.md](./worktree-isolation.md): worktree mechanics, per-lane state, saved work after a delete.
- [runtime.md](./runtime.md): environment setup, templates, ports, proxy, preview, diagnostics, main checkout packages.
- [oauth-redirect.md](./oauth-redirect.md): OAuth callback routing across lanes.
- [lane-sharing.md](./lane-sharing.md): sharing one lane with another DAEX account, and moving a chat to that person.

## Source file map

The lane services live in `apps/desktop/src/main/services/lanes/`. The brain
(`daex serve`, `apps/ade-cli/src/bootstrap.ts`) imports and runs them; the
desktop main process uses the same code only where no runtime is bound.

Main services (`apps/desktop/src/main/services/lanes/`):

| File | Responsibility |
|------|---------------|
| `laneService.ts` | Lane CRUD, worktree lifecycle, status, rebase runs, branch switching, drift, issue links, archive, delete. |
| `laneStartResolver.ts` | Resolves a start choice (`shared/laneStart.ts`) to a ref and commit. |
| `laneCompareBase.ts` | The compare base: open PR base, else the default branch; the primary lane uses its upstream. |
| `laneBranchNaming.ts` | Everything that names a branch: the project pattern, typed-name clash checks (`checkTypedBranch`), the auto-create placeholder and its rename, Rename branch, new-lane defaults. |
| `laneBranchDrift.ts` | Pure helpers: `parseWorktreeStatusPorcelainV2`, `detectLaneBranchDrift`, `classifyMissingLaneBranchDriftKind` (reads `git branch -m` reflog subjects to tell `renamed` from `missing`). |
| `laneBranchHistory.ts` | `createLaneBranchHistoryObserver`: reads each worktree's HEAD reflog and records the branches it used, for PR matching. |
| `laneBuiltOnMerged.ts` | Finds merged PR heads from the last 30 days and picks the replay boundary for a lane built on merged work. |
| `defaultBranchAutoPull.ts` | Keeps the main checkout's default branch current (fast-forward only). See [Default-branch auto-pull](#default-branch-auto-pull). |
| `laneFolderRemoval.ts` | Safe folder removal: move-aside-and-prune on Windows, Windows refusal messages, waiting for the lane's processes (`LaneFolderBusyError`), `LaneUnsavedWorkError`, the lane trash sweep. |
| `laneWorktreeNaming.ts` | Managed folder name `<slug cut to 40>-<laneId[0:8]>` (short for Windows' 260-character paths), plus the legacy uncapped name. |
| `worktreeResidualCleanup.ts` | Retries removal of managed folders that survived a delete (`local_worktree_residual_cleanups`). Never touches unknown non-empty folders. |
| `laneWorktreeLockService.ts` | Database lease for any operation that mutates a worktree (PR integration, storage reclaim/restore, idle build-output cleanup). |
| `deletedLaneSnapshots.ts` | Keeps what a delete or discard would lose as git refs for 30 days. See [worktree-isolation.md](./worktree-isolation.md). |
| `laneUsageTombstone.ts` | The counters row a deleted lane leaves for lifetime stats. See [What a deleted lane leaves behind](#what-a-deleted-lane-leaves-behind). |
| `laneEnvironmentService.ts`, `laneEnvironmentProcesses.ts` | Environment setup pipeline and its process bookkeeping and cancellation. |
| `laneEnvironmentSetup.ts` | `runLaneEnvironmentSetup`: the one entry point every caller (actions, IPC, sync, chat launch) uses; `planNewLaneEnvironment`. |
| `laneEnvInitMerge.ts`, `laneOverlayContext.ts`, `setupScriptConfig.ts` | Env-init config merging, overlay resolution shared by setup and teardown, per-OS setup script choice. |
| `laneTemplateService.ts` | Reusable lane templates. |
| `laneDependencyStatus.ts` | Lockfiles in the main checkout and whether they are installed. See [runtime.md](runtime.md#main-checkout-packages). |
| `portAllocationService.ts`, `laneProxyService.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts` | Port leases, `*.localhost` proxy, OAuth callbacks, health checks. See [runtime.md](./runtime.md). |
| `laneLaunchContext.ts` | Resolves launch cwd/env for terminals and tools; keeps cwd inside the worktree. |
| `laneListSnapshotService.ts` | Lane snapshots with presence, conflict status and session counts. |
| `laneShareRightsStore.ts` | Host-side rights and guest counters of lane shares (local only). |

Other main-process and CLI code:

- `apps/desktop/src/main/services/adeActions/registry.ts`: `lane.*` actions. `lane.delete` resolves the overlay before teardown, adds environment cleanup, and releases the port lease when the delete ends (also for a background delete).
- `apps/desktop/src/main/services/adeCloud/cloudComputerLaneHold.ts`, `cloudComputerRules.ts`: the one-lane-per-cloud-computer rule.
- `apps/desktop/src/main/services/git/git.ts`, `gitReadEnv.ts`, `gitRepoCache.ts`, `gitTimeouts.ts`, `gitTransportAuth.ts`: the shared git engine. See [Shared git engine](#shared-git-engine).
- `apps/desktop/src/main/services/prs/pullRequestRowCleanup.ts`: detaches PR rows when a lane goes.
- `apps/desktop/src/main/services/config/laneOverlayMatcher.ts`: per-lane overlay policies.
- `apps/desktop/src/main/services/shared/removeTreeOffProcess.ts`: whole-folder removal in a child process.

Shared code (`apps/desktop/src/shared/`): `laneStart.ts`, `laneBranchName.ts`
(pattern render, sanitize, clash rules), `laneBaseResolution.ts`,
`laneDisplayName.ts`, `laneNameFallback.ts`, `laneEmoji.ts`, `laneSetupPlatform.ts`,
`laneLinearIssue.ts`, `laneJiraIssue.ts`, `chatContextAttachments.ts`,
`editorTargets.ts`, `uuid.ts` (`requireNormalizedUuid` for every caller-reserved
id), `types/lanes.ts`.

Renderer (`apps/desktop/src/renderer/`):

| File | Responsibility |
|------|---------------|
| `components/lanes/LanesPage.tsx` | Lanes page, selection, deep links (`laneId`, `laneIds`, `inspectorTab`, `action=batch`), branch switch dialog. |
| `components/lanes/useLanesPageMachines.ts`, `state/laneMachineRouting.ts`, `state/projectMachines.ts` | One flat lane list across machines, the Computer filter entries, and fail-closed routing (`resolveLaneTarget`, `route(laneId, machineId)`). |
| `components/lanes/sidebar/` | `LaneSidebarList`, `LaneSidebarRow`, `laneSidebarModel`, `LaneFilterPanel` (Computer filter), group menus and `LaneSidebarBulkCatchUpDialog`, `LaneSidebarBulkContextMenu` (mixed-machine multi-select). |
| `components/lanes/overview/LaneDashboard.tsx`, `LaneGitActionsPane.tsx`, `LaneDiffPane.tsx` | Lane detail: identity, status, catch-up notice, PR, chats, changes; git actions; diff with stage/unstage/discard (read-only under another machine's pin). |
| `components/lanes/RestingCloudLaneDetail.tsx` | The lane of an asleep DAEX Cloud computer. |
| `components/lanes/LaneCatchUpMenu.tsx`, `laneCatchUp.ts`, `lib/laneCatchUpPrompt.ts` | Catch up menu, safety rules, agent prompt. |
| `components/lanes/LaneBranchDrift.tsx` | Drift chips: `LaneBranchDriftChip` (header) and `LaneBranchComposerChip` (composer strip, armed by `armLaneBranchDriftWarning`). |
| `components/lanes/CreateLaneDialog.tsx`, `CreateLaneDialogHost.tsx`, `createLaneComposerChips.tsx`, `LaneStartPicker.tsx`, `useLaneStartMenuData.ts`, `LaneBranchList.tsx`, `branchPickerSearch.ts` | New lane dialog. On submit `runDetachedLaneCreate` runs create and setup in the background against one binding fixed at submit. |
| `lib/pendingLaneCreates.ts` | "Creating…" rows for creates in flight (window-local). |
| `components/lanes/ManageLaneDialog.tsx`, `components/terminals/WorkManageLaneDialogHost.tsx` | Manage, archive, delete; Work's host routes to the lane's machine. |
| `components/lanes/LaneContextMenu.tsx`, `laneContextMenuItems.tsx` | `buildLaneMenuGroups`, the one action inventory shared with Work's **Lane** submenu (including **Open in**). |
| `components/lanes/lanePageModel.ts` | Pure selectors: `selectLanePrs` (lane-owned PRs only; a main checkout on its base branch shows none), `selectChatPrs`, batch delete planning. See [Pull requests](../pull-requests/README.md#lane-surfaces-and-chat-surfaces-need-two-different-selectors). |
| `components/lanes/LanePrBadgePopover.tsx` | Current-branch PR badge and its portal. |
| `components/lanes/laneColorPalette.ts`, `LaneColorPicker.tsx`, `LaneAccentDot.tsx` | Lane colors. |
| `components/lanes/LaneEmojiPicker.tsx`, `LaneEmojiPickerContent.tsx`, `LaneEmojiGlyph.tsx`, `useLaneEmojiSuggestion.ts` | Lane emoji. |
| `components/lanes/laneAgents.ts` | Per-lane agent rows (chats and CLI agents). |
| `components/lanes/LinearIssueBadge.tsx`, `linearIssueDisplay.ts`, `linearBrand.tsx` | Linear issue on lane surfaces. |
| `components/lanes/useLaneTemplateSetupChat.ts`, `lib/laneChatHandoff.ts`, `lib/laneTemplateSetupPrompt.ts` | "Set up with an agent" draft in the main checkout of the right machine; `useLaneChatHandoff(pin)`. |
| `components/app/useLaneDependencyBanners.tsx` | Main checkout notices: packages out of date, set up a lane template. |
| `components/app/toast/useLaneEventToasts.ts` | Lane lifecycle toasts (skips lanes a chat launch owns). |
| `hooks/useLaneListInvalidation.ts`, `lib/laneReadCache.ts`, `state/appStore.ts` | Event-driven lane list refresh, read coalescing, shared lane state. |
| `lib/laneDeleteProgress.ts` | Delete progress shared by Lanes and Work. |
| `components/settings/NewLaneSettingsSection.tsx`, `LaneTemplatesSection.tsx` | Settings › Lanes › New lanes. |
| `components/laneShare/` | Lane sharing UI, owner side; `laneShare/guest/` is the guest side. |

iOS (`apps/ios/ADE/Views/`): `LanesTabView.swift` and `Lanes/` hold the lane
list, create (`LaneCreateSheet`, `AddLaneSheet`, `LaneEnvInitProgressView`),
detail (`LaneDetailScreen`, `LaneDetailGitSection`, `LaneDetailGitActionsPane`
as the single git surface, `LaneDiffScreen`), manage (`LaneManageSheet`,
`LaneBatchManageSheet`), branch switch (`LaneBranchPickerSheet`), moves
(`LaneMove*`), recently deleted (`RecentlyDeleted*`), colors
(`LaneColorPalette`, `LaneColorSwatchPicker`) and links
(`LaneDeeplinkHelpers`, which mints `daex://lane/<id>` and
`daex://repo/<owner>/<repo>/branch/<branch>`). Auto-create from the phone
lives in `Work/WorkNewChatScreen.swift` and `Hub/HubComposerDrawer.swift`.

## Gotchas and fragile areas

- **Half-created worktrees must stay invisible to the reconcile.** A worktree
  appears in `git worktree list` as soon as `worktree add` registers it, but
  its lane row lands after checkout. `createWorktreeLane` and `importBranch`
  hold a pending-creation marker (`trackPendingWorktreeCreation`) across that
  window; adoption and reap both skip pending paths. **Any new code that runs
  `git worktree add` and then inserts a lane row must do the same.** The lanes
  table is a cr-sqlite CRR, so no unique index can enforce it;
  `repairDuplicateManagedWorktreeLanes` dedupes what slips through.
- **A lane row can disappear without a delete.** The reconcile reaps lanes
  whose worktree is gone from both git and disk. Code that removes a folder
  temporarily must hold a pending marker or archive the lane first (archived
  lanes are never reaped).
- **Deleting a lane does not delete its PRs.** Delete, `switchBranch` and
  rename-with-branch-change *detach* `pull_requests` rows
  (`pullRequestRowCleanup.ts`). Detached rows keep a dangling `lane_id`, so any
  lane-scoped query over `pull_requests` must add `detached_at is null`. See
  [Detached PR rows](../pull-requests/README.md#detached-pr-rows).
- **`LaneListSnapshot.adoptableAttached` must keep being emitted.** Nothing
  reads it and it is always `false`, but shipped iOS builds decode it as a
  non-optional `Bool`; dropping it blanks the lane list on phones that have not
  updated. It is declared required so the compiler catches an emitter that
  forgets it. Drop it only when the oldest iOS build in the field treats it as
  optional.
- **Main checkout protection.** `is_edit_protected = 1` is enforced in
  `laneService`, not the database. Code that updates rows directly must check
  it (delete, rebase start). The main checkout cannot be renamed.
- **Repair runs on every `lanes.list`.** A new lane field that can drift
  needs handling in the repair routines.
- **Lane list cache.** `LANE_LIST_CACHE_TTL_MS = 10_000`. Callers that need
  fresh status after a git operation pass `refresh: true` or mutate through the
  service.
- **The git repo cache is keyed by common git dir.** All worktrees of one repo
  share entries. Keys describe the question (`rev-parse:<cwd>:<ref>`), never
  the caller. Re-keying per lane removes the benefit and keeps the staleness.
- **Cache invalidation lives in `runGit` and fires on failure too.** Git
  spawned another way is not covered and can serve SHAs up to 1.5 s stale. A
  new ref-changing verb goes into `REF_AFFECTING_GIT_VERBS`; a read-only mood
  of a listed verb goes into the read-only tables, or every call drops the
  repo's cache.
- **Git run outside DAEX invalidates nothing.** Terminal commits and scripts
  rely on the 1.5 s TTL. Do not widen it.
- **Mutations bypass the 12-slot git semaphore** on purpose (some run for
  minutes). Routing writes through the queue reintroduces priority inversion.
- **Worktree paths stay absolute.** A relative path breaks `git -C`.
- **Open in is one inventory, two hosts.** `buildLaneMenuGroups` owns the
  `open-in` entry; `LaneContextMenu` and `LaneActionsSubmenu` render it. Do not
  add a second editor picker on a local singleton session menu. Foreign SSH
  rows without a header keep session-root Open in.
- **Every lane action carries the lane's pin.** Unknown or unroutable lanes
  fail closed; they never fall back to the tab's machine. Lane ids can repeat
  across machines, so selection uses machine id plus lane id.
- **OAuth redirect is fragile.** See [oauth-redirect.md](./oauth-redirect.md).

## Starting a lane

Every lane except the main checkout is a separate worktree folder. Git allows a
branch to be checked out in only one folder at a time.

**Create new branch.** The **Branch** field follows the lane name through the
project's branch pattern until you type your own; an attached Linear issue
fills it with the issue's branch name. A typed name is checked on the lane's
machine first: invalid names, and names taken locally or on the remote
(compared without case), are explained under the field. A pattern-made name
that is taken gets the lane id added.

**Start from** the default branch, the main checkout's branch, or another
branch, **On**:

- **Remote**: fetch and start from the remote branch.
- **Local**: start from the local tip, unpushed commits included.
- **Bring my uncommitted changes from <lane>** (shown when the start branch is
  open in a lane): start from the local tip and copy staged, unstaged and
  untracked changes. Ignored files are skipped; the source is never changed.

**Use existing branch** opens a branch directly. A branch open in another
folder cannot be picked.

A repository with no commits answers "This repository has no commits yet. Make
a first commit, then create a lane." A new project made in DAEX still starts
with no commit (never block on a first commit). When git cannot list branches,
the error carries git's first lines or "Git took too long to answer".

### Branch names

Settings › Lanes › New lanes › **Branch names** holds the pattern,
`ade/{slug}` unless changed (`DEFAULT_LANE_BRANCH_PATTERN` in
`shared/laneBranchName.ts`). The `ade/` prefix is kept on purpose: existing
branches, PRs and saved settings use it. `{slug}` is the lane name slugged and
must come last; `{user}` is git `user.name` on the lane's machine, slugged.
`{slug}` alone means no prefix. Names are capped near 100 characters and
stripped of what git or Windows refuse. Saving refuses a prefix that clashes
with an existing branch (`arul/` while `arul` exists).

Auto-create lanes start on a placeholder `<prefix><8 hex>` chosen by the lane's
machine (`autoNamedBranch: true`), marked with git config
`branch.<name>.adeautolane` so a bare hex name under an empty prefix is never
mistaken for a user's branch. The AI rename then gives `<prefix><title slug>`.

**Rename branch…** (`lane.renameBranch`, pinned) works only while the branch
was never pushed, tracks nothing and has no PR.

### New-lane defaults

Settings › Lanes › New lanes stores where new lanes start, the branch pattern
and the template, per account and repository (on this computer when the repo
has no remote). Auto-create, `daex lanes create` without flags, the dialog's
first choice and the phone use them. A deleted saved branch falls back to the
default branch with a note. Inspect with `daex lanes defaults --text`; change
with `daex lanes defaults set --from <branch>` or
`--branch-pattern "{user}/{slug}"`.

`daex lanes create` from an agent shell creates the lane in the shell's
project (`ADE_PROJECT_ROOT`, else the checkout the shell stands in).
`--project-root <dir>` names another project, and then the shell's
`ADE_LANE_ID` and `ADE_WORKSPACE_ROOT` are ignored. The new branch is pushed to
`origin` with upstream tracking right away, best effort (not an auto-create
placeholder).

### Compare base and Catch up

A lane compares against its open PR's base, else the project default branch,
as GitHub does. When the local base only trails `origin/<base>`, counts use
the remote one and `status.comparedTo` says so. The main checkout compares to
its upstream. The Lanes tab shows **N behind <base>** or **Built on work now in
<base>** with a **Catch up** menu (`LaneCatchUpMenu.tsx`), also on the sidebar
row, the overview status line and the Git pane header:

- **Ask an agent** (default): writes a prompt into a chat draft in the lane,
  never sent (newest Work chat, else a new chat). The prompt says fetch, rebase
  if never pushed else merge, resolve keeping the lane's intent, run checks,
  don't push without asking.
- **Rebase now**: only when clean, no rebase/merge in progress, no predicted
  conflict, and never pushed (no upstream, no PR). Runs `lanes.rebaseStart`
  with `pushMode: "none"`.
- **Merge <base> in**: same rules, pushed or not. Runs `git.mergeBaseIn`.

When neither direct way is safe, the menu shows one line saying why. Rules:
`laneCatchUpOptions` in `laneCatchUp.ts`. A lane on another machine has no
conflict scan, so its prediction is unknown; both direct ways undo themselves
on a conflict. A failure shows inline (`LaneCatchUpFailureBanner`) with **Ask
an agent**, or as a toast from the sidebar. Every read and write goes to the
lane's machine with its pin. **Catch up all** in the Behind group applies the
same rules per lane, one at a time.

`git.mergeBaseIn` (`daex git merge --lane <lane>`) fetches, then runs `git
merge --no-edit origin/<base>` as the lane operation `git_merge_base_in`. It
refuses a dirty lane or one mid-rebase/merge; on any failure it aborts and
throws. A failed fetch merges the last known copy (`fetched: false`).

A lane built on a squash-merged lane rebases only its own commits when DAEX
knows the merged PR head and finds its merge commit in the base. Rollback
refuses if any affected lane moved or has uncommitted work, and is unavailable
after a push.

## Where this runs

Lane lifecycle (create, adopt, rename, archive, delete, rebase, branch switch,
ports, proxy, OAuth, diagnostics) runs in the brain for the project. The
renderer's `window.ade.lanes.*` calls go through
`apps/desktop/src/preload/preload.ts` to the bound runtime (local or remote);
the local IPC handler runs only when no runtime is bound. For a remote binding
the worktree, git, watchers, PTYs and processes all live on the remote host.
Each window has its own binding.

### Lanes across machines

The create dialog offers every machine that can host the repository and picks
the only one automatically. Creating on another machine does not rebind the
tab; that lane's later actions go to its machine.

The Lanes tab shows one flat list across machines. The funnel in the sidebar
search row opens the Computer filter (`LaneFilterPanel.tsx`):

- One entry per own computer, one **DAEX Cloud** entry for all cloud computers
  (a lane's own cloud computer never gets an entry), plus **All**. Two
  checkouts on one machine are one entry (`machineIdOfSlot`).
- Single-select, remembered per project. An entry that is no longer listed
  reads as **All**. While a filter is on, one line says `Showing <computer> ·
  Show all`.
- A cloud lane whose computer was deleted stays under DAEX Cloud with a
  "Computer deleted" mark; its rows use the machine id `ade-cloud-deleted`, so
  every lane action refuses them, and its page shows
  `CloudLaneComputerDeletedBanner.tsx`.
- Offline own computers are hidden. An asleep cloud computer is not offline:
  its lanes stay listed from the account's saved copy.
- The text filter (`is:dirty`, `is:clean`, `type:worktree`, free text)
  combines with the Computer filter. There is no `machine:` term.
- When the filter hides the open lane, the view moves to the first visible one.
- Mixed batch selections are split by owner before running.

### An asleep DAEX Cloud lane

Opening it never wakes the computer (`RestingCloudLaneDetail.tsx`). The Git
line comes from `window.ade.adeCloud.projectOverview`; changed files come from
the lane pin's `diff.getChanges`, which preload answers from the account while
the computer rests (`renderer/state/adeCloudRestingReads.ts`, up to 200
files). It reads once, with no timer. **Wake to run** (`useAdeCloudLaneWake`)
is the only control that wakes it.

<a id="one-lane-per-ade-cloud-computer"></a>
### One lane per DAEX Cloud computer

Each DAEX Cloud computer holds one lane, counted across every project on it.
An archived lane counts (it keeps its computer for restore). The main checkout
never counts. Normal computers are unaffected. A lane started on DAEX Cloud
gets a new computer (see [DAEX Cloud lanes](../chat/README.md#ade-cloud-lanes));
deleting the lane deletes the computer; keeping it frees the computer
(`cloud_lanes_without_computer`, see
[DAEX Cloud](../ade-cloud/README.md#the-life-of-a-lanes-computer)).

- **Checked** in `laneService.ts` wherever a lane row comes to exist: `create`
  and `importBranch` (before git work and again under the write lock before the
  insert) and adoption (`recoverManagedWorktreeRows`, which skips and logs
  `laneService.cloud_computer_adoption_skipped`).
- **Across projects:** `cloudComputerLaneHold.ts` reads other projects' lanes
  read-only. A database that cannot be read counts as holding a lane.
- **Two creates at once:** a lock file (`cloud-computer-lanes.lock`) and a
  claim file (`cloud-computer-lanes.json`) in the machine's DAEX folder; a dead
  process's claim stops counting after two minutes.
- **Signal:** `cloudComputerLaneRuleApplies`: `ADE_CLOUD_INSTANCE_ID`, or on
  Linux the template's `/usr/local/bin/ade-entrypoint.sh` (file names keep the
  old name).
- **Refusal:** `CloudComputerLaneLimitError` (expected `user` error), with the
  sentences in `cloudComputerRules.ts`. `chat.startLaunch` refuses early
  (`assertRoomForNewLane`); a hand-off's destination check
  (`preflightCrossMachineDestination`) lists it as blocking.
- **Not refused:** the cloud launch's first lane, chats moved or copied to a
  new computer, unarchive, rename, a launch retried with the same id, and
  restoring a deleted lane when the computer holds no other lane. A computer
  from the older flow with several lanes keeps them but gets no more.

## Sharing a lane

**Share lane…** gives another DAEX account limited access to one lane on this
machine. The holding machine enforces the guest's rights on every action. The
guest opens it from Work's "Shared with me" or `/shared`, over DAEX Relay. See
[lane-sharing.md](./lane-sharing.md).

## Default-branch auto-pull

`defaultBranchAutoPull.ts` runs in the brain (wired in `bootstrap.ts`; not in
an embedded runtime) 20 s after the project opens and then every five minutes,
plus one pass after DAEX merges a PR into the default branch
(`refreshDefaultBranchAfterMerge`). Passes never overlap. Fast-forward only:

1. Gate (`evaluateDefaultBranchAutoPull`, pure): main checkout, HEAD attached
   on the detected default branch (`baseRef`, not `lanes.branch_ref`), no
   tracked changes, no rebase/merge/cherry-pick/revert, no held worktree lease,
   an upstream. Untracked files do not block.
2. Fetch.
3. `git pull --ff-only` only when strictly behind. Diverged skips.
4. Skips and failures are silent (logged only).

## Lane types

| Type | Folder | Use |
|------|--------|-----|
| `primary` | The repo root | The main checkout; always exists, edit-protected |
| `worktree` | Any worktree of the repo (`.ade/worktrees/<name>/` when DAEX made it) | Every other lane |
| `attached` | External path | **Legacy.** Never written; behaves like `worktree`. Only presentation differs (dashed border, `is:attached`, graph chip). |

Whether DAEX may remove a folder is decided by its path (a direct child of
`.ade/worktrees`), never by lane type. `ensurePrimaryLane()` creates the main
checkout lane on project open. `repairLegacyPrimaryBaseRootLanes` and
`repairDuplicateManagedWorktreeLanes` (keeps the row whose id matches the
folder suffix, re-points sessions and Linear links first) run inside every
`lanes.list`.

## Every git worktree is a lane

`listLanes` reconciles rows against one `git worktree list --porcelain` call on
every `lanes.list`, before the 10 s cache check.

- **Adopt** (`recoverManagedWorktreeRows`): every worktree of the repo with no
  lane row becomes a `worktree` lane, wherever it lives. Skipped: bare repos,
  the main checkout, detached HEADs, `prunable` worktrees, pending creations,
  and anything registered by path or branch.
- **Ownership scope** (`resolveWorktreeOwnershipScope`): a project root that
  is itself a linked worktree owns only worktrees under its own
  `.ade/worktrees`; a root checkout owns the whole repo. An unclear probe
  scopes down and is not cached. So project B never adopts (and so never
  deletes) project A's worktree.
- **Realpath space:** git answers with resolved paths (`/private/tmp` vs
  `/tmp` on macOS), so the reconcile canonicalizes paths and matches rows under
  both spellings. Residual cleanup errs toward skipping.
- **Reap** (`removeVanishedWorktreeLanes`): deletes the row of a non-primary,
  non-archived lane only when the path is absent from `git worktree list`
  *and* the folder does not exist, the listing succeeded and includes the repo
  root, no create/delete/reclaim is in flight, and (for a linked-worktree root)
  the path is under its own `.ade/worktrees`. It uses `cleanupLaneDatabaseRows`
  and removes the lane's proof files after commit; it never removes a folder.

The CLI resolves a linked checkout outside `.ade/worktrees` back to its parent
project when the parent's database records it as a lane.

A caller that must see a lane for a path it just learned about awaits
`lanes.list({ includeStatus: false })`; there is no separate register call.
Adopt and reap call `invalidateLanePathCaches()`, which also drops the 10 s
`project.inspectPath` cache. Every lifecycle mutation calls it.

## Lane status

`LaneStatus` (`shared/types/lanes.ts`) carries `dirty`, `ahead`, `behind`,
`remoteBehind`, file counts (`changedFileCount`, `staged`, `unstaged`,
`untracked`), `lastCommitAt`, `trackedFileCount`, `rebaseInProgress` and
`headBranchRef`. `computeLaneStatus` reads one `git status --porcelain=v2
--branch --untracked-files=normal -z` (whose `# branch.head` gives the live
branch, so drift costs nothing extra) and one `git log -1`. `git ls-files -z`
runs only for a new tree hash (cached ten minutes, capped at 200 trees; a
truncated listing is not cached).

A full refresh fans out to many git processes (about 130 on a 14-lane
checkout). The 12-process ceiling in `runGit` and the repo-scoped cache keep it
bounded. See
[Architecture › Process budget](../../ARCHITECTURE.md#92-process-budget-concurrency-ceiling-and-the-repo-scoped-cache).

The renderer re-reads a lane's status when it is older than 30 s (after a
status-less list, when a surface becomes active, when History opens) and shows
it as stale until then. A lane read through another machine's pin keeps that
machine's numbers.

`LaneSummary` adds `branchDrift`, `tags`, `color`, `icon` (holds the emoji),
`folder`, `devicesOpen` (presence from `syncHostService`, 60 s expiry, 30 s
heartbeat), `linearIssue` and `linearIssueLinks` (see
[Linear](../linear-integration/README.md)), and `jiraIssueLinks` (see
[Issues](../issues/README.md#jira-issues-on-lanes-and-chats)).

## Lane lifecycle

1. **Create** (`laneService.create`): resolves the start, makes worktree and
   branch, returns the resolved ref, commit, copied files and notes.
2. **Existing branch** (`importBranch`): opens a branch in a managed worktree.
3. **Rename / appearance**: metadata only.
4. **Archive**: `stopLaneRuntimeWork` stops chats, PTYs and watchers *before*
   the status write, because callers release the port lease and proxy route
   (`releaseLaneRuntimeResources`) as soon as archive resolves. Each stop step
   is best effort (`lane_runtime_teardown.step_failed`). The folder stays.
   `archiveLaneCore` then archives the lane's chats, CLIs and shells with the
   lane's own `archived_at` (`archiveSessionsForLane`); unarchive clears only
   rows with that stamp, so a chat archived on its own stays archived.
5. **Archive and free up space** (`archiveAndReclaim`, typed confirmation):
   keeps row, branch and chats; removes only the managed worktree and lane pack
   data after checking git's registry matches the saved path and branch, and
   rechecking symlinks and identity. Refuses the main checkout, paths outside
   `.ade/worktrees` (`worktree_outside_managed_root`), symlinks, and dirty work
   without the override. Holds the worktree lease. See
   [Storage and recovery](../storage-and-recovery/README.md) for the automatic
   rules.
6. **Unarchive**: restores in place if the folder exists; otherwise recreates
   it inside `.ade/worktrees` from the kept branch (local, else
   `origin/<branch>`). Refuses occupied or differently registered paths.
7. **Folder vanished on an active lane**: before the next chat turn,
   `agentChatService.sendMessage` calls `recreateMissingWorktree`. Only for a
   non-primary, non-archived lane inside `.ade/worktrees`, not via a symlink,
   from the **local** branch only, and not when that branch is checked out
   elsewhere. Clears the stale registration with a path-scoped `git worktree
   remove --force <path>`, never a repo-wide prune. Posts a notice that
   uncommitted changes are gone.
8. **Delete** (`delete({ laneId, deleteBranch?, deleteRemoteBranch?,
   remoteBranchName?, force? })`): emits `lanes.delete.event` per step:
   `git_status` → `stop_ptys` → `stop_watchers` → `cleanup_env` →
   `git_worktree_remove` → `git_branch_delete` → `git_remote_branch_delete` →
   `pack_dir_remove` → `database_cleanup`, then one `lane-deleted` lifecycle
   event. Missing optional services mark a step `skipped`. The worktree-mutation
   guard is held only during `git_worktree_remove`. `database_cleanup` runs in
   one `begin immediate` transaction and *detaches* PR rows
   (`detachPullRequestRowsForLane`, before the session/artifact deletes because
   it counts them). Proof files owned by the lane are removed (realpath-confined
   to `.ade/artifacts`; a capture also owned by another lane's chat survives).
   `getDeleteRisk` is the preflight. `lane.delete` through `daex actions run`
   takes the same path.

### Reserved ids, checkout progress, cancellation

`create(args, runtimeOptions)` takes options only in-process callers (chat
launch) pass: `laneId` (a UUID through `requireNormalizedUuid`; fixes the path
`<worktreesDir>/<slug>-<laneId[0:8]>`), `onCheckoutProgress` (parsed from
`Updating files: NN% (n/m)`, with `GIT_PROGRESS_DELAY=0` and
`GIT_ENGLISH_MESSAGES_ENV`; not `LC_ALL`, which would break UTF-8 hooks), and
`signal`. Aborted before git ran, nothing is cleaned up; aborted mid-checkout,
`cleanupCreatedWorktreeLaneAfterCreateFailure` removes the worktree and new
branch. `cleanupReservedWorktree` clears a failed checkout at a reserved path
(only when no row owns it); `findLaneIdentity` lets a launch adopt a lane whose
create inserted the row but never returned.

### Stopping a lane git write

A stuck checkout blocks every create, import and delete behind the
worktree-mutation guard.

- **No progress:** checkouts print progress; `runGit` stops one after 2
  minutes of silence (`GIT_TREE_WRITE_IDLE_TIMEOUT_MS`), before the 15-minute
  bound, and cleans up like a cancel. `worktree remove` prints nothing and
  keeps only the 15-minute bound.
- **Cancel / Stop:** `create`, `importBranch`, `switchBranch` and
  `git.checkoutBranch` take an `operationId`; `cancelGitWrite({ operationId })`
  stops it (refused once the checkout is done). `cancelDelete(laneId)` works
  while `LaneDeleteProgress.cancellable` is true; the lane row stays. Both go
  to the lane's machine; the web client uses the `lanes.cancelGitWrite` and
  `lanes.cancelDelete` sync commands.

On macOS and Linux, stopping git does not stop a hook's children; DAEX returns
after 5 s. `removeUnownedWorktreeAndBranch` uses `git worktree remove --force
--force` (removes a worktree locked "initializing"), then falls back to deleting
the folder and `worktree unlock` + `prune`, retrying EBUSY/EPERM/EACCES/ENOTEMPTY
for about 5 s.

### Deleting a lane removes the worktree

A checkout under `.ade/worktrees` is removed from disk. A checkout elsewhere is
removed only while git still registers it as the worktree root; otherwise the
row goes and `DeleteLaneResult.leftoverWorktree` names the folder, which the
desktop offers to reveal or delete (refusing the project root, symlinks, a path
git registered again, or a replaced directory, checked with a hidden token).
The offer remembers its project (a pin, or an exact local root) and survives a
runtime restart. An external worktree whose `.git` file is gone is repaired with
`git worktree repair`, never pruned.

Rails before `git worktree remove`: never the project root, the main checkout
or `.ade/worktrees` itself; no symlink in a managed path
(`hasSymlinkInManagedPath`); the dirty check and `--force` flow as usual.

Inside `.ade/worktrees`, a failed removal falls back to deleting the folder and
`git worktree prune`; if that fails too, the delete completes with a warning and
`worktreeResidualCleanup` retries later.

**Windows:** a registered checkout is renamed aside to
`.<name>.ade-deleting-<8 hex>`, pruned, and removed in the background, so the
guard is released at once instead of waiting on a slow `node_modules` walk. If
the rename fails, the normal path runs; if git still lists the worktree, the
folder moves back. Leftover renamed folders are swept unless their `.git` still
points at a live admin dir.

Every whole-folder removal runs in a child process (`removeTreeOffProcess`), on
every OS: a recursive `fs.rm` in the brain blocks its shared I/O threads (one
190,000-file folder stalled a Windows brain for 30 s). The child never follows
links and refuses a path whose real location changed.

A delete of a lane on another machine answers once its checks pass
(`DeleteLaneArgs.background`) and the machine finishes it; the window follows
`lane.listDeleteProgress`. A repeated delete joins the running one; a gone lane
answers `alreadyDeleted`. When the remote branch delete is not required
(`requireRemoteBranchDelete`), it runs after the lane is gone and retries after
1 and 5 minutes while the remote still holds the saved commit.

### What a deleted lane leaves behind

`cleanupLaneDatabaseRows` writes one `lane_usage_tombstones` row before the
cascade, inside the same transaction, so lifetime stats on the Usage page are
not survivor stats. It holds only counters (sessions, files, insertions,
deletions, commits, pushes, PR landings, artifacts, longest session), created
and deleted days, and an active-day bitmap: no text, paths or names.
`tombstoneMode`: `deleted` (default, also for reaps), `absorbed` (duplicate
dedupe; not counted as created), `none` (create rollback). Artifacts use
`LANE_OWNED_ARTIFACT_IDS_SQL`, the same predicate as the delete. See
[Usage tracking](../onboarding-and-settings/usage-tracking.md).

## Lane color and emoji

`color` is a hex from `laneColorPalette.ts` (12 classic, 7 rainbow;
`LANE_FALLBACK_COLORS` for lanes without one). `laneService.updateAppearance`
rejects a color another active lane in the project uses; pickers pre-filter
with `colorsInUse`, and new lanes get `nextAvailableColor`. iOS mirrors the
palette.

One emoji per lane, stored in the existing `lanes.icon` CRR column (no new
replicated column; legacy icon names map to emoji), trimmed, NFC-normalized and
checked as one grapheme. `daex lanes appearance <lane> --emoji 🐛` sets it;
`--emoji ""` clears it. During manual creation, Jev suggests one from 69
choices (`shared/laneEmoji.ts`) 1.2 s after the name settles, shown at
confidence 0.5 or higher; Tab or click accepts. Agent, CLI and auto-created
lanes get no suggestion.

## Auto-created lane names

Auto-create (desktop `startBackgroundLaneNaming` in `AgentChatPane`, phone
`WorkNewChatScreen.swift` and `HubComposerDrawer.swift`) creates the lane at
once with a deterministic name (`shared/laneNameFallback.ts`: stopwords removed,
whole clauses, at most five words, no canned phrases) on the placeholder
branch, starts the session, then asks the host for one AI lane/branch identity
(`agentChatService.generateAutoLaneIdentity`; phone via the non-queueable
`lanes.suggestName` sync command). The host renames the branch only while the
lane, worktree, upstream and PR state prove it safe. Collisions check live
lanes, `pull_requests.head_branch` (including detached rows) and
`github_pr_projections.head_branch`; a manual rename wins over a late result.
Naming never blocks or fails a launch.

## Branch switching inside a lane

The branch picker lists the lane's open chats and terminals (with machine and
status) and offers wait, stop and switch, switch anyway, or cancel. Stop and
switch waits for the host to confirm process trees exited. `lane_branch_profiles`
remembers per-(lane, branch) `base_ref`, `source_branch_ref` and last checkout.

| Method | Purpose |
|--------|---------|
| `listBranchProfiles(laneId)` | Profiles plus the active branch. |
| `listBranchHistory()` | Every `(laneId, branchRef)` an active lane used, for PR matching (`prService.autoLinkLaneBranchHistory`). |
| `previewBranchSwitch(args)` | Dirty probe, duplicate owner, active work, base inference. |
| `switchBranch(args)` | Refuses dirty trees and duplicate owners, needs `acknowledgeActiveWork` with live work, checks out, updates the row and profile. PR rows stay on the lane. |
| `updateBranchRef(laneId, branchRef)` | Keeps the profile and `branch_ref` in sync; emits `lane-branch-updated`. |

IPC: `ade.lanes.listBranchProfiles`, `.previewBranchSwitch`, `.switchBranch`.
iOS: `LaneBranchPickerSheet.swift` through the sync commands
`branchProfiles.list`, `branchSwitch.preview`, `branchSwitch.commit`. `daex git
checkout <branch>` uses the same service and guards.

## Branch drift

A raw `git checkout` in the worktree leaves `lanes.branch_ref` behind. That is
drift. While drifted, the session card and PR pane match PRs by the checked-out
branch (`branchDrift.headBranchRef`); the create form still names `branchRef`,
since opening a PR pushes the recorded branch.

Types (`shared/types/lanes.ts`): `LaneBranchDrift` `{ expectedBranchRef,
headBranchRef, kind? }`; `LaneBranchDriftKind` `"switched" | "renamed" |
"missing"` (absent means `switched`); `ResolveLaneBranchDriftArgs` `{ laneId,
resolution: "switch-back" | "keep-head", expectedHeadBranchRef?,
acknowledgeActiveWork? }`.

- **Detection** rides the status refresh; no extra spawn, no timer. Unknown
  sides (detached HEAD, unavailable worktree) mean no drift.
- **Renamed vs missing** runs only while drifted: `git show-ref --verify` on
  the recorded branch; if gone, the reflogs are searched for `Branch: renamed
  refs/heads/<old> to refs/heads/<new>`, following chains. Unclear cases fall
  back to `switched`. The verdict is memoized, the ref's existence is not.
- **`getBranchDrift({ laneId })`** is a fresh read for callers about to act.
- **`resolveBranchDrift(args)`** re-reads HEAD and refuses a stale
  `expectedHeadBranchRef`. `switch-back` delegates to `switchBranch` (refused
  for `renamed`/`missing`). `keep-head` re-points `branch_ref` in one
  transaction, never renames the lane, and refuses when another lane owns the
  branch.
- **Agents move the lane with them.** `agentChatService` records the branch at
  turn start (`noteLaneBranchTurnBoundary`) and at turn end calls
  `adoptAgentBranchSwitch`, which runs `keep-head` with `adoptedByAgent`. It
  refuses (and the chip asks) for the main checkout, a lane already off its
  branch at turn start, an old branch with commits on neither the new branch
  nor any remote, or a branch another lane owns. Logged as
  `lane.agent_branch_adopted` / `lane.agent_branch_not_adopted`. A switch you
  make in a terminal is never adopted.
- **UI is arm-on-act.** `LaneBranchDriftChip` sits in `WorkSurfaceHeader`.
  `LaneBranchComposerChip` appears above the composer only after
  `armLaneBranchDriftWarning` (from `AgentChatPane.submit` and
  `ChatGitToolbar`'s PR button), reads HEAD fresh, and offers Switch back /
  Keep, or a single **Update lane** for `renamed`/`missing`. After an agent
  adoption it shows `Now on <branch> · Switch back` for ten minutes. It follows
  the composer's effective launch target, so an auto-create draft or another
  machine's lane shows no chip.
- **Reach:** IPC `ade.lanes.getBranchDrift` / `.resolveBranchDrift`; sync
  commands `lanes.getBranchDrift` / `lanes.resolveBranchDrift`
  (`syncRemoteCommandService.ts`).

## IPC surface

Lane calls are `lane` domain runtime actions, with legacy IPC handlers in
`main/services/ipc/registerIpc.ts` for the unbound path. Channel names keep the
`ade.` prefix (frozen identifiers).

| Channel | Notes |
|---------|-------|
| `ade.lanes.list`, `.create`, `.importBranch` | `create` without `start` uses the defaults; `start: { from: "branch", branch, on: "uncommitted" }` copies a lane's uncommitted changes. |
| `ade.lanes.rename`, `.updateAppearance`, `.archive`, `.delete` | Edits. |
| `ade.lanes.reclaim.risk`, `.archiveAndReclaim`, `.unarchive` | Free up space and restore (also `lane.getReclaimRisk`, `lane.archiveAndReclaim`, `lane.unarchive`). |
| `ade.lanes.delete.risk`, `.delete.cancel`, `.delete.event`, `.delete.progress.list` | Delete preflight, cancel, progress stream, replay of running deletes. |
| `ade.lanes.cancelGitWrite` | Stop a create/import/switch checkout by `operationId`. |
| `ade.lanes.lifecycle.event` | `lane-created`, `lane-renamed`, `lane-branch-updated` (refresh only), `lane-archived`, `lane-reclaimed`, `lane-unarchived`, `lane-restored`, `lane-deleted`, and `lanes-invalidated` (re-read the set; its lane id is the placeholder `LANES_INVALIDATED_LANE_ID`, so nothing may name a lane from it). Runtime paths push `lane_lifecycle_event`; preload merges both behind `onLifecycleEvent`. |
| `ade.lanes.linkLinearIssues`, `.unlinkLinearIssues`, `.attachLinearIssueToSession`, `.detachLinearIssueFromSession`, `.listLinearIssuesForSession`, `.listLinearIssuesForLaneSessions` | Linear links on lanes and sessions. |
| `ade.lanes.getBranchDrift`, `.resolveBranchDrift` | See [Branch drift](#branch-drift). |
| `ade.lanes.rebaseStart`, `.rebaseAbort`, `.rebaseRollback`, `.rebasePush` | Rebase runs. |
| `ade.git.mergeBaseIn` | See [Compare base and Catch up](#compare-base-and-catch-up). |
| `ade.lanes.initEnv`, `.getEnvStatus`, `.getOverlay`, `.env.event`, `.templates.*`, `.port.*`, `.proxy.*`, `.oauth.*`, `.diagnostics.*` | Runtime isolation; see [runtime.md](./runtime.md). |

Environment setup from any entry point goes through `runLaneEnvironmentSetup`;
add behavior there. Lane sharing has no owner-side IPC: `window.ade.laneShare.*`
takes the lane's pin and calls the user-only `lane_share` domain; the guest's
account calls (`ade.laneShareGuest.*`) go to the account directory with no pin.

## Renderer wiring

`LanesPage` renders `LaneSidebarList` through `ProjectSidebarSlot`. The main
area shows the selected lane: `LaneDashboard` and `LaneGitActionsPane`, split
by `LaneSplitBody`. There are no lane tabs. Lane lists refresh from lifecycle
events (`useLaneListInvalidation`: clear coalescing, debounce, one delayed
follow-up), not polling. Action deep links (`action=batch`) run first and then
strip `action`, `laneId` and `laneIds` from the URL. `appStore` keeps
`laneDeleteProgressByLaneId` across remounts and restores cached lane state on
warm tab switches; `refreshLanes` drops stale responses by version token.

## Shared git engine

Every lane service reaches git through `main/services/git/`:

- `git.ts`: `runGit` adds the `-c` overrides from `gitReadEnv.ts` (so personal
  config like `status.showUntrackedFiles=no` cannot change what DAEX reads) and
  `GIT_TERMINAL_PROMPT=0`. Lane checkouts and `worktree add`/`remove` get 15
  minutes, lane fetches 5 (`gitTimeouts.ts`); lane write actions wait longer
  (`LANE_GIT_WRITE_ACTION_TIMEOUT_MS`). The Fetch button and Sync keep 60 s.
  Paths are read with `-z`, branches from full `refs/heads/` refs. Holds the
  12-slot read semaphore and invalidates the repo cache after ref-changing
  commands.
- `gitRepoCache.ts`: keyed by common git dir; 1.5 s for ref SHAs, 5 minutes
  for config-shaped answers; single-flight, epoch-guarded.
- `gitTransportAuth.ts`: GitHub sign-in for push/fetch/pull/`ls-remote`. See
  [Pull requests › GitHub connectivity model](../pull-requests/README.md#github-connectivity-model).
