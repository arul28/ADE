# Lanes

A lane is DAEX's unit of parallel work: one git branch in its own worktree
folder, with its own chats, terminals, ports, proxy hostname, OAuth callbacks,
environment setup and health checks. The project's own folder is the primary
lane. Its stored name is "Primary"; every screen calls it **Main checkout**
through `laneDisplayName(lane)` (`apps/desktop/src/shared/laneDisplayName.ts`).
Write new copy as "main checkout", and never change the stored name or
`laneType: "primary"`.

Commands use `daex`; `ade` still works.

Detail docs:

- [worktree-isolation.md](./worktree-isolation.md): worktree mechanics, per-lane state, saved work after a delete.
- [runtime.md](./runtime.md): environment setup, templates, ports, proxy, preview, diagnostics, main checkout packages.
- [oauth-redirect.md](./oauth-redirect.md): OAuth callback routing across lanes.
- [lane-sharing.md](./lane-sharing.md): sharing one lane with another DAEX account.

## Source file map

Services live in `apps/desktop/src/main/services/lanes/`; the brain
(`daex serve`, `apps/ade-cli/src/bootstrap.ts`) runs them, and desktop main
uses them only where no runtime is bound.

| File | Owns |
|---|---|
| `laneService.ts` | Lane CRUD, worktree lifecycle, status, rebase, branch switching, drift, issue links, archive, delete, the worktree reconcile. |
| `laneStartResolver.ts`, `laneCompareBase.ts` | Start choice → ref and commit; the compare base. |
| `laneBranchNaming.ts` | Branch pattern, typed-name clash checks, auto-create placeholder and rename, Rename branch. |
| `laneBranchDrift.ts`, `laneBranchHistory.ts` | Drift detection; HEAD-reflog branch history for PR matching. |
| `laneBuiltOnMerged.ts` | Replay boundary for a lane built on squash-merged work. |
| `defaultBranchAutoPull.ts` | Fast-forwards the main checkout's default branch. |
| `laneFolderRemoval.ts`, `worktreeResidualCleanup.ts`, `laneWorktreeNaming.ts` | Safe folder removal (Windows move-aside), residual retries, managed folder names (`<slug≤40>-<laneId[0:8]>`). |
| `laneWorktreeLockService.ts` | Database lease for worktree-mutating operations. |
| `deletedLaneSnapshots.ts` | What a delete or discard would lose, kept as git refs for 30 days. |
| `laneUsageTombstone.ts` | Counters a deleted lane leaves for lifetime stats. |
| `laneEnvironmentService.ts`, `laneEnvironmentSetup.ts`, `laneEnvironmentProcesses.ts`, `laneEnvInitMerge.ts`, `laneOverlayContext.ts`, `setupScriptConfig.ts` | Environment setup; `runLaneEnvironmentSetup` is the one entry point. |
| `laneTemplateService.ts`, `laneDependencyStatus.ts` | Templates; main checkout package status. |
| `portAllocationService.ts`, `laneProxyService.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts` | Ports, `*.localhost` proxy, OAuth, health ([runtime.md](./runtime.md)). |
| `laneLaunchContext.ts` | Launch cwd/env for terminals and tools, kept inside the worktree. |
| `laneListSnapshotService.ts` | Lane snapshots with presence, conflict status, session counts. |
| `laneShareRightsStore.ts` | Host-side rights and guest counters of lane shares. |

Elsewhere: `adeActions/registry.ts` (`lane.*` actions),
`adeCloud/cloudComputerLaneHold.ts` + `cloudComputerRules.ts` (one lane per
cloud computer), `git/` ([Shared git engine](#shared-git-engine)),
`prs/pullRequestRowCleanup.ts`, `config/laneOverlayMatcher.ts`,
`shared/removeTreeOffProcess.ts`. Shared: `apps/desktop/src/shared/laneStart.ts`,
`laneBranchName.ts`, `laneBaseResolution.ts`, `laneDisplayName.ts`,
`laneNameFallback.ts`, `laneEmoji.ts`, `uuid.ts` (`requireNormalizedUuid`),
`types/lanes.ts`.

Renderer (`apps/desktop/src/renderer/`):

| File | Owns |
|---|---|
| `components/lanes/LanesPage.tsx` | Page, selection, deep links, branch switch dialog. |
| `components/lanes/useLanesPageMachines.ts`, `state/laneMachineRouting.ts`, `state/projectMachines.ts` | One lane list across machines; fail-closed routing (`resolveLaneTarget`). |
| `components/lanes/sidebar/` | Sidebar list, rows, Computer filter, bulk menus. |
| `components/lanes/overview/` (`LaneDashboard.tsx`, `LaneGitActionsPane.tsx`, `LaneDiffPane.tsx`) | Lane detail, git actions, diff. |
| `components/lanes/RestingCloudLaneDetail.tsx` | An asleep DAEX Cloud lane. |
| `components/lanes/LaneCatchUpMenu.tsx`, `laneCatchUp.ts` | Catch up. |
| `components/lanes/LaneBranchDrift.tsx` | Drift chips. |
| `components/lanes/CreateLaneDialog*.tsx`, `LaneStartPicker.tsx`, `lib/pendingLaneCreates.ts` | New lane dialog; background create against the binding fixed at submit. |
| `components/lanes/ManageLaneDialog.tsx`, `LaneContextMenu.tsx`, `laneContextMenuItems.tsx` | Manage/archive/delete; `buildLaneMenuGroups`, the one action inventory (shared with Work). |
| `components/lanes/lanePageModel.ts` | `selectLanePrs` / `selectChatPrs` ([PRs](../pull-requests/README.md#lane-surfaces-and-chat-surfaces-need-two-different-selectors)). |
| `hooks/useLaneListInvalidation.ts`, `lib/laneReadCache.ts`, `lib/laneDeleteProgress.ts` | Event-driven refresh, read coalescing, delete progress. |
| `components/laneShare/` | Lane sharing UI (owner; `guest/` for the guest). |

iOS: `apps/ios/ADE/Views/LanesTabView.swift` and `Views/Lanes/` (list, create,
detail, `LaneDetailGitActionsPane` as the git surface, manage, branch picker,
recently deleted, `LaneDeeplinkHelpers` minting `daex://lane/<id>`).

## Gotchas and fragile areas

- **Half-created worktrees must stay invisible to the reconcile.** A worktree is in `git worktree list` before its lane row exists. `createWorktreeLane` and `importBranch` hold `trackPendingWorktreeCreation` across that window. Any new code that runs `git worktree add` and then inserts a lane must do the same. The lanes table is a CRR, so no unique index can enforce it; `repairDuplicateManagedWorktreeLanes` dedupes leaks.
- **A lane row can disappear without a delete.** The reconcile reaps lanes whose worktree is gone from git and disk. Code that removes a folder temporarily must hold a pending marker or archive the lane first.
- **Deleting a lane detaches its PRs, it does not delete them** (`pullRequestRowCleanup.ts`). A branch switch keeps previous-branch PRs on the lane. Lane-scoped queries on `pull_requests` add `detached_at is null`. See [Detached PR rows](../pull-requests/README.md#detached-pr-rows).
- **`LaneListSnapshot.adoptableAttached` must keep being emitted** (always `false`): shipped iOS builds decode it as a required `Bool`.
- **Main checkout protection** (`is_edit_protected = 1`) is enforced in `laneService`, not the database. It cannot be renamed or deleted.
- **Repair runs on every `lanes.list`.** A new drift-prone field needs a repair routine.
- **Lane list cache** is 10 s (`LANE_LIST_CACHE_TTL_MS`); pass `refresh: true` after a git operation.
- **The git repo cache is keyed by common git dir** and by the question (`rev-parse:<cwd>:<ref>`), never the caller. Invalidation lives in `runGit` and fires on failure too; git spawned another way relies on the 1.5 s TTL. A new ref-changing verb goes into `REF_AFFECTING_GIT_VERBS`.
- **Mutations bypass the 12-slot git semaphore** on purpose (some run for minutes).
- **Worktree paths stay absolute.**
- **Every lane action carries the lane's pin.** Unroutable lanes fail closed; lane ids can repeat across machines, so selection uses machine id plus lane id.
- **Open in is one inventory** (`buildLaneMenuGroups`); do not add a second editor picker.

## Starting a lane

Every lane except the main checkout is its own worktree; git allows a branch
in one folder at a time.

- **Create new branch.** The branch follows the lane name through the project pattern until typed; a Linear issue fills it with the issue's branch name. Typed names are checked on the lane's machine against local and remote branches (case-insensitive).
- **Start from** the default branch, the main checkout's branch or another branch, **On** Remote (fetch first), Local (unpushed commits included), or **Bring my uncommitted changes from <lane>** (copies staged, unstaged and untracked changes; the source is untouched).
- **Use existing branch** opens a branch not checked out elsewhere.
- A repository with no commits is refused with "Make a first commit, then create a lane."

### Branch names

The pattern (Settings › Lanes › New lanes › Branch names) defaults to
`ade/{slug}` (`DEFAULT_LANE_BRANCH_PATTERN`); the `ade/` prefix is kept for
compatibility with existing branches and PRs. `{slug}` must come last; `{user}`
is git `user.name`, slugged.

Auto-create lanes start on a placeholder `<prefix><8 hex>` marked with git
config `branch.<name>.adeautolane`, then the AI rename gives
`<prefix><title slug>` only while the branch is unpushed and has no PR.
**Rename branch…** (`lane.renameBranch`) has the same limits.

### New-lane defaults

Stored per account and repository (on this computer when the repo has no
remote): start, branch pattern, template. `daex lanes defaults --text` shows
them; `daex lanes defaults set --from <branch>` / `--branch-pattern` change
them. `daex lanes create` from an agent shell uses the shell's project
(`ADE_PROJECT_ROOT`) unless `--project-root` is given, and pushes the new branch
with upstream tracking, best effort.

### Compare base and Catch up

A lane compares against its open PR's base, else the default branch
(`origin/<base>` when the local base trails it); the main checkout compares to
its upstream. **Catch up** (`LaneCatchUpMenu.tsx`, rules in
`laneCatchUpOptions`):

- **Ask an agent** (default): fills a chat draft in the lane, never sends.
- **Rebase now**: only clean, not mid-operation, no predicted conflict, never pushed. `lanes.rebaseStart` with `pushMode: "none"`.
- **Merge <base> in**: same rules, pushed or not. `git.mergeBaseIn` (`daex git merge --lane`) aborts and throws on any failure.

A lane on another machine has no conflict scan, so both direct ways undo
themselves on conflict. Every read and write goes to the lane's machine.

## Where this runs

Lane lifecycle runs in the project's brain. `window.ade.lanes.*` goes through
preload to the bound runtime; for a remote binding the worktree, git and
processes live on the remote host.

### Lanes across machines

- The create dialog offers every machine that can host the repo. Creating elsewhere does not rebind the tab.
- The Lanes tab lists every machine's lanes. The Computer filter (`LaneFilterPanel.tsx`) has one entry per own computer, one **DAEX Cloud** entry, and **All**; offline own computers are hidden, asleep cloud computers are not.
- A cloud lane whose computer was deleted uses machine id `ade-cloud-deleted`, so every action refuses it.
- Mixed batch selections are split by owner.

### An asleep DAEX Cloud lane

Opening it never wakes the computer (`RestingCloudLaneDetail.tsx`): Git info
comes from `adeCloud.projectOverview` and changed files from the account
(`renderer/state/adeCloudRestingReads.ts`), read once. **Wake to run** is the
only control that wakes it.

<a id="one-lane-per-ade-cloud-computer"></a>
### One lane per DAEX Cloud computer

Each DAEX Cloud computer holds one lane across all projects (archived counts;
the main checkout does not). A lane started on DAEX Cloud gets a new computer
([DAEX Cloud lanes](../chat/README.md#daex-cloud-lanes)); deleting the lane
deletes it ([lifecycle](../ade-cloud/README.md#the-life-of-a-lanes-computer)).

- Checked in `laneService.ts` wherever a lane row comes to exist (`create`, `importBranch`, adoption), again under the write lock.
- Other projects' lanes are read through `cloudComputerLaneHold.ts`; an unreadable database counts as holding a lane. Concurrent creates use `cloud-computer-lanes.lock` and a claim file.
- The rule applies when `cloudComputerLaneRuleApplies` (`ADE_CLOUD_INSTANCE_ID`, or the template's entrypoint file).
- Refusal: `CloudComputerLaneLimitError` with the sentences in `cloudComputerRules.ts`; `chat.startLaunch` refuses early.
- Not refused: the launch's first lane, moved chats, unarchive, rename, a retried launch, restoring a deleted lane on an empty computer.

## Default-branch auto-pull

`defaultBranchAutoPull.ts` runs in the brain 20 s after the project opens,
then every five minutes, plus once after DAEX merges into the default branch.
Fast-forward only, and only when the main checkout is attached on the default
branch with no tracked changes, no operation in progress, no held lease, and
an upstream. Skips and failures are silent.

## Lane types

| Type | Folder | Use |
|---|---|---|
| `primary` | The repo root | The main checkout; always exists. |
| `worktree` | Any worktree of the repo (`.ade/worktrees/<name>/` when DAEX made it) | Every other lane. |
| `attached` | External path | Legacy; never written, behaves like `worktree`. |

Whether DAEX may remove a folder is decided by its path (a direct child of
`.ade/worktrees`), never by lane type.

## Every git worktree is a lane

`listLanes` reconciles rows against one `git worktree list --porcelain` on
every `lanes.list`, before the cache check.

- **Adopt** (`recoverManagedWorktreeRows`): every worktree with no lane row becomes a `worktree` lane, except bare repos, detached HEADs, prunable worktrees and pending creations.
- **Ownership scope** (`resolveWorktreeOwnershipScope`): a project root that is itself a linked worktree owns only worktrees under its own `.ade/worktrees`, so project B never adopts (and deletes) project A's worktree.
- Paths are compared in realpath space (`/private/tmp` vs `/tmp`).
- **Reap** (`removeVanishedWorktreeLanes`): only a non-primary, non-archived lane absent from git *and* disk, with a good listing and nothing in flight. It never removes a folder.

A caller that must see a lane for a new path awaits
`lanes.list({ includeStatus: false })`.

## Lane status

`computeLaneStatus` reads one `git status --porcelain=v2 --branch -z` (its
`# branch.head` gives drift for free) and one `git log -1`; `git ls-files` runs
only for a new tree hash. A full refresh can spawn ~130 git processes on 14
lanes, bounded by the 12-process ceiling and repo cache
([Architecture › Process budget](../../ARCHITECTURE.md#92-process-budget-concurrency-ceiling-and-the-repo-scoped-cache)).
The renderer re-reads status older than 30 s.

`LaneSummary` adds `branchDrift`, `tags`, `color`, `icon` (the emoji),
`devicesOpen`, Linear and Jira links
([Issues](../issues/README.md#jira-issues-on-lanes-and-chats)).

## Lane lifecycle

1. **Create** / **Existing branch** (`create`, `importBranch`).
2. **Archive**: `stopLaneRuntimeWork` stops chats, PTYs and watchers *before* the status write, because callers release ports and proxy routes as soon as archive resolves. The lane's sessions are archived with the lane's stamp; unarchive clears only that stamp.
3. **Archive and free up space** (`archiveAndReclaim`): removes only the managed worktree and pack data after verifying git's registry; refuses the main checkout, paths outside `.ade/worktrees`, symlinks, and dirty work without override. See [Storage and recovery](../storage-and-recovery/README.md).
4. **Unarchive**: restores in place, or recreates the worktree from the kept branch.
5. **Folder vanished on an active lane**: `recreateMissingWorktree` before the next chat turn, from the local branch only, with a path-scoped `git worktree remove --force`, never a repo-wide prune.
6. **Delete** (`delete({ laneId, deleteBranch?, deleteRemoteBranch?, force? })`): steps `git_status` → `stop_ptys` → `stop_watchers` → `cleanup_env` → `git_worktree_remove` → `git_branch_delete` → `git_remote_branch_delete` → `pack_dir_remove` → `database_cleanup`, each emitted on `lanes.delete.event`. `database_cleanup` is one transaction that detaches PR rows (before session deletes, because it counts them) and removes lane-owned proof. `getDeleteRisk` is the preflight.

### Reserved ids, checkout progress, cancellation

In-process callers (chat launch) can pass `laneId` (a UUID; fixes the folder
path), `onCheckoutProgress` (parsed from git's `Updating files: NN%`), and an
abort `signal`. An abort mid-checkout removes the worktree and new branch.
`findLaneIdentity` lets a launch adopt a lane whose create inserted the row but
never returned.

- A checkout silent for 2 minutes is stopped (`GIT_TREE_WRITE_IDLE_TIMEOUT_MS`), under a 15-minute bound.
- `create`, `importBranch`, `switchBranch` and `git.checkoutBranch` take an `operationId`; `cancelGitWrite({ operationId })` stops one. `cancelDelete(laneId)` works while `cancellable`.

### Deleting a lane removes the worktree

A checkout under `.ade/worktrees` is removed from disk; one elsewhere only
while git still registers it, else `DeleteLaneResult.leftoverWorktree` names
the folder for the user to reveal or delete. Never the project root, the main
checkout or `.ade/worktrees` itself, and never through a symlink.

- A failed removal falls back to deleting the folder and pruning; then `worktreeResidualCleanup` retries later.
- **Windows:** the folder is renamed aside (`.<name>.ade-deleting-<hex>`), pruned and removed in the background.
- Every whole-folder removal runs in a child process (`removeTreeOffProcess`): a recursive `fs.rm` in the brain blocked its I/O threads for 30 s on a large folder.
- A delete on another machine answers once its checks pass (`background`) and the window follows `lane.listDeleteProgress`.

### What a deleted lane leaves behind

`cleanupLaneDatabaseRows` writes one `lane_usage_tombstones` row inside the
delete transaction: counters only (sessions, files, insertions, deletions,
commits, pushes, PR landings, artifacts), days and an active-day bitmap; no
text, paths or names. `tombstoneMode` is `deleted`, `absorbed` (dedupe) or
`none` (create rollback). See [Usage tracking](../onboarding-and-settings/usage-tracking.md).

## Lane color and emoji

`color` comes from `laneColorPalette.ts`; `updateAppearance` rejects a color
another active lane uses. One emoji per lane in the `lanes.icon` column
(validated as one grapheme); `daex lanes appearance <lane> --emoji 🐛`. Manual
creation may suggest one via Jev.

## Auto-created lane names

Auto-create creates the lane at once with a deterministic name
(`shared/laneNameFallback.ts`) on the placeholder branch, starts the session,
then asks the host for one AI lane/branch identity
(`agentChatService.generateAutoLaneIdentity`; phone via `lanes.suggestName`).
The branch is renamed only while provably safe; a manual rename wins. Naming
never blocks a launch.

## Branch switching inside a lane

The picker lists the lane's open chats and terminals and offers wait, stop and
switch, switch anyway, or cancel. `lane_branch_profiles` remembers per-branch
`base_ref`. `switchBranch` refuses dirty trees and duplicate owners and needs
`acknowledgeActiveWork` with live work; PR rows stay on the lane. `daex git
checkout <branch>` uses the same service. iOS uses `branchProfiles.list`,
`branchSwitch.preview`, `branchSwitch.commit`.

## Branch drift

A raw `git checkout` in the worktree leaves `lanes.branch_ref` behind: drift.
While drifted, PR surfaces match by the checked-out branch.

- `LaneBranchDrift` `{ expectedBranchRef, headBranchRef, kind? }`, kind `switched | renamed | missing`. Detection rides the status refresh; renamed vs missing reads the reflogs only while drifted.
- `resolveBranchDrift` re-reads HEAD: `switch-back` delegates to `switchBranch`; `keep-head` re-points `branch_ref` and refuses when another lane owns the branch.
- **Agents move the lane with them.** At turn end `adoptAgentBranchSwitch` runs `keep-head` unless the lane is the main checkout, was already drifted, the old branch has commits nowhere else, or another lane owns the new one. A switch made in a terminal is never adopted.
- **UI is arm-on-act.** `LaneBranchComposerChip` appears only after `armLaneBranchDriftWarning` (on send and on the PR button) and offers Switch back / Keep.
- Reach: IPC `ade.lanes.getBranchDrift` / `.resolveBranchDrift`; sync commands of the same names.

## IPC surface

Lane calls are `lane` domain runtime actions; channel names keep the `ade.`
prefix.

- `ade.lanes.list`, `.create` (`start` optional), `.importBranch`, `.rename`, `.updateAppearance`, `.archive`, `.delete`.
- `.reclaim.risk`, `.archiveAndReclaim`, `.unarchive`; `.delete.risk`, `.delete.cancel`, `.delete.event`, `.delete.progress.list`; `.cancelGitWrite`.
- `.lifecycle.event`: `lane-created`, `lane-renamed`, `lane-branch-updated`, `lane-archived`, `lane-reclaimed`, `lane-unarchived`, `lane-restored`, `lane-deleted`, `lanes-invalidated` (its lane id is the placeholder `LANES_INVALIDATED_LANE_ID`).
- Linear links, branch drift, rebase (`.rebaseStart` / `Abort` / `Rollback` / `Push`), `ade.git.mergeBaseIn`, and runtime isolation (`.initEnv`, `.templates.*`, `.port.*`, `.proxy.*`, `.oauth.*`, `.diagnostics.*`).

Environment setup from any entry point goes through `runLaneEnvironmentSetup`.
Lane sharing: `window.ade.laneShare.*` takes the lane's pin (user-only
`lane_share` domain); guest calls go to the account directory with no pin.

## Shared git engine

Every lane service reaches git through `apps/desktop/src/main/services/git/`:

- `git.ts`: `runGit` adds `gitReadEnv.ts` overrides (so personal config cannot change what DAEX reads) and `GIT_TERMINAL_PROMPT=0`, uses `-z` paths and full refs, holds the 12-slot read semaphore, and invalidates the repo cache after ref-changing commands. Timeouts in `gitTimeouts.ts` (checkouts 15 min, lane fetches 5).
- `gitRepoCache.ts`: keyed by common git dir; 1.5 s for ref SHAs, 5 minutes for config answers.
- `gitTransportAuth.ts`: GitHub sign-in for push/fetch; see [PRs › GitHub connectivity model](../pull-requests/README.md#github-connectivity-model).
