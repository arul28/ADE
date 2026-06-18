# Pull requests

ADE's pull-request surface manages lane-backed PRs, stacked PR chains,
PR merge queues, integration (merge-plan) proposals, and GitHub
inspection. It treats local git state as the source of truth for
merge/integration simulation while keeping remote GitHub state warm
through layered caching.

This folder documents:

- [`stacking.md`](./stacking.md) — stacked PR chains, rebase ordering, queue-aware rebase targeting.
- [`queue.md`](./queue.md) — PR merge queue model and landing state machine.
- [`conflict-simulation.md`](./conflict-simulation.md) — how ADE predicts PR merge conflicts before the user hits Merge.

## Where this runs

PR mutations, GitHub polling, queue landing, integration proposal
simulation, and the issue/rebase resolver agent dispatch all run inside
the **active ADE runtime** (local machine runtime for local-bound
windows, SSH-attached remote runtime for remote-bound windows). The
renderer's `window.ade.prs.*` surface in
`apps/desktop/src/preload/preload.ts` is the routing boundary:
remote-bound windows route PR service work through the remote runtime,
while local-bound windows still use selected legacy in-process IPC
paths during migration. PR polling fingerprints, the
`prsRouteState.ts` URL-state helper, and the PR detail panes are
renderer-only — they hold no service state.

The PR bridge deliberately splits local and remote reads while the PR
service finishes its runtime migration. Remote-bound windows execute PR
tab reads on the remote runtime through `callPrReadRuntimeActionOr`
(`domain: "pr"`). Local-bound windows call the in-process PR IPC
handlers directly for high-volume reads such as `listWithConflicts`,
`getDetail`, `getStatus`, `getChecks`, `getReviews`, `getComments`,
`getFiles`, `getCommits`, `getDeployments`, `getAiSummary`, and
`getGitHubSnapshot`, so opening the PR tab does not wait on local
daemon startup. Mutations and long-running workflows still use the
project runtime route where that route owns the behavior.

For remote-bound windows, GitHub polling and the queue automation loop
all execute on the remote machine. The git operations that back PR
merges, rebases, and conflict resolution use the worktrees on the
remote host. Status reads work exactly the same as local; the desktop
window just sends every action through the SSH-tunneled JSON-RPC
instead of the local socket.

## Source file map

Services. The canonical implementations run inside the runtime
daemon; the desktop main-process files below stay as fallback targets
for the legacy in-process IPC path.

CLI and agent entry points:

| File | Responsibility |
|------|---------------|
| `apps/ade-cli/src/cli.ts` | User-facing `ade prs` commands and text formatters. `ade prs create --text` prints both the GitHub PR URL and the ADE HTTPS PR URL when repo owner/name and PR number are available. |
| `apps/ade-cli/src/adeRpcServer.ts` | Private action/RPC wrapper for PR tools. `create_pr_from_lane` returns `{ pr, githubUrl, adeUrl }` so agents can include both links in closeout. |
| `apps/desktop/src/main/services/ai/tools/workflowTools.ts`, `ctoOperatorTools.ts` | Managed chat/CTO PR creation tools return both `githubUrl` and `adeUrl` alongside the PR object. |

Service files (`apps/desktop/src/main/services/prs/`):

| File | Responsibility |
|------|---------------|
| `prService.ts` | PR CRUD, GitHub sync, merge context, draft descriptions, check/review/comment hydration, cached detail snapshots (`listSnapshots`), commit snapshots (`getCommits`), integration proposals, merge-into-existing-lane adoption, merge bypass, post-merge cleanup, standalone PR branch cleanup (`cleanupBranch`), deployment listing, review-thread reply/resolve/react mutations for the timeline, the aggregate `getMobileSnapshot` that powers the iOS PRs tab, and `listOpenPullRequests` — a paginated `/repos/{owner}/{name}/pulls?state=open` fetch returning `BranchPullRequest[]` for the lane-creation branch picker. `getForLane(laneId)` resolves through `getDisplayRowForCurrentLaneBranch`: it returns the most recently updated PR whose head branch matches the lane's current branch ref, ranked open/draft → merged → closed, so a freshly merged PR still shows in lane-scoped UI instead of disappearing the moment GitHub flips the state. `getGitHubSnapshot` fetches repo PRs, backfills same-repo lane PR rows by branch, and performs a capped per-branch fallback (`head=<owner>:<branch>`) for active lane branches missing from the repo snapshot window so old merged/closed externally-created PRs can still badge lanes. On PR open, `publishLinearPrCardsForLane` combines the lane's own Linear references with `collectLinearPrIssueReferencesForLaneSessions(laneId)` — issues attached only to a chat/CLI session in the lane (via `laneService.listLinearIssuesForLaneSessions`, authoritative for sessions whose lane mirror never landed) — deduped via `dedupeLinearPrIssueReferences`, so a session-only issue still gets a PR attachment. When the optional live-status round-trip is enabled (`getLinearLiveStatusService`, gated by `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`) it also posts a PR-link comment back to each linked issue. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). `computeStatus` / `getStatusByGithub` fetch the authoritative GitHub merge box over GraphQL (`mergeStateStatus`, `reviewDecision`, required/approving review counts, `viewerPermission` for bypass) and fold it into `PrStatus`; `getStatusByGithub` does the same for unmapped GitHub-tab PRs keyed only on `owner/repo#num` coords. `land` takes an editable commit title/body (`commit_title`/`commit_message`, `--subject`/`--body` on the admin retry; ignored for `rebase`) and an `expectedHeadSha` stale-head guard, and `updateBranch` brings a behind branch up to date via GitHub's `update-branch` API (`merge` strategy) or ADE's local lane rebase + force-with-lease push (`rebase` strategy, conflict-aware). Review-thread reply/resolve/react mutations work on unmapped GitHub-tab PRs through synthetic `gh:owner/repo#num` ids (`parseSyntheticGithubPrId` resolves the repo; `assertThreadBelongsToPr` still verifies thread ownership). Commit rows carry an avatar URL — the linked GitHub avatar when present, else a Gravatar identicon derived from the commit-author email. |
| `prService.mobileSnapshot.test.ts` | Coverage for the mobile snapshot builder: stack chaining, capability gates, per-lane create eligibility, workflow-card aggregation |
| `prService.mergeInto.test.ts` | Coverage for integration proposals that preview or adopt an existing merge target lane, including dirty-worktree handling and drift metadata. |
| `prPollingService.ts` | 60 s polling loop, fingerprint-based change detection, notification emission. Writes `last_polled_at` per PR so callers can run delta polls on the next tick |
| `prSummaryService.ts` | AI PR summary generator; caches `PrAiSummary` per `(prId, headSha)` in `pull_request_ai_summaries` so pushes invalidate the cache |
| `queueLandingService.ts` | Merge queue state machine (`ALLOWED_TRANSITIONS`), landing loop, auto-resolve on conflicts |
| `integrationPlanning.ts` | `buildIntegrationPreflight` — validates source lanes for an integration proposal |
| `integrationValidation.ts` | `parseGitStatusPorcelain`, `hasMergeConflictMarkers` — shared helpers for integration flows |
| `prIssueResolver.ts` | Builds issue-resolution prompts for the agent, launches chat session |
| `prRebaseResolver.ts` | Builds rebase-resolution prompts, launches chat session |
| `resolverUtils.ts` | Shared permission-mode mapping, recent commit reading, comment noise filter, and the `looksLikeResolutionAck` heuristic that flags resolved-looking replies on unresolved review threads |

Renderer components (`apps/desktop/src/renderer/components/prs/`):

| File | Responsibility |
|------|---------------|
| `PRsPage.tsx` | Top-level tab shell (GitHub vs Workflows) with URL-driven state. Consumes create-PR handoff params from either router search or hash search (`create=1`, `sourceLaneId` / `laneId`, `target=primary`) and the `prs.create` dialog bus props, then opens `CreatePrModal` with matching initial values without persisting the one-shot route as the last PR route. |
| `state/PrsContext.tsx` | PR data provider (list, selection, queue groups, rebase needs). Selected-PR primary reads apply progressively as status/check/review/comment requests resolve, so one slow piece does not hold the whole detail pane busy; cached snapshots stay visible during GitHub rate limits. Workflow queue-state reads tolerate older remote runtimes that do not expose the optional `pr.listQueueStates` action by rendering an empty queue-state set instead of failing the whole PR refresh. |
| `prsRouteState.ts` | URL ↔ page state mapping plus project-scoped last-route storage. When a project root is known, the PRs tab reads only that project's stored route and does not fall back to the legacy global route from another project. |
| `CreatePrModal.tsx` | Draft/queue/integration PR creation with lane warnings, branch name validation, and optional initial values for single-PR handoffs from lane/chat surfaces. A `target: "primary"` handoff resolves the base branch from the primary lane (falling back to `main`). |
| `tabs/NormalTab.tsx` | Normal PR list |
| `tabs/GitHubTab.tsx` | Repository PR browser with label filters, CI badges, review indicators, ADE-vs-unmanaged scope counts, and linked-lane context. State filter is one of `open` / `closed` / `merged` / `all`. The tab ignores legacy cross-repo `externalPullRequests` payloads; the "External" scope means repo PRs that are not managed by ADE. The "create lane from PR branch" affordance has been removed — open/closed PRs on branches without a lane no longer offer the preflight + create dialog (`prsPreflightCreateLaneFromPrBranch` / `prsCreateLaneFromPrBranch` IPC channels have been deleted), so creating a lane for an existing PR now goes through the standard lane creation flow. |
| `tabs/QueueTab.tsx` | Merge queue UI showing queued stack members and their landing state. |
| `tabs/IntegrationTab.tsx` | Integration (merge-plan) proposals and execution, including merge-into-lane selection, apply-and-resimulate, and adopted-lane cleanup messaging |
| `tabs/RebaseTab.tsx` | Lane rebase needs (base + queue + PR target) and attention items. Hide/snooze controls only affect the lane rebase suggestion banner; still-behind needs remain actionable in the Rebase view. |
| `tabs/WorkflowsTab.tsx` | Container for queue/integration/rebase sub-tabs. The Rebase/Merge history view is backed by actual ADE rebase operation records, while active rebase needs include any lane still behind its target regardless of banner hide/snooze state. |
| `tabs/queueWorkflowModel.ts` | Pure model for queue tab rendering (active/history bucketing, guidance computation) |
| `tabs/rebaseWorkflowModel.ts` | Pure model for active rebase bucketing and operation-history filtering |
| `detail/PrDetailPane.tsx` | Selected PR detail pane: status, checks, reviews, comments, files, commits, merge readiness, bypass, resolver modals. Rich detail/files/commits/action-run reads render progressively; late cached snapshot hydration can update snapshot-owned fields but cannot overwrite richer live detail/files/commits already loaded for the selected PR. Switches the Overview tab between the legacy grid and the Timeline+Rails layout based on `prsTimelineRailsEnabled`. Persists the selected sub-tab (`overview | files | checks | activity`) per PR in `localStorage` under `ade:prs:detailTabs:v1`, mirrored through the `detailTab` URL param so deep links restore the last-used tab. The detail view has four tabs: Overview, Files, CI / Checks, and Activity. |
| `detail/PrDetailTimelineRails.tsx` | Timeline+Rails overview: hosts the central `PrTimeline`, the left commit/checks rail, the right merge/metadata rail, the inline comment composer, and the command palette. Seeds the timeline with a synthetic `pr_opened` event followed by description, review threads, activity-stream entries (commits, comments, reviews, label changes, merges, deployments) and falls back to `args.checks` for any check that did not appear in the activity stream. Owns the deep-link scroll behaviour and the merge-bypass plumbing through to the right rail. |
| `shared/PrTimeline.tsx` | Timeline column: renders the pre-computed `PrTimelineEvent[]` from `PrDetailTimelineRails`, handles per-PR filters (`PrTimelineFilters`), and groups events |
| `shared/PrDetailLeftRail.tsx` | Left timeline rail. Stacks the commit list (`PrCommitRail` in `layout: "pane"` mode) on top of `PrPushChecksRail`, sharing the same accent gradient that bleeds into the timeline background. |
| `shared/PrDetailRightRail.tsx` | Right timeline rail. Splits into two resizable panels: a top `PrDetailMergeRail` (merge readiness + actions) and a bottom `PrDetailRightMetadataRail` (reviewers, labels, participants, review-submit affordance). |
| `shared/PrDetailMergeRail.tsx` | Merge readiness panel. Hosts the GitHub-style `PrMergeChecklist` (one row per requirement, with the inline "Update branch" split button on the behind-base row), the primary "Merge" button that opens the portaled `PrMergeDialog`, the branch-cleanup affordance, and the inline lane-management entry. Owns the per-PR live-status re-poll loop that keeps `mergeStateStatus` fresh and clears the "Checking mergeability…" state. Calls helpers from `prMergeRailUtils.ts` to build the checklist and derive merge-method labels. |
| `shared/PrMergeDialog.tsx` | Portaled merge dialog (in `LaneDialogShell`, so its method dropdown is never clipped by the rail). Method picker (`squash` / `merge` / `rebase`, remembered default), editable commit title/body seeded from `buildDefaultCommitMessage` with a "reset to GitHub default" affordance (hidden for `rebase`), collapsible command-line instructions, a stale-head guard that re-seeds defaults if the PR head advances while open, and an admin "Override & merge" path (two-click arm/confirm) shown only when the viewer `canBypass` and the merge box is `blocked`. Returns `{ method, commitTitle, commitBody, bypassRules, expectedHeadSha }`. |
| `shared/PrMergeChecklist.tsx` | GitHub-parity requirement checklist for the merge surface: a header pill (`Checking mergeability…` while `mergeabilityComputing`, `Draft`, `Merging is blocked`, or `Ready to merge`) over a row per requirement (conflicts, behind base, checks, review). Renders approving-review avatars on the review row and the inline update-branch split button (merge commit / rebase) on the behind row. |
| `shared/PrDetailRightMetadataRail.tsx` | Reviewers / labels / participants metadata strip in the right rail, plus the "Request AI review" affordance (`PrRequestAiReviewDialog`) and the modal-driven review-submit flow (`PrReviewSubmitModal`). |
| `shared/PrCommitRail.tsx` | Commit list rail. Reused inside both the left timeline rail (pane layout) and standalone surfaces (rail layout); resolves commit selection via `activeSha` + `onSelectCommit`. |
| `shared/PrPushChecksRail.tsx` | Compact checks summary inside the left rail; renders the green "checks passing" header strip and a scrollable `PrCheckList`. |
| `shared/prCheckList.tsx` | Pure check rendering: `PrCheckList` groups checks into `ci` / `security` / `bots` / `other` buckets and `summarizeChecks(checks)` returns the per-bucket counters used by `PrPushChecksRail` and `PrDetailMergeRail`. |
| `shared/prMergeRailUtils.ts` | Shared merge-rail helpers: `mergeMethodLabel` / `mergeMethodShortLabel`, `canAttemptMerge` (prefers `status.mergeStateStatus`, falls back to the legacy boolean), `buildMergeChecklist` (the per-requirement rows driven by `mergeStateStatus` + `reviewDecision`), `buildDefaultCommitMessage` (GitHub-style default merge/squash commit title + body), `deriveMergeBlockers`, `buildMergeCommandLineInstructions`, `deriveParticipants`, `reviewStateForLogin`, `isBotLogin`. Consumed by the merge dialog, checklist, metadata rail, and the timeline composer plumbing. |
| `shared/prUnifiedChecks.ts` | Reconciler between GitHub `PrCheck` rows and `PrActionRun.jobs`. Produces `UnifiedCheckItem[]` so the Checks sub-tab can display Actions jobs and named checks in a single list with steps + duration + details URL. |
| `shared/PrCommentComposer.tsx` | Inline comment composer used at the bottom of the timeline view; thin wrapper around `ChatComposerShell` with Enter-to-submit semantics. |
| `shared/PrReviewSubmitModal.tsx` | Modal that captures the optional review body and `Approve` / `Request changes` / `Comment` event before submitting through `ade.prs.submitReview`. |
| `shared/PrRequestAiReviewDialog.tsx` | "Request AI review" launcher rendered from the metadata rail; opens `LaneDialogShell`, picks a default Codex model + reasoning, and dispatches `startReviewRun`. |
| `shared/PrManageLaneDialogHost.tsx` | Hosts the shared `ManageLaneDialog` (delete / archive / adopt / appearance) from PR surfaces. Owns the local delete-confirmation state so the lane dialog can mount without polluting the PR detail pane. |
| `shared/GitHubPrSearchInput.tsx`, `shared/GitHubRepoSyncBar.tsx` | Repo-PR header chrome shared by the GitHub tab and detail views: the magnifying-glass search input and the "syncing…" toolbar that drives manual snapshot refreshes. |
| `shared/PrUserAvatar.tsx` | Shared GitHub user avatar with a fallback `UserCircle` glyph for users that don't have a cached avatar URL. Commit rows without a linked GitHub account use the Gravatar identicon URL the service derives from the commit-author email (see `prService.getCommits`), so the CSP allowlist includes `gravatar.com`. |
| `shared/PrCommandPalettes.tsx` | `g c` (commits) / `g t` (threads) / `g f` (files) palettes opened by the keyboard chord and by the timeline toolbar |
| `shared/PrAiSummaryCard.tsx` | AI summary card above the timeline; dismissible per PR (state in `PrsContext.dismissedAiSummaries`), with a "Regenerate" action wired to `prSummaryService.regenerateSummary` |
| `shared/PrReviewThreadCard.tsx`, `shared/PrBotReviewCard.tsx` | Rich thread cards for the timeline (bot-review collapse, reply box, resolve/react actions) |
| `shared/PrDeploymentCard.tsx` | Deployment row used in the status rail and on the timeline |
| `shared/PrAiResolverPanel.tsx` | AI resolver launch controls in Rebase/Integration flows, including additional-instructions passthrough |
| `shared/PrLaneCleanupBanner.tsx` | Post-merge cleanup banner on the PR detail. Also renders a dedicated "PR branch cleanup" variant when the PR is linked to the primary lane but its head branch differs — the primary lane is never deleted, but the user can still delete the local and/or remote PR branch after confirming `delete <branch>` |
| `shared/IntegrationPrContextPanel.tsx` | Integration PR context panel |
| `shared/prVisuals.tsx` | CI running indicator, check/review badges, dot colors, activity derivation |
| `shared/rebaseNeedUtils.ts` | Rebase need dedup, route selection, upstream rebase chain |
| `shared/rebaseAttentionUtils.ts` | Auto-rebase attention items for the Rebase tab |
| `shared/lanePrWarnings.ts` | Pre-submit lane-health warnings |
| `shared/prFormatters.ts` | Formatting helpers shared across PR surfaces. `formatPrBadgeLabel(pr)` returns a state-aware compact badge (`PR #123`, `DRAFT #123`, `MERGED #123`, `CLOSED #123`) used by the chat git toolbar and the lane list PR tag so closed/merged PRs aren't visually identical to open ones. |
| `shared/laneBranchTargets.ts` | Target branch resolution for PR creation |
| `ConflictFilePreview.tsx` | File-level conflict marker preview |
| `PrRebaseBanner.tsx` | Rebase banner on a PR |
| `PrConflictBadge.tsx` | Lightweight conflict chip |

Shared contracts:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/shared/types/prs.ts` | PR DTOs and integration proposal contracts, including `preferredIntegrationLaneId`, `mergeIntoHeadSha`, `integrationLaneOrigin`, and `additionalInstructions` fields. `MergeStateStatus` (lowercase mirror of GitHub's GraphQL merge-box enum) and `PrReviewDecision` drive the merge checklist; `PrStatus` carries `mergeStateStatus`, `reviewDecision`, `approvalsCount` / `requiredApprovals`, `mergeabilityComputing`, `canBypass`, and `headSha`. `LandPrArgs` adds `commitTitle` / `commitBody` (editable merge-commit message) and `expectedHeadSha` (stale-head guard) alongside `bypassRules`, which opts the merge into a `gh pr merge --admin` retry when GitHub rejects the standard merge. `UpdateBranchArgs` / `UpdateBranchResult` back the `merge` / `rebase` update-branch flow. `PrActionCapabilities` adds `mergeStateStatus`, `canBypass`, and `canUpdateBranch` so mobile renders the same merge state. `PrTimelineEvent` carries a `pr_opened` variant plus `lifecycle`, `cross_reference`, `renamed`, `branch_ref`, `assignment`, expanded `review_request`, and `review_dismissed` variants so the timeline reaches GitHub event parity; review-thread events now carry the full `comments` list (with `diffHunk`) and force-push commit events carry before/after SHAs. |
| `apps/desktop/src/shared/types/git.ts` | `BranchPullRequest` (branch / prNumber / title / state / url / author / updatedAt) — the lightweight PR shape returned by `prService.listOpenPullRequests` and consumed by the branch picker without going through `PrSummary`. `GitHubAutolink` (id / keyPrefix / urlTemplate / isAlphanumeric) backs the new `ade.github.listRepoAutolinks` / `ade.github.createRepoAutolink` IPC channels. |
| `apps/desktop/src/shared/types/conflicts.ts` | Conflict resolver DTOs; `PrepareResolverSessionArgs.additionalInstructions` is appended to generated resolver prompts. |
| `apps/desktop/src/shared/linearMagicWords.ts` | Pure helpers for PR/commit Linear references. `linearPrMagicWord` / `buildLinearPrReference` / `ensureLinearPrReference` (single-issue magic word in the PR body), `dedupeLinearPrIssueReferences` / `ensureLinearPrReferences` (multi-issue dedupe + injection), and `renderLinearPrIssueLinkSection` / `ensureLinearPrIssueLinkSection` (the `<!-- ade:linear-links v=1 -->`-fenced "Linked Linear issues" markdown block appended to PR bodies by `prService.applyLinearPrLinkage`). |
| `apps/desktop/src/shared/prMarkdownText.ts` | `normalizeEscapedMarkdownNewlines(text)` — unescapes literal `\n` / `\r\n` / `\r` / `\t` sequences that arrive in PR bodies after GitHub round-trips them through JSON. Used by `PrMarkdown` before handing the string to ReactMarkdown so escaped newlines render as paragraph breaks. |
| `apps/desktop/src/shared/ipc.ts` / `apps/desktop/src/preload/preload.ts` | PR IPC constants and renderer bridge for proposal simulation, update, commit, resolver, cleanup, and read flows. Read-heavy PR tab calls route to the remote runtime only for remote-bound windows and use in-process IPC for local-bound windows. Local PR/session push subscriptions are multiplexed so multiple renderer subscribers share one IPC listener per channel. |

## Core model

`PrSummary` (selected fields, full type in `src/shared/types.ts`):

```ts
type PrSummary = {
  id: string;
  laneId: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  githubPrNumber: number;
  githubUrl: string;
  title: string;
  state: PrState;          // open | closed | merged
  baseBranch: string;
  headBranch: string;
  checksStatus: PrChecksStatus;    // passing | failing | pending | unknown
  reviewStatus: PrReviewStatus;    // approved | changes_requested | review_required | ...
  labels: PrLabel[];
  isBot: boolean;
  commentCount: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`PrStatus` adds live fields not cached on the summary row
(mergeability, behind-by, merge conflicts, activity events).

## IPC surface

Selected channels exposed through `preload.ts`:

- `ade.prs.createFromLane`, `ade.prs.createQueue`, `ade.prs.createIntegration`
- `ade.prs.listAll`, `ade.prs.listProposals`, `ade.prs.listQueueStates`
- `ade.prs.listOpenForRepo` — flat list of open PRs in the project's GitHub repo as `BranchPullRequest[]` (branch / number / title / state / url / author / updatedAt). Independent of `pull_requests` cache so the lane-creation branch picker can attach PR pills to branches that have no lane yet. See [features/lanes/README.md](../lanes/README.md) for the consumer.
- `ade.prs.land`, `ade.prs.landStack`, `ade.prs.landStackEnhanced`, `ade.prs.landQueueNext`
- `ade.prs.updateBranch` — bring a behind PR head up to date with its base (`strategy: "merge"` uses GitHub's update-branch API; `strategy: "rebase"` runs ADE's local lane rebase + force-with-lease push and reports `hasConflicts` when it can't auto-apply)
- `ade.prs.getStatusByGithub` — live `PrStatus` (incl. the GraphQL merge box) for an unmapped GitHub-tab PR addressed by `owner/repo#num` coords, without a `pull_requests` row
- `ade.prs.getMergeContext`, `ade.prs.getMergeContexts`, `ade.prs.listSnapshots`, `ade.prs.getStatus`, `ade.prs.getChecks`, `ade.prs.getReviews`, `ade.prs.getComments`, `ade.prs.getFiles`, `ade.prs.getCommits`
- `ade.prs.cleanupBranch` — delete a merged/closed PR's local and/or remote branch without touching the lane (protected against deleting any primary-lane branch)
- `ade.prs.updateDescription`, `ade.prs.updateTitle`, `ade.prs.updateBody`, `ade.prs.setLabels`, `ade.prs.requestReviewers`, `ade.prs.submitReview`, `ade.prs.close`, `ade.prs.reopen`
- `ade.prs.getReviewThreads`, `ade.prs.replyToReviewThread`, `ade.prs.resolveReviewThread`
- `ade.prs.postReviewComment`, `ade.prs.setReviewThreadResolved`, `ade.prs.reactToComment` — GraphQL-backed mutations used by the timeline's thread cards
- `ade.prs.getDeployments` — deployments for the PR's head SHA, with the latest status status URL and environment URL
- `ade.prs.getAiSummary` / `ade.prs.regenerateAiSummary` — cached/forced `PrAiSummary` per `(prId, headSha)`
- `ade.prs.rebaseResolutionStart`
- `ade.prs.retargetBase` — re-point a PR's base branch (used by stack-queue workflows)
- `ade.prs.getGitHubSnapshot` — repository PR snapshot for the active GitHub repo. The DTO still carries `externalPullRequests` and accepts `includeExternalClosed` for compatibility, but the current service returns repo PRs only and the renderer ignores legacy cross-repo external items.
- `ade.prs.simulateIntegration`, `ade.prs.createIntegrationLaneForProposal`, `ade.prs.commitIntegration`, `ade.prs.cleanupIntegrationWorkflow`
- `ade.github.listRepoAutolinks` / `ade.github.createRepoAutolink` — read and create GitHub repo autolink references (the `key_prefix` + `url_template` rules that turn issue identifiers like `ADE-123` into GitHub-rendered hyperlinks). Used by the Linear setup flow so a project's Linear identifiers become clickable in PR bodies. `createRepoAutolink` requires `urlTemplate` to contain `<num>` and busts the autolinks ETag cache after a successful POST.

Integration merge-into flow uses these existing channels with widened
DTOs:

- `ade.prs.simulateIntegration` accepts `mergeIntoLaneId`. Pairwise
  child-vs-child checks still use `baseBranch`, while the sequential
  preview starts at the selected lane's current HEAD and returns
  `mergeIntoHeadSha`.
- `ade.prs.updateIntegrationProposal` can set
  `preferredIntegrationLaneId`, store `mergeIntoHeadSha`, and clear an
  existing integration binding when the merge target changes.
- `ade.prs.createIntegrationLaneForProposal` and
  `ade.prs.commitIntegration` accept `allowDirtyWorktree`; commit can
  also receive `preferredIntegrationLaneId` to override the stored
  preference.
- `ade.prs.aiResolutionStart` and issue-resolution launch args accept
  `additionalInstructions`, which are appended to the generated
  resolver prompt after the structured context.

## GitHub data-loading model

The GitHub tab renders PRs from the active repository, sorted by
creation date. The scope filter (`all` / `ade` / `external`) is local
to that repository: `ade` means ADE-managed/linked PRs, while
`external` means repo PRs that are not currently managed by ADE.
Cross-repo PRs involving the viewer are not fetched or displayed.

Caching layers:

1. **Runtime cache** — GitHub snapshot is cached for a short TTL
   inside `prService` on the active runtime for remote-bound windows
   and in the local in-process PR service for local-bound windows.
   Repeated in-flight snapshot requests are deduplicated. The snapshot
   fetches repository PRs only, then does at most 12 targeted same-repo
   head-branch lookups for active lane branches that were absent from
   the repo-wide page window.
2. **Renderer cache** — `PrsContext` holds the last snapshot so
   revisiting the tab renders immediately. Selected PR detail panes
   hydrate from `listSnapshots({ prId })` before live status, check,
   review, comment, file, and commit requests run in the background.
   Each live piece applies as soon as it resolves; a slow comments or
   action-runs request does not block status/checks/files from
   rendering.
3. **Manual sync** — a "Refresh" action forces a fresh pull. Explicit
   multi-PR refreshes run with bounded parallelism instead of refreshing
   each PR serially.

Snapshot contents include `labels` (name, color, description),
`isBot`, and `commentCount` fields so filters can run locally.

PR rows in `tabs/GitHubTab.tsx` and queue member rows in `tabs/QueueTab.tsx`
render the linked lane's color through `LaneAccentDot` (resolved from the
app store via `useLaneColorById` / a `Map<laneId, color>`); the rest of the
row text inherits the lane color so a glance correlates a PR with its lane
across the queue / GitHub / Workflows tabs.

## GitHub connectivity model

`getStatus()` in `apps/desktop/src/main/services/github/githubService.ts`
returns a `GitHubStatus` shaped to be the single source of truth for
"GitHub is usable here" — UI banners and badges read `status.connected`
rather than re-deriving from individual fields.

Fields:

- `tokenStored`, `tokenDecryptionFailed`, `tokenType` — `classic` |
  `fine-grained` | `unknown`. Set from token prefix on save.
- `userLogin`, `scopes`, `checkedAt` — outcome of `validateToken` (calls
  `GET /user`). Classic tokens populate `scopes` from
  `x-oauth-scopes`; fine-grained tokens never return that header so
  `scopes` is empty.
- `repo` — auto-detected origin owner/name.
- `repoAccessOk: boolean | null`, `repoAccessError: string | null` —
  result of an explicit `GET /repos/{owner}/{name}` probe
  (`probeRepoAccess`). `null` means no probe was run (no repo to
  probe, or `getStatus` returned early on a token-error path).
- `connected: boolean` — computed by `computeConnected`:
  - `false` if token is missing or `userLogin` is null.
  - For `fine-grained` tokens: requires the repo probe to pass (or no
    repo to probe). This is the only reliable check because fine-grained
    permissions are not introspectable from headers; a token can
    authenticate as a user yet 403 every PR-tab call.
  - For `classic` tokens: requires `getGitHubTokenAccessState(scopes)`
    to report `hasRequiredAccess`.
  - For `unknown` token prefixes: best-effort — `userLogin` is enough.

Status is cached in-memory for 30 s. The cache is bypassed when the
caller passes `getStatus({ forceRefresh: true })` (Settings'
"REFRESH" button does this so the user can fix permissions on
github.com and immediately re-check). When the cache is hit but the
auto-detected `repo` has changed, `repoAccessOk` is reset to `null`
because the cached probe no longer applies.

Status changes broadcast through the `ade.github.statusChanged` IPC
channel (`window.ade.github.onStatusChanged`) every time
`setToken` / `clearToken` is called. `AppShell` subscribes so the
unconnected-banner state reflects the latest status the moment
Settings saves a new token — fixing the prior bug where Settings said
CONNECTED while the AppShell banner still said disconnected.

`renderer/components/settings/GitHubSection.tsx` distinguishes:

- `tokenAuthenticated` — token decrypted and `userLogin` is populated.
- `isConnected` (`status.connected` from the backend) — the actual
  "GitHub is usable" gate. Drives the green CONNECTED / amber LIMITED
  ACCESS / muted NOT CONNECTED label and any saved-and-verified
  notice.
- A repo-probe-failed inline error renders when the token authenticated
  but the probe came back 403/404, with copy that asks the user to
  grant Contents (Read), Pull requests (Read and write), and Metadata
  (Read) on the active repo (fine-grained tokens) or to make sure the
  classic token has access to the repo.

`AppShell.describeGithubBanner(status)` mirrors the same three-way
split for the banner copy: "not connected" / "cannot access
{owner}/{repo}" / "missing required permissions".

## Background polling

`prPollingService` runs at a 60 s default interval (clamped to
5 s–5 min, jittered ±10%). Each tick:

1. Pulls the current PR list via `prService`.
2. Computes a fingerprint per PR (excluding volatile timing fields:
   `lastSyncedAt`, `createdAt`, `updatedAt`, `projectId`).
3. Diffs against last seen fingerprints; only changed PRs trigger
   events/UI updates.
4. Emits `PrEventPayload` for state transitions (checks failing,
   review requested, changes requested, merge ready).

Notification titles are generic (not PR-specific) so they display
well as system notifications. The event payload includes `prTitle`,
`repoOwner`, `repoName`, `baseBranch`, `headBranch` so consumers can
format context-aware messages themselves.

In-app, the App Shell renders these events as PR toasts. Their
"View PR" action now navigates straight into the PR detail drawer
on `/prs` via `buildPrsRouteSearch`, with `selectedPrId` set to the
event's PR id and `detailTab` chosen from the event kind:
`checks_failing` → `checks`, `changes_requested` /
`review_requested` → `activity`, everything else → drawer overview.
This replaces the older "select lane + open lane inspector merge
tab" route, which depended on the lane being currently focused and
forced the user to leave the PRs surface to follow up on a PR
event.

## PR context loading

The PR page no longer assumes every tab loads every workflow query:

- Queue state loads only for workflow-oriented tabs.
- Merge contexts load lazily per selected PR.
- Selected PR detail (status, checks, reviews, comments) loads on
  demand.
- Background refresh updates only the stale subset using
  fingerprints, not every PR on every cycle.

## Merge flow

The merge surface mirrors GitHub's merge box. `prService.computeStatus`
(and `getStatusByGithub` for unmapped GitHub-tab PRs) fetches the
authoritative state over GraphQL — `mergeStateStatus`, `reviewDecision`,
required/approving review counts, and `viewerPermission` (for the bypass
gate) — behind the `merge-info-preview` Accept header, falling back to the
REST-derived `isMergeable` heuristic when GraphQL is unavailable. The
GraphQL path never blocks on the long mergeability poll: while GitHub is
still computing (`mergeStateStatus === "unknown"` or REST `mergeable ==
null`) the status carries `mergeabilityComputing: true` and the renderer
re-polls, so the merge UI never gets stuck on a dead "Checking
mergeability…" spinner.

`PrMergeChecklist` renders that state as a GitHub-style requirement list
(conflicts, behind base, checks, review) under a single header pill
(`Checking mergeability…` / `Draft` / `Merging is blocked` / `Ready to
merge`). The behind-base row carries an inline "Update branch" split
button that calls `prService.updateBranch` with `strategy: "merge"`
(GitHub's update-branch API) or `strategy: "rebase"` (ADE's local lane
rebase onto the base + `--force-with-lease` push; on conflict the rebase
auto-aborts and `hasConflicts` routes the user to the existing resolver).

The actual merge runs through the portaled `PrMergeDialog`. It is
mounted in `LaneDialogShell` so the method dropdown is never clipped by
the rail. The dialog offers the method picker (remembered default), an
editable commit title/body seeded from `buildDefaultCommitMessage` (sent
as `commit_title` / `commit_message` on the REST merge and `--subject` /
`--body` on the admin retry; ignored for `rebase`), collapsible
command-line instructions, and a stale-head guard: it captures the head
SHA on open, passes it as `expectedHeadSha` (GitHub returns 409 if the
head advanced), and re-seeds the default commit message if the head
changes while the dialog is open.

### Admin bypass

When GitHub reports the merge box as `blocked` and the viewer has bypass
permission (`status.canBypass`, derived from `viewerPermission ===
"ADMIN"`), the dialog shows an "Override & merge" path instead of the
normal confirm button. It requires a deliberate two-click arm/confirm and
sets `LandPrArgs.bypassRules = true`, which instructs `prService.land` to
retry with `gh pr merge --admin` (carrying the same commit title/body)
after the standard REST merge comes back blocked. The merge request still
goes through GitHub — GitHub itself decides whether the bypass is allowed.

## Post-merge cleanup

After a successful GitHub merge, cleanup runs inside an outer
try-catch so a cleanup failure does not mask the successful merge:

- branch deletion
- group membership removal
- lane archiving (if configured)
- base branch fetch
- cache invalidation
- rebase-needs scan

Individual failures log as warnings; the operation is marked
succeeded with a `cleanupError` metadata field when anything went
wrong.

### Standalone PR branch cleanup

`prService.cleanupBranch` is a second cleanup entry point scoped to the
PR branch itself rather than a lane. It is reachable from
`PrLaneCleanupBanner` when the PR is linked to the primary lane but its
head branch differs, which happens after a manual import / re-link.
Guarantees:

- refuses to run unless the PR is `merged` or `closed`
- refuses to delete any branch that matches a primary lane's branch ref
- local deletion uses `git branch -D` after `git show-ref --verify`
- remote deletion uses `git push <remote> --delete` after `git ls-remote
  --heads` confirms the branch exists on the remote
- returns a `CleanupPrBranchResult` with independent `localDeleted` /
  `remoteDeleted` booleans and per-side error strings; partial failures
  log `prs.branch_cleanup_partial_failure` but do not throw

`linkToLane` also now guards against cross-linking: linking a PR to a
lane whose branch ref does not match the PR's head branch throws
instead of silently linking mismatched branches.

## PR issue resolution

ADE supports agent-driven resolution of PR issues for two scopes:

- `checks` — after all checks have completed and at least one failed
- `comments` — unresolved review threads (non-outdated)
- `both` — combined

`prIssueResolver.ts` assembles a structured prompt from live PR
state (failing checks + workflow run detail, unresolved threads with
compact summaries, changed files, recent commits) and launches a
chat agent session scoped to the lane worktree. The session gets
workflow tools to re-pull checks/threads/comments, re-trigger failed
GitHub Actions check runs, post replies on review threads, and mark
review threads resolved.

The generated prompt frames each session as one bounded resolution
round: the agent makes a coherent set of fixes for the current
checks and threads, commits and pushes, and stops with a concise
final note (what changed, what was validated, whether it pushed, and
any blocker). The agent is explicitly told not to wait indefinitely
for CI or advisory review bots — ADE's poller will observe post-push
comments and launch the next round if new actionable work appears.

## Integration merge target adoption

An integration proposal can target an existing lane instead of always
creating a fresh `integration-*` child lane:

1. The user selects a merge target lane in `IntegrationTab` or
   `CreatePrModal`. The selected lane cannot be one of the proposal's
   source lanes and cannot be the primary lane.
2. Simulation persists `preferredIntegrationLaneId` plus the selected
   lane's `mergeIntoHeadSha`. This lets the UI warn when the adopted
   lane has drifted since the last preview.
3. Pairwise conflict checks between source lanes remain anchored to the
   proposal's `baseBranch`; additional merge-tree checks compare the
   adopted lane HEAD against each source lane so existing work on the
   target lane is represented.
4. Creating/committing the proposal either reuses the adopted lane
   (`integrationLaneOrigin: "adopted"`) or creates an ADE-owned lane
   (`"ade-created"`). Cleanup messaging follows that origin: deleting a
   proposal keeps adopted lanes by default.

The corresponding database columns are
`integration_proposals.preferred_integration_lane_id` and
`integration_proposals.merge_into_head_sha`. iOS mirrors both in its
bootstrap schema and `IntegrationProposal` model so synced PR workflow
cards can display the same state.

## Timeline + Rails overview (PRs tab redesign)

`PrDetailPane` renders two different layouts for the Overview tab
depending on `prsTimelineRailsEnabled` in `PrsContext`:

- **Legacy grid** — the original checks/reviews/comments cards.
- **Timeline + Rails** — `PrDetailTimelineRails` with a central event
  timeline, a left rail (commits + push-time checks), and a right
  rail (merge readiness + reviewers/labels/participants metadata).

The right rail is itself split into two resizable panels via
`react-resizable-panels`:

- **Top: `PrDetailMergeRail`** — hosts the `PrMergeChecklist`
  (requirement rows + inline update-branch split button), the primary
  merge button that opens the portaled `PrMergeDialog` (method picker,
  editable commit message, command-line instructions, admin override),
  the live-status re-poll loop that clears the "Checking mergeability…"
  state, the branch cleanup affordance, the lane-management entry, and
  (for non-open PRs) reopen / close actions. See [Merge flow](#merge-flow).
- **Bottom: `PrDetailRightMetadataRail`** — reviewers + labels editors,
  participants list, "Request AI review" entry (`PrRequestAiReviewDialog`),
  and the review-submit modal launcher (`PrReviewSubmitModal`).

The left rail (`PrDetailLeftRail`) stacks `PrCommitRail` in pane
layout on top of `PrPushChecksRail`, which renders a compact
"checks passing" banner over a `PrCheckList` grouped into
`ci` / `security` / `bots` / `other` buckets.

Below the timeline column itself, `PrCommentComposer` renders an
inline shell-of-`ChatComposerShell` text area that posts an issue
comment without the user having to switch sub-tabs.

Per-PR state (all persisted to `localStorage` under
`ade:prs:timelineFiltersByPrId`, `ade:prs:dismissedAiSummaries`,
`ade:prs:timelineRailsEnabled`):

- `PrTimelineFilters` — which event types to show (description,
  commits, reviews, threads, comments, checks, deployments, labels,
  merges).
- `dismissedAiSummaries[prId]` — whether the AI summary card is
  collapsed for this PR.
- `viewerLogin` — authenticated GitHub login used to highlight
  reactions the viewer already placed.

Deep linking: `prsRouteState` carries `eventId`, `threadId`,
`commitSha`, and `detailTab` in the URL. `PRsPage` preserves them as
long as the URL still points at the selected PR and drops them when the
PR changes. `PrDetailPane` reads them on mount to scroll / open the
right card and to pick the right sub-tab. `PRsPage` also writes the
most recent `/prs...` path to `localStorage` via `writeStoredPrsRoute`
scoped per project root, so the top-bar `TabNav` can route back to the
user's last PR selection when they click the PRs tab from elsewhere.

Event sources: `buildTimelineEvents` prepends a synthetic `pr_opened`
event (title, PR number, head/base branches, draft flag, additions /
deletions) before folding in description, review threads, activity
entries, and per-check status. The activity stream reaches GitHub-event
parity: alongside commits, comments, reviews, label changes, merges, and
deployments it carries lifecycle changes (closed / reopened / ready /
converted-to-draft), cross-references, renames, head/base branch ref
changes, assignment changes, review requests and removals, and review
dismissals. Inline review threads render as grouped "X reviewed" blocks
(matching GitHub's merge-box framing) with the full reply chain and diff
hunks; commits are grouped and force-push entries render "from `<a>` to
`<b>`" with the before/after SHAs. Usernames, SHAs, and PR/issue
references are clickable and open on github.com externally via
`window.ade.app.openExternal`, and authors render real avatars (with the
Gravatar identicon fallback for unlinked commit authors). Commits are
deduplicated across `PrActivityEvent.commit_push` entries and the
`getCommits` snapshot — with the activity path winning so force-push
metadata survives — and render as a full-width "commit divider" between
review / comment activity bands. The reconciler also derefs
comments/reviews seen in both review-thread and activity sources by
comment / review id so the timeline never double-renders a thread reply.

Keyboard shortcuts (bound only when Timeline+Rails is active and the
Overview tab is selected):

| Chord | Action |
|------|--------|
| `g c` | Open the commit palette |
| `g t` | Open the unresolved-threads palette |
| `g f` | Open the changed-files palette |
| `[` / `]` | Prev / next unresolved thread |

## AI summary cache

`prSummaryService` generates a `PrAiSummary` (summary text, risk
areas, reviewer hotspots, unresolved concerns) via the AI integration
service and caches it in `pull_request_ai_summaries` keyed by
`(pr_id, head_sha)`. Pushing new commits advances `head_sha`
(maintained by `prService.upsertFromGithub`) so the next read misses
and the summary regenerates. `regenerateSummary` forces a rebuild
regardless of cache state.

## Delta polling cursor

`prPollingService` writes `last_polled_at` on every PR after a
successful tick. The cursor is exposed via `getLastPolledAt(prId)` so
downstream services that hit GitHub with `since=` parameters (review
threads, comments) can skip work they already saw. The cursor is
best-effort — failures log a warning and do not abort the tick.

## Renderer wiring

- `PRsPage` parses URL state via `parsePrsRouteState` and writes it
  back with `buildPrsRouteSearch`. Active tab, workflow sub-tab,
  selected PR, queue group, lane, and rebase item are all encoded.
- `PrsContext` mounts cheaply on the plain GitHub PR list. The initial `refreshCore` only kicks a background GitHub refresh when the active tab is a workflow tab (`queue` / `integration` / `rebase`) or a PR is selected; otherwise `githubRefreshMode` is left undefined so the renderer paints from the existing snapshot. `applyLocalPrState` calls `prs.listWithConflicts({ includeConflictAnalysis: false })` and `lanes.list({ includeStatus: false })` for the plain list, then enables conflict analysis, rebase-needs scans, and auto-rebase status reads only when a workflow tab or selected PR needs them.
- Workflow surfaces batch PR merge context through `prs.getMergeContexts(prIds)` instead of fanning out one `getMergeContext(prId)` call per card. The service builds the batch from metadata-only lane rows so queue/integration/rebase views do not pay full git status cost on render. Conflict analysis also runs as one batch over metadata-only active lanes, preserving overlap warnings against non-PR peer lanes without per-PR conflict calls.
- `PrsContext` owns PR list, queue states, rebase needs, proposals,
  and the Timeline+Rails UI state
  (`prsTimelineRailsEnabled`, `timelineFiltersByPrId`,
  `dismissedAiSummaries`, `viewerLogin`, `detailReviewThreads`,
  `detailDeployments`, `detailAiSummary`). It exposes
  `setTimelineFilters`, `setAiSummaryDismissed`, and
  `regeneratePrAiSummary`.
- `PrDetailPane` is where most rich behavior concentrates:
  issue resolver modal, rebase banner, check/review/comment sections
  with running indicators (`PrCiRunningIndicator`), merge readiness
  with bypass checkbox, PR markdown rendered with `rehype-sanitize`
  after `rehype-raw`.
- `GitHubTab` renders the active repository's PR snapshot; filter tab
  counts respect the active ADE/unmanaged scope. Legacy
  `externalPullRequests` entries are ignored even if an old cache
  contains them.

## Mobile snapshot

`prService.getMobileSnapshot()` produces a `PrMobileSnapshot` for the
iOS PRs tab in one call (exposed over sync as
`prs.getMobileSnapshot`). Types live in
`apps/desktop/src/shared/types/prs.ts`.

```ts
type PrMobileSnapshot = {
  generatedAt: string;
  prs: PrSummary[];
  stacks: PrStackInfo[];                              // lane chains with >=1 PR
  capabilities: Record<string, PrActionCapabilities>; // per-PR action gates
  createCapabilities: PrCreateCapabilities;           // which lanes can create
  workflowCards: PrWorkflowCard[];                    // queue/integration/rebase
  live: boolean;                                      // false → phone banner
};
```

Builder responsibilities:

- **Stacks** (`buildStackInfos` / `collectStackMembers`) — walks
  `laneService.list` in parent → child order, tagging each member
  with `role` (`root | middle | leaf`), `depth`, and linked PR fields
  when a PR exists for the lane. Stacks without any PRs are dropped.
- **Capabilities** (`capabilitiesForPr`) — gates `canMerge` on
  `state === "open"` and non-failing checks; blocks merges on drafts
  and closed/merged PRs with an explicit `mergeBlockedReason`.
  `requiresLive` is always true today — all listed actions need a
  live host.
- **Create eligibility** (`buildCreateCapabilities`) — enumerates
  non-primary, non-archived lanes, marks lanes as ineligible when an
  open/draft PR already exists, and resolves the default base branch
  through `resolveStableLaneBaseBranch`.
- **Workflow cards** (`buildWorkflowCards`) — pulls non-terminal
  queue entries from `queue_landing_state` joined with `pr_groups`,
  active integration proposals via `listIntegrationWorkflows({ view:
  "active" })`, and active rebase needs from
  `conflictService.scanRebaseNeeds()` (filtered to `kind ===
  "lane_base"` with `behindBy > 0`). Using the same source the desktop
  Rebase tab consumes
  via `window.ade.rebase.scanNeeds` keeps the phone's rebase cards
  in sync with the desktop — including drift against a local `main`
  that hasn't been pushed yet, which `rebaseSuggestionService` misses
  because it only reads `origin/<base>`. Hide / snooze rebase-banner
  actions (`lanes.dismissRebaseSuggestion`,
  `lanes.deferRebaseSuggestion`) update only `rebaseSuggestionService`;
  they do not dismiss or defer the underlying `conflictService` rebase
  need, so unresolved drift stays actionable in PR workflow surfaces.
  Failures in any source log a warning and skip that card category
  rather than failing the whole snapshot.

The snapshot is read-only; create/merge/close/comment actions go
through the existing command surface (`prs.createFromLane`,
`prs.land`, `prs.close`, `prs.addComment`, `prs.rerunChecks`,
`prs.draftDescription`). The mobile client calls `getMobileSnapshot`
on open and re-fetches on focus or after a successful mutation.

## Gotchas

- **Branch name validation in `CreatePrModal`** runs before submission
  and rejects invalid git ref characters. Skipping this produces
  opaque errors from the GitHub API.
- **`rehype-sanitize` must run after `rehype-raw`** in the PR body
  renderer. Flipping the order lets attacker-controlled HTML through.
- **Fingerprint exclusion list.** `getPrFingerprint` omits four
  fields. Adding a new volatile field without updating the exclusion
  list causes polling to emit notifications on every tick.
- **Queue transitions use `ALLOWED_TRANSITIONS`.** Invalid
  transitions are logged and rejected rather than silently applied.
  Cancel path force-fails entries in non-skippable states.
- **Post-merge cleanup is best-effort.** Never wrap the merge itself
  in the same try-catch; the merge must be reported succeeded even
  if cleanup fails.
- **Conflict marker parser handles CRLF.** `parseConflictMarkers`
  matches both `\n` and `\r\n`. Windows checkouts depend on this.
- **Review thread resolution uses GraphQL.** `prService`'s GraphQL
  path backs `getReviewThreads`, `replyToReviewThread`, and
  `resolveReviewThread`. The REST API does not expose all the
  required fields. These mutations also work on unmapped GitHub-tab
  PRs that have no `pull_requests` row: the renderer addresses them by
  a synthetic `gh:owner/repo#num` id, `parseSyntheticGithubPrId`
  resolves the repo for the ownership check, and the mutations key on
  the global thread / comment node id. `assertThreadBelongsToPr` still
  confirms the thread belongs to the PR before mutating, so a
  UI-supplied `threadId` can't target a foreign thread.
- **`mergeStateStatus` needs the merge-info preview header.** The
  GraphQL merge-box query passes
  `Accept: application/vnd.github.merge-info-preview+json`; without it
  GitHub errors with "field requires preview header" and the merge box
  silently falls back to the REST heuristic (logged at `warn`).
