# Pull requests

ADE's pull-request surface manages lane-backed PRs, native GitHub stacks,
integration (merge-plan) proposals, and GitHub inspection. It treats local git state as the source of truth for
merge/integration simulation while keeping remote GitHub state warm
through layered caching.

This folder documents:

- [`github-stacked-prs.md`](./github-stacked-prs.md) — native GitHub stack membership, reconciliation, and ADE UI.
- [`conflict-simulation.md`](./conflict-simulation.md) — how ADE predicts PR merge conflicts before the user hits Merge.

## Where this runs

PR mutations, GitHub polling, stack reconciliation, integration proposal
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

For remote-bound windows, GitHub polling and stack reconciliation execute on
the remote machine. The git operations that back PR
merges, rebases, and conflict resolution use the worktrees on the
remote host. Status reads work exactly the same as local; the desktop
window just sends every action through the SSH-tunneled JSON-RPC
instead of the local socket.

Background PR polling lives in whichever process backs the window's
runtime. In packaged / installed builds the desktop window is
runtime-bound, so the ADE daemon owns the `prPollingService` instance
(created, started, and disposed in `apps/ade-cli/src/bootstrap.ts`)
whose ticks emit the PR events consumers render as `prs-updated`; the
daemon also starts the automation ingress relay subscriber/drain loop there, which feeds
`prService.ingestGithubWebhook` for webhook-driven freshness (see
[automations](../automations/README.md#runtime-ownership)). Without
this the desktop main process no longer hosts the loop in production,
so PR state would only refresh when a surface issued a direct read. For
local-bound windows the desktop main process still owns its own
`prPollingService`: it is scheduled at project init as the
`prs.polling_start` background task (gated by `ADE_ENABLE_PR_POLLING`,
allowlisted in startup stability mode) and is also lazily started on
the first PR read through `ensurePrPolling` in `registerIpc.ts`.

## Which machine answers a PR read

A lane's PR row lives in the `.ade` database of the machine that owns the
lane — the same ownership rule that governs the lane itself (`worktree_path`
is an absolute path on exactly one machine) and the sessions that inherit
their machine through `laneId`. A PR read therefore has to name a machine,
exactly as a chat or terminal read does.

Every `pr` domain read in preload takes an optional trailing
`OpenProjectBinding` pin. `callPrReadRuntimeActionOr(pin, action, request,
local)` routes through `callPinnedOrBoundRuntimeActionOr`, so a pinned read
resolves on the lane's own machine while an unpinned one resolves on the
machine the project tab is bound to. `pin: null` is a stated choice rather
than an absence: the PRs tab is bound-machine-scoped by design, so every
tab-scoped call site passes `null` explicitly. `prs.onEvent(cb, pin)` obeys
the same rule — a pinned surface subscribes to the owning machine's
`prs-updated` / `pr-reconcile` feed, because the bound runtime's feed
describes a different database and would leave a pinned PR pill permanently
stale.

Reads are pinned; writes are not. Creating a PR is a write against the lane's
worktree, and the inline creator derives branch, base, and Linear links from
the bound machine's lanes, so a pinned `ChatPrPane` renders
`Switch to <machine> to open one` in place of `ChatPrInlineCreator` instead
of offering a button that cannot work. Opening a PR is machine-bound in one
direction: the PRs tab resolves a PR id against the bound machine only, so a
foreign PR's chip opens GitHub — the one destination that means the same
thing from either machine. `openLanePr` in
`apps/desktop/src/renderer/lib/lanePrBadge.ts` is the single implementation of
that decision, shared by the sidebar badge, the session card and its hover
card, the chat Git toolbar, and the chat PR pane, so a fourth caller cannot
reintroduce the dead end. Its foreign branch falls back to `window.open` when
the main process's `openExternal` allowlist rejects a URL that arrived from a
paired machine.

Cross-machine PR rows reach the renderer through the Work union
(`apps/desktop/src/renderer/state/crossMachineLanes.ts`): each machine's slice
(`CrossMachineMachineLanes`) carries `prs` alongside `lanes` and `sessions`,
read with `pr.listAll` on the **lane** cadence rather than the faster chat
cadence — a PR is only ever rendered by joining it to a lane and changes on
the same slow scale a lane does, so paying for a foreign round trip every ten
seconds would buy nothing the cadence does not already exist to avoid. The PR
read goes out in parallel with the lane and session reads on a cadence tick,
so it costs no extra latency; only the off-cadence catch-up (a chat naming a
lane the machine has never reported forces a mid-tick lane read) issues a
sequential PR read, deliberately, so a slow PR round trip never holds a
machine's lanes and chats out of the store. The read is best-effort: a machine
that answers `lane.list` but fails `pr.listAll` still contributes its lanes and
sessions, and `mergeCrossMachineLanes` retains the machine's last reported PR
rows whenever the key is omitted. `decodeForeignPrs` validates every field the
badge path actually reads — `id`, `laneId`, `headBranch`, `githubPrNumber`,
`githubUrl`, `state` — and drops a row missing any of them, because a badge
reading `PR #undefined` or one whose click is a silent no-op is worse than no
badge.

`useLanePrsByLaneId` folds the bound machine's event-driven read together with
each union machine's rows into one map with three namespaced key spaces and no
bare lane ids. Lane ids are not unique across machines — cross-machine handoff
copies a lane, id included — so "which machine" is part of the identity of a PR
lookup, and a bare id that doubled as "the bound machine's answer" let a
foreign machine's PR render on a bound-machine row whose badge deep-linked into
a PRs tab that could not resolve it.

| Key space | Accessor | Read by |
|-----------|----------|---------|
| `bound:<laneId>` | `boundMachineLanePrs` | every row on the machine the tab is bound to, so purely local render paths need no machine id |
| `<machineId>:<laneId>` | `lanePrsForMachine` | a foreign row — its own machine's answer, never another's |
| `any:<laneId>` | `laneHasAnyPr` | the Has PR filter chip, the only lookup that may ignore machine identity |

The GitHub repo snapshot is deliberately not re-read per machine: it describes
the repository, not a machine, so one snapshot joins correctly against every
machine's lanes. Per-machine maps are memoized on the reference-stable `lanes`
/ `prs` arrays `mergeCrossMachineLanes` hands out, so chat churn on one machine
does not rebuild the union.

The hosted web client has a single host and cannot route a pin to a second
one, so its `prs` adapter shims (`renderer/webclient/adapter/prs.ts`) run every
pin through `assertWebRuntimePinRoutable`. A pin naming the host and project
this adapter is already bound to is a no-op and proceeds unpinned; anything
else throws rather than silently answering from the only host they have.

## Source file map

Services. The canonical implementations run inside the runtime
daemon; the desktop main-process files below stay as fallback targets
for the legacy in-process IPC path.

CLI and agent entry points:

| File | Responsibility |
|------|---------------|
| `apps/ade-cli/src/cli.ts` | User-facing `ade prs` commands and text formatters. `ade prs create --text` prints both the GitHub PR URL and the ADE HTTPS PR URL when repo owner/name and PR number are available. |
| `apps/ade-cli/src/adeRpcServer.ts` | Private action/RPC wrapper for PR tools. `create_pr_from_lane` returns `{ pr, githubUrl, adeUrl }` so agents can include both links in closeout. Its `summarizePrChecks` delegates to the shared `rollupPrChecks` rather than carrying its own pass/fail rule, so the agent-facing `overall` is the full `PrChecksStatus` (including `not_run`) and a PR with zero checks no longer reads green. |
| `apps/desktop/src/main/services/ai/tools/workflowTools.ts`, `ctoOperatorTools.ts` | Managed chat/CTO PR creation tools return both `githubUrl` and `adeUrl` alongside the PR object. |

Service files (`apps/desktop/src/main/services/prs/`):

| File | Responsibility |
|------|---------------|
| `prService.ts` | PR CRUD, GitHub sync, merge context, draft descriptions, check/review/comment hydration, cached detail snapshots (`listSnapshots`), commit snapshots (`getCommits`), integration proposals, merge-into-existing-lane adoption, merge bypass, post-merge cleanup, standalone PR branch cleanup (`cleanupBranch`), deployment listing, review-thread reply/resolve/react mutations for the timeline, the aggregate `getMobileSnapshot` that powers the iOS PRs tab, and `listOpenPullRequests` — a paginated `/repos/{owner}/{name}/pulls?state=open` fetch returning `BranchPullRequest[]` for the lane-creation branch picker. `getForLane(laneId)` resolves through `getDisplayCandidateForCurrentLaneBranch`: it returns the best PR whose head branch matches the lane's current branch ref, considering both mapped `pull_requests` rows and unmapped `github_pr_projections` rows (folded in as synthetic `gh:owner/repo#num` summaries with `unmapped: true`), ranked open/draft → merged → closed then most-recently-updated / created / highest PR number, so a freshly merged PR still shows in lane-scoped UI instead of disappearing the moment GitHub flips the state — and a lane whose PR was created outside ADE still badges from the projection alone. A primary lane whose branch equals its base is excluded. `listPrsByLane()` walks `laneService.list` and applies the same candidate selection over one shared read of mapped rows + projection rows. `getGitHubSnapshot` fetches repo PRs, backfills same-repo lane PR rows by branch, and performs a capped per-branch fallback (`head=<owner>:<branch>`) for active lane branches missing from the repo snapshot window so old merged/closed externally-created PRs can still badge lanes. On PR open, `publishLinearPrCardsForLane` combines the lane's own Linear references with `collectLinearPrIssueReferencesForLaneSessions(laneId)` — issues attached only to a chat/CLI session in the lane (via `laneService.listLinearIssuesForLaneSessions`, authoritative for sessions whose lane mirror never landed) — deduped via `dedupeLinearPrIssueReferences`, so a session-only issue still gets a PR attachment. When the optional live-status round-trip is enabled (`getLinearLiveStatusService`, gated by `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`) it also posts a PR-link comment back to each linked issue. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). `computeStatus` / `getStatusByGithub` fetch the authoritative GitHub merge box over GraphQL (`mergeStateStatus`, `reviewDecision`, required/approving review counts, `viewerPermission` for bypass) and fold it into `PrStatus`; `getStatusByGithub` does the same for unmapped GitHub-tab PRs keyed only on `owner/repo#num` coords. `computeStatus` is also the single derivation of `checksStatus` / `checksReason` / `checksMissingRequired`: it normalizes check runs and legacy combined statuses, resolves required contexts through `requiredChecks.ts`, and calls `rollupChecks` — the webhook path re-enters here rather than trusting the delivered payload. See [Checks rollup](#checks-rollup-what-counts-as-a-pass). `land` takes an editable commit title/body (`commit_title`/`commit_message`, `--subject`/`--body` on the admin retry; ignored for `rebase`) and an `expectedHeadSha` stale-head guard, and `updateBranch` brings a behind branch up to date via GitHub's `update-branch` API (`merge` strategy) or ADE's local lane rebase + force-with-lease push (`rebase` strategy, conflict-aware). Review-thread reply/resolve/react mutations work on unmapped GitHub-tab PRs through synthetic `gh:owner/repo#num` ids (`parseSyntheticGithubPrId` resolves the repo; `assertThreadBelongsToPr` still verifies thread ownership). Commit rows carry an avatar URL — the linked GitHub avatar when present, else a Gravatar identicon derived from the commit-author email. `reconcileOnFocus({ force? })` is the catch-up safety net for the pollerless brain (in-memory 90 s throttle + single-flight, bounded merged-heal, 30-min `state:"all"` closed-sweep) and `syncLanePr(laneId)` is the manual per-badge sync; both heal merged/unmapped lane PRs and emit a `pr-reconcile` event. See [Keeping PR status fresh](#keeping-pr-status-fresh). |
| `prService.test.ts` | Feature-level service coverage, including mobile snapshot aggregation, paged GitHub history and exact state totals, webhook invalidation, unmapped mobile detail, and integration proposal behavior. |
| `requiredChecks.ts` | Three-tier resolver for a base branch's required status-check contexts, cached per `(repo, base branch)` behind a 5-minute TTL. Tier 1 is `/repos/{owner}/{repo}/rules/branches/{branch}` (repository rulesets) — read access is enough, so it answers for every credential source ADE supports. Tier 2 is `/branches/{branch}/protection` (classic protection), admin-only and therefore a 403 for most contributors, but the only source for repos that never migrated to rulesets. Tier 3 is `mergeStateStatus === "blocked"`, already fetched for the merge box: it cannot name contexts and conflates missing checks with review-required and out-of-date branches, so it is corroboration only — enough to strengthen a not-run finding, never enough to contradict a genuine pass. When all three come up empty the result is `null` contexts meaning **unknown**, never "none required". See [Checks rollup](#checks-rollup-what-counts-as-a-pass). |
| `prAsync.test.ts` | Shared bounded-concurrency and async helper coverage, plus the `prMergeAutoSettlementService` regression suite. |
| `pullRequestRowCleanup.ts` | The only writer of the detach columns. `detachPullRequestRowsForLane` stamps `detached_at` + the frozen lane identity and provenance when a lane is deleted, lifts `commit_count` / `changed_files` off the snapshot, nulls the bulky snapshot JSON columns, drops lane-scoped group membership, and removes live PR↔chat routing edges. `detachPullRequestRowsByIds` remains an explicit cleanup helper for callers that truly need to detach selected rows; ordinary branch switching retains previous-branch PRs as live lane history. `countLaneProvenance` must run *before* the caller deletes the lane's sessions / artifacts / checkpoints. `deletePullRequestRowsByIds` remains for genuinely destructive paths. See [Multi-PR lane ownership](#multi-pr-lane-ownership-and-chat-edges) and [Detached PR rows](#detached-pr-rows). |
| `prPollingService.ts` | Webhook-first PR freshness plus the direct-GitHub safety net. `reconcilePrs(prIds)` coalesces webhook-linked ids and refreshes only those rows immediately. A healthy relay suppresses hot polling and reduces broad refreshes to a 15-minute safety sweep; an unhealthy relay uses the configurable 60 s fallback (clamped to 5 s–5 min) and user-driven hot windows of 15 s for the first minute, then 30 s until the three-minute cap. Empty-cache discovery runs at most every 30 minutes with a healthy relay or 10 minutes without one. Before every network refresh, the poller honors credential cooldown/reset state and preserves the final 500 core/GraphQL requests for foreground actions. It writes `last_polled_at` per PR for delta polling. The ADE daemon owns an instance (created + started + disposed in `apps/ade-cli/src/bootstrap.ts`) for runtime-bound windows; the desktop main process owns the local-bound instance. |
| `prMergeAutoSettlementService.ts` | Applies the enabled lane-PR merge settlement policy after each polling snapshot. It files linked chat and tracked-agent-CLI sessions for a newly discovered merged PR even when normal settlement blockers or background work remain: the merge is the explicit override. Each PR is handled once, so user reactivation is not re-filed by that old merge, while another linked PR can file a later lifecycle. It emits `pr-sessions-auto-settled` only when the preceding in-memory snapshot contained that PR as open or draft. A first-sight merge — including backfilled history from another machine or the first snapshot after restart — is filed silently, so an imported history cannot generate merge toasts or push notifications. |
| `prChatCards.ts` | Converts bounded PR polling transitions into durable `ade_card` episodes for linked Work chats: CI completion/failure, review received, merge ready, conflicts, and merged. CI jobs are failure-first, capped at three visible rows with `rowsTruncated`, and report an honest `degradedReason` + Retry action when both job/check detail sources fail instead of rendering an empty success state. Desktop-main and daemon-owned pollers call the same emitter, and failures are isolated per PR/session so one cold or malformed chat cannot stop the poll loop. |
| `prSummaryService.ts` | AI PR summary generator; caches `PrAiSummary` per `(prId, headSha)` in `pull_request_ai_summaries` so pushes invalidate the cache |
| `workflowGraph.ts` | `createWorkflowGraph` — reconstructs the CI pipeline DAG (`PrWorkflowGraph`) behind a swappable `WorkflowGraph` interface. GitHub's jobs API does not return `needs:`, so the graph is built by parsing the workflow YAML that actually ran and joining it to live run state. Parses **only** `jobs.<id>.needs` and `jobs.<id>.strategy.matrix`, with the existing `yaml` dep. Source order: lane worktree `git show <headSha>:.github/workflows/<file>` → GitHub Contents API `?ref=<headSha>` (fork PRs / non-local repos) → `source: "none"` with an `unavailableReason`; it never guesses an edge. A single WORKFLOW degrades to flat swimlanes (not the whole graph) when a job uses a reusable workflow (`uses:`), has a `${{ }}` `name:`, or the YAML will not parse. Matrix legs collapse into one node whose state is the worst leg (failed > running > queued > passed > skipped); `tier` is a cycle-safe longest-path rank over `needs`; `criticalPath` is the longest-duration chain. Running nodes report live elapsed. Parsed YAML is cached per `(repo, headSha)` behind a TTL; the graph itself is always recomputed from live run state. |
| `checkLogParser.ts` | Pure parsing for `prService.getCheckLog`: strips the per-line ISO timestamp, splits a job log on top-level `##[group]` / `##[endgroup]` markers into step sections, selects the failing step's section, and lifts a framework summary headline (vitest/jest/pytest/go) — falling through to `null` rather than guessing. `prService` owns the bounded streaming download (the logs endpoint 302s to a pre-signed blob; the redirect is followed without the API token and reading stops past a few MB, setting `truncated`). |
| `githubPrStackService.ts` | Native GitHub stack decoding, persistence, and repository reconciliation |
| `integrationPlanning.ts` | `buildIntegrationPreflight` — validates source lanes for an integration proposal |
| `integrationValidation.ts` | `parseGitStatusPorcelain`, `hasMergeConflictMarkers` — shared helpers for integration flows |
| `prIssueResolver.ts` | Builds issue-resolution prompts for the agent, launches chat session |
| `prRebaseResolver.ts` | Builds rebase-resolution prompts, launches chat session |
| `resolverUtils.ts` | Shared permission-mode mapping, recent commit reading, comment noise filter, and the `looksLikeResolutionAck` heuristic that flags resolved-looking replies on unresolved review threads |

GitHub access and relay dependencies:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/main/services/github/githubService.ts`, `apps/ade-cli/src/headlessLinearServices.ts` | Desktop-local and runtime-owned GitHub request paths. Both build the environment → App → GitHub CLI → PAT read chain, skip the read-only App for writes, retry compatible credentials after auth/permission/rate failures, and expose the active/fallback sources through `GitHubStatus`. |
| `apps/desktop/src/main/services/github/githubCredentialHealth.ts`, `githubRateLimit.ts` | Token-digest health keyed by REST/GraphQL resource, five-minute invalid/permission cooldowns, rate-limit reset handling, same-account primary-quota propagation, and the 500-request background reserve. |
| `apps/desktop/src/shared/githubOperationCredential.ts`, `apps/desktop/src/shared/types/git.ts` | Capability-aware credential order and the optional status DTOs for source state, fallback, write availability, and background-pause time. |
| `apps/desktop/src/main/services/automations/automationIngressService.ts`, `apps/ade-cli/src/bootstrap.ts`, `apps/desktop/src/main/main.ts` | Relay cursor drain and targeted reconciliation, relay-health tracking, and injection of relay/quota state into the runtime-owned or desktop-local PR poller. |
| `apps/webhook-relay/src/relay.ts` | Hosted event/subscription authorization. Signed-in ADE account requests use the installed repository binding in D1 first; legacy clients fall back to a GitHub-token repository-access check. |

Branch-scoped `gh` lookup (`apps/desktop/src/main/services/git/`):

| File | Responsibility |
|------|---------------|
| `ghOpenPrLookup.ts` | `lookupOpenPrForBranch({ worktreePath, branch })` — the single implementation of "does this lane's branch have an open PR in *our* repo". Resolves the `origin` owner, runs `gh pr list --head <branch> --state open --json <fields> --limit 10` with an 8 s timeout, filters by head repo, and never throws (every failure degrades to the empty summary). See [Open-PR lookup for a lane branch](#open-pr-lookup-for-a-lane-branch). |
| `ghPrHeadRepo.ts` | Pure parsing/selection for that lookup: `GH_PR_LIST_JSON_FIELDS`, `GH_PR_LIST_LEGACY_JSON_FIELDS`, `parseGhPrListEntry` (lenient decode), `ghPrHeadRepoMatchesLane`, `selectOwnRepoOpenPr`, `EMPTY_GH_OPEN_PR_SUMMARY`, `GhOpenPrSummary`. |

`prService.ts` also owns the coordinate-based `getMobileGithubDetail`
aggregate for unmapped PRs and the opt-in repository state-count query used by
mobile. Count requests are single-flight and epoch-guarded, and snapshot
invalidation clears their cache so an older response cannot repopulate a newer
webhook generation.

Renderer components (`apps/desktop/src/renderer/components/prs/`):

| File | Responsibility |
|------|---------------|
| `PRsPage.tsx` | Top-level tab shell (GitHub vs Workflows) with URL-driven state. Consumes create-PR handoff params from either router search or hash search (`create=1`, `sourceLaneId` / `laneId`, `target=primary`) and the `prs.create` dialog bus props, then opens `CreatePrModal` with matching initial values without persisting the one-shot route as the last PR route. |
| `state/PrsContext.tsx` | PR data provider (list, selection, GitHub stacks, and rebase needs). Selected-PR primary reads apply progressively as status/check/review/comment requests resolve, so one slow piece does not hold the whole detail pane busy; cached snapshots stay visible during GitHub rate limits. |
| `prsRouteState.ts` | URL ↔ page state mapping plus project-scoped last-route storage. When a project root is known, the PRs tab reads only that project's stored route and does not fall back to the legacy global route from another project. |
| `CreatePrModal.tsx` | Single/integration PR creation with lane warnings, branch name validation, and optional initial values for single-PR handoffs from lane/chat surfaces. Normal PRs default the title to `source lane -> target lane`; a `target: "primary"` handoff resolves the base branch from the primary lane (falling back to `main`). |
| `tabs/NormalTab.tsx` | Normal PR list |
| `tabs/GitHubTab.tsx` | Repository PR browser with label filters, CI badges, review indicators, ADE-vs-unmanaged scope counts, and linked-lane context. State filter is one of `open` / `closed` / `merged` / `all`. The tab ignores legacy cross-repo `externalPullRequests` payloads; the "External" scope means repo PRs that are not managed by ADE. The "create lane from PR branch" affordance has been removed — open/closed PRs on branches without a lane no longer offer the preflight + create dialog (`prsPreflightCreateLaneFromPrBranch` / `prsCreateLaneFromPrBranch` IPC channels have been deleted), so creating a lane for an existing PR now goes through the standard lane creation flow. Snapshot rows are mapped through `reconcileLinkedPrState` (using `isTerminalPrState` from `renderer/lib/prState.ts`) into `reconciledItems`; `computeTerminalOverlayItems` then appends last-seen rows for linked ADE PRs that went terminal but dropped from an open-only snapshot, producing `displayedItems`, so a terminal ADE PR state (merged/closed) overrides a stale non-terminal GitHub row and a just-merged row is not erased before a full-history fetch (see [Terminal-state precedence](#terminal-state-precedence)). The selection effect follows a PR into its new bucket on merge/close and the detail pane pins the selected PR through the transition behind a `PrBucketTransitionBanner` rather than blanking (see [Selection follow and detail-pane pinning](#selection-follow-and-detail-pane-pinning)). The Merged/Closed buckets are rendered through `shared/prListGrouping.ts` with sticky period headers; terminal rows collapse to two lines and swap queue signals for merge facts (see [Terminal bucket rendering](#terminal-bucket-rendering)). |
| `tabs/IntegrationTab.tsx` | Integration (merge-plan) proposals and execution, including merge-into-lane selection, apply-and-resimulate, and adopted-lane cleanup messaging |
| `tabs/RebaseTab.tsx` | Lane rebase needs (base + PR target) and attention items. Hide/snooze controls only affect the lane rebase suggestion banner; still-behind needs remain actionable in the Rebase view. |
| `tabs/WorkflowsTab.tsx` | Container for integration and rebase workflows. The Rebase/Merge history view is backed by actual ADE rebase operation records, while active rebase needs include any lane still behind its target regardless of banner hide/snooze state. |
| `tabs/rebaseWorkflowModel.ts` | Pure model for active rebase bucketing and operation-history filtering |
| `detail/PrDetailPane.tsx` | Selected PR detail pane: status, checks, reviews, comments, files, commits, merge readiness, bypass, and resolver flows. Rich detail/files/commits/action-run reads render progressively; late cached snapshot hydration can update snapshot-owned fields but cannot overwrite richer live data. Persists the selected sub-tab (`overview | files | checks`) per PR in `localStorage` under `ade:prs:detailTabs:v1`, mirrored through the `detailTab` URL param so deep links restore the selected tab. The old `activity` target remains accepted as an alias for Overview. The failing-log drawer's **Fix in chat** action queues a bounded log excerpt into the lane's most recent Work chat (or a new-chat draft) and then navigates there. `UnmappedPrBanner` is suppressed for terminal PRs — both of its actions require an open PR and a live head branch, so on a merged PR it was a warning with nothing behind it; the merge rail's shipped summary carries that space instead. |
| `detail/PrDetailTimelineRails.tsx` | Resizable Timeline+Rails overview: central `PrTimeline`; a left rail with the commit pane plus a capped files-changed card; and a right rail ordered reviewers/metadata → checks (the vertical growth target) → merge readiness pinned at the bottom. Left/right widths are pixel-preserving, drag-resizable, and persisted per project. Seeds the timeline with description, review threads, activity-stream entries (commits, comments, reviews, label changes, merges, deployments), and check fallbacks. `buildTimelineEvents` pins the description first after the stable timestamp sort. Owns deep-link scrolling and merge-bypass plumbing. |
| `detail/PrChecksTab.tsx` | CI workspace with Graph / List / Failures views. Graph nodes come from `PrWorkflowGraph`; unparseable or unmapped PRs degrade to honest workflow swimlanes. Matrix legs collapse to pips, running jobs show live elapsed time and step progress, stale-head runs are called out, and the first failing job auto-opens an on-demand log drawer with copy/full-log/re-run/Fix-in-chat actions. |
| `shared/PrTimeline.tsx` | Timeline column: renders the pre-computed `PrTimelineEvent[]` from `PrDetailTimelineRails`, handles per-PR filters (`PrTimelineFilters`), and groups events. Bot review cards (`PrBotReviewCard`) and long bot-authored issue comments render collapsed by default so a late Greptile/Copilot/codex review or a large "## ADE review" summary shows a clamped preview with a Show more/less affordance (`CollapsibleCommentBody`) instead of dumping a wall of text at the end of the thread; `isLongBotCommentBody` gates a comment as long at >12 lines or >900 chars. |
| `shared/PrDetailMergeRail.tsx` | Merge readiness panel. Hosts the GitHub-style `PrMergeChecklist` (one row per requirement, with the inline "Update branch" split button on the behind-base row), the primary "Merge" button that opens the portaled `PrMergeDialog`, the branch-cleanup affordance, and the inline lane-management entry. Owns the per-PR live-status re-poll loop that keeps `mergeStateStatus` fresh and clears the "Checking mergeability…" state. Calls helpers from `prMergeRailUtils.ts` to build the checklist and derive merge-method labels. Once merged, the rail's banner carries `PrShippedSummary`: merger + merge method + merge time, then commit/file counts and how long the PR was open, then the frozen `was: <lane>` provenance line. Every line is independently omitted, so a PR merged before ADE recorded this shows less rather than showing blanks. |
| `shared/PrMergeDialog.tsx` | Portaled merge dialog (in `LaneDialogShell`, so its method dropdown is never clipped by the rail). Method picker (`squash` / `merge` / `rebase`, remembered default), editable commit title/body seeded from `buildDefaultCommitMessage` with a "reset to GitHub default" affordance (hidden for `rebase`), collapsible command-line instructions, a stale-head guard that re-seeds defaults if the PR head advances while open, and an admin "Override & merge" path (two-click arm/confirm) shown only when the viewer `canBypass` and the merge box is `blocked`. Returns `{ method, commitTitle, commitBody, bypassRules, expectedHeadSha }`. |
| `shared/PrMergeChecklist.tsx` | GitHub-parity requirement checklist for the merge surface: a header pill (`Checking mergeability…` while `mergeabilityComputing`, `Draft`, `Merging is blocked`, or `Ready to merge`) over a row per requirement (conflicts, behind base, checks, review). Renders approving-review avatars on the review row and the inline update-branch split button (merge commit / rebase) on the behind row. |
| `shared/PrDetailRightMetadataRail.tsx` | Right-rail stack for reviewers/labels/participants plus the checks summary. It feeds `shared/PrChecksCard.tsx`, which renders required contexts from `checksMissingRequired` that never reported as dimmed ghost rows above the reported checks, and gates its own header on `checksStatus` so a producer-blind row count cannot claim a pass. Review actions are folded into the reviewer section; the checks section grows to consume remaining height instead of leaving a dead lower gutter. Also owns the "Request AI review" and review-submit dialogs. |
| `shared/PrCommitRail.tsx` | Commit list rail. Reused inside both the left timeline rail (pane layout) and standalone surfaces (rail layout); resolves commit selection via `activeSha` + `onSelectCommit`. |
| `shared/PrFilesChangedCard.tsx` | Capped lower-left summary of changed files and additions/deletions; opens the Files tab without competing with the growing commit pane. |
| `shared/PrCheckLogDrawer.tsx` | On-demand failing-step log surface shared by the checks workspace: bounded excerpt, failure headline, copy/full-log, job-scoped rerun, and Fix in chat. It never fetches until opened. |
| `shared/prListGrouping.ts` | Pure day/week grouping for the terminal buckets. `buildPrListRows(items, { grouped })` interleaves `PrListGroupHeader` rows into an already-sorted, newest-first item array without reordering it; `prListGroupLabel` names the period (`Today`, `Yesterday`, `This week`, `Last week`, a Monday-anchored `Jul 21 – 27` range within the same year, else `July 2026`); `prListGroupTimestamp` files a row under `mergedAt` → `updatedAt` → `createdAt`; `prListHeaderIndices` feeds sticky-header pinning; `formatPrListGroupDiff` renders the per-period `+1.2k −380` aggregate. Open PRs are deliberately ungrouped — a work queue reads better flat. iOS mirrors the same rules in `PrHelpers.swift`. |
| `shared/prCheckList.tsx` | Pure compact check rendering and live-duration math shared by PR summary surfaces. |
| `shared/prMergeRailUtils.ts` | Shared merge-rail helpers: `mergeMethodLabel` / `mergeMethodShortLabel`, `canAttemptMerge` (prefers `status.mergeStateStatus`, falls back to the legacy boolean), `buildMergeChecklist` (the per-requirement rows driven by `mergeStateStatus` + `reviewDecision`), `buildDefaultCommitMessage` (GitHub-style default merge/squash commit title + body), `deriveMergeBlockers`, `buildMergeCommandLineInstructions`, `deriveParticipants`, `reviewStateForLogin`, `isBotLogin`. Consumed by the merge dialog, checklist, metadata rail, and the timeline composer plumbing. `buildMergeChecklist` and `deriveMergeBlockers` both take the verdict from the canonical rollup (`status.checksStatus ?? pr.checksStatus`) rather than from `summarizeChecks`' row counts, which are producer-blind; a `not_run` rollup becomes a neutral "No CI has run on this commit" row instead of "All 3 checks passed". |
| `shared/prUnifiedChecks.ts` | Reconciler between GitHub `PrCheck` rows and `PrActionRun.jobs`. Produces `UnifiedCheckItem[]` so the Checks sub-tab can display Actions jobs and named checks in a single list with steps + duration + details URL. |
| `apps/desktop/src/shared/prPipelineState.ts` | Canonical status/conclusion → pipeline-state mapping and worst-state ranking used by service graphing, chat cards, and renderer rollups so cancelled/unknown/running jobs cannot be classified differently by surface. |
| `apps/desktop/src/shared/prChecksRollup.ts` | The canonical checks rollup — the single answer to "was this commit verified?". Two entry points: `rollupChecks(input)` for the service, which sees check runs, legacy commit statuses and required contexts separately; and `rollupPrChecks(rows)` for surfaces that only hold a flattened `PrCheck[]` (the ADE CLI, the `ade code` TUI, chat toolbars). State mapping delegates to `prPipelineState`, so the rollup can never disagree with the per-job rows rendered beneath it. Also exports `NON_CI_PRODUCER_APP_SLUGS`' predicates (`isCiProducerAppSlug`, `isCiProducerCheck`), the `COMMIT_STATUS_APP_SLUG` sentinel, `NO_CI_REASON`, and `CI_PENDING_GRACE_MS`. See [Checks rollup](#checks-rollup-what-counts-as-a-pass). |
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

Renderer PR helpers outside the PRs tab (the Work-surface badge/pill path):

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/renderer/lib/lanePrBadge.ts` | Lane-PR presentation and navigation contract. `selectPrimaryLanePr` picks the row a lane badges with, `lanePrStateLabel` / `lanePrStateColor` render its state, `lanePrDeepLinkPath` builds the in-app `/prs?tab=normal&prId=…` target, and `openLanePr(pr, { foreign, navigate, localPath? })` is the single answer to "where does this PR open" for every Work surface. A foreign PR goes to GitHub because a PR id resolves only on the machine that owns it; the local branch takes `localPath` when a caller (the chat Git toolbar) wants the richer route that also selects the lane. |
| `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` | The lane→PR map every Work surface reads. Builds the bound machine's map from a coalesced `prs.listAll` + GitHub snapshot refreshed by `prs-updated`, then folds in each union machine's `prs` slice. Exports the three namespaced key builders (`laneBoundMachineKey`, `lanePrCompositeKey`, `laneAnyMachineKey`) and their accessors `boundMachineLanePrs`, `lanePrsForMachine`, and `laneHasAnyPr` — see [Which machine answers a PR read](#which-machine-answers-a-pr-read). |
| `apps/desktop/src/renderer/lib/prReadCache.ts` | In-flight coalescing and cooldown for renderer PR reads (`listPrsCoalesced`, `refreshPrsCoalesced`, `refreshLinkedPrCoalesced`, `getGitHubSnapshotCoalesced`). The cache key is scoped by pin ahead of project root, so two reads differing only by pin are treated as reads of two different databases and never share an entry. |
| `apps/desktop/src/renderer/components/terminals/LanePrBadge.tsx` | The compact PR chip itself. Presentation only — its host supplies `onOpen`, which is always `openLanePr`. |
| `apps/desktop/src/renderer/lib/prChatScope.ts` | Pure chat-specific PR scoping. Explicit `pull_request_chat_sessions` edges win; rows with no edge use the lane fallback for legacy data, while a chat with no edge never displays another chat's explicitly linked PR. |

Shared contracts:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/shared/types/prs.ts` | PR DTOs and integration proposal contracts, including `preferredIntegrationLaneId`, `mergeIntoHeadSha`, `integrationLaneOrigin`, and `additionalInstructions` fields. `PrSummary.unmapped?: true` flags a projection-synthesized summary with no `pull_requests` row. `syntheticGithubPrId(coords)` / `parseSyntheticGithubPrId(id)` are the single source of the `gh:owner/repo#num` id format — both the service (projection-only summaries, coordinate fetches) and the renderer (keying unmapped GitHub-tab rows) import them from here instead of re-deriving the string. `MergeStateStatus` (lowercase mirror of GitHub's GraphQL merge-box enum) and `PrReviewDecision` drive the merge checklist; `PrStatus` carries `mergeStateStatus`, `reviewDecision`, `approvalsCount` / `requiredApprovals`, `mergeabilityComputing`, `canBypass`, and `headSha`. `LandPrArgs` adds `commitTitle` / `commitBody` (editable merge-commit message) and `expectedHeadSha` (stale-head guard) alongside `bypassRules`, which opts the merge into a `gh pr merge --admin` retry when GitHub rejects the standard merge. `UpdateBranchArgs` / `UpdateBranchResult` back the `merge` / `rebase` update-branch flow. `PrActionCapabilities` adds `mergeStateStatus`, `canBypass`, and `canUpdateBranch` so mobile renders the same merge state. `PrTimelineEvent` carries a `pr_opened` variant plus `lifecycle`, `cross_reference`, `renamed`, `branch_ref`, `assignment`, expanded `review_request`, and `review_dismissed` variants so the timeline reaches GitHub event parity; review-thread events now carry the full `comments` list (with `diffHunk`) and force-push commit events carry before/after SHAs. `PrEventPayload` adds a `pr-reconcile` variant (`state: "running" | "idle"`, `polledAt`) emitted around a catch-up reconcile so the renderer can show a "syncing…" affordance. `PrDetachedLane` (`at`, `laneName`, `laneColor`, `chats`, `artifacts`, `checkpoints`) and `PrMergedBy` (`login`, `avatarUrl`) back the merged view; `PrSummary` and `GitHubPrListItem` both carry `detached`, `mergedBy`, `mergeMethod`, `commitCount`, `changedFiles` (all optional and null-tolerant, because rows predating this feature have none). |
| `apps/desktop/src/shared/types/git.ts` | `BranchPullRequest` (branch / prNumber / title / state / url / author / updatedAt) — the lightweight PR shape returned by `prService.listOpenPullRequests` and consumed by the branch picker without going through `PrSummary`. `GitHubAutolink` (id / keyPrefix / urlTemplate / isAlphanumeric) backs `ade.github.listRepoAutolinks` / `ade.github.createRepoAutolink`. The same module owns the optional `GitHubStatus` credential-chain fields described in [GitHub connectivity model](#github-connectivity-model). |
| `apps/desktop/src/shared/types/conflicts.ts` | Conflict resolver DTOs; `PrepareResolverSessionArgs.additionalInstructions` is appended to generated resolver prompts. |
| `apps/desktop/src/shared/linearMagicWords.ts` | Pure helpers for PR/commit Linear references. `linearPrMagicWord` / `buildLinearPrReference` / `ensureLinearPrReference` (single-issue magic word in the PR body), `dedupeLinearPrIssueReferences` / `ensureLinearPrReferences` (multi-issue dedupe + injection), and `renderLinearPrIssueLinkSection` / `ensureLinearPrIssueLinkSection` (the `<!-- ade:linear-links v=1 -->`-fenced "Linked Linear issues" markdown block appended to PR bodies by `prService.applyLinearPrLinkage`). |
| `apps/desktop/src/shared/prMarkdownText.ts` | `normalizeEscapedMarkdownNewlines(text)` — unescapes literal `\n` / `\r\n` / `\r` / `\t` sequences that arrive in PR bodies after GitHub round-trips them through JSON. Used by `PrMarkdown` before handing the string to ReactMarkdown so escaped newlines render as paragraph breaks. |
| `apps/desktop/src/shared/ipc.ts` / `apps/desktop/src/preload/preload.ts` | PR IPC constants and renderer bridge for proposal simulation, update, commit, resolver, cleanup, and read flows. Read-heavy PR tab calls route to the remote runtime only for remote-bound windows and use in-process IPC for local-bound windows. Local PR/session push subscriptions are multiplexed so multiple renderer subscribers share one IPC listener per channel. |

For mobile, `types/prs.ts` also defines paged GitHub history metadata
(`pageLimit`, `repoPullRequestsMayHaveMore`, `repoPullRequestCounts`) and
`PrMobileGithubDetailSnapshot`, whose `unavailableParts` distinguishes a failed
optional sidecar from an authoritative empty result.

## Core model

`PrSummary` (selected fields, full type in `src/shared/types.ts`):

```ts
type PrSummary = {
  id: string;
  unmapped?: true;         // synthesized from a GitHub projection row; no pull_requests row
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
  checksStatus: PrChecksStatus;    // passing | failing | pending | none | not_run
  checksReason?: string | null;         // one sentence explaining a non-obvious rollup
  checksMissingRequired?: string[] | null; // required contexts that never reported
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

`unmapped: true` marks a summary that was synthesized from a
`github_pr_projections` row rather than a real `pull_requests` row — its `id`
is the synthetic `gh:owner/repo#num` coordinate (`syntheticGithubPrId`), and
consumers that need a DB-backed PR (chat live-refresh, `getChecks`) skip
unmapped summaries. See [Lane PR resolution](#lane-pr-resolution-mapped--unmapped).

## Checks rollup (what counts as a pass)

`apps/desktop/src/shared/prChecksRollup.ts` is the only place that decides
whether a commit was verified. Every surface — PR rows, Lanes, the workspace
graph, PR detail, the Work-chat `pr_ci` card, iOS, and the `ade code` TUI —
reads that verdict instead of counting rows itself.

The rollup answers **"was this code verified?"**, not "did anything succeed?".
Counting successes is producer-blind: three third-party apps can each report
`success` — a review bot that bailed while rate-limited, a preview deploy that
was cancelled by an ignored-build step, a comment bot — while GitHub Actions
registers no check suite at all, and a row count reads that as a green pipeline.

Three rules govern a green:

1. **State mapping goes through `prPipelineState`.** `skipped` and `neutral`
   cannot masquerade as success, and the rollup cannot classify a job
   differently from the per-job row rendered beneath it.
2. **A CI producer must have succeeded.** Producers are identified by a
   **denylist** (`NON_CI_PRODUCER_APP_SLUGS`: `coderabbitai`, `vercel`,
   `netlify`, `mintlify`, `greptile-apps`, `railway-app`, `graphite-app`,
   `cursor`, `sonarcloud`, `renovate`, `dependabot`, and friends) rather than an
   allowlist. An Actions-only allowlist was wrong in the dangerous direction:
   CircleCI, Buildkite, Azure Pipelines, Semaphore and Travis all report through
   the **Checks API** under their own slugs, so an allowlist marked those repos
   permanently unverified, silently and forever. The denylist's residual — an
   unrecognised bot can still carry a green — is caught by rule 3 wherever
   branch protection is readable.
3. **Required contexts that never reported hold the rollup back.** A satisfied
   branch-protection gate (`allRequiredPassed`) overrides the producer guess,
   because a repo whose CI is an app ADE does not recognise is still verified
   when its own merge gate is green. That override is evaluated **after** the
   in-flight check, so it can never claim "passed" while a job is still running.

Precedence inside `rollupChecks`: a real failure outranks everything (the
actionable fact is the red job, not the absent one) → anything in flight →
missing required contexts → satisfied required gate → any CI pass → CI producers
that all skipped → non-CI producers only, or a `blocked` merge state → nothing
at all.

`PrCheck.appSlug` carries the producing GitHub App's slug. Legacy combined-status
contexts get the literal `commit_status`, and those **are** CI — Jenkins,
Buildkite and CircleCI report that way. An absent slug is treated as CI by
`isCiProducerCheck` (the flattened-row path) because persisted rows, older hosts
and TUI action payloads predate the field; failing those closed would report "CI
has not run" for every legacy payload whose CI genuinely passed. The
payload-level predicate `isCiProducerAppSlug` is stricter and refuses to vouch
for an unattributed run.

### `not_run` vs `none`

`PrChecksStatus` has five values. `none` means nothing was observed **and**
nothing led ADE to expect anything — a repo without CI stays quiet. `not_run`
means something was expected and nothing verified the commit; it is the only one
of the two that is a finding. It reads muted everywhere — never the danger colour: a hollow dashed ring on desktop PR rows and PR detail and on iOS, and a muted dot or label on Lanes, the workspace graph, the `pr_ci` chat card, and the TUI.
the danger colour — absence is not failure) on desktop PR rows, Lanes, the
workspace graph, PR detail, the Work-chat `pr_ci` card, iOS, and the TUI. The
merge checklist and `deriveMergeBlockers` surface it as a neutral "No CI has run
on this commit" row rather than a pass.

### Grace window

`CI_PENDING_GRACE_MS` (5 minutes) holds the rollup at `pending` right after a
push, so a commit whose suite has not registered yet does not flash a spurious
"CI has not run". The clock is the earliest check `started_at` / status `created_at` whenever anything reported, and falls back to the PR's `updated_at` only when nothing has
including the comments posted by the very bots whose presence is the finding —
which reset a months-old unverified commit back to "hasn't run *yet*". A check's
own start time cannot be moved by a comment.

### Persistence and freshness

`pull_requests` (a `PHONE_CRITICAL` cr-sqlite CRR table) carries two columns for
the rollup:

- `checks_reason` — one generated sentence explaining a non-obvious rollup
  ("3 checks reported, none from a CI provider. CI has not run on this commit.").
  Null when the state speaks for itself. Surfaces render this instead of
  re-deriving an explanation. On `PrSummary` the field is both optional *and*
  nullable, and the difference is load-bearing at the upsert: absent means "leave
  the stored value alone" (partial summaries flow through `upsertRow` constantly),
  null means "clear it".
- `checks_missing_required` — JSON array of required contexts that never
  reported, in GitHub's declared order, rendered as dimmed ghost rows in the PR
  detail check list.

Both ALTERs go through `crrAwareDb`, which wraps them in `crsql_begin_alter` /
`crsql_commit_alter`, so the columns replicate to phones and other machines.
A change in the reason string or the missing-context list counts as a material
change for change detection even when `checksStatus` itself holds, because both
drive rendered content.

Both ingestion paths converge on one derivation: `ingestGithubWebhook` uses the
webhook payload only to resolve *which* PR changed, then hands those ids to the
poller (`onPrStateIngested` → `reconcilePrs`), which re-derives through
`computeStatus` — the same function the scheduled poll calls.
fetch preserves the previous rollup rather than persisting a false `not_run` —
the best-effort fetch returns `[]` on a 403, which is indistinguishable from
"this commit has no checks".

## IPC surface

Selected channels exposed through `preload.ts`. Read methods take an optional
trailing `OpenProjectBinding` pin — `getForLane`, `syncLanePr`, `listAll`,
`refresh`, `getStatus`, `getChecks`, `getComments`, `getReviews`, and the
`onEvent` subscription — routing the read to the machine that owns the lane.
See [Which machine answers a PR read](#which-machine-answers-a-pr-read).

- `ade.prs.createFromLane`, `ade.prs.createIntegration`
- `ade.prs.listAll`, `ade.prs.listProposals`, `ade.prs.listGithubStacks`
- `ade.prs.listOpenForRepo` — flat list of open PRs in the project's GitHub repo as `BranchPullRequest[]` (branch / number / title / state / url / author / updatedAt). Independent of `pull_requests` cache so the lane-creation branch picker can attach PR pills to branches that have no lane yet. See [features/lanes/README.md](../lanes/README.md) for the consumer.
- `ade.prs.land` for individual PRs; GitHub owns native stack merge and rebase actions
- `ade.prs.updateBranch` — bring a behind PR head up to date with its base (`strategy: "merge"` uses GitHub's update-branch API; `strategy: "rebase"` runs ADE's local lane rebase + force-with-lease push and reports `hasConflicts` when it can't auto-apply)
- `ade.prs.getStatusByGithub` — live `PrStatus` (incl. the GraphQL merge box) for an unmapped GitHub-tab PR addressed by `owner/repo#num` coords, without a `pull_requests` row
- `ade.prs.getMergeContext`, `ade.prs.getMergeContexts`, `ade.prs.listSnapshots`, `ade.prs.getStatus`, `ade.prs.getChecks`, `ade.prs.getReviews`, `ade.prs.getComments`, `ade.prs.getFiles`, `ade.prs.getCommits`
- `ade.prs.reconcileNow` — force one catch-up reconcile of the whole project's PR state (`reconcileOnFocus({ force: true })`); used by the post-auth auto-heal. `ade.prs.syncLanePr` — best-effort per-lane sync (the manual ⟳ on the PR chip) that heals a merged/closed lane PR or maps a merged-but-unmapped PR on the lane branch. Both route to the daemon `pr` domain (`reconcileOnFocus` / `syncLanePr`) for runtime-bound windows and to the in-process PR service for local-bound windows. See [Keeping PR status fresh](#keeping-pr-status-fresh).
- `ade.prs.cleanupBranch` — delete a merged/closed PR's local and/or remote branch without touching the lane (protected against deleting any primary-lane branch)
- `ade.prs.updateDescription`, `ade.prs.updateTitle`, `ade.prs.updateBody`, `ade.prs.setLabels`, `ade.prs.requestReviewers`, `ade.prs.submitReview`, `ade.prs.close`, `ade.prs.reopen`
- `ade.prs.getReviewThreads`, `ade.prs.replyToReviewThread`, `ade.prs.resolveReviewThread`
- `ade.prs.postReviewComment`, `ade.prs.setReviewThreadResolved`, `ade.prs.reactToComment` — GraphQL-backed mutations used by the timeline's thread cards
- `ade.prs.getDeployments` — deployments for the PR's head SHA, with the latest status status URL and environment URL
- `ade.prs.getAiSummary` / `ade.prs.regenerateAiSummary` — cached/forced `PrAiSummary` per `(prId, headSha)`
- `ade.prs.rebaseResolutionStart`
- `ade.prs.retargetBase` — re-point an individual PR's base branch
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
History-enabled snapshots also carry `repoPullRequestsMayHaveMore` and the
applied `pageLimit`. The mobile caller opts into
`history.repoPullRequestCounts`: one GraphQL query fetches exact Open / Merged /
Closed totals independent of the loaded row window, with cached projection
counts as the best-effort fallback. iOS uses those totals for the All-scope
category tabs and requests additional terminal-history pages only when the
user taps Load more; ADE/External scope counts are derived from the rows
already reconciled on-device.

PR rows in `tabs/GitHubTab.tsx` render the linked lane's color through
`LaneAccentDot` (resolved from the
app store via `useLaneColorById` / a `Map<laneId, color>`); the rest of the
row text inherits the lane color so a glance correlates a PR with its lane
across GitHub and Workflows views.

### Terminal-state precedence

A GitHub snapshot can lag ADE's own PR state — the repo-wide page window
is refreshed on a slower cadence than a merge/close the user just made.
When ADE holds an authoritative terminal state for a PR (`merged` or
`closed`) it wins over a stale non-terminal snapshot row for the same PR.
`isTerminalPrState` in `apps/desktop/src/renderer/lib/prState.ts` is the
shared rule: merged is permanent and closed only leaves via an explicit
reopen, so a terminal local state is never overwritten by an out-of-date
`open` / `draft` snapshot. Two renderer surfaces apply it:

- **GitHub tab** — `GitHubTab.tsx` maps each snapshot row through
  `reconcileLinkedPrState` into `reconciledItems`. When a row's linked ADE
  PR (`linkedPrId`) is terminal but the snapshot still shows it
  non-terminal, the row is rewritten to the ADE state (clearing `isDraft`
  and adopting the ADE title / `updatedAt`) before filtering, counting,
  and selection all read the derived `displayedItems`, so a just-merged PR
  is not still counted or listed as open.

  **Terminal-row overlay.** An open-only snapshot drops a PR entirely once it
  merges/closes, which would erase a just-merged row before a full-history
  fetch catches up. `GitHubTab` records every row it has actually displayed
  (`lastSeenRowByCoordRef`, keyed by `owner/repo#num`), and
  `computeTerminalOverlayItems` resurrects the last-seen row — reusing its id,
  lane, and labels — under the merged/closed bucket for any linked ADE PR that
  is terminal but absent from the snapshot. The overlay disappears once a
  full-history fetch reintroduces the authoritative row, or when a reopen makes
  the linked state non-terminal again. Rows never previously displayed produce
  no overlay (there is no lane/label context to synthesize).
- **Lane PR tag** — `lanePageModel.ts` `shouldPreferGithubPrTag` uses the
  same helper to decide whether a lane's GitHub-by-branch PR tag should
  override the ADE PR tag. It never prefers the GitHub tag when the ADE
  state is terminal and the GitHub state is not, so a lane badge does not
  flip back to "open" after the PR merges; when both states are
  comparable it still prefers the GitHub tag on a genuine state mismatch.

### Terminal bucket rendering

Open, Merged, and Closed answer different questions, and the list renders them
differently. Open is a queue: "what still needs me". Merged and Closed are a
log: "what shipped, and when". `GitHubTab` derives `terminal` from
`isTerminalPrState(item.state)` and changes four things when it holds.

- **Period headers.** `buildPrListRows` interleaves sticky day/week headers into
  the merged/closed lists only, each carrying the period's row count and summed
  `+adds −dels`. Grouping never reorders — it consumes an already-sorted,
  newest-first array — so the tab's sort stays the single source of row order.
  Both the flat and virtualized list paths render the same `PrListRow[]`.
- **Two-line rows.** CI dot, review indicator, and the branch row are dropped:
  the merge already answered all three. The `merged` state badge is dropped too
  (bucket, glyph colour and merge facts each say it); `closed` keeps its badge,
  because closed-without-merging is a genuinely different outcome.
- **Merge facts instead of branches.** `PrRowMergeFacts` folds
  `<merger> · <method> · → <base>` onto the meta line. Each part is omitted when
  unknown rather than rendered as a placeholder.
- **Relative time flips meaning.** Open rows age from `createdAt` ("how long has
  this been waiting"); terminal rows age from `mergedAt ?? updatedAt` ("when did
  this ship").

The lane column (`PrRowLaneChip`) has three distinct states. A mapped PR shows
the lane chip in the lane's colour. A detached PR shows the dim, action-free
ghost chip `was: <lane> · 3 chats · 2 proof`. A PR with no lane at all shows
*nothing* in the terminal buckets — absence already reads as "no lane", and
badging every merged row is what turned Merged into a wall of warnings — and a
chip in Open, amber only when `isPrRowMappable` says the badge leads somewhere
(unlinked, in-repo, open/draft, with a usable local head branch). Amber is
reserved for rows the user can act on.

### Selection follow and detail-pane pinning

The GitHub tab keeps the selected PR usable across a state transition (open →
merged/closed) instead of stranding the user on an empty filter:

- **Follow into the new bucket.** The selection effect tracks the selected PR
  together with its current effective bucket (`lastHandledSelectedRef`). On a
  fresh selection, or when the already-selected PR's bucket changes, it moves
  the active filter to the PR's bucket (`bucketForState`). A manual filter
  switch leaves the PR's bucket unchanged, so it never re-triggers the follow.
- **Pinned detail pane.** `selectedItem` is resolved by `selectedItemId` first,
  then falls back to the linked `selectedPrId` coordinate, so the detail pane
  survives a row momentarily dropping out of the list and never blanks
  mid-transition. When the selected PR's state no longer matches the active
  filter (`selectedBucketMismatch`), the pane shows a slim
  `PrBucketTransitionBanner` ("This PR is now Merged/Closed" with a "Show in …"
  action) instead of clearing, reusing the neighboring banner idiom (no new
  colors).

## Lane PR resolution (mapped + unmapped)

A lane's PR badge draws from two row sources, unified so a lane shows a PR
whether or not ADE created it:

1. **Mapped rows** — real `pull_requests` rows created/linked through ADE.
2. **Unmapped projection rows** — `github_pr_projections` rows for repo PRs
   ADE has seen over the GitHub snapshot / webhook path but that have no
   `pull_requests` row. `listUnmappedGithubProjectionRowsForDisplay` selects
   only projections with no matching mapped row (by
   `project + owner/repo + number`). `projectionToLanePrSummary` turns one into
   a `PrSummary` with `unmapped: true`, the synthetic `gh:owner/repo#num` id,
   and `checksStatus`/`reviewStatus` of `none` (projections carry no check or
   review detail).

`selectLanePrDisplayCandidate` filters both sources to the lane's normalized
branch, then `compareLanePrDisplayCandidates` picks one: terminal rank
(open/draft `0` → merged `1` → closed `2`), then newest `updatedAt`, then
newest `createdAt`, then highest PR number, with a mapped row breaking a final
tie. Projection matching (`projectionMatchesLaneBranchForDisplay`) also requires
the head repo to match the base repo (no fork PRs) and the projection's repo to
match the tracked `activeGithubRepo` (captured from the GitHub snapshot / status
so lane display never leaks a projection from a different repo).

`getForLane` and `listPrsByLane` both go through this path; `listPrsByLane`
only attaches live check counts for candidates backed by a mapped row (an
unmapped projection has no snapshot to read).

### Open-PR lookup for a lane branch

The resolution above answers "which PR row do we already know about for this
lane". A second, narrower path answers "does this branch have an open PR on
GitHub right now" by asking the `gh` CLI directly inside the lane worktree:
`gitOperationsService.getOpenPrForBranch` (behind `ade.git.getOpenPrForBranch`,
used by the chat Git toolbar and History's "Open branch PR" / "Copy PR link")
and the ADE action registry both delegate to `lookupOpenPrForBranch` in
`apps/desktop/src/main/services/git/ghOpenPrLookup.ts`.

**`gh pr list --head <branch>` alone is not a correct answer.** `--head`
matches on branch **name only**, across every fork of the repository, so a PR
opened from somebody else's fork that happens to use the same branch name is
returned — and, unfiltered, attaches itself to the lane. `lookupOpenPrForBranch`
therefore resolves the lane's own `origin` owner (`git remote get-url origin` +
`parseGithubRemoteUrl`) and hands the rows to `selectOwnRepoOpenPr`, which
picks the PR whose head-repo owner matches. Because `--head` matches across
forks the wanted row is not necessarily first, so the query asks for
`--limit 10` rather than `--limit 1`. The whole call is bounded by an 8 s
timeout and never throws; any failure degrades to the empty summary.

**Old `gh` degrades to the pre-filter behavior, not to nothing.** The head-repo
fields (`headRepositoryOwner`, `headRepository`) are only emitted by
`gh >= 2.47`, and `gh` rejects an unknown `--json` field with a non-zero exit
rather than omitting it — so requesting them against an older CLI would fail the
*entire* lookup and report "no PR" for every lane. Two rules prevent that:

- `parseGhPrListEntry` decodes leniently. `gh` renders those fields as objects
  (`{"login":"acme"}` / `{"name":"widgets"}`), though a bare string is accepted
  too, and an **absent** field means "cannot verify — accept", never "reject".
- On a non-zero exit the lookup retries once with
  `GH_PR_LIST_LEGACY_JSON_FIELDS` (`url,number,title,headRefName`), the four
  fields that have existed for as long as `pr list --json` has. Without an owner
  the head repo cannot be verified, and the lenient decode accepts those rows,
  so an old CLI lands on the old (unfiltered) behavior instead of on nothing.

The runner distinguishes three outcomes precisely so the retry decision is
sound: JSON on success, `""` when `gh` ran and exited non-zero (bad flag, not
authenticated, not a repo), and `null` when `gh` could not be run at all or
timed out — only the middle case can be helped by retrying with fewer fields.

### Projection sync on material refresh

When `upsertFromGithub` detects a material summary change it now also writes the
matching `github_pr_projections` row (state, `is_draft`, title, `updated_at`,
`synced_at`) and calls `emitPrsUpdated()`, so an unmapped lane badge and the
GitHub tab both track a PR's state without waiting for the next full snapshot.
The same path backfills GitHub's real `created_at` onto both the mapped row and
the projection: `upsertFromGithub` and `linkToLane` store the PR's GitHub
`created_at` (falling back to link time only when GitHub omits it) while keeping
`updated_at` as the link/observe time, so an adopted or externally-created PR
sorts by its true age.

### PR event fan-out (runtime)

In the daemon, the PR service's event emitter is wired through
`createPrEventFanout` (`apps/ade-cli/src/prEventFanout.ts`), which forwards every
`PrEventPayload` to multiple sinks with each sink isolated in its own
try/catch. Today those sinks are the runtime `pr_event` emitter (surfaced to
runtime-bound windows) and search indexing (`searchService.notifyPrChanged` on
`prs-updated`). A throw in one sink can no longer suppress the others.

## Multi-PR lane ownership and chat edges

`pull_requests.lane_id` is intentionally non-unique. A live lane may retain
multiple PR rows as it moves from one branch to another: a row whose
`head_branch` matches the lane's current branch is `active`; a row with a
different head branch is `previous`. This role is derived at read time, so a
branch switch does not rewrite or detach the PR history. `detached_at` is
reserved for deleting the lane (or an explicit destructive cleanup path).

`prService.listAll({ laneId })` returns the lane's complete live set for the
renderer. `getForLane(laneId)` remains a single-value compatibility bridge: it
prefers the current-branch PR and otherwise returns the newest previous-branch
row. New lane, Work, and chat surfaces should use the plural read so they can
show a primary badge plus a `+N` counter and a short list on hover/focus. The
primary state is the worst attention state across the set (conflicts,
changes-requested, or failing CI outrank pending, open, merged, and closed),
while the list keeps each PR's own state, CI, review, and active/previous
signals.

Chat ownership is a separate optional edge in
`pull_request_chat_sessions`. Creating or linking a PR from a chat records the
canonical `terminal_sessions.id` when that session is available. One chat can
therefore be linked to multiple PRs, and a PR can retain links to multiple
chats in the same lane. PR cards and merge auto-settlement use those explicit
edges; rows created before this table existed fall back to the lane's recent
eligible Work chat so old data stays useful. Deleting a lane or retiring a
session removes its live routing edges while preserving the PR row/history.

The edge table is a CRR table with a primary-key-only uniqueness contract and
is mirrored in the iOS bootstrap/migration schema and PR projection cleanup.
Do not add a unique secondary index; CRR conversion rejects it.

## Detached PR rows

A PR outlives the lane it was built in. The normal flow — merge, then delete the
lane and its branch — used to delete the `pull_requests` row with the lane,
which erased ADE's record that the PR was ever ADE's and took the CI outcome,
review result and diff stats with it. Instead the row is **soft-detached**.

**What a detached row is.** A `pull_requests` row with `detached_at` set. It
also carries `detached_lane_name`, `detached_lane_color`, and
`detached_provenance` (JSON `{ chats, artifacts, checkpoints }`). It is history:
a record that this PR was ADE's work, and which lane it was built in.

**Invariants — the parts that are easy to get wrong later:**

- **`detached_at` is the flag; `lane_id` is not.** `lane_id` deliberately keeps
  pointing at the deleted lane. It is `NOT NULL`, and `pull_requests` is a
  `PHONE_CRITICAL_CRR_TABLES` member — making the column nullable would mean
  rebuilding a CRR table, which cr-sqlite cannot do via `ALTER`. CRR conversion
  already strips the FK, so the dangling id is inert and doubles as a provenance
  key. **Never treat a non-null `lane_id` as proof the lane exists.**
- **Provenance is frozen, not derived.** The counts are taken at detach time
  because `terminal_sessions`, `computer_use_artifacts` and `checkpoints` are
  hard-deleted with the lane and there is no commits table. `countLaneProvenance`
  must therefore run *before* the lane-delete cascade, not after.
- **The first detach wins.** The stamping `UPDATE` is guarded by
  `detached_at is null`, so a later, unrelated detach cannot overwrite the
  original lane name.
- **Lane-scoped reads must filter; project-wide reads must not.** `prService`
  defines `LIVE_PR_ROWS` (`detached_at is null`) and applies it to every "what is
  this lane working on" lookup. Project-wide reads (`listRows`, the GitHub
  snapshot join) deliberately do not filter — that is how the merged view gets
  its provenance back.
- **Detaching is not free-form deletion.** `deletePullRequestRowsByIds` still
  exists for genuinely destructive paths; lane deletion must go through the
  detach helper so PR history and provenance survive the lane cascade.

**What detaches a row:** lane delete (`detachPullRequestRowsForLane`) and
explicit destructive cleanup through `detachPullRequestRowsByIds`. Ordinary
branch switching and rename-with-branch-change do not detach rows; their
previous-branch PRs remain live lane history and are role-labeled by the
renderer. Lane detachment also drops `pr_group_members` — group membership is
lane-scoped work in progress, not history — and prunes any group left empty.

**Storage does not grow.** Detach nulls `files_json`, `checks_json`,
`comments_json` and `reviews_json` on `pull_request_snapshots`, which frees more
than the retained row costs. `commit_count` and `changed_files` are lifted onto
the PR row first so the merged view survives the purge; the 60-day
`prunePrSnapshots` TTL remains the backstop for the rest.

**What may reclaim a detached row.** Only `upsertRow`, and only when *both* hold:
the target lane still exists, **and** it still tracks the PR's head branch. Lane
existence alone is not enough for legacy rows detached by an older branch switch
or an explicit cleanup path: a background refresh must not reattach a PR to a
lane that has since moved to a different branch. The branch check also settles
archived lanes correctly: one still on the branch may reclaim its PR, one that
moved on may not. Reclaiming clears all four detach columns, and is written as a
separate statement from the upsert so a plain refresh of a detached row — whose
`lane_id` still names its dead lane — can never resurrect it.

**Two row lookups, deliberately different.** `getLiveRowForRepoPr` answers "does
a lane already own this PR?" and backs the four ownership guards (auto-map by
branch, `discoverLanePullRequests`, create-lane-from-PR-branch, `linkToLane`), so
a detached row can never block re-mapping. `getRowForRepoPr` answers "is there a
row for these coordinates at all" and stays unfiltered, so `upsertRow` updates an
existing detached row instead of inserting a duplicate primary key. `upsertRow`
resolves by id first for the same reason.

Beyond `prService`, `LIVE_PR_ROWS` semantics are applied by `conflictService`
(rebase-need scanning), `autoRebaseService`, `rebaseSuggestionService`,
`reviewContextBuilder`, `laneService` (branch-rename and base-ref repair,
plus the "lane has a PR" delete guard), and the integration-proposal prune.

## Merge outcome metadata

A merged PR can describe how it shipped without another GitHub call.
`merged_by_login`, `merged_by_avatar_url`, `merge_method`, `commit_count`, and
`changed_files` are written by `recordMergeOutcome`, from two places:

- `land()` — the merge method is what the user picked, and the merging account is
  the authenticated viewer (GitHub's merge response does not name the actor).
- `computeStatus` — when the poller observes a PR that is already merged, the
  single-PR payload carries `merged_by`, `commits` and `changed_files` for free.

Writes use `coalesce`, so whichever observation arrived first wins and a later,
thinner one cannot blank out good data. The whole write is wrapped in a
try/catch that logs `prs.record_merge_outcome_failed` — merge metadata is a
nicety on a history view and must never fail a merge. All five columns are null
for PRs merged before this shipped, and every surface renders them as optional.

## GitHub connectivity model

`getStatus()` in `apps/desktop/src/main/services/github/githubService.ts`
returns a `GitHubStatus` shaped to be the single source of truth for GitHub
read and write availability. UI banners and badges read `status.connected` for
read access and `writeAuthSource` for mutations rather than inferring either
from token-storage fields.

Fields:

- `tokenStored`, `tokenDecryptionFailed`, `tokenType` — `classic` |
  `fine-grained` | `oauth` | `unknown`, detected from the active token.
- `userLogin`, `scopes`, `checkedAt` — outcome of `validateToken` (calls
  `GET /user`). Classic tokens populate `scopes` from
  `x-oauth-scopes`; fine-grained tokens never return that header so
  `scopes` is empty.
- `authSource` — the credential selected for reads, using environment → ADE
  GitHub App → GitHub CLI → stored PAT. The App credential is read-only.
- `writeAuthSource` — the first usable environment, GitHub CLI, or stored PAT
  credential. `none` means reads may remain connected through the App while
  create/update/merge actions remain unavailable.
- `credentialStates`, `credentialFallback` — optional per-source availability,
  capabilities, active roles, cooldown/failure state, and the active read
  fallback transition. Different sources that resolve to the same token are
  attempted once.
- `authFailure` — optional structured validation failure for compatibility
  with older runtimes: `rate_limited`, `invalid_token`, `permission_denied`,
  `network`, or `unknown`, with the original message and optional retry time. A
  present failure means ADE found credentials but could not finish validating
  a usable read path; clients must not reinterpret that as missing scopes.
- `rateLimit` — the latest quota headers (`limit`, `remaining`, `used`,
  `resetAt`, and `resource`) from the active status probe.
- `backgroundRefreshPausedUntil` — optional reset time exposed when the core or
  GraphQL quota of an available project credential reaches the 500-request
  reserve. Search's smaller independent bucket does not pause PR refresh.
- `repo` — auto-detected origin owner/name.
- `repoAccessOk: boolean | null`, `repoAccessError: string | null` —
  result of an explicit `GET /repos/{owner}/{name}` probe
  (`probeRepoAccess`). `null` means no probe was run (no repo to
  probe, or `getStatus` returned early on a token-error path).
- `connected: boolean` — computed by `computeConnected`:
  - `false` if token is missing or `userLogin` is null.
  - For the App: requires the repository probe to pass (or no repo to probe).
  - For `fine-grained` tokens: requires the repo probe to pass (or no
    repo to probe). This is the only reliable check because fine-grained
    permissions are not introspectable from headers; a token can
    authenticate as a user yet 403 every PR-tab call.
  - For `classic` / `oauth` tokens: requires
    `getGitHubTokenAccessState(scopes)`
    to report `hasRequiredAccess`.
  - For `unknown` token prefixes: best-effort — `userLogin` is enough.

Status is cached in-memory for 30 s. The cache is invalidated and re-probed when
the auto-detected repository or the head credential changes. The cache is also
bypassed when the caller passes `getStatus({ forceRefresh: true })` (Settings'
"REFRESH" button); forced refresh retries invalid/permission cooldowns so a user
can verify a repair immediately, but it still honors rate-limit resets.

Status changes broadcast through the `ade.github.statusChanged` IPC
channel (`window.ade.github.onStatusChanged`) every time
`setToken` / `clearToken` is called. `AppShell` subscribes so the
unconnected-banner state reflects the latest status the moment
Settings saves a new token — fixing the prior bug where Settings said
CONNECTED while the AppShell banner still said disconnected.

`renderer/components/settings/GitHubSection.tsx` and
`renderer/lib/githubIntegrationStatus.ts` distinguish:

- `tokenAuthenticated` — token decrypted and `userLogin` is populated.
- `isConnected` (`status.connected` from the backend) — the actual
  "GitHub reads are usable" gate. Drives the connected / needs-permission /
  not-connected presentation and allows App-only PR snapshots. Write actions
  use `writeAuthSource`; when it is `none`, ADE keeps reads live and asks the
  user to connect GitHub CLI or a PAT before changing GitHub.
- A structured auth failure takes precedence over permission inference.
  Healthy connections do not expose GitHub quota bookkeeping. If one
  credential is temporarily unavailable, Settings names the paused connection
  and the connection ADE is using instead, plus the retry time when GitHub
  supplied one. When no fallback remains, invalid credentials render a
  reconnect action; network and unknown validation failures render a
  retry/status action, with the raw error confined to Settings.
- A repo-probe-failed inline error renders when the token authenticated
  but the probe came back 403/404, with copy that asks the user to
  grant Contents (Read), Pull requests (Read and write), and Metadata
  (Read) on the active repo (fine-grained tokens) or to make sure the
  classic token has access to the repo.

The App Shell banner uses the same shared presentation helper as Settings. It
stays quiet when a fallback keeps reads and writes usable, distinguishes
App-only read access from a write-capable connection, and never advertises a
reconnect command for an account-level rate-limit pause.

## Background polling

`prPollingService` runs inside the process that backs the window's runtime —
the ADE daemon for runtime-bound (packaged) windows, the desktop main process
for local-bound windows (see [Where this runs](#where-this-runs)). With a
healthy GitHub App relay, webhook deliveries drive targeted refreshes and the
poller performs only a 15-minute safety sweep (30 minutes for empty-project
discovery). Relay health means the most recent cursor drain completed
successfully; a disabled or failed drain clears that signal so the poller's
next run uses the direct-GitHub fallback. Without a healthy relay the poller uses the configured 60 s default
interval (clamped to 5 s–5 min, jittered ±10%). Each sweep:

1. Pulls the current PR list via `prService`.
2. Computes a fingerprint per PR (excluding volatile timing fields:
   `lastSyncedAt`, `createdAt`, `updatedAt`, `projectId`).
3. Diffs against last seen fingerprints; only changed PRs trigger
   events/UI updates.
4. Emits `PrEventPayload` for lifecycle and status transitions
   (opened, reopened, closed, merged, checks failing, review requested,
   changes requested, merge ready).

A relay or local-webhook ingest can call `reconcilePrs(prIds)` before the next
scheduled tick. The service coalesces those ids and runs one targeted
`prService.refresh({ prIds })`; ids that arrive during a running tick schedule
one immediate follow-up. This preserves the real-time webhook feel without
turning each delivery into a broad repository refresh.

When the relay is unavailable, hot refresh is reserved for service-owned
activity expected to cause near-term GitHub transitions, such as merge-queue
progress, PR mutations, or a newly mapped PR row. It is strictly bounded: 15 s
reads for the first minute, 30 s reads until three minutes, then the normal
cadence resumes. A healthy relay suppresses the hot loop because webhook
reconciliation owns the fast path. Re-marking an already-hot PR retains the
original start time, and fingerprint changes discovered by the poller do not
mark PRs hot.

GitHub REST or GraphQL failures that carry a primary or secondary rate-limit
reset are typed with `rateLimitResetAtMs`. The poller waits until that reset plus
a small buffer and does not let webhook pokes bypass the pause. It also stops
when an available project credential's core or GraphQL bucket reaches 500
remaining, leaving that reserve for explicit user actions, and resumes
automatically after reset. A low search bucket does not pause PR polling.

When `prService` reports zero tracked PRs, the tick can force a full
repo-snapshot discovery (`discoverLanePullRequests`). Because that is
far heavier than a tracked-PR delta poll, it is throttled to at most once every
30 minutes with a healthy relay or 10 minutes without one for projects that
have no PRs yet (new users, non-PR projects). User-driven surfaces still
discover PRs on their own reads. The throttle seeds from epoch, not "never", so
the first tick after start still discovers.

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

## Keeping PR status fresh

PR state stays current through complementary layers:

1. **Webhooks** — the primary real-time path. The ADE GitHub App (relayed
   through the webhook relay) feeds `prService.ingestGithubWebhook` so a
   push/merge/review updates the local projection immediately (see
   [automations](../automations/README.md#runtime-ownership)). After each
   relay page is durably cursor-committed, linked PR ids are coalesced into one
   targeted REST reconciliation. A successful multi-page drain emits one
   reconciliation batch; if a later page fails, ids from already committed
   pages are still flushed. A successful drain marks the relay healthy. Failed
   relay polls mark it unhealthy, respect `Retry-After` when present, and use an
   exponential 30 s–15 min retry cooldown; `pollNow()` clears that cooldown for
   an explicit retry. Webhook results never start a hot-poll window. Signed-in
   account event reads and subscriptions authorize from the relay's installed
   repository binding without spending a GitHub REST request; the GitHub-token
   repository check remains as the legacy-client fallback.
2. **Background polling** — the safety net for missed or unavailable webhooks.
   A healthy relay reduces broad reconciliation to a 15-minute safety sweep;
   the 60 s cadence is retained only when webhook delivery is unavailable.
   When the relay is unavailable, bounded hot windows run only around
   service-owned changes expected to produce near-term GitHub transitions, with
   rate-limit-aware backoff and a 500-request reserve for direct user work. Poll
   results can notify consumers but cannot re-arm the hot window, so active CI
   does not amplify itself into a quota-exhausting loop.
3. **Reconcile-on-focus** — the broader catch-up path for a project that was
   dormant, unfocused, or missed enough events to require a snapshot sweep.
   `prService.reconcileOnFocus()` runs on project open
   (`prs.reconcile_on_open`) and on warm-reuse / deep-link focus. It is composed
   from existing TTL-cached, single-flighted primitives in three phases — an open
   sweep + auto-map (`getGithubSnapshot({ force: true })`), a bounded merged-heal
   that refreshes the stalest active rows (`RECONCILE_MERGED_HEAL_MAX = 25`), and
   a slower `state:"all"` closed-sweep (every 30 min) that backfills a
   merged-but-never-mapped PR onto its lane. Its guards are all **in-memory on the
   service instance** (a 90 s per-project throttle + single-flight), so they die
   with the context on eviction and never cross into the CRR-replicated `kv`
   table. `main.ts` adds a global anti-stampede limiter (`RECONCILE_GLOBAL_MAX =
   1`, jittered) so opening several projects at once cannot stampede GitHub, and a
   fire-time runner (`buildReconcileRunner`) re-resolves the live context when the
   queued reconcile fires: an in-process runtime reconciles directly, while a
   dormant/runtime-backed (production) context has no local `prService` and is
   routed to the daemon's `pr.reconcileOnFocus` action, where the always-on
   runtime actually owns the service. The default-on behavior has its own kill
   switch (`ADE_DISABLE_PR_RECONCILE=1`); it is never gated behind PR polling.
4. **Manual sync (per-badge ⟳)** — `prService.syncLanePr(laneId)`, wired to the
   ⟳ affordance next to the PR chip in `ChatGitToolbar`. It resolves the lane's
   current PR and refreshes it (or pulls `state:"all"` to map a merged-but-unmapped
   PR on the lane branch), then re-reads the linked-PR pill. Post-auth auto-heal
   fires `reconcileNow` so badges light up right after authorizing GitHub.

Both `reconcileOnFocus` and `syncLanePr` emit a `pr-reconcile` `PrEventPayload`
(`state: "running" | "idle"`) around each catch-up so the renderer can drive a
subtle "syncing…" spin on the PR chip. `ChatGitToolbar` subscribes to that event
in its own effect (keyed only on stable deps, not `linkedPr`) with a debounced
idle-hide, so a fast reconcile does not flicker and a `linkedPr` change cannot
strand the spinner.

## PR context loading

The PR page no longer assumes every tab loads every workflow query:

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

### PR episodes in chat

PR state appears in two intentionally different chat surfaces:

- **The PR companion panel answers “what is true now?”** It owns current
  rollups and may auto-open for high-level lifecycle/push transitions.
- **An `ade_card` transcript row answers “what happened then?”** It is one
  bounded episode, live while the episode is running and frozen when terminal.
  It remains in chronology to explain the surrounding agent conversation.

The polling change hook emits provider-independent, durable cards into every
explicitly linked non-archived Work chat for the PR. Variants are `pr_ci`,
`pr_review`, `pr_merge_ready`, `pr_merged`, and `pr_conflict` (conflicts and
behind-base transitions). CI cards use a stable
`prId + headSha + runAttempt` identity so all workflows in one attempt roll up
into one episode and pending → terminal updates merge
in place rather than append. Review cards include the latest reviewer and
unresolved-thread count. Every card carries a PR `navTarget`; CI targets include
`detailTab: "checks"` on desktop, iOS, and TUI/deeplink fallback. Rows without a
chat edge use the recent eligible Work chat in the PR's lane as a compatibility
fallback, so older PRs do not lose cards while new chat-specific links settle
the routing.

CI detail ranks failed → running → queued → unknown → skipped → passed and
shows at most three rows, followed by `+N more`. Rows are split into a **CI**
group and an **Other** group using the same `isCiProducerCheck` predicate as the
rollup, so preview deploys and review bots read as context rather than as the
headline; the non-CI group is capped at two rows. Required contexts that never
reported are named inline (up to three, then `+N more`), and the card's headline
is the canonical `checksStatus` — it never says "CI passed" off a row count. A
rejected GitHub runs/checks
request is kept distinct from a genuine empty result. If one source still
returns jobs, the card renders that real detail. If both leave the card empty,
the payload carries `degradedReason`, no false status metric, and a Retry
action. A later degraded re-emit preserves the last rich rows/progress/metrics
as stale instead of blanking the chronological episode.

`emitAdeCard` uses the normal durable transcript commit path, including for a
cold or idle provider session. It never relies on a model emitting special
prose, and it never uses the live-only envelope path, so cards replay after a
restart and sync to mobile. Unknown variants degrade to required `fallbackText`
plus the deeplink.

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

`PrDetailPane` always renders `PrDetailTimelineRails` for Overview; the
legacy grid and its feature flag have been removed. The horizontal group has
three pixel-preserving panels whose left/right widths are drag-resizable and
persisted per project:

- **Left — what changed:** `PrCommitRail` is the growth target and
  `PrFilesChangedCard` is capped below it.
- **Center — what happened:** `PrTimeline` owns the chronological thread and
  the inline comment composer. Author/avatar identity lives inside each
  comment/review card; the old dedicated avatar gutter is gone.
- **Right — can this land:** `PrDetailRightMetadataRail` starts with
  reviewers/labels/participants and lets its checks card consume the available
  vertical slack. `PrDetailMergeRail` is a separate, shrink-free card pinned at
  the bottom with enough width for behind-base copy and the update-branch
  control to wrap cleanly.

Below the timeline column itself, `PrCommentComposer` renders an
inline shell-of-`ChatComposerShell` text area that posts an issue
comment without the user having to switch sub-tabs.

Per-PR state (persisted to `localStorage` under
`ade:prs:timelineFiltersByPrId` and `ade:prs:dismissedAiSummaries`):

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
entries, and per-check status. After the stable timestamp sort it moves the
`description` event back to the top, so a PR carrying a wrong `createdAt`
(common on adopted / linked PRs) still shows its description first.
Bot-authored review cards and long bot issue comments render collapsed by
default (`CollapsibleCommentBody`), matching GitHub's treatment of noisy
review-bot output. The activity stream reaches GitHub-event
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
  selected PR, lane, and rebase item are all encoded.
- `PrsContext` mounts cheaply on the plain GitHub PR list. The initial `refreshCore` only kicks a background GitHub refresh when an integration/rebase workflow or selected PR needs it; otherwise the renderer paints from the existing snapshot. It also listens to lane lifecycle events so local and remote lane changes refresh the PR mapping without polling.
- Workflow surfaces batch PR merge context through `prs.getMergeContexts(prIds)` instead of fanning out one `getMergeContext(prId)` call per card. The service builds the batch from metadata-only lane rows so integration/rebase views do not pay full git status cost on render.
- `PrsContext` owns PR list, GitHub stack state, rebase needs, proposals,
  and the Timeline+Rails UI state
  (`timelineFiltersByPrId`, `dismissedAiSummaries`, `viewerLogin`, `detailReviewThreads`,
  `detailDeployments`, `detailAiSummary`). It exposes
  `setTimelineFilters`, `setAiSummaryDismissed`, and
  `regeneratePrAiSummary`.
- Chat-side PR surfaces (`ChatGitToolbar`, `ChatPrPane`) first scope the cached
  lane PR set to the selected chat's explicit edges, so one chat can show more
  than one PR without leaking another chat's PR. Rows with no edge retain the
  lane fallback for backwards compatibility. They then use
  `renderer/lib/prReadCache.ts` to coalesce and throttle a targeted
  `prs.refresh({ prIds })` for the linked PR when the pane or compact menu
  opens. This keeps chat PR badges near-live without forcing a repo snapshot
  refresh or broad background sync on every Work chat mount. The **manual** sync
  affordance is the ↻ in `ChatPrPane`'s title
  bar (`prs.syncLanePr`, then a re-read of the pane's PR); `ChatGitToolbar` is
  a status strip with no manual sync, so toolbar-only surfaces heal through
  reconcile-on-focus plus `prs-updated`. The pane spins for either a manual
  sync or a backend `pr-reconcile`, debounced 300 ms on the hide so a fast
  reconcile does not flicker. Its open/closed state is persisted per chat
  (see [Composer and chat UI](../chat/composer-and-ui.md#source-file-map)), and
  when a lane has no PR the pane embeds `ChatPrInlineCreator`, whose title
  defaults to the chat session title before falling back to the
  `<lane> -> <target>` derivation.
- Every chat-side PR surface takes a `runtimePin`: `ChatGitToolbar`,
  `ChatPrPane`, and `useChatPrAutoPop`, threaded from their hosts
  (`AgentChatPane` passes its `chatRuntimePin`; `WorkSurfaceHeader`,
  `CliSessionWorkSurfaceHeader` / `GridTileSessionHeaderActions`, and
  `WorkViewArea`'s CLI surface pass the session's owning binding). A chat or
  CLI session on another machine therefore gets the same PR pill, auto-pop,
  and pane as a local one — the pin just routes the reads and the event
  subscription to the lane's machine. Effects key on the pin's **key**, never
  its object identity: a local pin is reconstructed on every cross-machine
  merge, and depending on the object would blank the pill and re-anchor the
  pinned event pump on that timer. Two things stay bound-machine-only inside a
  pinned toolbar: `diff.getChanges` is unpinned, so the dirty-file count is
  skipped rather than asked about a lane the bound machine does not have; and
  PR creation falls through to the "switch machines" copy instead of the
  create-PR handoff.
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
  workflowCards: PrWorkflowCard[];                    // integration/rebase
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
  through `resolveStableLaneBaseBranch`. The aggregate lane read is
  metadata-only (`includeStatus: false`); it never probes every worktree's git
  status just to paint the PR tab.
- **Workflow cards** (`buildWorkflowCards`) — pulls active integration
  proposals via `listIntegrationWorkflows({ view: "active" })` and active
  rebase needs from
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
`prs.draftDescription`). The mobile create wizard now creates normal
PRs with `source lane -> target lane` titles and no AI-generated
title/body step; the explicit `prs.draftDescription` action remains
available to callers that request PR-description drafting directly.
The mobile client calls `getMobileSnapshot` on open and re-fetches on focus or
after a successful mutation. Unmapped GitHub projections are local-only on the
host, so webhook changes also emit a tiny `prs_updated` sync invalidation.
iOS coalesces event bursts, then performs one cached/projected GitHub snapshot
read with background revalidation disabled; it does not poll GitHub on a timer
or run one request per PR. The list
reconciles that projection with replicated `pull_requests` rows so mapped PRs
remain visible offline and a terminal local state cannot fall back to a stale
Open row.
Open / Merged / Closed totals come from one batched GraphQL count query cached
with the snapshot; row history remains independently paged, so accurate tab
counts do not require downloading the entire repository history.

The iOS list row intentionally follows GitHub's information hierarchy instead
of rendering every field as a badge: state symbol and title first, then PR
number/author/repository, followed by a compact branch, lane, check, review,
and comment signal row. It uses local symbols rather than network-fetched
avatars and precomputes filtered/reconciled rows when inputs change, keeping
scroll-time view work bounded.

The mobile PR **detail** screen (`PrDetailView`, a single-column
adaptation of the desktop Timeline+Rails layout) pulls its per-PR action
sidecars — review threads, activity feed, action runs, deployments, and this
snapshot's capabilities — separately, and keeps them live while open through a
warm-cache freshness gate keyed on both the
replicated PR revision and the lightweight remote GitHub revision. Mapped-row
changes arrive through the changeset stream; local-only projection changes use
`prs_updated`. The detail screen re-fetches sidecars at most once every 25 s.
See
[iOS companion → PR detail screen](../sync-and-multi-device/ios-companion.md#pr-detail-screen).

An unmapped PR uses the stable synthetic id `gh:owner/repo#number` and the
`prs.getMobileGithubDetail` aggregate. That command returns the core snapshot,
fresh list/header identity, review threads, action runs, and activity in one
controller round trip. Phone requests are single-flight per PR, and failed
optional sidecars are named explicitly so the phone preserves the last good
value and shows partial-data retry UI instead of caching an empty result as a
true zero. Partial aggregates use the normal 25 s freshness window as retry
backoff; explicit Retry bypasses it. The phone renders the same
description/files/checks/timeline it would for a mapped PR while keeping
mutation controls locked until the PR is mapped.
The compact unmapped notice starts collapsed and remembers its expanded state
per PR for the current scene. Its expanded actions offer both
create-from-branch and map-to-existing-lane, so mapping does not require backing
out to the list.

The mobile detail header is intentionally compact: a plain back chevron,
centered PR title with `#number · lane · branch`, and a plain ellipsis
actions button. The old large PR hero is replaced by a small summary section
showing a state/approval line and Checks, Changes, and Commits metrics. Commit
rows expand inline from that metric and tap into the same timeline anchors that
desktop uses for commit-focused navigation. PR descriptions additionally
normalize safe embedded GitHub HTML into Markdown and turn
`<details>/<summary>` regions into native disclosure rows, avoiding raw
Dependabot release-note markup. Other Markdown bodies are normalized for
escaped GitHub newlines and rendered through the shared mobile Work markdown
renderer;
collapsed comment/thread previews stay cheap text so large PRs do not pay
markdown layout cost for offscreen or folded content.

## Gotchas

- **Branch name validation in `CreatePrModal`** runs before submission
  and rejects invalid git ref characters. Skipping this produces
  opaque errors from the GitHub API.
- **`rehype-sanitize` must run after `rehype-raw`** in the PR body
  renderer. Flipping the order lets attacker-controlled HTML through.
- **Fingerprint exclusion list.** `getPrFingerprint` omits four
  fields. Adding a new volatile field without updating the exclusion
  list causes polling to emit notifications on every tick.
- **Hot polling must stay externally bounded.** Service-owned mutations or new
  mappings may begin a hot window; webhook and poll results use targeted
  reconciliation or normal notifications. Never reset a hot PR's start time
  from a refresh result, or active CI can consume the shared GitHub quota
  indefinitely.
- **A non-null `lane_id` does not mean the lane exists.** Detached rows keep a
  dangling `lane_id` on purpose (see [Detached PR rows](#detached-pr-rows)).
  Any new lane-scoped query over `pull_requests` must add
  `detached_at is null`, or it will attribute a deleted lane's PR to live lane
  state. Project-wide queries must *not* add it.
- **Count lane provenance before the delete cascade.** `countLaneProvenance`
  reads `terminal_sessions` / `computer_use_artifacts` / `checkpoints`, all of
  which are hard-deleted with the lane. Moving the detach call after the cascade
  silently freezes zeros.
- **New `pull_requests` columns must be mirrored on iOS.** The table replicates
  through cr-sqlite; a column the phone does not know about surfaces as a
  changeset-apply error on the phone, which nacks the whole batch and freezes
  sync for that device until an app update ships. Add a matching `ensureColumn`
  in `apps/ios/ADE/Services/Database.swift` whether or not any Swift view reads
  it, nullable and without a unique index.
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
