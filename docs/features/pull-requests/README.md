# Pull requests

ADE's pull-request surface manages lane-backed PRs, native GitHub stacks and
GitHub inspection. Local git state is the source of truth for merge
simulation; layered caching keeps the remote GitHub state warm. There is one
view, the GitHub list. A link with an unknown `tab` opens it.

Detail docs:

- [`github-stacked-prs.md`](./github-stacked-prs.md): native GitHub stack membership, reconciliation and the ADE UI.
- [`conflict-simulation.md`](./conflict-simulation.md): how ADE predicts merge conflicts before Merge.

## Where this runs

PR mutations, GitHub polling, stack reconciliation and issue-resolution agent
dispatch run in the **active ADE runtime**: the local runtime for a local
window, the remote runtime for a remote window. `window.ade.prs.*`
(`apps/desktop/src/preload/preload.ts`) is the routing boundary. PR polling
fingerprints, `prsRouteState.ts` and the PR detail panes are renderer-only and
hold no service state.

- A remote window runs PR reads on the remote runtime through
  `callPrReadRuntimeActionOr` (`domain: "pr"`). Polling, stack reconciliation
  and the git work behind merges, rebases and conflict resolution use the
  remote host's worktrees.
- A local window calls the in-process PR IPC handlers directly for
  high-volume reads (`listWithConflicts`, `getDetail`, `getStatus`,
  `getChecks`, `getReviews`, `getComments`, `getDetailBundle`, `getFiles`,
  `getCommits`, `getDeployments`, `getGitHubSnapshot`), so the PR tab does not
  wait for the local daemon. Mutations and long workflows use the runtime
  route where it owns the behavior.

Background polling lives in the process behind the window's runtime:

- A packaged, runtime-bound window: the ADE daemon owns `prPollingService`
  (`apps/ade-cli/src/bootstrap.ts`). Its ticks emit the events the renderer
  shows as `prs-updated`. The daemon also runs the automation ingress relay
  loop that feeds `prService.ingestGithubWebhook`
  ([automations](../automations/README.md#runtime-ownership)).
- A local-bound window: the desktop main process owns its own
  `prPollingService`. It starts at project init as the `prs.polling_start`
  background task (gated by `ADE_ENABLE_PR_POLLING`, allowed in startup
  stability mode), or on the first PR read through `ensurePrPolling` in
  `registerIpc.ts`.

## Which machine answers a PR read

A lane's PR row lives in the `.ade` database of the machine that owns the
lane, so a PR read names a machine, as a chat or terminal read does.

- Every `pr` read in preload takes an optional trailing `OpenProjectBinding`
  pin. `callPrReadRuntimeActionOr(pin, action, request, local)` routes through
  `callPinnedOrBoundRuntimeActionOr`: a pinned read goes to the lane's machine,
  an unpinned one to the tab's machine. `prs.onEvent(cb, pin)` subscribes to
  the owner's event stream.
- The PR tab joins machine-owned PR-to-lane mappings from the lane union with
  machine-scoped ids, and restores the original lane ids at the call boundary.
- Lane mutations go to the lane's owner. Creating a lane from a PR asks for a
  machine when more than one is eligible. Merge is unavailable while the owner
  is offline. The GitHub PR inventory stays repository-wide.
- `openLanePr` (`apps/desktop/src/renderer/lib/lanePrBadge.ts`) is the one
  implementation of "open this lane's PR", shared by the sidebar badge, the
  session card and its hover card, the chat Git toolbar and the chat PR pane.
  A foreign PR that no local workspace resolves opens on GitHub; when the
  `openExternal` allowlist rejects a URL from a paired machine, it falls back
  to `window.open`.

Cross-machine PR rows come through the Work union
(`apps/desktop/src/renderer/state/crossMachineLanes.ts`). Each machine slice
carries `prs` beside `lanes` and `sessions`, read with `pr.listAll` on the
**lane** cadence, in parallel with the lane and session reads:

- Only the off-cadence catch-up (a chat names a lane the machine never
  reported) reads PRs after the lanes, so a slow PR read never holds lanes and
  chats out of the store.
- The read is best-effort. A machine that answers `lane.list` but fails
  `pr.listAll` still gives its lanes and sessions, and `mergeCrossMachineLanes`
  keeps its last PR rows when the key is missing.
- `decodeForeignPrs` drops a row that lacks any field the badge reads (`id`,
  `laneId`, `headBranch`, `githubPrNumber`, `githubUrl`, `state`).

`useLanePrsByLaneId` folds the bound machine's reads and each union machine's
rows into one map with three key spaces and no bare lane ids. Lane ids are not
unique across machines (a cross-machine handoff copies a lane, id included).

| Key space | Accessor | Read by |
|-----------|----------|---------|
| `bound:<laneId>` | `boundMachineLanePrs` | rows on the tab's machine |
| `<machineId>:<laneId>` | `lanePrsForMachine` | a foreign row: its own machine's answer only |
| `any:<laneId>` | `laneHasAnyPr` | the Has PR filter chip, the only lookup that may ignore the machine |

The GitHub repo snapshot is read once, not per machine: it describes the
repository. Per-machine maps are memoized on the stable `lanes` / `prs` arrays
from `mergeCrossMachineLanes`, so chat churn does not rebuild the union.

The hosted web client has one host. Its `prs` adapter
(`renderer/webclient/adapter/prs.ts`) runs every pin through
`assertWebRuntimePinRoutable`: a pin that names the bound host and project
runs unpinned; any other pin throws.

Review status uses GitHub's review decision, with its required-review rules.
Moderator-hidden comments and reviews are left out of the timeline and counts
within the newest 100 of each.

## With no computer awake

PR rows (lane links, snapshots) live on machines. `usePrsReader`
(`components/prs/state/prsReader.ts`) picks where the PRs tab and the issue
panes read from:

| Reader | When | What shows |
|---|---|---|
| `machine` | An online copy of the repository | The full PRs tab, pinned to that copy. |
| `direct` | No machine online, a github.com repository, and `window.ade.githubDirect` | `DirectPrsList`: the open PRs, read-only, from GitHub with the account's sign-in. |
| `none` | Neither | "No computer is online", and no call. |

An ADE Cloud tab never pins a PR read to ADE Cloud. With no own computer
online it uses the `direct` reader.

The direct list (`lib/accountGithubReadStore.ts`, `useAccountGithubPulls`):

- It says "Read-only. Open ADE on a computer that has this project to work on
  these pull requests." Land, lanes, stacks and launch need a computer.
- Every component that shows the same request shares one read. It refreshes
  every 60 s only while shown and the window is visible; a hidden page passes
  no repository and reads nothing.
- Reads are ETag'd, so an unchanged answer is a `304` that GitHub does not
  count. A timed refresh is skipped while the rate limit is below 10 %.
- A state only a person can fix (not connected, App not installed) waits
  5 minutes between reads. A rate limit or an outage waits until GitHub's
  time, at least 60 s.
- An answer for another ADE account drops the stored data, so one account's
  reads never show for another.

**Lane chips.** Each row names its lanes on every machine, from one read of
the account lane index (`GET /account/lanes`, `useLaneMentionsByPr`) when the
list opens, never one read per row. Refresh reads it again. The index is for
mentions only: it never fills the Lanes tab, and a chip never renames or
deletes a lane. A lane on two machines is two chips; a PR whose branch has no
lane has none. `LaneMentionChip`:

- A lane on an online machine opens in the Lanes tab.
- A lane on a resting ADE Cloud computer wakes it first and opens once it is
  connected. A failed wake shows the server's sentence (from
  `wakeRestingCloudMachine`).
- A lane on an offline own computer does not open. It says "This lane is on
  <machine>, which is offline. Open it when <machine> is on."
- A failed index read shows a banner ("which lanes these pull requests are
  on") with Retry, and keeps the rows read before.

## Source file map

The services run in the runtime daemon. The desktop main-process files also
serve the legacy in-process IPC path.

CLI and agent entry points:

| File | Responsibility |
|------|---------------|
| `apps/ade-cli/src/cli.ts` | User-facing `ade prs` commands and text formatters. `ade prs create --text` prints both the GitHub PR URL and the ADE HTTPS PR URL when repo owner/name and PR number are available. `ade prs link-chat` / `unlink-chat` write the hybrid PR↔chat edge and the dismissal tombstone. |
| `apps/ade-cli/src/adeRpcServer.ts` | Private action/RPC wrapper for PR tools. `create_pr_from_lane` returns `{ pr, githubUrl, adeUrl }` so agents can include both links in closeout. Its `summarizePrChecks` delegates to the shared `rollupPrChecks` so the agent-facing `overall` is the full `PrChecksStatus` (including `not_run`) and a PR with zero checks is not green. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | Managed chat/CTO PR creation tools return both `githubUrl` and `adeUrl` alongside the PR object. |

Service files (`apps/desktop/src/main/services/prs/`):

| File | Responsibility |
|------|---------------|
| `prShellBodyRepair.ts` | Repair of a PR text a chat wrote with `gh`: footer, Linear reference and owned cited proof, one pass per PR at a time, skipped when the text changed meanwhile. See [Merge settlement scope](#merge-settlement-scope). |
| `prBodyProofStaging.ts` | Stages cited proof files and rewrites the citations for `gh pr edit --attach`; shared by `ade proof publish --in-body` / `ade prs body` and the repair. |
| `prService.ts` | PR CRUD, GitHub sync, check/review/comment hydration, cached detail snapshots (`listSnapshots`), commit snapshots (`getCommits`), merge bypass, post-merge cleanup, standalone PR branch cleanup (`cleanupBranch`, which resolves without a row but refuses fork PRs and any PR outside this project's repository), deployment listing, review-thread reply/resolve/react mutations for the timeline, REST comment edits via `prCommentMutations.ts`, the aggregate `getMobileSnapshot` that powers the iOS PRs tab, and `listOpenPullRequests` — a paginated `/repos/{owner}/{name}/pulls?state=open` fetch returning `BranchPullRequest[]` for the lane-creation branch picker. `getForLane(laneId)` resolves through `getDisplayCandidateForCurrentLaneBranch`: it returns the best PR whose head branch matches the lane's current branch ref, considering both mapped `pull_requests` rows and unmapped `github_pr_projections` rows (folded in as synthetic `gh:owner/repo#num` summaries with `unmapped: true`), ranked open/draft → merged → closed then most-recently-updated / created / highest PR number, so a freshly merged PR still shows in lane-scoped UI instead of disappearing the moment GitHub flips the state — and a lane whose PR was created outside ADE still badges from the projection alone. A primary lane whose branch equals its base is excluded. `listPrsByLane()` walks `laneService.list` and applies the same candidate selection over one shared read of mapped rows + projection rows. `getGitHubSnapshot` fetches repo PRs, backfills same-repo lane PR rows by branch, and performs a capped per-branch fallback (`head=<owner>:<branch>`) for active lane branches missing from the repo snapshot window so old merged/closed externally-created PRs can still badge lanes. It takes an `automaticRefresh` opt-out alongside `force` and shares one failure ladder (`githubReadBackoff.ts`) across the snapshot and the per-branch lookups — see [GitHub read failure ladder](#github-read-failure-ladder). On PR open, `publishLinearPrCardsForLane` combines the lane's own Linear references with `collectLinearPrIssueReferencesForLaneSessions(laneId)` — issues attached only to a chat/CLI session in the lane (via `laneService.listLinearIssuesForLaneSessions`, authoritative for sessions whose lane mirror never landed) — deduped via `dedupeLinearPrIssueReferences`, so a session-only issue still gets a PR attachment. When the optional live-status round-trip is enabled (`getLinearLiveStatusService`, gated by `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`) it also posts a PR-link comment back to each linked issue. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). `computeStatus` / `getStatusByGithub` fetch the authoritative GitHub merge box over GraphQL (`mergeStateStatus`, `reviewDecision`, required/approving review counts, `viewerPermission` for bypass) and fold it into `PrStatus`; `getStatusByGithub` does the same for unmapped GitHub-tab PRs keyed only on `owner/repo#num` coords. `computeStatus` is also the single derivation of `checksStatus` / `checksReason` / `checksMissingRequired`: it normalizes check runs and legacy combined statuses, resolves required contexts through `requiredChecks.ts`, and calls `rollupChecks` — the webhook path re-enters here rather than trusting the delivered payload. See [Checks rollup](#checks-rollup-what-counts-as-a-pass). `land` takes an editable commit title/body (`commit_title`/`commit_message`, `--subject`/`--body` on the admin retry; ignored for `rebase`), an `expectedHeadSha` stale-head guard, and an opt-in `deleteRemoteBranch` (default **false** — see [Deleting the head branch is opt-in](#deleting-the-head-branch-is-opt-in)). When the target PR is in a GitHub Stack, `land` delegates to `githubStackMerge.ts` and merges the stack through GitHub's async merge API instead of the single-PR endpoint. `updateBranch` brings a behind branch up to date via GitHub's `update-branch` API (`merge` strategy) or ADE's local rebase + force-with-lease push (`rebase` strategy, conflict-aware; the only PR mutation that genuinely needs a local checkout). Every mutation resolves its target through `resolvePrTarget(prId)`, which accepts either a `pull_requests` row id or a synthetic `gh:owner/repo#num` id and returns `{ repo, prNumber, row }` with a **null** `row` for the latter — so merge, close, reopen, comment, review, label, reviewer-request, re-run and branch cleanup all work on any PR in the repository, and only the *local bookkeeping* is conditional on a row (`refreshAfterMutation` re-reads the row and opens a hot window when there is one, and drops the activity memos plus invalidates the GitHub snapshot cache when there is not). See [A lane link is not a permission](#a-lane-link-is-not-a-permission). `assertThreadBelongsToPr` still verifies thread ownership for review-thread mutations. Commit rows carry an avatar URL — the linked GitHub avatar when present, else a Gravatar identicon derived from the commit-author email. `reconcileOnFocus({ force? })` is the catch-up safety net for a project that is unfocused, dormant, or was last seen on another machine (in-memory 90 s throttle + single-flight, bounded merged-heal, 30-min `state:"all"` closed-sweep), and `syncLanePr(laneId)` is the manual per-badge sync: for an unmapped lane it first looks up an open PR on the lane's own branch (one GitHub request) before falling back to the repo-wide `state:"all"` sweep; both heal merged/unmapped lane PRs and emit a `pr-reconcile` event. See [Keeping PR status fresh](#keeping-pr-status-fresh). |
| `prCommentMutations.ts` | Shared GitHub comment PATCH and reaction decoding used by the timeline. `createPrCommentMutations` owns `updateGithubCommentByCoords` (GET then PATCH an issue or review comment after verifying PR membership and that `resolveWriteViewerLogin` matches the comment author). `toPrComment` / `toPrReactions` / `reactionToGraphqlEnum` normalize REST counts, GraphQL reaction nodes, and `reactionGroups` (write-viewer `viewerHasReacted`). `resolveReactableSubjectId` maps a REST database id to a GraphQL node id before `addReaction`. `prService.updateComment` (IPC `ade.prs.updateComment`) and in-process `updateCommentByGithub` (review-session edits after a local PR row is gone) go through it; `reactToComment` resolves the subject then issues GraphQL `addReaction` in `prService`. |
| `prService.test.ts` | Feature-level service coverage, including mobile snapshot aggregation, paged GitHub history and exact state totals, webhook invalidation, unmapped mobile detail, comment-edit ownership, and the GitHub failure-ladder / never-pushed-branch behavior of the snapshot path. |
| `githubReadBackoff.ts` | The keyed failure ladder shared by every GitHub read `prService` makes: the whole-repo snapshot under `snapshot:<owner>/<repo>` and each targeted lane-branch lookup under `branch:<owner>/<repo>#<branch>`. `githubReadFailureBackoffMs(attempts, successTtlMs)` is a 20 s → 40 s → 80 s … ladder capped at 15 minutes and then **floored at the success TTL**, so a failed read always buys at least as much quiet as a successful one. `createGithubReadBackoff()` holds the per-key entries (`isBackedOff`, `lastError` to replay, `record` to arm/climb, `clear` for one key or all), expires them lazily against `Date.now()`, and sweeps expired keys on every write so a long-lived process does not accumulate one entry per branch it ever failed on. `markGithubRequestError` / `isGithubRequestError` tag the error so only GitHub arms the ladder — a snapshot rebuild also reads lanes and SQLite, and a local hiccup must not silence GitHub reads for minutes. See [GitHub read failure ladder](#github-read-failure-ladder). |
| `requiredChecks.ts` | Three-tier resolver for a base branch's required status-check contexts, cached per `(repo, base branch)` behind a 5-minute TTL. Tier 1 is `/repos/{owner}/{repo}/rules/branches/{branch}` (repository rulesets) — read access is enough, so it answers for every credential source ADE supports. Tier 2 is `/branches/{branch}/protection` (classic protection), admin-only and therefore a 403 for most contributors, but the only source for repos that never migrated to rulesets. Tier 3 is `mergeStateStatus === "blocked"`, already fetched for the merge box: it cannot name contexts and conflates missing checks with review-required and out-of-date branches, so it is corroboration only — enough to strengthen a not-run finding, never enough to contradict a genuine pass. When all three come up empty the result is `null` contexts meaning **unknown**, never "none required". See [Checks rollup](#checks-rollup-what-counts-as-a-pass). |
| `prAsync.test.ts` | Shared bounded-concurrency and async helper coverage, plus the `prMergeAutoSettlementService` regression suite. |
| `pullRequestRowCleanup.ts` | The only writer of the detach columns. `detachPullRequestRowsForLane` stamps `detached_at` + the frozen lane identity and provenance when a lane is deleted, lifts `commit_count` / `changed_files` off the snapshot, nulls the bulky snapshot JSON columns, drops lane-scoped group membership, and removes live PR↔chat routing edges. `detachPullRequestRowsByIds` remains an explicit cleanup helper for callers that truly need to detach selected rows; ordinary branch switching retains previous-branch PRs as live lane history. `countLaneProvenance` must run *before* the caller deletes the lane's sessions / artifacts / checkpoints. `deletePullRequestRowsByIds` remains for genuinely destructive paths. See [Multi-PR lane ownership](#multi-pr-lane-ownership-and-chat-edges) and [Detached PR rows](#detached-pr-rows). |
| `prPollingService.ts` | Webhook-first PR freshness plus the direct-GitHub safety net. `reconcilePrs(prIds)` coalesces webhook-linked ids and refreshes only those rows immediately. A healthy relay suppresses hot polling and reduces broad refreshes to a 15-minute safety sweep; an unhealthy relay uses the configurable 60 s fallback (clamped to 5 s–5 min) and user-driven hot windows of 15 s for the first minute, then 30 s until the three-minute cap. Repo-snapshot discovery runs at most every 30 minutes with a healthy relay or 10 minutes without one, whether or not PRs are already tracked: a PR opened with `gh pr create` has no row until a snapshot maps it to its lane by branch, and a viewer on another machine depends on the sweep because the desktop focus reconcile only reaches a project open on this computer. Before every network refresh, the poller honors credential cooldown/reset state and preserves the final 500 core/GraphQL requests for foreground actions. It writes `last_polled_at` per PR for delta polling. The ADE daemon owns an instance (created + started + disposed in `apps/ade-cli/src/bootstrap.ts`) for runtime-bound windows; the desktop main process owns the local-bound instance. |
| `prMergeAutoSettlementService.ts` | Applies the enabled lane-PR merge settlement policy after each polling snapshot. It files chat and tracked-agent-CLI sessions for a newly discovered merged PR even when the session has pending input or background work: the merge is the explicit override. It defers when a chat turn is running *right now* — see [Active-turn deferral](#active-turn-deferral) — and also when the session still has other open or draft **linked** PRs (`sessionHasOpenLinkedPrs`; unedged current-branch fallbacks do not count). **Which** sessions it may file is an explicit `MergeSettlementScope` union rather than an implicit fallthrough — see [Merge settlement scope](#merge-settlement-scope). Each PR is handled once — including when the scope resolves to `ambiguous` and nothing is filed at all, because this merge looked and decided — so user reactivation is not re-filed by that old merge, while another linked PR can file a later lifecycle. It emits `pr-sessions-auto-settled` only when the preceding in-memory snapshot contained that PR as open or draft. A first-sight merge — including backfilled history from another machine or the first snapshot after restart — is filed silently, so an imported history cannot generate merge toasts or push notifications. |
| `prChatCards.ts` | Converts bounded PR polling transitions into durable `ade_card` episodes for linked Work chats: CI completion/failure, review received, merge ready, conflicts, merged, and `pr_stack_land` when every GitHub stack sibling is merged. Stack-land cards use a stable `pr-stack-land:{owner}:{repo}:{stackNumber}` id so later layers merge in place, and they fan out to every linked chat even when those chats live on another lane. CI jobs are failure-first, capped at three visible rows with `rowsTruncated`, and report an honest `degradedReason` + Retry action when both job/check detail sources fail instead of rendering an empty success state. Desktop-main and daemon-owned pollers call the same emitter, and failures are isolated per PR/session so one cold or malformed chat cannot stop the poll loop. |
| `workflowGraph.ts` | `createWorkflowGraph` — reconstructs the CI pipeline DAG (`PrWorkflowGraph`) behind a swappable `WorkflowGraph` interface. GitHub's jobs API does not return `needs:`, so the graph is built by parsing the workflow YAML that actually ran and joining it to live run state. Parses **only** `jobs.<id>.needs` and `jobs.<id>.strategy.matrix`, with the existing `yaml` dep. Source order: lane worktree `git show <headSha>:.github/workflows/<file>` → GitHub Contents API `?ref=<headSha>` (fork PRs / non-local repos) → `source: "none"` with an `unavailableReason`; it never guesses an edge. A single WORKFLOW degrades to flat swimlanes (not the whole graph) when a job uses a reusable workflow (`uses:`), has a `${{ }}` `name:`, or the YAML will not parse. Matrix legs collapse into one node whose state is the worst leg (failed > running > queued > passed > skipped); `tier` is a cycle-safe longest-path rank over `needs`; `criticalPath` is the longest-duration chain. Running nodes report live elapsed. Parsed YAML is cached per `(repo, headSha)` behind a TTL; the graph itself is always recomputed from live run state. |
| `checkLogParser.ts` | Pure parsing for `prService.getCheckLog`: strips the per-line ISO timestamp, splits a job log on top-level `##[group]` / `##[endgroup]` markers into step sections, selects the failing step's section, and lifts a framework summary headline (vitest/jest/pytest/go) — falling through to `null` rather than guessing. `selectStepSection` returns the section **and** how it chose it (`named-step` / `errored-step` / `whole-log`); when neither a step name nor an `##[error]` identifies one it returns no section (the last section is the `Post Run …` cleanup group). `prService` owns the bounded streaming download (the logs endpoint 302s to a pre-signed blob; the redirect is followed without the API token and reading stops past a few MB, setting `truncated`). |
| `githubStackStore.ts` | Native GitHub stack decoding, persistence, and repository reconciliation |
| `githubStackMerge.ts` | `createGithubStackMerge` — merges a PR that is in a GitHub Stack through GitHub's async merge API. GitHub honors `bypass_rules` only for a merge of the bottom open PR, so a bypass merge from higher up runs layer by layer: each covered PR, bottom first, waits until GitHub has moved it to the bottom (`waitUntilBottom`, up to 3 minutes), then merges alone with the bypass, retrying a start GitHub refuses while it is still restacking. A layer that fails stops the run, and the result names the layers that did merge. A rules refusal without bypass says to merge again with "Bypass branch rules". `PUT .../pulls/{n}/merge-async` starts the merge of every open PR from the stack base up to the requested one (all or none); ADE polls `GET .../merge-async/{uuid}` for up to 20 s in the foreground, then keeps polling in the background for up to 15 minutes and answers `pending` in the meantime. A 409 follows the merge GitHub already runs; a poll-time rule failure surfaces from the poll, not the first call. `merge_queued`/`enqueued` is not treated as merged. After it settles, only the requested PR's lane is archived and each merged PR's branch is deleted only when GitHub reports the PR merged and no open PR still uses it as a base. |
| `prHeadChange.ts` | `createPrHeadChangeDetector` — the stale-head check shared by `land` and `githubStackMerge.ts`: `detect` compares a fresh (or just-read) head with `expectedHeadSha`, describes the move through the compare API, and refreshes the PR row; `afterMergeRefusal` does the same for GitHub's "Head branch was modified" refusal. `formatHeadChangeMessage` words the result. See [A moved head refuses the merge and says what landed](#a-moved-head-refuses-the-merge-and-says-what-landed). |
| `resolverUtils.ts` | Merge error formatting, admin-merge gate detection, recent commit reading, comment noise filter, and the `looksLikeResolutionAck` heuristic that flags resolved-looking replies on unresolved review threads |

GitHub access and relay dependencies:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/main/services/github/githubService.ts`, `apps/ade-cli/src/headlessLinearServices.ts` | Desktop-local and runtime-owned GitHub request paths. Both build the environment → App → GitHub CLI → PAT read chain, skip the read-only App for writes (except issue edits, `issue-write`, which use the App only when its installation grants `Issues: write`; see [Issues](../issues/README.md)), retry compatible credentials after auth/permission/rate failures, and expose the active/fallback sources through `GitHubStatus`. Both also record a **transport** failure — a hang, timeout, DNS/TLS error, or a body that stalls mid-stream, caught at the header read *and* at the body read — before rethrowing it, with a null rate limit so it cannot clobber real quota numbers. Both expose `getRequestBudget()`, so the runtime-bound build's poll governor is gated too. Both also hold their resolved credential for `GITHUB_CREDENTIAL_CACHE_TTL_MS` (30 s) through `shared/expiringPromiseCache.ts`, at the granularity each one can afford: the desktop service caches the whole inventory behind the `gh`-CLI revision counter, while the headless twin caches only the App-token lookup so the `gh` and PAT reads keep answering live. Both resolve the App credential through the shared `resolveStoredAppUserTokenForRelay`, which skips the read entirely when no token is stored and keeps the classified reason when there is one. `githubService` additionally takes an optional `onAppUserAuthChanged` callback, fired whenever the stored App credential is replaced or removed. |
| `apps/desktop/src/main/services/github/githubCredentialHealth.ts`, `githubRateLimit.ts` | Token-digest health keyed by REST/GraphQL resource, five-minute invalid/permission cooldowns, rate-limit reset handling, same-account primary-quota propagation, and the 500-request background reserve. `classifyGitHubAuthFailure` maps GitHub 5xx (and GitHub's own outage bodies) to `service_unavailable` ahead of the transient-network check, and that kind is deliberately given **no** credential cooldown — the credential is not the problem, so parking it would fail the user's next local merge or PR read for the whole window. `githubRequestBudget()` exposes the reserve plus the worst *recent* failure kind as a zero-network `GitHubRequestBudget`, which is how foreground pollers honour the same reserve. The reserve half uses the quota-bucket filter (`core` / `graphql` / a large-limit `unknown`); the kind half deliberately does not, skipping only the independent `search` bucket, and bounds what it reports by `REQUEST_BUDGET_FAILURE_FRESHNESS_MS` (90 s). `REQUEST_BUDGET_FAILURE_SEVERITY` ranks the kinds and is a stated two-way contract with `ladderBaseMs` in the renderer's poll governor; `renewing` sits last in that ranking, because ADE waiting on its own refresh lease is the one entry GitHub never refused. `classifyGitHubAuthFailure` also accepts an `oauthError` code and a caller-known `retryAt`. The code is necessary because GitHub's OAuth endpoints answer a rejected refresh token with HTTP **200** plus an `error` field, so status alone cannot tell a dead credential from a healthy response; `isDefinitiveGitHubOAuthError` names the five codes (`bad_refresh_token`, `incorrect_client_credentials`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`) that mean the credential will never work again. Everything outside that set is transient. The `retryAt` wins over anything derived from headers, because it is the instant ADE will actually retry. See [Keeping automatic GitHub reads inside the quota](#keeping-automatic-github-reads-inside-the-quota). |
| `apps/desktop/src/main/services/github/githubAppUserAuthService.ts`, `githubAppUserAuthLedger.ts`, `githubAppUserAuthFailure.ts`, `githubAppUserAuthDeviceFlow.ts` | The ADE GitHub App user credential: the device flow that creates it, the cross-process refresh lease and backoff ledger that keeps it alive, and the classification every surface reports it through. Both request paths above read the App credential from here. See [automations → How ADE stops a GitHub App refresh storm](../automations/README.md#how-ade-stops-a-github-app-refresh-storm) for the mechanism and the full source file map. |
| `apps/desktop/src/main/services/github/credentialReadState.ts` | Reads a credential and the store's readability verdict in one call, so the `getLastReadState()` answer belongs to the `getSync` it is being asked about. An undecryptable store returns an empty view instead of throwing, so the verdict is what tells "no token" from "a token ADE cannot read"; a store that throws counts as unreadable too. Feeds `GitHubStatus.credentialStoreUnreadable`. |
| `apps/desktop/src/main/services/github/githubStatusPage.ts`, `apps/desktop/src/shared/githubServiceHealth.ts` | GitHub-outage attribution. See [Telling a GitHub outage apart from a broken credential](#telling-a-github-outage-apart-from-a-broken-credential). The shared module is the pure half — Statuspage `summary.json` parsing into `GitHubServiceHealth`, the ADE-relevant component allowlist, and `isGithubServiceUnavailable`; the main-process module owns the failure-triggered lookup, its cache, and `attachGitHubServiceHealth`. |
| `apps/desktop/src/shared/githubOperationCredential.ts`, `apps/desktop/src/shared/types/git.ts` | Capability-aware credential order and the optional status DTOs for source state, fallback, write availability, background-pause time, credential-store readability, and corroborated service health. `resolveGithubStatusCredentials` stops walking the chain on `service_unavailable` alongside `network` / `unknown`: a GitHub 5xx says nothing about the credential, so the next candidate would fail identically and only add load to a failing service. `git.ts` also owns `GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY`, the one wording for the unreadable case — it sits beside the field because the main process builds the PR tab's empty-state message from it — plus the GitHub App account DTOs: `GitHubAppUserAuthCredentialState` (`missing` / `authorized` / `blocked` / `needs_reauth`), `GitHubAppUserAuthRefreshError`, `GitHubAppUserAuthUnavailable`, and `GITHUB_APP_USER_AUTH_RENEWING_COPY`. `githubOperationCredential.ts` owns `GITHUB_CREDENTIAL_CACHE_TTL_MS` (30 s), the window both request paths reuse a resolved credential for. |
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
| `PRsPage.tsx` | Top-level page: the GitHub list and detail, with URL-driven state. With no machine online it shows `DirectPrsList` (the `direct` reader) or the "No computer is online" empty state (`none`); see [With no computer awake](#with-no-computer-awake). Consumes create-PR handoff params from either router search or hash search (`create=1`, `sourceLaneId` / `laneId`, `target=primary`) and the `prs.create` dialog bus props, then opens `CreatePrModal` with matching initial values without persisting the one-shot route as the last PR route. |
| `state/prsReader.ts` | `usePrsReader`: where the PRs tab and the issue panes read from. `machine` (an online copy's pin), `direct` (no machine online, a github.com repository, and `window.ade.githubDirect`), or `none`. An ADE Cloud tab never pins a PR read to ADE Cloud. |
| `DirectPrsList.tsx`, `LaneMentionChip.tsx`, `state/accountLaneMentions.ts` | The read-only open PR list with no machine (`useAccountGithubPulls`, the account's GitHub sign-in), the lane chips on each row, and the account lane index reads (`useLaneMentions`, `useLaneMentionsByPr`, `lanesNamedInText`, `laneMentionLabel`). |
| `state/PrsContext.tsx` | PR data provider (list, selection, and GitHub stacks). Selected-PR primary reads apply progressively as status/check/review/comment requests resolve, so one slow piece does not hold the whole detail pane busy; cached snapshots stay visible whenever a live read fails, not only during rate limits. Owns `viewerLogin` (read-side GitHub identity) and optional `writeViewerLogin` (write-capable identity for comment edit/react; explicit `null` hides those controls). Exposes the shared GitHub poll governor to the PR surface. Also holds `optimisticTerminalStates` — merges and closes GitHub has already confirmed, keyed by `owner/repo#num` — plus `markPrTerminalLocally` / `clearPrTerminalLocally`. Reopen is the one action that walks a close back, so it clears rather than overwrites. |
| `state/githubPollGovernor.ts` | Pure state machine shared by every automatic PR read on the surface: a stand-down armed by any rejection (one rung while unclassified, exponential once attributed to GitHub) plus the runtime's 500-request quota reserve, tracked as an independent stand-down that a success does not clear. Returns a poll *period* so timers slow down rather than waking and returning early. See [Keeping automatic GitHub reads inside the quota](#keeping-automatic-github-reads-inside-the-quota). |
| `state/useGithubPollGovernor.ts` | The provider-side hook that drives it: holds the state in a ref (interval callbacks would otherwise read a stale closure), exposes `isGithubPollStoodDown` / `noteGithubReadFailure` / `noteGithubReadSuccess` / `githubPollPeriodFor`, bumps a render generation only when a stand-down actually changes, and refreshes `ade.github.getRequestBudget` on a slow timer and after every failure. |
| `prsRouteState.ts` | URL ↔ page state mapping plus project-scoped last-route storage. When a project root is known, the PRs tab reads only that project's stored route and does not fall back to the legacy global route from another project. |
| `CreatePrModal.tsx` | PR creation from one lane with lane warnings, branch name validation, and optional initial values for single-PR handoffs from lane/chat surfaces. Normal PRs default the title to `source lane -> target lane`; a `target: "primary"` handoff resolves the base branch from the primary lane (falling back to `main`). |
| `tabs/GitHubTab.tsx` | Repository PR browser with label filters, CI badges, review indicators, ADE-vs-unmanaged scope counts, and linked-lane context. Snapshot hydration writes `viewerLogin` and `writeViewerLogin` into `PrsContext` so timeline comment mutations use the write-capable GitHub account rather than the read-only App login. State filter is one of `open` / `closed` / `merged` / `all`. The tab ignores legacy cross-repo `externalPullRequests` payloads; the "External" scope means repo PRs that are not managed by ADE. It owns no link/unlink controls. Its only lane offer is **Open as lane** it hands to `PrDetailHeader` (preflight + create dialog over `pr.preflightCreateLaneFromPrBranch` / `pr.createLaneFromPrBranch`) for an open PR that has no local lane. The create dialog seeds an editable lane name from the preflight (defaulting to the PR title) and, on success, navigates to the Lanes tab with the new lane selected, so the PR→lane→chat flow ends where the lane lives. Snapshot rows are mapped through `reconcileLinkedPrState` (using `isTerminalPrState` from `renderer/lib/prState.ts`) into `reconciledItems`; `computeTerminalOverlayItems` then appends last-seen rows for linked ADE PRs that went terminal but dropped from an open-only snapshot, producing `displayedItems`, so a terminal ADE PR state (merged/closed) overrides a stale non-terminal GitHub row and a just-merged row is not erased before a full-history fetch (see [Terminal-state precedence](#terminal-state-precedence)). The selection effect follows a PR into its new bucket on merge/close and the detail pane pins the selected PR through the transition behind a `PrBucketTransitionBanner` rather than blanking (see [Selection follow and detail-pane pinning](#selection-follow-and-detail-pane-pinning)). The Merged/Closed buckets are rendered through `shared/prListGrouping.ts` with sticky period headers; terminal rows collapse to two lines and swap queue signals for merge facts (see [Terminal bucket rendering](#terminal-bucket-rendering)). It also folds `PrsContext.optimisticTerminalStates` over the reconciled rows through `applyOptimisticTerminalState`, so a PR the user just merged or closed moves bucket immediately instead of sitting in Open until the next snapshot. |
| `tabs/githubTabModel.ts` | Pure list model for the GitHub tab: `githubCoordKey`, `matchesFilter`, `countGitHubItemsByState`, `reconcileLinkedPrState`, `computeTerminalOverlayItems`, and `applyOptimisticTerminalState` — which folds a locally-confirmed merge/close over a snapshot row. That overlay only ever moves a row **into** a terminal bucket, never back out, and expires after `OPTIMISTIC_TERMINAL_TTL_MS` (5 min) so a reopened PR cannot stay pinned to Closed for the session. |
| `detail/PrDetailPane.tsx` | Selected PR detail pane: status, checks, reviews, comments, files, commits, merge readiness, bypass, and chat hand-offs (including the resolve-conflicts prompt when **Update branch** hits conflicts). Rich detail/files/commits/action-run reads render progressively; late cached snapshot hydration can update snapshot-owned fields but cannot overwrite richer live data. Persists the selected sub-tab (`overview | files | checks`) per PR in `localStorage` under `ade:prs:detailTabs:v1`, mirrored through the `detailTab` URL param so deep links restore the selected tab. An `activity` target is an alias for Overview. The failing-log drawer's **Fix in chat** action queues a bounded log excerpt into the lane's most recent Work chat (or a new-chat draft) and then navigates there. Merge, close and reopen are issued for any selected PR — there is no lane precondition and no "this PR isn't mapped" refusal — and each records or clears an optimistic terminal state through `PrsContext` (`markPrTerminalLocally` on a confirmed merge/close, `clearPrTerminalLocally` on reopen) so the list and the pane agree before the refetch lands. The header's **Open as lane** offer is hidden for terminal PRs: it needs an open PR and a live head branch. The Files sub-tab renders each patch through `AdeDiffViewer` with the **Ignore whitespace** toggle persisted under `ade:diff:ignoreWhitespace:pr-code-tab`. A **Tree** toggle in the same toolbar (persisted under `ade:diff:fileTree:pr-code-tab`, default off) opens the shared `DiffFileTree` beside the flat list. The tree groups the changed paths into folders — open by default, each folder independently collapsible, with per-file git status marks (`A`/`M`/`D`/`R`) and folder-only **Expand all** / **Collapse all**. Clicking a file expands its diff and scrolls it into view. Folder state is pruned to the surviving paths when the file list changes, so an agent edit does not reset what the reader opened or closed. |
| `detail/PrDetailTimelineRails.tsx` | The Overview: one thread column with the push tick rail (`PrPushTickRail`) on its right edge and the floating dock (`PrFloatingDock`) at the bottom right. Both are laid over the thread, so the thread keeps its full width. Builds `PrTimelineEvent[]` (`buildTimelineEvents`), turns it into the triage model (`buildDigestTimelineModel`), and computes the next step with `resolvePrNextStep`. Owns the Merge card actions (chat hand-off, update branch, draft, auto-merge, merge dialog), deep-link scrolling, and the `PrMarkdownEnvContext` that gives the description its file chips and `#123` pills. The draft and auto-merge actions go to the host as the same `PrNextStepAction` names (`PrStateAction`: `ready_for_review`, `enable_auto_merge`, `disable_auto_merge`); there is no second action vocabulary. `buildCommitRailCommits` returns `PrCommitTick[]`, and that type is defined here. The Reviewers card sends a `ReviewerRequest` (from `shared/types/prs.ts`). `PR_OVERVIEW_MIN_PX` (520) is the detail pane floor that `GitHubTabView` uses. The same layout serves the PRs tab and the chat tools panel. |
| `detail/PrChecksTab.tsx` | CI workspace with Graph / List / Failures views. Graph nodes come from `PrWorkflowGraph`, which resolves by GitHub coordinates and so charts any PR in the repository; a workflow whose YAML will not parse degrades to honest swimlanes, and a *failed* Actions-runs read shows "couldn't reach GitHub" with a retry instead of an empty chart that looks like "this repo has no CI". Matrix legs collapse to pips, running jobs show live elapsed time and step progress, and stale-head runs are called out. The first failing job auto-opens the detail drawer; a passing job opens it too, without a fetch. |
| `detail/prChecksApi.ts` | The renderer's side of the checks IPC, and the one place the "is a log fetch worth it" decision lives. `isCheckLogFetchWorthwhile` says no for `passed` / `running` / `queued` / `skipped` — the graph node already carries that job's steps, conclusions and timings from the poll the pane runs anyway. `fetchCheckLogForState` returns a `resolution` of `fetched` / `skipped` / `no-api` so a caller never reads "no excerpt" as "the fetch failed", and `force` (a user asking for a green job's log) is the only thing that sets `includeLog` and steps outside the automatic-read budget. |
| `detail/PrDetailHeader.tsx`, `detail/PrDetailHeader.css` | The PR header card. Row 1: `#N` (opens GitHub), author, open time, the last update time (only when it reads differently from the open time; the full date is in the tooltip), state, and "Open as lane" for a PR with no lane. Row 2: the title, with the edit pencil on hover. Row 3: `base ← head`, the lane chip (which opens the lane in the Lanes tab), and chips for the chats linked through `PrSummary.chatSessionIds`. The tabs row has Overview, Files, and Checks with a live note (`3/5` while running, then a result dot), then refresh, "Ready for review" on a draft, and the `⋯` menu. Container queries on the header width hide the state badge and then the tab words in the narrow tools panel. |
| `detail/PrChecksGraphCanvas.tsx`, `PrChecksGraphNode.tsx`, `PrChecksGraphEdge.tsx`, `PrChecksGraphSkeleton.tsx` | The React Flow DAG, pan/zoom, GitHub-Actions style. The canvas is behind `React.lazy` and nothing outside it may import `@xyflow/react` — `scripts/check-webclient-entry.mjs` caps the web client's first-load entry graph and rejects an eagerly linked chunk matching `/graph/`. Nodes are ARIA buttons, not `<button>`s, because they carry a second control; a second activation of the same node closes the drawer. |
| `detail/prChecksGraphLayout.ts` | Pure Sugiyama-style layout: Kahn longest-path layering (so a malformed cyclic `needs:` is detected rather than looped on), barycentre crossing reduction, and critical-path marking. Tiers are clamped to a whole number inside the node count before they index a column. |
| `detail/prChecksGraphCache.ts` | Module-scoped graph cache keyed `prId@headSha`, with a longer TTL for a charted graph than an uncharted one, plus in-flight de-duplication. A rejected read is never cached — storing it as "no graph here" is the failed-read-that-looks-empty bug. |
| `detail/prChecksListModel.ts` | Pure grouping for the List view: workflow sections, worst-state-first ordering, and per-section counts. Shares `workflowNameOf`/`stripWorkflowPrefix` with `prChecksModel.ts` and the rank table with `shared/prPipelineState.ts`. |
| `detail/prChecksVisuals.tsx` | The one status vocabulary for the CI surface — `STATE_COLOR`, `STATE_LABEL`, `STATE_BORDER_STYLE`, `StateIcon`, `tint`, `fmtMs` — plus `OpenOnGitHubButton`. Colour is never the only channel: every state also carries a distinct glyph shape, a distinct border style, and a written word. Imported by both the eager tab and the lazy canvas, so it stays free of heavy imports. |
| `shared/PrTimeline.tsx` | The virtualized thread. It renders the `digest` model (a required prop) in the triage layout: the "Needs you" line (the checks that fail now and the open, not outdated threads; one line that opens into the list, six rows, then "Show N more"), the description (a Brief when it is one), a divider per push, and one folded row per bot per push. A bot row expands into one line per item, and a line opens the full card (reply, resolve, react, edit stay the same components). There are no thread filters. Resolved and outdated threads stay in the thread (in a bot row, or as their own row), so a deep link can always focus them. `n` / `p` step through the unresolved threads. Comment/reaction/edit identity is `writeViewerLogin` when that prop is present (including explicit `null`), else `viewerLogin`. |
| `shared/prDigestTimelineModel.ts` | Turns `PrTimelineEvent[]` into the triage render items (`attention`, `push`, `bot-group`, `event`) and the push ticks. Consecutive commits with no conversation between them are one push; a force-push starts its own. Uses the shared `buildPrConversationDigest`. |
| `shared/PrTimelineDigestRows.tsx` | The digest row components that `PrTimeline` renders: `DigestRowShell` (the measured, absolutely positioned row), `NeedsAttentionBlock`, `PushDivider`, and `BotGroupRow`. A bot row opens by itself when the focused event is inside it. Bot blocks split out of the PR body show a note that the PR author wrote them. |
| `shared/PrFloatingDock.tsx`, `shared/PrFloatingDock.css` | The bubble column and its cards: Merge (open by default, ring in the next-step tone that pulses once when the step changes, off under Reduce Motion), Comment (comment or review), Reviewers (requested reviewers plus everyone who reviewed, split into People and Agents), Labels, and Assignees. One card is open at a time; Escape closes it. `PrMergeCard` renders the next step: headline, detail, main action, secondary action, "Merge anyway" or "Bypass & merge", and the requirement chips. The Overview resolves the two buttons before it renders the card: `PrMergeCardActions` holds `primary` and `secondary` as `{ action, label, busy }` or `null` (null when the host cannot run that action), plus `run` and `onChip`. On a merged PR the card shows `PrShippedSummary`. |
| `shared/PrPushTickRail.tsx` | One tick per push on the thread's right edge. A tick is amber when its push has open threads and carries a dot when it drew comments. Hover shows the commit, time, and comment count; a click scrolls to that push. |
| `shared/PrBrief.tsx`, `shared/PrProofMedia.tsx`, `shared/PrSelectionToolbar.tsx` | The description as a Brief, proof in the PR text (this machine's copy or GitHub's, and the side-by-side figure), and "Add to chat" for selected text. See [The Brief](#the-brief). |
| `shared/PrActionsMenu.tsx`, `shared/prChatActions.ts` | The `⋯` menu model and its two renderers: the header dropdown and the sidebar row's right-click menu (`GitHubTabPrRow`). Chat actions (Ask, Explain, Fix open review findings, Fix failing checks, Resolve conflicts, Update the description) put a prompt in a chat composer and never send it. One linked chat is used directly; several give a submenu; none starts a chat in the PR's lane (a lane-owned PR is in every lane chat's PR scope). A PR with no lane has no chat actions. The rest: Convert to draft / Ready for review, Enable or Turn off auto-merge, Refresh, Open on GitHub, Copy link / PR number / branch / checkout command, Manage lane… (only for a PR with a lane; opens `PrManageLaneDialogHost`), and Close (with a confirm) or Reopen. |
| `shared/PrShippedSummary.tsx` | The record of how a PR shipped, in the Merge card after a merge: who merged it and when, its size, and the ADE lane that produced it. Each group is omitted when its data is missing. The lane counts are frozen at detach time, so they stay after the lane is deleted. |
| `shared/PrAgentAvatar.tsx` | Agent and bot marks, keyed on `classifyPrAuthor` from `apps/desktop/src/shared/prBotIdentity.ts`. A bundled logo when ADE ships one (single-color SVGs are drawn as a CSS mask in the brand color, quoted because Vite inlines them as `data:` URLs), else the GitHub app avatar, which is the app's real logo, else a brand-colored monogram. A person gets `PrUserAvatar`. |
| `shared/prMarkdownContext.tsx` | What PR markdown knows inside the Overview: the PR file list (inline code that names a PR file becomes a chip that opens its diff in the Files tab; a repo path opens the Files editor), other PRs' states (`#123` pills), and the GitHub alert callouts. Outside the Overview the markdown falls back to plain code and links. |
| `shared/PrMarkdown.tsx` | The PR markdown renderer (GitHub-flavored, sanitized). `variant="document"` renders the description as a document; `comment` is the default. A fenced block with a file name in its info string gets a header with the file icon, the name, and a Copy button. A blockquote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]` renders as a GitHub alert callout. `#123` links to the same repository render as state pills, and inline code that names a PR file renders as a file chip, both from `prMarkdownContext`. |
| `shared/PrTimelineCommentCards.tsx` | Description and issue-comment cards used by the timeline: markdown body, optional Edit (author must match the mutation viewer), `PrCommentEditForm`, and `PrReactionBar`. |
| `shared/PrReactionBar.tsx` | Compact reaction chips plus an add-reaction picker. Optimistic `ade.prs.reactToComment` against the subject's GitHub node id; no-ops when the viewer already placed that reaction. Hidden entirely when there is neither a write-capable viewer nor existing reactions. |
| `shared/usePrCommentEdit.ts`, `shared/PrCommentEditForm.tsx` | Shared edit state (`ade.prs.updateComment` with `commentId` + `source`) and the inline Save/Cancel form. `canEdit` requires a numeric GitHub comment id and author === mutation viewer. |
| `shared/PrMergeDialog.tsx` | Portaled merge dialog (in `LaneDialogShell`, so its method dropdown is never clipped by the dock card). Method picker (`squash` / `merge` / `rebase`, remembered default), editable commit title/body seeded from `buildDefaultCommitMessage` with a "reset to GitHub default" affordance (hidden for `rebase`), collapsible command-line instructions, a stale-head guard that re-seeds defaults if the PR head advances while open, and an admin "Override & merge" path shown only when the viewer `canBypass` and the merge box is `blocked`. The bypass checkbox is the confirmation, so the primary button submits on one click. Returns `{ method, commitTitle, commitBody, bypassRules, expectedHeadSha }`. It does not offer branch deletion: on desktop a merge always keeps the remote branch, and removing it is the separate **Delete branch** action in the Merge card of a merged PR. |
| `shared/prSection.tsx` | The flat section vocabulary: `PrSection` (icon, title, meta, action, optional inline-empty and divided variants), used by the Checks tab, plus the `prFlatButton` and `prSolidButton` styles. |
| `shared/PrCheckLogDrawer.tsx` | Per-job detail surface shared by the checks workspace, rendered for the job's **actual** state. Failed: named failing step, failure headline, bounded log tail, Fix in chat. Passed / running / queued / skipped: the step breakdown with per-step durations, drawn from `drawer.node.steps` (already hydrated by the checks poll) plus the full log on GitHub — no log fetch, and no failure wording. `buildCheckDetailPlan` in `detail/prChecksModel.ts` is the pure model behind it. It never fetches until opened, and for a job that did not fail it does not fetch at all. |
| `shared/prListGrouping.ts` | Pure day/week grouping for the terminal buckets. `buildPrListRows(items, { grouped })` interleaves `PrListGroupHeader` rows into an already-sorted, newest-first item array without reordering it; `prListGroupLabel` names the period (`Today`, `Yesterday`, `This week`, `Last week`, a Monday-anchored `Jul 21 – 27` range within the same year, else `July 2026`); `prListGroupTimestamp` files a row under `mergedAt` → `updatedAt` → `createdAt`; `prListHeaderIndices` feeds sticky-header pinning; `formatPrListGroupDiff` renders the per-period `+1.2k −380` aggregate. Open PRs are deliberately ungrouped — a work queue reads better flat. iOS mirrors the same rules in `PrHelpers.swift`. |
| `shared/prMergeRailUtils.ts` | Shared merge helpers: `readLastMergeMethod` / `writeLastMergeMethod` (the last method the user picked, in `localStorage` under `ade:prs:lastMergeMethod`; every merge surface shares the key), `mergeMethodLabel` / `mergeMethodShortLabel`, `canAttemptMerge` (prefers `status.mergeStateStatus`, falls back to the legacy boolean), `buildDefaultCommitMessage` (GitHub-style default merge/squash commit title + body), and `buildMergeCommandLineInstructions`. Used by the merge dialog, the Merge card, the `⋯` menu, and the detail pane (auto-merge uses the remembered method). |
| `shared/prUnifiedChecks.ts` | Reconciler between GitHub `PrCheck` rows and `PrActionRun.jobs`. Produces `UnifiedCheckItem[]` so the Checks sub-tab can display Actions jobs and named checks in a single list with steps + duration + details URL. |
| `apps/desktop/src/shared/prPipelineState.ts` | Canonical status/conclusion → pipeline-state mapping and worst-state ranking used by service graphing, chat cards, and renderer rollups so cancelled/unknown/running jobs cannot be classified differently by surface. `pipelineStateOf` accepts `waiting` (an Actions run parked on a deployment approval — runs carry it, checks do not) and folds it into `queued`. `STATE_RANK` is exported because three surfaces sort by it (graph rollup, live matrix rollup, list sections). |
| `apps/desktop/src/shared/prChecksRollup.ts` | The canonical checks rollup — the single answer to "was this commit verified?". Two entry points: `rollupChecks(input)` for the service, which sees check runs, legacy commit statuses and required contexts separately; and `rollupPrChecks(rows)` for surfaces that only hold a flattened `PrCheck[]` (the ADE CLI, chat toolbars). State mapping delegates to `prPipelineState`, so the rollup can never disagree with the per-job rows rendered beneath it. Also exports `NON_CI_PRODUCER_APP_SLUGS`' predicates (`isCiProducerAppSlug`, `isCiProducerCheck`), the `COMMIT_STATUS_APP_SLUG` sentinel, `NO_CI_REASON`, and `CI_PENDING_GRACE_MS`. See [Checks rollup](#checks-rollup-what-counts-as-a-pass). |
| `shared/PrReviewSubmitModal.tsx` | Modal that captures the optional review body and `Approve` / `Request changes` / `Comment` event before submitting through `ade.prs.submitReview`. |
| `shared/PrManageLaneDialogHost.tsx` | Hosts the shared `ManageLaneDialog` (delete / archive / adopt / appearance) from PR surfaces. Owns the local delete-confirmation state so the lane dialog can mount without polluting the PR detail pane. |
| `shared/GitHubPrSearchInput.tsx`, `shared/GitHubRepoSyncBar.tsx` | Repo-PR header chrome shared by the GitHub tab and detail views: the magnifying-glass search input and the "syncing…" toolbar that drives manual snapshot refreshes. |
| `shared/PrUserAvatar.tsx` | Shared GitHub user avatar with a fallback `UserCircle` glyph for users that don't have a cached avatar URL. Commit rows without a linked GitHub account use the Gravatar identicon URL the service derives from the commit-author email (see `prService.getCommits`), so the CSP allowlist includes `gravatar.com`. |
| `shared/PrCommandPalettes.tsx` | `g c` (commits) / `g t` (threads) / `g f` (files) palettes opened by the keyboard chord and by the timeline toolbar |
| `shared/PrReviewThreadCard.tsx`, `shared/PrBotReviewCard.tsx` | Rich thread cards for the timeline (bot-review collapse, reply box, resolve, `PrReactionBar`, and per-comment Edit via `usePrCommentEdit`). `PrBotReviewCard` takes its name from `classifyPrAuthor` and its mark from `PrAgentAvatar`, so it uses the same bot table as every other PR surface. It reads severity, issue-count, and confidence badges from the body only for a bot that the table knows. |
| `shared/PrDeploymentCard.tsx` | Deployment row used in the status rail and on the timeline |
| `shared/PrLaneCleanupBanner.tsx` | Post-merge cleanup banner on the PR detail. Also renders a dedicated "PR branch cleanup" variant when the PR is linked to the primary lane but its head branch differs — the primary lane is never deleted, but the user can still delete the local and/or remote PR branch after confirming `delete <branch>` |
| `shared/prVisuals.tsx` | CI running indicator, check/review badges, dot colors, activity derivation |
| `shared/lanePrWarnings.ts` | Pre-submit lane-health warnings |
| `shared/prFormatters.ts` | Formatting helpers shared across PR surfaces. `formatPrBadgeLabel(pr)` returns a state-aware compact badge (`PR #123`, `DRAFT #123`, `MERGED #123`, `CLOSED #123`) used by the chat git toolbar and the lane list PR tag so closed/merged PRs aren't visually identical to open ones. |
| `shared/laneBranchTargets.ts` | Target branch resolution for PR creation |
| `ConflictFilePreview.tsx` | File-level conflict marker preview |
| `PrConflictBadge.tsx` | Lightweight conflict chip |

Renderer PR helpers outside the PRs tab (the Work-surface badge/pill path):

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/renderer/lib/lanePrBadge.ts` | Lane-PR presentation and navigation contract. `selectPrimaryLanePr` picks the row a lane badges with, `lanePrStateLabel` / `lanePrStateColor` render its state, `lanePrDeepLinkPath` builds the in-app `/prs?tab=normal&prId=…` target, and `openLanePr(pr, { foreign, navigate, localPath? })` is the single answer to "where does this PR open" for every Work surface. A foreign PR goes to GitHub because a PR id resolves only on the machine that owns it; the local branch takes `localPath` when a caller (the chat Git toolbar) wants the richer route that also selects the lane. |
| `apps/desktop/src/renderer/components/terminals/useLanePrs.ts` | The lane→PR map every Work surface reads. Builds the bound machine's map from a coalesced `prs.listAll` + GitHub snapshot refreshed by `prs-updated`, then folds in each union machine's `prs` slice. Exports the three namespaced key builders (`laneBoundMachineKey`, `lanePrCompositeKey`, `laneAnyMachineKey`) and their accessors `boundMachineLanePrs`, `lanePrsForMachine`, and `laneHasAnyPr` — see [Which machine answers a PR read](#which-machine-answers-a-pr-read). |
| `apps/desktop/src/renderer/lib/prReadCache.ts` | In-flight coalescing and cooldown for renderer PR reads (`listPrsCoalesced`, `refreshPrsCoalesced`, `refreshLinkedPrCoalesced`, `getGitHubSnapshotCoalesced`). The cache key is scoped by pin ahead of project root, so two reads differing only by pin are treated as reads of two different databases and never share an entry. `getGitHubSnapshotCoalesced` also keys on `automaticRefresh`, so a timer-driven snapshot and a user's Refresh never collapse onto one in-flight request — they mean different things to the service. |
| `apps/desktop/src/renderer/components/terminals/LanePrBadge.tsx` | The compact PR chip itself. Presentation only — its host supplies `onOpen`, which is always `openLanePr`. |
| `apps/desktop/src/renderer/components/lanes/lanePageModel.ts` | `selectLanePrs` (strictly lane-owned — and empty for a primary lane on its base branch — for lane surfaces) and `selectChatPrs` (lane-owned **plus** this chat's own links, even when the lane surface dropped them, for chat surfaces), both ordered by `comparePrTags`. The split is load-bearing; see [Lane surfaces and chat surfaces need two different selectors](#lane-surfaces-and-chat-surfaces-need-two-different-selectors). |
| `apps/desktop/src/shared/prChatScope.ts` | Pure chat-specific PR scoping. `selectPrsForChat` narrows a set to one session; `selectPrsForChatInLane` is the one answer to "what does this chat show" for both the chat toolbar and the PR pane. Explicit `pull_request_chat_sessions` edges win, decided per PR so one linked row does not hide every older row in the lane; rows with no edge use the lane fallback for legacy data, while a chat with no edge never displays another chat's explicitly linked PR. `prStateTone` is the single state dot/label map. |

Shared contracts:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/shared/types/prs.ts` | PR DTOs, including the `additionalInstructions` field on issue-resolution args. `GitHubPrSnapshot` carries `viewerLogin` plus optional `writeViewerLogin` (the write-capable GitHub account when it is distinct from the read login). `UpdatePrCommentArgs` / `ReactToPrCommentArgs` back timeline comment edit and reactions. `PrSummary.unmapped?: true` flags a projection-synthesized summary with no `pull_requests` row. `syntheticGithubPrId(coords)` / `parseSyntheticGithubPrId(id)` are the single source of the `gh:owner/repo#num` id format — both the service (projection-only summaries, coordinate fetches) and the renderer (keying unmapped GitHub-tab rows) import them from here instead of re-deriving the string. The parse regex matches GitHub's own name grammar (owner: 1–39 alphanumeric/hyphen, no leading hyphen; repo: 1–100 of `A-Za-z0-9._-`) and rejects a non-positive or unsafe PR number — see [Synthetic PR ids are an authorization input](#synthetic-pr-ids-are-an-authorization-input). `MergeStateStatus` (lowercase mirror of GitHub's GraphQL merge-box enum) and `PrReviewDecision` drive the merge checklist; `PrStatus` carries `mergeStateStatus`, `reviewDecision`, `approvalsCount` / `requiredApprovals`, `mergeabilityComputing`, `canBypass`, and `headSha`. `LandPrArgs` adds `commitTitle` / `commitBody` (editable merge-commit message), `expectedHeadSha` (stale-head guard), and `deleteRemoteBranch` (default **false**) alongside `bypassRules`, which opts the merge into a `gh pr merge --admin` retry when GitHub rejects the standard merge. `LandResult.headChanged` (`LandHeadChange`) is set when the merge was refused because the head moved past `expectedHeadSha`. `PrCheckLogExcerpt` carries the job's own rolled-up state (`jobState` / `jobStatus` / `jobConclusion`), its `steps` with timings, the in-flight step, and a three-way `logStatus` (`PrCheckLogStatus`: `excerpt` / `not-fetched` / `unavailable`) plus `logUnavailableReason` and `logScope` (`PrCheckLogScope`: `failing-step` / `named-step` / `whole-log`). Everything below `htmlUrl` is optional so an older runtime can answer with the original shape. `GetPrCheckLogArgs.includeLog` is the user-action opt-in that downloads a log for a job that did not fail. `UpdateBranchArgs` / `UpdateBranchResult` back the `merge` / `rebase` update-branch flow. `PrActionCapabilities` adds `mergeStateStatus`, `canBypass`, and `canUpdateBranch` so mobile renders the same merge state. `PrTimelineEvent` carries a `pr_opened` variant plus `lifecycle`, `cross_reference`, `renamed`, `branch_ref`, `assignment`, expanded `review_request`, and `review_dismissed` variants so the timeline reaches GitHub event parity; review-thread events carry the full `comments` list (with `diffHunk`) and force-push commit events carry before/after SHAs. `PrEventPayload` adds a `pr-reconcile` variant (`state: "running" | "idle"`, `polledAt`) emitted around a catch-up reconcile so the renderer can show a "syncing…" affordance. `PrDetachedLane` (`at`, `laneName`, `laneColor`, `chats`, `artifacts`, `checkpoints`) and `PrMergedBy` (`login`, `avatarUrl`) back the merged view; `PrSummary` and `GitHubPrListItem` both carry `detached`, `mergedBy`, `mergeMethod`, `commitCount`, `changedFiles` (all optional and null-tolerant). |
| `apps/desktop/src/shared/types/git.ts` | `BranchPullRequest` (branch / prNumber / title / state / url / author / updatedAt) — the lightweight PR shape returned by `prService.listOpenPullRequests` and consumed by the branch picker without going through `PrSummary`. `GitHubAutolink` (id / keyPrefix / urlTemplate / isAlphanumeric) backs `ade.github.listRepoAutolinks` / `ade.github.createRepoAutolink`. The same module owns the optional `GitHubStatus` credential-chain fields described in [GitHub connectivity model](#github-connectivity-model). |
| `apps/desktop/src/shared/types/conflicts.ts` | Conflict DTOs: predictions, overlaps, proposals and rebase needs. |
| `apps/desktop/src/shared/linearMagicWords.ts` | Pure helpers for PR/commit Linear references. `linearPrMagicWord` / `buildLinearPrReference` / `ensureLinearPrReference` (single-issue magic word in the PR body), `dedupeLinearPrIssueReferences` / `ensureLinearPrReferences` (multi-issue dedupe + injection), and `renderLinearPrIssueLinkSection` / `ensureLinearPrIssueLinkSection` (the `<!-- ade:linear-links v=1 -->`-fenced "Linked Linear issues" markdown block appended to PR bodies by `prService.applyLinearPrLinkage`). |
| `apps/desktop/src/shared/prNextStep.ts` | `resolvePrNextStep` / `resolvePrNextStepFromStatus`: the one next step for a PR (kind, headline, tone, requirement chips, and the "Merge anyway" skip list). See [Overview (triage layout)](#overview-triage-layout). The Merge card uses it, and `prService` stores the short `PrLaneNextStep` (`kind`, `headline`, `tone`) on `PrLaneSummary.nextStep`. |
| `apps/desktop/src/shared/prBotIdentity.ts` | `classifyPrAuthor`, `isPrBotAuthor`, `normalizeGithubLogin`: tells a review bot or agent from a person, from GitHub's bot flag and the known agent logins. |
| `apps/desktop/src/shared/prConversationDigest.ts` | `buildPrConversationDigest`: the conversation in triage shape. Open threads are pinned, the rest is one section per push, and bot activity is one row per bot with thread and comment counts (`describeBotGroup`). Person entries are never folded. |
| `apps/desktop/src/shared/prBodyBotSections.ts` | `splitPrBodyBotSections`: removes the blocks that review bots write into the PR description (CodeRabbit release notes, the Cursor summary, the Devin review badge) by their HTML comment markers. The description keeps only the author's text. Each block becomes a synthetic comment (id prefix `desc-bot:`) from that bot, which the digest folds into the bot's row with the note "from the PR description". No text is dropped. |
| `apps/desktop/src/shared/prAutoMerge.ts` | `describeAutoMergeFailure`: turns a GitHub auto-merge error into a sentence that names the repository setting to change. |
| `apps/desktop/src/shared/prMarkdownText.ts` | `normalizeEscapedMarkdownNewlines(text)` — unescapes literal `\n` / `\r\n` / `\r` / `\t` sequences that arrive in PR bodies after GitHub round-trips them through JSON. Used by `PrMarkdown` before handing the string to ReactMarkdown so escaped newlines render as paragraph breaks. |
| `apps/desktop/src/shared/ipc.ts` / `apps/desktop/src/preload/preload.ts` | PR IPC constants and renderer bridge for PR mutations, cleanup, and read flows. Read-heavy PR tab calls route to the remote runtime only for remote-bound windows and use in-process IPC for local-bound windows. Local PR/session push subscriptions are multiplexed so multiple renderer subscribers share one IPC listener per channel. |

For mobile, `types/prs.ts` also defines paged GitHub history metadata
(`pageLimit`, `repoPullRequestsMayHaveMore`, `repoPullRequestCounts`) and
`PrMobileGithubDetailSnapshot`, whose `unavailableParts` distinguishes a failed
optional sidecar from an authoritative empty result.

## Core model

`PrSummary` (selected fields; full type in `src/shared/types/prs.ts`):

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

`PrStatus` adds live fields that the summary row does not cache
(mergeability, behind-by, merge conflicts, activity events).

`unmapped: true` marks a summary built from a `github_pr_projections` row, not
a `pull_requests` row. Its `id` is the synthetic `gh:owner/repo#num`
coordinate (`syntheticGithubPrId`). Consumers that need a database-backed PR
(chat live-refresh, `getChecks`) skip it. See
[Lane PR resolution](#lane-pr-resolution-mapped--unmapped).

## Checks rollup (what counts as a pass)

`apps/desktop/src/shared/prChecksRollup.ts` is the only place that decides
whether a commit was verified. PR rows, Lanes, the workspace graph, PR detail,
the Work-chat `pr_ci` card and iOS read its verdict; none counts rows itself.

The rollup answers **"was this code verified?"**, not "did anything succeed?".
Third-party apps (a rate-limited review bot, a cancelled preview deploy, a
comment bot) can each report `success` while CI registered nothing. Three
rules govern a green:

1. **State mapping goes through `prPipelineState`.** `skipped` and `neutral`
   are not success, and the rollup cannot classify a job differently from its
   row.
2. **A CI producer must have succeeded.** Producers are found by a **denylist**
   (`NON_CI_PRODUCER_APP_SLUGS`: `coderabbitai`, `vercel`, `netlify`,
   `mintlify`, `greptile-apps`, `railway-app`, `graphite-app`, `cursor`,
   `sonarcloud`, `renovate`, `dependabot` and others), not an allowlist:
   CircleCI, Buildkite, Azure Pipelines, Semaphore and Travis report through
   the Checks API under their own slugs. Rule 3 catches an unknown bot's green
   where branch protection is readable.
3. **Required contexts that never reported hold the rollup back.** A satisfied
   branch-protection gate (`allRequiredPassed`) overrides the producer guess.
   It is evaluated **after** the in-flight check, so it never says "passed"
   while a job runs.

Precedence in `rollupChecks`: a real failure → anything in flight → missing
required contexts → a satisfied required gate → any CI pass → CI producers that
all skipped → non-CI producers only, or a `blocked` merge state → nothing.

`PrCheck.appSlug` is the producing GitHub App's slug. Legacy combined-status
contexts get `commit_status`, and those **are** CI (Jenkins, Buildkite,
CircleCI). `isCiProducerCheck` (flattened rows) treats an absent slug as CI,
because persisted rows and older hosts have no slug. The payload-level
`isCiProducerAppSlug` is stricter and does not vouch for an unattributed run.

### `not_run` vs `none`

- `none`: nothing was observed **and** nothing led ADE to expect anything. A
  repository without CI stays quiet.
- `not_run`: something was expected and nothing verified the commit. It is a
  finding, but it reads muted everywhere, never in the danger colour: a hollow
  dashed ring on desktop PR rows, PR detail and iOS, a muted dot or label on
  Lanes and the `pr_ci` card. The merge checklist and `deriveMergeBlockers`
  show it as a neutral "No CI has run on this commit" row.

### Grace window

`CI_PENDING_GRACE_MS` (5 minutes) holds the rollup at `pending` after a push,
so a commit whose suite has not registered does not flash "CI has not run".
The clock is the earliest check `started_at` / status `created_at`. Only when
nothing reported does it fall back to the PR's `updated_at`. A comment (even
from the bots in question) cannot move a check's own start time.

### Persistence and freshness

`pull_requests` (a `PHONE_CRITICAL` cr-sqlite CRR table) has two rollup
columns:

- `checks_reason`: one generated sentence for a non-obvious rollup ("3 checks
  reported, none from a CI provider. CI has not run on this commit."), null
  when the state speaks for itself. On `PrSummary` the field is optional
  *and* nullable: absent means "keep the stored value" (partial summaries go
  through `upsertRow`), null means "clear it".
- `checks_missing_required`: a JSON array of required contexts that never
  reported, in GitHub's order, shown as dimmed rows in the PR detail check
  list.

Both ALTERs go through `crrAwareDb` (`crsql_begin_alter` /
`crsql_commit_alter`), so the columns replicate. A change in either column is
a material change even when `checksStatus` holds.

Both ingestion paths use one derivation. `ingestGithubWebhook` uses the
payload only to find *which* PR changed and hands the ids to the poller
(`onPrStateIngested` → `reconcilePrs`), which calls `computeStatus`, as the
scheduled poll does. A failed checks fetch keeps the previous rollup instead
of storing a false `not_run`: the best-effort fetch returns `[]` on a 403,
which looks like "no checks".

## IPC surface

Selected channels in `preload.ts`. These reads take an optional trailing
`OpenProjectBinding` pin that routes to the lane's machine: `getForLane`,
`syncLanePr`, `reconcileOnFocus`, `listAll`, `refresh`, `getStatus`,
`getChecks`, `getComments`, `getReviews` and the `onEvent` subscription.

- `ade.prs.createFromLane`, `ade.prs.listAll`, `ade.prs.listGithubStacks`.
- `ade.prs.listOpenForRepo`: open PRs of the repository as `BranchPullRequest[]`,
  apart from the `pull_requests` cache, for the lane-creation branch picker
  ([lanes](../lanes/README.md)).
- `ade.prs.land`: one PR, or a PR in a GitHub Stack through GitHub's async
  merge API (every open PR from the stack base up to it, all or none). Takes
  an opt-in `deleteRemoteBranch` (default false).
- `ade.prs.updateBranch`: `strategy: "merge"` uses GitHub's update-branch API;
  `strategy: "rebase"` runs ADE's local rebase + force-with-lease push and
  reports `hasConflicts`.
- `ade.prs.getStatusByGithub`: live `PrStatus` (with the GraphQL merge box)
  for an unmapped PR by `owner/repo#num`.
- `ade.prs.listSnapshots`, `getStatus`, `getChecks`, `getReviews`,
  `getComments`, `getFiles`, `getCommits`.
- `ade.prs.getDetailBundle`: status, checks, reviews and comments in one read;
  a failed piece does not drop the others.
- `ade.prs.reconcileNow` (`reconcileOnFocus({ force: true })`, the post-auth
  heal), `ade.prs.reconcileOnFocus(pin)` (throttled, to the pinned machine),
  `ade.prs.syncLanePr` (the manual ⟳). They go to the daemon `pr` domain for a
  runtime-bound window and in-process otherwise. See
  [Keeping PR status fresh](#keeping-pr-status-fresh).
- `ade.prs.cleanupBranch`: see [Standalone PR branch cleanup](#standalone-pr-branch-cleanup).
- `ade.prs.updateDescription`, `updateTitle`, `updateBody`, `setLabels`,
  `requestReviewers`, `submitReview`, `close`, `reopen`.
- `ade.prs.getReviewThreads`, `replyToReviewThread`, `resolveReviewThread`.
- `ade.prs.updateComment`: REST PATCH of a comment the write account wrote
  (`source` defaults to `"issue"`); works for synthetic ids.
- `ade.prs.postReviewComment`, `setReviewThreadResolved`, `reactToComment`
  (GraphQL; `reactToComment` also backs `PrReactionBar`).
- `ade.prs.getDeployments`, `ade.prs.retargetBase`.
- `ade.prs.getGitHubSnapshot({ force?, includeExternalClosed?, historyPageLimit?, automaticRefresh? })`:
  the repository snapshot. It returns repo PRs only; `externalPullRequests`
  stays on the DTO for compatibility and the renderer ignores it. `force`
  skips the cache; `automaticRefresh: true` says a timer asked, which keeps
  the call inside the [failure ladder](#github-read-failure-ladder). The
  fields reach the service the same way over in-process IPC, the runtime
  action registry and the sync remote command.
- `ade.github.getRequestBudget`: a zero-network `GitHubRequestBudget` (reserve
  pause, worst recent failure kind, GitHub's retry instant). It is on
  in-process IPC, the `github` action domain and the sync remote command, so
  the web client honours the paired machine's reserve. It is optional on the
  client; an older runtime leaves callers on their own backoff.
- `ade.github.listRepoAutolinks` / `createRepoAutolink`: the repository's
  autolink rules (`key_prefix` + `url_template`), used by Linear setup.
  `urlTemplate` must contain `<num>`; a POST clears the ETag cache.

## GitHub data-loading model

The GitHub tab lists the active repository's PRs, newest update first (else
created). The **Blocked** toggle floats rows whose next step needs a person
(conflicts, behind, failing checks, requested changes, a needed review, a
blocking rule) above rows waiting on CI. It uses `resolvePrNextStep` +
`prNextStepBlocker`, never moves a row across Open/Merged/Closed, and keeps
relevance order during a search. It persists in the warm cache and as
`sort=blocked` in the URL. The scope filter is `all` / `ade` (ADE-managed or
linked) / `external` (repo PRs ADE does not manage). Cross-repo PRs are not
fetched.

Caching layers:

1. **Runtime cache.** `prService` caches the snapshot:
   `GITHUB_SNAPSHOT_TTL_MS` (120 s) for the open list,
   `GITHUB_CLOSED_SNAPSHOT_TTL_MS` (600 s) with closed history. In-flight
   requests are shared. After the repo page, it does at most 12 targeted
   head-branch lookups for active lane branches the page missed. Branches in
   the failure ladder drop out first; on the open-list path only, branches
   with no remote-tracking ref drop out too (never pushed, so no PR). The
   history path keeps them, because a merged PR's head branch is often
   deleted. A failed fetch is negatively cached.
2. **Renderer cache.** `PrsContext` keeps the last snapshot, so a revisit
   paints at once. A detail pane hydrates from `listSnapshots({ prId })`,
   then each live piece (status, checks, reviews, comments, files, commits)
   applies when it resolves.
3. **Manual sync.** "Refresh" forces a fresh pull and is the one caller
   allowed past the failure ladder. Every automatic refresh (the hot-refresh
   timer, the `prs-updated` reaction, Lanes PR tags, reconcile-on-focus, the
   discovery sweep) sends `automaticRefresh: true`. Multi-PR refreshes run
   with bounded parallelism.

Snapshot rows carry `labels`, `isBot` and `commentCount`, so filters run
locally.

**Label, author and assignee filters search GitHub.** The **Filter** control
(`shared/GitHubPrFilters.tsx`) has three pickers. Each lists the loaded rows'
values first, then `pr.listGithubFilterOptions` (GraphQL `labels(query:)`,
`mentionableUsers` for authors, `assignableUsers` for assignees; 5-minute
cache, single-flight, only while a picker is open, 250 ms after typing).
`label:"a b" author:x assignee:@me no:assignee` in the search box become chips
(`shared/githubPrSearch.ts`).

- While a filter is on, the list is `pr.searchGithubPrs` (`prListFilters.ts`):
  GraphQL `search(type: ISSUE)` in this repository and state, 50 a page with
  **Load more**, rows from the snapshot's row builder. It has a 60 s cache in
  the service and the renderer and a 300 ms debounce, and drops stale
  answers. GraphQL, because REST `/search/issues` has no head/base branch and
  spends the 30/min search bucket.
- Until GitHub answers, or when it fails or the host is older, the list
  narrows the loaded rows by label and author and says so in one quiet line.
- Clearing the filters returns to the snapshot with no request. Filters live
  in the warm cache, not the URL.
- The Assignees card uses `pr.setAssignees` (issue `/assignees` POST/DELETE,
  write credential, serialized per PR, synthetic ids too), optimistic with
  rollback and a toast. It is read-only when `writeViewerLogin` is `null` or
  the host lacks the action. GitHub silently drops a person it cannot assign;
  the result names them in `notAssigned`.

History snapshots also carry `repoPullRequestsMayHaveMore` and `pageLimit`.
Mobile opts into `history.repoPullRequestCounts`: one GraphQL query for exact
Open / Merged / Closed totals, with cached projection counts as the fallback.
iOS uses them for the All-scope tabs and loads more terminal history only on
Load more.

PR rows show the linked lane's color through `LaneAccentDot`
(`useLaneColorById`).

### GitHub read failure ladder

A cached success buys a window of quiet. A failure must buy at least as much,
or the app asks faster while GitHub refuses. `githubReadBackoff.ts` is the
shared ladder; `prService` keeps one instance for both read shapes: the
snapshot (`snapshot:<owner>/<repo>`) and each lane-branch lookup
(`branch:<owner>/<repo>#<branch>`).

- **Cooldown.** A failure arms `20 s → 40 s → 80 s …`, capped at 15 minutes and floored at the success TTL. The snapshot always floors on the *open-list* TTL (120 s), even when the history variant failed, because both share one key.
- **Who arms it.** Only errors tagged by `markGithubRequestError` at the paginated GitHub fetch helper. A local failure (lanes, SQLite) never silences GitHub.
- **A backed-off read.** If nothing local can answer, it replays the recorded error and spends no call. A caller that stale cache or a projection can serve still gets it, without a background revalidation. Stack reconciliation is gated the same way.
- **What clears it.** Any successful read clears its key, even one too late to publish. Dropping GitHub auth clears every key and bumps an auth generation, so an in-flight request cannot arm the ladder with a dead token's error. Swapping one working token for another does not clear it; Refresh does.
- **Who is exempt.** A user `force` (no `automaticRefresh`).

In the renderer, `GitHubTab` stamps its last-load time on a failure as well as
a success, because the `prs-updated` effect gates on it.

### Terminal-state precedence

A snapshot can lag a merge or close the user just made. When ADE holds a
terminal state (`merged` or `closed`), it wins over a stale non-terminal row.
`isTerminalPrState` (`apps/desktop/src/renderer/lib/prState.ts`) is the rule:
merged is permanent, and closed leaves only through a reopen.

- **GitHub tab.** `reconcileLinkedPrState` rewrites a row whose linked ADE PR (`linkedPrId`) is terminal to the ADE state (clears `isDraft`, takes the ADE title and `updatedAt`). Filtering, counting and selection read the result (`displayedItems`).
- **Terminal-row overlay.** An open-only snapshot drops a PR once it merges or closes. `GitHubTab` records each row it displayed (`lastSeenRowByCoordRef`, by `owner/repo#num`), and `computeTerminalOverlayItems` shows that row in the merged/closed bucket for a linked ADE PR that is terminal but missing. The overlay goes when a full-history fetch has the row, or a reopen makes it non-terminal. A row never displayed gets no overlay.
- **Lane PR tag.** `shouldPreferGithubPrTag` (`lanePageModel.ts`) never prefers the GitHub tag when the ADE state is terminal and GitHub's is not. When both are comparable, it prefers the GitHub tag on a real mismatch.

### Terminal bucket rendering

Open is a queue ("what still needs me"). Merged and Closed are a log ("what
shipped, and when"). When `isTerminalPrState(item.state)` holds, `GitHubTab`
changes four things:

- **Period headers.** `buildPrListRows` adds sticky day/week headers, each with its row count and summed `+adds −dels`, to the merged/closed lists only. It never reorders. The flat and virtualized paths render the same `PrListRow[]`.
- **Two-line rows.** The CI dot, review indicator and branch row drop. The `merged` badge drops; `closed` keeps its badge (closed without merging is a different outcome).
- **Merge facts.** `PrRowMergeFacts` shows `<merger> · <method> · → <base>`, leaving out each unknown part.
- **Relative time.** Open rows age from `createdAt`; terminal rows from `mergedAt ?? updatedAt`.

The lane column (`PrRowLaneChip`) has two states. A PR with a lane shows the
branch glyph in the lane's colour and the name, with no chip box. A detached PR
shows the dim ghost chip `was: <lane>` plus `3 chats · 2 proof` (the name goes
first as the row narrows). Anything else shows nothing: every action works
with or without a lane.

### Selection follow and detail-pane pinning

- **Follow into the new bucket.** The selection effect tracks the selected PR and its bucket (`lastHandledSelectedRef`). On a new selection, or when the selected PR's bucket changes, it moves the filter to that bucket (`bucketForState`). A manual filter switch does not trigger it.
- **Pinned detail pane.** `selectedItem` resolves by `selectedItemId`, then by the linked `selectedPrId`, so the pane never blanks mid-transition. When the PR's state no longer matches the filter (`selectedBucketMismatch`), the pane shows `PrBucketTransitionBanner` ("This PR is now Merged/Closed" with "Show in …").

## A lane link is not a permission

The link between a `pull_requests` row and a lane is plumbing ADE keeps for
itself. It is not a gate, and the product has no words for it: no "Map to
lane", **Map** or **Unmap**, no "Not mapped" warning or badge. "map" and
"unmap" are internal identifiers only (`unmapped: true`, `linkToLane`, the
auto-map heal in `reconcileOnFocus`).

The link decides only:

- **Local bookkeeping after a mutation.** A row gets a targeted re-read and a hot window; a PR without one drops its activity memos and invalidates the snapshot cache (`refreshAfterMutation`).
- **Lane side effects of a merge.** Archiving the lane, group removal and the rebase-needs scan need a lane. A PR without one still merges and still deletes its head branch if asked.
- **Provenance.** Chats, proof and the frozen `was: <lane>` counts. There is no control to break the link by hand.
- **The one local operation.** `updateBranch` with `rebase` rewrites and force-pushes the branch, so it needs a local checkout and says so ("there is no local checkout of `<branch>`"). The `merge` strategy works for any PR.

Everything else (merge, close, reopen, comments, reactions, reviews, reviewers,
labels, title/body, re-run, workflow graph, job log, branch cleanup) is a GitHub
call through `resolvePrTarget`, which takes a row id or a synthetic
`gh:owner/repo#num` id. Two guards apply: `cleanupBranch` refuses a fork PR
(the head branch is in another repository) and any PR outside this project's
repository (it runs `git` in `projectRoot` on a branch *name*).

The one offer is the inverse: **Open as lane** checks the PR's branch out into
a local lane. It is hidden on terminal PRs and where a lane exists.

### Synthetic PR ids are an authorization input

Every mutation resolves through `parseSyntheticGithubPrId`, so the id decides
which endpoint a write hits on the user's token. The regex matches GitHub's
name grammar and rejects `/`, `..` and `#` in either half. A permissive group
would let `gh:x/../../user/repos#999#1` normalise (through `new URL()`) to
`/user/repos`, a caller-chosen endpoint.

## Lane PR resolution (mapped + unmapped)

These names are internal. A lane's PR badge reads two row sources, so a lane
shows a PR whether or not ADE created it:

1. **Mapped rows**: `pull_requests` rows created or linked through ADE.
2. **Unmapped projection rows**: `github_pr_projections` rows for repo PRs with no `pull_requests` row. `listUnmappedGithubProjectionRowsForDisplay` selects those with no mapped row (`project + owner/repo + number`). `projectionToLanePrSummary` makes a `PrSummary` with `unmapped: true`, the synthetic id, and `none` for checks and review.

`selectLanePrDisplayCandidate` filters both to the lane's normalized branch.
`compareLanePrDisplayCandidates` then ranks: open/draft → merged → closed, then
newest `updatedAt`, newest `createdAt`, highest number, and a mapped row last.
`projectionMatchesLaneBranchForDisplay` also requires the head repo to equal
the base repo (no forks) and the repo to equal `activeGithubRepo`.

`getForLane` and `listPrsByLane` use this path. `listPrsByLane` adds live
check counts only for mapped rows. A primary lane whose branch equals its base
is left out.

### Open-PR lookup for a lane branch

A narrower path answers "does this branch have an open PR on GitHub now" with
the `gh` CLI in the lane worktree. `gitOperationsService.getOpenPrForBranch`
(`ade.git.getOpenPrForBranch`: the chat Git toolbar, History's "Open branch
PR" / "Copy PR link") and the action registry call `lookupOpenPrForBranch`
(`apps/desktop/src/main/services/git/ghOpenPrLookup.ts`).

- `gh pr list --head <branch>` matches the branch **name** across every fork. The lookup resolves the lane's `origin` owner and `selectOwnRepoOpenPr` picks the PR whose head-repo owner matches. It asks for `--limit 10`, because the wanted row may not be first.
- It has an 8 s timeout and never throws; a failure gives the empty summary.
- The head-repo fields need `gh >= 2.47`, and an older `gh` exits non-zero on an unknown `--json` field. `parseGhPrListEntry` decodes leniently (an object or a string; an **absent** field means "accept"). On a non-zero exit the lookup retries once with `GH_PR_LIST_LEGACY_JSON_FIELDS` (`url,number,title,headRefName`), so an old CLI gets the unfiltered answer, not nothing.
- The runner returns JSON on success, `""` when `gh` exited non-zero, and `null` when `gh` could not run or timed out. Only `""` retries.

### Projection sync on material refresh

When `upsertFromGithub` sees a material change, it also writes the
`github_pr_projections` row (state, `is_draft`, title, `updated_at`,
`synced_at`) and calls `emitPrsUpdated()`, so an unmapped lane badge and the
GitHub tab follow without a full snapshot. `upsertFromGithub` and `linkToLane`
store GitHub's `created_at` (link time only when GitHub omits it) and keep
`updated_at` as the link/observe time.

### PR event fan-out (runtime)

In the daemon, `createPrEventFanout` (`apps/ade-cli/src/prEventFanout.ts`)
sends every `PrEventPayload` to each sink in its own try/catch: the runtime
`pr_event` emitter and search indexing (`searchService.notifyPrChanged` on
`prs-updated`). A throw in one sink does not stop the others.

## Multi-PR lane ownership and chat edges

### A PR is identified by what it is, not by a branch

A pull request row resolves by `(repo_owner, repo_name, github_pr_number)`.
The lane-branch lookup runs only for a summary with no usable repo and number
yet. Two PRs from one chat share the lane's branch as head, so a branch key
would merge them into one row.

A link is a pointer:

- `linkToLane` accepts a PR whose head branch differs from the lane's (one lane can hold several PRs, and you can review a colleague's PR from your lane).
- `linkToLane` accepts a PR another lane owns. The owning lane keeps ownership (rebase and settle logic key on it); the link only adds a reference. Chat edges from other lanes stay.
- For a PR this lane does not own, ADE does not rewrite the description with ADE/Linear linkage and does not publish Linear PR cards.

`createLaneFromPrBranch` refuses a PR that already has an owning lane, so it
never makes a duplicate worktree.

### A lane imported from a PR carries one chat origin

`createLaneFromPrBranch` records a machine-local, durable one-shot origin for
the PR. The first ordinary user chat on that lane claims it; the claim and the
`pull_request_chat_sessions` edge commit in one transaction, and an insert
failure rolls both back so the launch can retry.

- Chat creation calls the claim only after a persisted user-chat create, never for identity or helper sessions. A failed create, or another project or lane, does not consume it.
- A chat already linked to another PR is ambiguous and gets no automatic edge.
- If the PR merges before its first chat claims the origin, that new edge gets one bounded settlement follow-up after the normal merge handling. Origin chats wait for their first turn to finish. The final write checks the live links and session lifecycle, so an unlink, another open linked PR, or new user activity wins. An explicit unlink cancels the follow-up; a reopened chat does not rearm it.
- A manual link associates any later chat. No runtime action is added.

### Lane surfaces and chat surfaces need two different selectors

`renderer/components/lanes/lanePageModel.ts` keeps two rules apart:

- **`selectLanePrs` is strictly lane-owned.** Lane tags, badges and Work cards read it with the *project-wide* list, so it keeps the `pr.laneId === lane.id` check. Only the branch half is relaxed: a PR this lane owns and a chat linked stays visible after the lane moves branch. Rows with no link fall back to the branch rule. A primary lane on its base branch (live HEAD) returns nothing, chat link or not. Deleting the chat drops its links.
- **`selectChatPrs` takes the union**: everything `selectLanePrs` gives, plus any PR this chat linked, even when another lane owns it or the lane surface dropped it. `linkToLane` leaves `lane_id` on the owning lane, so a lane-bound chat view would hide a cross-lane link.

`shared/prChatScope.ts` narrows either set to one chat.
`selectPrsForChatInLane` is the one rule for the chat toolbar and the PR pane,
and `prStateTone` is the one state colour map (a draft is amber).

A chat shows **N** pull requests ordered by `comparePrTags` (open and draft
first, then recency). The newest open PR is primary; the switcher reaches the
rest. iOS mirrors it (`apps/ios/ADE/Views/Lanes/LaneHelpers.swift`:
`selectLanePrs`, `selectChatPrs`, `workChatPrTag`).

### Reaching a PR from the composer and from search

- **`#` in the composer** opens the PR menu and inserts a PR chip. The trigger is shared (`shared/composerTriggers.ts`): a markdown heading (`# Title`) does not fire it, and `owner/repo#12` inside a word does not either. Suggestions come from `prs.listAll` on the **chat's** pin (a draft uses its execution binding), by number prefix or title, at most 20. Transcript chip hover cards read `listPrsCoalesced`.
- **⌘K finds a chat by its PR.** `searchService` rebuilds `prTermsByChatSession` on every PR index and sweep and folds `#1237`, `owner/repo#1237`, the PR URL and title into each linked chat's meta document. The returned set of changed session ids drives a re-index, so a chat indexed before the first sweep gets the terms and an unlinked chat loses them.

`pull_requests.lane_id` is not unique. A lane keeps several PR rows as it moves
between branches: a row whose `head_branch` matches the current branch is
`active`, others are `previous`. The role is derived at read time, so a branch
switch does not detach history. `detached_at` is only for lane deletion (or an
explicit destructive cleanup).

`prService.listAll({ laneId })` returns the lane's whole live set.
`getForLane(laneId)` is a single-value bridge: the current-branch PR, else the
newest previous-branch row, and `null` for a primary lane on its base branch.
Lane, Work and chat badges go through `selectLanePrs` / `selectChatPrs`.

Chat ownership is a separate optional edge in `pull_request_chat_sessions`:

- Creating or linking a PR from a chat records the `terminal_sessions.id`. A chat can link several PRs (stack members on other lanes too), and a PR several chats.
- Unlink deletes the edge and writes a PK-only CRR tombstone in `pull_request_chat_session_dismissals`, so the current-branch fallback cannot revive it.
- `selectPrsForChat` is edges-first. A chat with no edge may show unedged current-branch PRs, with no write, and never shows a PR another chat claimed. Rows older than the table fall back to the lane's recent eligible Work chat.
- PR cards, the desktop and iOS Work peeks and merge auto-settlement use the edges.
- Deleting a chat (`sessionService.deleteSession`) or a lane (`laneService.cleanupLaneDatabaseRows`) calls `deletePullRequestChatLinksForSessions` (`pullRequestRowCleanup`): the edges and tombstones go, the PR row stays. The lane door matters for a *cross-lane* link, which the lane's `pr_id` detach does not touch.
- A session this machine has never seen is not treated as deleted: it may live on another machine.

**Links climb the spawn tree, one way.** The primary link is written first,
then the chats above it up to the root (`getChatAncestorSessionIds`). A
subagent does not inherit its parent's PRs, and siblings do not see each
other's. A chat that unlinked the PR stays unlinked (`hasChatSessionDismissal`).
A chat spawned while its parent holds open or draft PRs starts linked to them;
merged and closed PRs are not copied. Ancestors resolve from each chat's own
lineage.

**Cross-lane links carry no chat cards.** Cards go to the chats that claimed
the PR (`claimingSessionIds`: the links minus cross-lane ones) on the PR's own
lane, or that lane's most recent chat when none claimed it. The stack-landed
card still reaches a cross-lane coordinator.

**Cards stop when the PR is finished.** Only `draft` and `open` get cards; the
merged card still fires.

The edge table and the dismissal table are CRR tables with a PK-only
uniqueness contract, mirrored in the iOS schema and PR projection cleanup. Do
not add a unique secondary index; CRR conversion rejects it.

A new GitHub stack layer from a lane also attaches to parent chats that linked
an earlier layer of the same stack. Child chats do not get the parent's base PR
through that attach.

### Merge settlement scope

`prMergeAutoSettlementService` resolves a `MergeSettlementScope` before it
settles anything:

| Scope | When | What it files |
|---|---|---|
| `linked` | The PR declares `chatSessionIds`. | Exactly those sessions, even on another lane or claimed by a sibling PR. A declaration always wins. It still waits until the session has no other open/draft **linked** PRs. |
| `sweep` | The PR declares none, and every other PR in the lane is closed or merged. | Eligible non-chat sessions in the lane **minus** those another PR claims. Chats settle only through edges. |
| `ambiguous` | The PR declares none, and another PR in the lane is `open` or `draft`. | Nothing. |

The sweep exists for PRs with no declared chats (`gh pr create` from a
terminal, backfilled PRs). It bypasses the normal settlement checks, so it is
bounded to lanes where it cannot be wrong.

Chats reach `linked` even for a PR opened outside ADE:

- **Auto-map.** When polling maps a PR to its lane (current branch or branch history), it records an edge for each agent session (at most three, never a plain shell) open in the lane when the PR was created.
- **Shell commands (first choice).** `main/services/prs/prShellLinkWatcher.ts` (parsing in `shared/ghPrShellCommands.ts`) reads a chat's shell commands as they settle: Codex as one `command` event, Claude and ACP as a `tool_call` plus its `tool_result`. When a command ran `gh pr create` and printed a PR URL on its own line, or ran `gh pr merge`, `prService.linkShellPrAction` links that PR to that chat.
  - The parser ignores `gh pr create` inside quotes, a heredoc or a comment, a PR the command names itself, and more PR URLs than create commands.
  - GitHub must confirm the PR is in this repository, not from a fork, with the lane's current branch as head. An unlink from that chat or an unmap from that lane is never overruled.
  - With no lane holding the PR, it links through `linkToLane` (the ADE footer is added the same way).
  - A `gh pr merge` from the chat links the merged PR, so `linked` settles that chat even while another PR in the lane is open.

**PR text repair.** The same watcher repairs a PR the chat wrote with `gh pr
create` or `gh pr edit --body`/`--body-file` (`readGhPrBodyEdits`,
`prShellBodyRepair.ts`, in the desktop and the brain). Those commands replace
the whole text. The repair reads it back from GitHub, restores the "Open in
ADE" footer and the Linear reference, and uploads the proof the text cites as
`ade prs body` does (`prBodyProofStaging.ts`, `gh pr edit --attach`, on the
machine with the files).

- Only proof the chat or its lane owns goes up (`computerUseArtifactBrokerService.findProofForOwners`); every other line stays.
- Only the lane's own open PR in this repository, never a fork.
- One repair per PR at a time; commands meanwhile fold into one more pass. It reads the text again before it writes and skips (`superseded`) when the agent changed it.
- Without `gh` 2.99+ only the footer goes back.

Declared sessions resolve **by id** (`sessionService.get`), not from a paged
lane listing, and are not filtered to the PR's own lane. The sweep keeps its
bounded 500-row listing.

### Active-turn deferral

A merge outranks pending input and background work, but not a chat turn that
is running: the settle check (`settleTurnCheck.ts`, see
[`terminals-and-sessions/README.md`](../terminals-and-sessions/README.md))
refuses it with `turn_running`. It also does not settle a chat that still has
other open or draft linked PRs (unedged fallback PRs do not count). So
`hasActiveChatTurn(sessionId)` and `sessionHasOpenLinkedPrs` run before each
`settleSessions…` call.

- Liveness comes from `getChatLiveness`, built by `chatLivenessReader(agentChatService)`. Both poller hosts wire it: desktop `main.ts` and the brain's `apps/ade-cli/src/bootstrap.ts` (usually the brain polls).
- It reports **`status` only**. `awaitingInput` is a resting state, not a turn.
- No liveness (no callback, or nothing for the session, as for non-chat and tracked-CLI rows) settles at once. The persisted `terminal_sessions` row is never read: it says `running` for a tracked CLI's life and between chat turns.
- A **thrown** liveness read counts as active and defers this poll. The settle check fails closed the same way (no answer in 10 s refuses with `status_unknown`).

The gate re-reads liveness on every attempt, so every abort reason retries
once the session is quiet, with no time cap and no bookkeeping. The PR stays
unhandled; a retry costs one poll. A deferral logs
`prs.auto_settle_deferred_active_turn` (PR number, lane id, session id).

## Detached PR rows

A PR outlives its lane. Deleting a lane **soft-detaches** its `pull_requests`
rows, so ADE keeps the record that the PR was ADE's work, with its CI outcome,
review result and diff stats.

A detached row has `detached_at` set, plus `detached_lane_name`,
`detached_lane_color` and `detached_provenance` (JSON
`{ chats, artifacts, checkpoints }`).

Invariants:

- **`detached_at` is the flag, not `lane_id`.** `lane_id` keeps the deleted lane's id. It is `NOT NULL`, and `pull_requests` is in `PHONE_CRITICAL_CRR_TABLES` (cr-sqlite cannot rebuild it through `ALTER`). CRR conversion strips the FK, so the dangling id is inert. **Never treat a non-null `lane_id` as proof the lane exists.**
- **Provenance is frozen.** `terminal_sessions`, `computer_use_artifacts` and `checkpoints` are hard-deleted with the lane, so `countLaneProvenance` must run *before* the lane-delete cascade.
- **The first detach wins.** The `UPDATE` is guarded by `detached_at is null`.
- **Lane-scoped reads filter; project-wide reads do not.** `prService` applies `LIVE_PR_ROWS` (`detached_at is null`) to every "what is this lane working on" lookup. `listRows` and the snapshot join do not filter, which is how the merged view gets its provenance.
- **Lane deletion detaches, it does not delete.** `deletePullRequestRowsByIds` is only for destructive paths.

Only lane delete (`detachPullRequestRowsForLane`) and explicit destructive
cleanup (`detachPullRequestRowsByIds`) detach. A branch switch or a rename with
a branch change keeps previous-branch PRs as live lane history.

**Storage does not grow.** Detach nulls `files_json`, `checks_json`,
`comments_json` and `reviews_json` on `pull_request_snapshots`, after it lifts
`commit_count` and `changed_files` onto the PR row. The 60-day
`prunePrSnapshots` TTL is the backstop.

**Reclaim.** Only `upsertRow` may reclaim a detached row, and only when the
target lane exists **and** still tracks the PR's head branch (an archived lane
on the branch may reclaim; one that moved on may not). Reclaim clears all four
detach columns in a separate statement, so a plain refresh of a detached row
never resurrects it.

**Two row lookups.** `getLiveRowForRepoPr` ("does a lane own this PR?") backs
the ownership guards (auto-map by branch or branch history,
`discoverLanePullRequests`, create-lane-from-PR-branch, `linkToLane`), so a
detached row never blocks re-mapping. `getRowForRepoPr` ("is there a row at
all?") is unfiltered, so `upsertRow` updates a detached row instead of
inserting a duplicate key; `upsertRow` resolves by id first for the same
reason.

`conflictService` (rebase-need scan) and `laneService` (branch-rename and
base-ref repair, the "lane has a PR" delete guard) also apply `LIVE_PR_ROWS`.

## Merge outcome metadata

`recordMergeOutcome` writes `merged_by_login`, `merged_by_avatar_url`,
`merge_method`, `commit_count` and `changed_files`, so a merged PR describes
how it shipped with no GitHub call. It is called from:

- `land()`: the method the user picked, and the authenticated viewer as merger (GitHub's merge response does not name the actor).
- `computeStatus`: a PR the poller sees already merged carries `merged_by`, `commits` and `changed_files`.

Writes use `coalesce`, so a later, thinner observation cannot blank good data.
A failure logs `prs.record_merge_outcome_failed` and never fails a merge. Every
surface treats the five columns as optional.

## GitHub connectivity model

`getStatus()` (`apps/desktop/src/main/services/github/githubService.ts`)
returns the one `GitHubStatus` for read and write availability. UI reads
`status.connected` for reads and `writeAuthSource` for mutations, never
token-storage fields.

Fields:

- `tokenStored`, `tokenDecryptionFailed`, `tokenType` (`classic` | `fine-grained` | `oauth` | `unknown`).
- `userLogin`, `scopes`, `checkedAt`: from `validateToken` (`GET /user`). Classic tokens fill `scopes` from `x-oauth-scopes`; fine-grained tokens leave it empty.
- `authSource`: the read credential, from environment → ADE GitHub App → GitHub CLI → stored PAT. The App is read-only.
- `writeAuthSource`: the first usable environment, GitHub CLI or PAT credential. `none` means reads may work through the App while create, update and merge do not.
- `writeUserLogin`: the write credential's login when it differs from `userLogin`. Snapshots publish it as `writeViewerLogin`; with no matching write source it is `null` and the timeline hides Edit and Add reaction.
- `gitTransport` (optional): whether `git push` to the https GitHub origin can sign in. Git signs in with the machine's own credential (keychain, gh's helper). ADE's remote git commands (lane push, fetch, pull, sync, the upstream push on lane create, the pushes and `ls-remote` in `prs.create` and rebases, publish, cloud agents, automations) run through `runGitWithGithubAuthFallback` (`services/git/gitTransportAuth.ts`):
  - Git's own sign-in goes first. On a sign-in failure or a 403, the command runs again with ADE's write credential as an `http.extraheader` in git's config environment (never persisted, never on the command line). After a sign-in failure, the next ten minutes go straight to ADE's credential.
  - Each GitHub service registers a process-wide reader with `setGitTransportTokenReader`. Only an https GitHub push URL takes the fallback; no askpass or Credential Manager window opens.
  - The state comes from the last real command or a dry-run push of HEAD (`--no-verify`), cached ten minutes while healthy and two while broken, re-checked when a credential appears; a status read waits at most four seconds. `state: "auth_failed"` (no credential could sign in; a 403 on a repository the account cannot write is not one) raises the **Git can't sign in to GitHub** banner, the **Pushes with** fact and the **Connected · can't push** chip.
- `credentialStates`, `credentialFallback` (optional): per-source availability, capabilities, roles, cooldown and the active read fallback. Sources that resolve to one token are tried once.
- `credentialStoreUnreadable` (optional): the encrypted credential store could not be decrypted. An unreadable store returns an **empty view**, so it looks like a fresh install while the credentials are still on disk. Clients must not show it as "never connected", because a reconnect overwrites them. The flag rides on the 30-second credential inventory and clears on a successful token write.
- `authFailure` (optional): `rate_limited`, `invalid_token`, `permission_denied`, `service_unavailable`, `network`, `renewing` or `unknown`, with the message and an optional retry time. Credentials exist but no usable read path was validated; do not read it as missing scopes. `service_unavailable` (GitHub answered 5xx) is never a credential problem, so no client offers reconnect. `renewing` means another process holds the GitHub App refresh lease; it ranks **last** in `REQUEST_BUDGET_FAILURE_SEVERITY`.
- `serviceHealth` (optional `GitHubServiceHealth`): set only when a request failed **and** githubstatus.com corroborates an incident on a surface ADE uses.
- `rateLimit`: the latest quota headers (`limit`, `remaining`, `used`, `resetAt`, `resource`).
- `backgroundRefreshPausedUntil` (optional): the reset time when an available credential's core or GraphQL quota reaches the 500-request reserve. The search bucket does not pause PR refresh.
- `repo`: the detected origin owner/name.
- `repoAccessOk`, `repoAccessError`: the `GET /repos/{owner}/{name}` probe (`probeRepoAccess`); `null` when no probe ran.
- `connected` (`computeConnected`): `false` with no token or no `userLogin`. The App and `fine-grained` tokens need the repo probe to pass (or no repo); fine-grained permissions cannot be read from headers. `classic` / `oauth` need `getGitHubTokenAccessState(scopes).hasRequiredAccess`. An `unknown` prefix needs only `userLogin`.

Status is cached for 30 s and re-probed when the detected repository or the
head credential changes. `getStatus({ forceRefresh: true })` (Settings'
Refresh) bypasses the cache and retries invalid/permission cooldowns, but
honors rate-limit resets. `setToken` / `clearToken` broadcast
`ade.github.statusChanged` (`window.ade.github.onStatusChanged`); `AppShell`
subscribes, so the banner matches Settings at once.

`renderer/components/settings/GitHubSection.tsx` and
`renderer/lib/githubIntegrationStatus.ts` distinguish:

- `tokenAuthenticated`: the token decrypted and `userLogin` is set.
- `isConnected` (`status.connected`): the "reads are usable" gate, which allows App-only PR snapshots. Writes use `writeAuthSource`; with `none`, ADE keeps reads and asks for GitHub CLI or a PAT before a change.
- A structured auth failure outranks permission inference. A healthy connection hides quota bookkeeping. With one credential paused, Settings names it, the one in use instead, and the retry time. With no fallback, an invalid credential gets a reconnect action; network and unknown failures get retry/status, with the raw error only in Settings.
- A failed repo probe (403/404) asks for Contents (Read), Pull requests (Read and write) and Metadata (Read) on a fine-grained token, or repo access on a classic one.

The App Shell banner uses the same helper. It stays quiet when a fallback keeps
reads and writes usable, tells App-only reads from a write connection, and
never offers reconnect for an account-level rate-limit pause.

**An unreadable store is checked first**, before `!tokenStored` and before the
outage check, in `describeGithubCliBanner` and in
`prService.buildGithubSnapshotAuthError`: every other state would be read off
credentials ADE never saw, and it is a local, repairable fact that outlives an
incident. The helper returns a `target` with the copy: an outage and every auth
failure point to the GitHub settings card; an unreadable store points to the
Connections panel.

## Telling a GitHub outage apart from a broken credential

A failing request looks the same whether the credential is wrong or GitHub is
down. Two layers tell them apart, so ADE never pushes a reconnect that can
destroy a working credential.

**The response.** `isGithubServiceUnavailable`
(`apps/desktop/src/shared/githubServiceHealth.ts`) treats any 5xx as GitHub's
failure, and matches GitHub's own outage bodies (`no server is currently
available to service your request`, `service unavailable`, `bad gateway`,
`gateway timeout`, `unicorn!`) where the status is gone. The pattern is narrow
on purpose (not "server error", not the 404 page). This alone gives
`service_unavailable`, with no network call.

**Corroboration.** `apps/desktop/src/main/services/github/githubStatusPage.ts`
reads githubstatus.com's `summary.json`, which is hosted outside GitHub. It is
**not a poller**: while GitHub works, ADE makes no request to it.

- Only a failure ADE already saw triggers it, and only `service_unavailable` and `unknown`. `invalid_token`, `permission_denied` and `rate_limited` are GitHub's answers about this credential; `network` is ADE's own connectivity.
- Results (negative too) are cached for 60 s, the lookup times out at 2 s, and every failure means "say nothing".
- `deriveGitHubServiceHealth` needs a component ADE uses (API Requests, Pull Requests, Issues, Actions, Webhooks, Git Operations) to be non-operational. Copilot, Codespaces, Pages or Packages alone give nothing. Components key on Statuspage's stable ids (name as fallback), and the incident shortlink must be `https:` because it reaches `openExternalUrl`.
- **Attribution is one-way.** A corroborated incident stops ADE blaming the credential. A healthy page proves nothing (it lags incidents by 10-20 minutes), so ADE keeps its error copy.

`attachGitHubServiceHealth` wraps the single exit of `getStatus` in **both**
owners: the desktop `githubService` and the headless
`createHeadlessGitHubService` (`apps/ade-cli/src/headlessLinearServices.ts`).
It wraps the resolved status, so a status-cache hit still gets fresh
corroboration.

### What the UI does during a corroborated outage

`describeGithubOutage(status)` (`renderer/lib/githubIntegrationStatus.ts`)
returns null with no corroboration, else whether there is an outage, what to
say and where the button goes. Every GitHub-blaming surface gates on it:

- `IntegrationBanners` collapses the GitHub banner family in `AppBannerHost` into one neutral `info` notice linking the incident, on the same condition that renders it. Other banners stay. The notice sorts first despite `info`. Its dismissal fingerprint is the affected surfaces only, so a wider incident shows it again but severity flapping does not.
- `GitHubSection`: the chip reads "GitHub outage", the failure box loses its warning tint, `READS WITH` / `WRITES WITH` read "Unknown", cooldown badges read "Waiting on GitHub", and the `gh auth login` steps hide. A *missing* token still shows its instruction.
- `GitHubAppInstallPanel` reads "Waiting on GitHub", not "Couldn't verify".
- `describeGithubPatVerification` says a saved token is unverified, not bad.

`describeGithubAuthFailure` and `describeGithubCliBanner` also check
`describeGithubOutage` first, so a refactor of the banner suppression cannot
bring the accusation back. Without corroboration, `service_unavailable` reads
"GitHub isn't responding" (pointing to ADE Settings) and never suggests
reconnecting.

## Keeping automatic GitHub reads inside the quota

The PRs surface reads GitHub from the background `prPollingService` and from
the renderer's own timers. Both stay inside the quota. ADE degrades only its
request rate when GitHub fails, never its function: no rung blanks a pane,
hides a PR or stops polling, and recovery is automatic.

For scale: `PrDetailPane` polls readiness every 5 s while the Checks tab is open
and a job is queued or running. A tick costs about seven to ten REST requests
(a pull, an Actions runs page, up to `PR_ACTION_RUNS_LIMIT` (12) job reads, a
combined status, a check-runs page), so an unbounded hour spends the whole
5,000/hour quota. `checksTerminal` normally stops it when CI settles.

- **A failed checks read rejects.** `prService.getChecks` / `getChecksByGithub` reject when neither source could be read, and return what they got when one failed. A silent `[]` would look like "no checks yet" and the loop would never stop. A rejection also stops `upsertSnapshotRow` overwriting a good snapshot, and the mobile aggregate files checks under `unavailableParts`.
- **One shared brake.** `renderer/components/prs/state/githubPollGovernor.ts`, driven by `useGithubPollGovernor`, covers every automatic PR read on the surface. **Any** rejection arms a stand-down; there is no substring test.
  - The fast loops take the stand-down as a longer timer *period* (`githubPollPeriodFor`), with the in-tick `isGithubPollStoodDown()` check as a second line. The provider's 60 s detail poll skips its ticks instead.
  - One success clears the ladder. The stand-down survives PR selection, because an outage is account-wide.
  - An **unclassified** failure (no kind; a runtime reconnect, an IPC blip, a local `PR not found`) buys one flat 30 s rung and does not climb.
  - Once the budget names a GitHub kind, the ladder is re-derived (only when the kind changed) and climbs `base * 2^(n-1)` to a 5-minute ceiling (`prPollingService`'s `MAX_INTERVAL_MS`). The base is 60 s for `service_unavailable` / `invalid_token` / `permission_denied`, 30 s for `network` and `unknown`. `rate_limited` goes straight to the ceiling, or to GitHub's reset instant when that is later.
  - The failure ladder and the **quota reserve** are two independent stand-downs. Only the ladder clears on a success: user actions are ungated, and a success does not refill the quota. An elapsed reserve is dropped by the budget fold *and* by a success, so the timers return to the fast cadence when the quota resets.
- **The failure kind arrives as data.** IPC and JSON-RPC flatten an error to its message, so `ade.github.getRequestBudget` returns the `GitHubRequestBudget`: the reserve pause and the `GitHubAuthFailure["kind"]` that `classifyGitHubAuthFailure` recorded, including `service_unavailable` ([outage taxonomy](#telling-a-github-outage-apart-from-a-broken-credential)).
- **The budget read is zero-network and zero-subprocess.** It reads in-memory credential health only, never a credential inventory (which can run `gh auth token`, decrypt the store, or refresh an App token over the network).
  - It answers from every credential the process knows, because the quota is per account (as `prPollingService` calls `githubBackgroundRequestPauseUntilMs()` unscoped).
  - The reported kind is bounded by `REQUEST_BUDGET_FAILURE_FRESHNESS_MS` (90 s), so a permanently bad credential (a stale `GITHUB_TOKEN`, a revoked PAT) does not slow every project on a healthy GitHub.
  - With several failures it reports the worst by `REQUEST_BUDGET_FAILURE_SEVERITY`, which must agree with the governor's `ladderBaseMs` order. Change one, change both.
  - A request with no answer (a hang, a timeout, a DNS or TLS failure, a body that stalls) is recorded by both owners before it is rethrown, at the header read and the body read. The kind scan does not use the reserve's quota-bucket filter, because these failures carry no `x-ratelimit-*` headers.
  - It is in **both** GitHub service owners (desktop `githubService`, the daemon's `createHeadlessGitHubService`) and on the sync remote-command surface, because the web client's timers spend the paired machine's quota. It is optional on the client.
- **User actions are exempt.** Refresh and post-mutation re-reads (`refreshSelectedPrDetail`) bypass the stand-down; the reserve exists for them. This matches the `force` exemption in the [failure ladder](#github-read-failure-ladder).
- **A failed detail read falls back to the cached snapshot** for every failure, not only a rate limit.
- **The background sweep reports a GitHub-wide failure.** `prService.refresh()` runs candidates through `refreshPrIds`, which throws only when **no** row refreshed. The sweep rethrows to `prPollingService` only for a GitHub-wide reason: `rate_limited` / `service_unavailable` / `network`, a GitHub 5xx body, or a transport failure (`isGithubWideFailure`, falling back to `isTransientGithubProbeFailure`, since outages often hang). Anything else logs `prs.background_refresh_rows_failed` and counts as clean, because a row that permanently 404s stays the only stale candidate and would pin the poller at max backoff. `refreshPrIds` throws a GitHub-wide reason first when it picks one.

There is no extra UI for this. A corroborated outage already collapses the
GitHub banners ([corroborated outage](#what-the-ui-does-during-a-corroborated-outage)),
and an uncorroborated `service_unavailable` has its own copy.

**The merge-box GraphQL brake** (`prs/mergeStateGraphqlBrake.ts`). GraphQL has
no conditional requests, so the merge-state query sits behind its own brake at
the shared choke point:

- A typed `rate_limited` rejection (never a message substring) arms a per-repo cooldown to `max(reset, now + 5 min)` that short-circuits before any request.
- A rate limit rethrows instead of trying the no-stack fallback query.
- A `Field 'stack' doesn't exist` rejection is memoized per repo, so a repo without stacks pays discovery once.
- The short-circuit log is one line per cooldown window.
- Auth loss clears the cooldown (`githubReadBackoff.clear()`); the schema memo stays.
- `fetchMergeStateViaGraphql` must not turn a failure into a resolved `null` that the renderer records as a governor success.
- In the renderer, the mergeability deadline lives in a ref keyed by PR id, because `githubPollGeneration` is an effect dependency and a per-mount deadline would re-arm the 60 s ceiling on every governor change.

**Request accounting** (`github/githubRequestAccounting.ts`). Both GitHub
service owners count every request at their fetch choke point in memory, keyed
`component | tokenSource | outcome` (`304` apart from `2xx`), and log one
`github.request_usage_summary` every 10 minutes. It goes to the machine sink
(`desktop-main.jsonl` / `brain.jsonl`) through a lazy resolver, not a project
logger (the daemon's multi-project logger is a no-op). Empty windows log
nothing. Component tags must match `/^[a-z0-9_]{1,40}$/` (else `unknown`).

**Delta sweeps** (`fetchAllPages` `stopWhenUpdatedBeforeMs`). Reconcile sweeps
list with `sort=updated&direction=desc` and stop at the first page with an
item older than the last successful sweep (minus 60 s), keeping that page.

- `fetchAllPages` enforces `direction=desc`, because GitHub's default flips to `asc` for `sort=updated`.
- The per-repo cursor (`owner/name:open|closed`) is **in memory on the service, and must stay there**: a CRR `kv` cursor would tell machine B that machine A's sweep ran. No cursor (a restart, or a >24 h gap) means a full walk.
- The cursor advances only after `upsertGithubPrProjectionsFromRawPulls` persists the page.
- Only automatic sweeps (`options.automaticRefresh`, which includes a background revalidation) exit early. User history paging walks in full, and a truncated closed-inclusive walk forces `repoPullRequestsMayHaveMore: true`.
- A walk the page budget cut short advances no cursor, except a full walk of the open list (ten pages, so it saw everything an open walk can).

**Fewer reads per PR.**

- Every GitHub request in a process passes one gate of six in flight (`githubRequestGate.ts`). A request waits for a slot before its timeout starts.
- Status, checks and reviews of an opened PR share reads: an in-flight read is joined, a settled one is reused for 5 s (`readCache.shared`, `prs/prGithubReadCache.ts`).
- Jobs of a finished CI run attempt are kept.
- The commit list's check dots come from one GraphQL `statusCheckRollup` read; settled results of older commits are kept 30 minutes.
- A healthy GitHub status is reused for 2 minutes (`GITHUB_STATUS_CACHE_TTL_MS`), so the detail refresh does not call `GET /user` each tick.
- The merge box and the review threads are reused while the PR is quiet (`readCache.whileQuiet`: same last update, head, base and merge state, at most 3 minutes). A merge state GitHub is still computing is never reused, and any write through ADE clears them.
- The detail refresh and the mergeability re-poll skip ticks while the window is hidden.

## Background polling

`prPollingService` runs in the process behind the window's runtime (see
[Where this runs](#where-this-runs)).

- With a healthy GitHub App relay, webhooks drive targeted refreshes and the poller runs a 15-minute safety sweep (30 minutes for empty-project discovery). The relay is healthy when the last cursor drain completed; a disabled or failed drain clears it.
- Without one, the poller uses the configured 60 s interval (clamped to 5 s–5 min, jittered ±10%).

Each sweep pulls the PR list, fingerprints each PR (without `lastSyncedAt`,
`createdAt`, `updatedAt`, `projectId`), and emits `PrEventPayload` only for
changed PRs: opened, reopened, closed, merged, checks failing, review
requested, changes requested, merge ready.

**`checks_failing` fires once per red stretch.**

- `pending`, `none` and `not_run` do not re-arm it; it arms again after `passing`.
- A new head does not toast on the poll that first sees it (that poll may carry the old rollup). It toasts on a later poll if the same head still fails. A missing head SHA keeps the last one.
- A PR already failing on the first poll after start is not announced.
- A failed checks fetch does not store the new head SHA.

**`review_requested` and `changes_requested` fire once per review round.**

- A dip to `none` does not end the round: `none` is also an unknown verdict (a failed read, or a backfill from a pull list with no verdict).
- A push does not start a round. A verdict (`approved`) ends it; a move between `requested` and `changes_requested` announces the new one.
- A PR already waiting on the first poll is remembered, not announced.
- While the verdict cannot be read, a saved `changes_requested` stays unless a working reviews read shows no blocking review. A pending reviewer request alone does not clear it.

The lane backfill in `getGitHubSnapshot` is a mapping step, not a status read.
For a PR with a live row it keeps `checks_status`, `review_status`, the checks
reason and the sync time, and opens a hot-refresh window only for rows it
created.

**Webhook bursts fold.** `prService.ingestGithubWebhook` does not emit one
`prs-updated` per delivery (the event carries the whole list, about 225 KB for
194 PRs). Each delivery restarts a 500 ms quiet window; a stream that never
goes quiet sends one event every 2 s; an immediate `prs-updated` from another
path replaces a waiting one. The webhook path keeps no fingerprint guard,
because the chat PR pane reloads checks on the event.

A relay or local-webhook ingest can call `reconcilePrs(prIds)` before the next
tick. The service coalesces the ids into one targeted
`prService.refresh({ prIds })`; ids during a running tick schedule one
follow-up.

**Hot refresh** (relay unavailable only) is for service-owned activity that
expects GitHub transitions soon: merge-queue progress, PR mutations, a newly
mapped row. It reads every 15 s for the first minute, 30 s until three
minutes, then the normal cadence. Re-marking a hot PR keeps its start time,
and poller fingerprint changes do not mark PRs hot.

**Rate limits.** A REST or GraphQL failure with a primary or secondary reset is
typed with `rateLimitResetAtMs`. The poller waits until that reset plus a
buffer, and webhook pokes cannot bypass the pause. It also stops when an
available credential's core or GraphQL bucket reaches 500 remaining, and
resumes after the reset. A low search bucket does not pause it.

**Discovery.** On that cadence a tick can force a full repo-snapshot discovery
(`discoverLanePullRequests`: past the snapshot cache, but marked automatic),
whether or not PRs are tracked. It runs at most every 30 minutes with a healthy
relay, 10 without. It maps a PR an agent opened with `gh pr create` to its
lane; a viewer on another machine or a phone depends on it, because the focus
reconcile only reaches a project open on this computer. The throttle seeds from
epoch, so the first tick discovers.

Notification titles are generic so they read well as system notifications.
The payload has `prTitle`, `repoOwner`, `repoName`, `baseBranch` and
`headBranch` for richer messages. The App Shell shows the events as PR toasts.
"View PR" opens the PR on `/prs` (`buildPrsRouteSearch`, `selectedPrId`), with
`detailTab` by kind: `checks_failing` → `checks`, `changes_requested` /
`review_requested` → `activity`, else the overview.

## Keeping PR status fresh

PR state stays current through four layers:

1. **Webhooks**, the real-time path. The ADE GitHub App (through the webhook relay) feeds `prService.ingestGithubWebhook` ([automations](../automations/README.md#runtime-ownership)).
   - After each relay page is cursor-committed, linked PR ids coalesce into one targeted REST reconciliation. A failed later page still flushes the ids of committed pages.
   - A successful drain marks the relay healthy. A failed poll marks it unhealthy, respects `Retry-After`, and backs off 30 s–15 min; `pollNow()` clears the cooldown.
   - Webhook results never start a hot window.
   - Signed-in account reads authorize from the relay's installed repository binding with no GitHub REST request; the GitHub-token check is the legacy fallback.
2. **Background polling**, the safety net ([Background polling](#background-polling)). Poll results can notify consumers but cannot re-arm the hot window, so active CI does not amplify itself.
3. **Reconcile-on-focus**, the catch-up for a dormant or unfocused project. `prService.reconcileOnFocus()` runs on project open (`prs.reconcile_on_open`) and on warm-reuse or deep-link focus.
   - `main.ts` runs it only for a project open on this computer. A chat whose lane is on another machine asks that machine for a non-forced reconcile on the chat header's mount and on window refocus (`window.ade.prs.reconcileOnFocus(pin)`); `requestMachinePrReconcile` (`renderer/lib/prReadCache.ts`) adds a 60 s client cooldown per machine.
   - Three phases from cached, single-flighted reads: an open sweep + auto-map (`getGithubSnapshot({ force: true, automaticRefresh: true })`, inside the [failure ladder](#github-read-failure-ladder)), a bounded merged-heal of the stalest active rows (`RECONCILE_MERGED_HEAL_MAX = 25`), and a `state:"all"` closed-sweep every 30 minutes that maps a merged-but-never-mapped PR.
   - Its guards (a 90 s per-project throttle + single-flight) are **in memory on the service**, never in the CRR `kv` table.
   - `main.ts` adds a global limiter (`RECONCILE_GLOBAL_MAX = 1`, jittered). `buildReconcileRunner` re-resolves the context when the queued reconcile fires: in-process when there is a local `prService`, else the daemon's `pr.reconcileOnFocus` action.
   - `ADE_DISABLE_PR_RECONCILE=1` turns it off. It does not depend on PR polling.
4. **Manual sync (⟳)**: `prService.syncLanePr(laneId)`, the ⟳ in the PR pane's title bar (`ChatPrPane`). A mapped PR refreshes by id. An unmapped lane first looks for an open PR on its own branch (one request), then the repo-wide `state:"all"` sweep. It is a user action, so it passes the failure ladder. The post-auth heal fires `reconcileNow`.

`reconcileOnFocus` and `syncLanePr` emit `pr-reconcile` (`state: "running" | "idle"`)
around each catch-up. `ChatGitToolbar` subscribes in its own effect (stable
deps, not `linkedPr`) with a debounced idle-hide, so the "syncing…" spin does
not flicker or get stranded.

### Opening a PR after a branch switch

A plain `git switch` in a lane's worktree leaves the lane record on the old
branch. `prService.createFromLane` reads the checked-out branch
(`git rev-parse --abbrev-ref HEAD`) after its input checks and before the push.
A different branch is adopted through `laneService.updateBranchRef`, and the
PR opens for it. A detached HEAD or a failed read keeps the recorded branch; a
lane with no branch is refused before any push. The remote check and the push
use the upstream only when it names the same branch; otherwise (for example
`git checkout -b <new> origin/main`) ADE pushes to `origin/<new>`
(`git push -u origin <new>`).

### Lane branch history

A worktree can move to a follow-up branch (`git checkout -B`) with no change to
the lane record. `laneService` reads the worktree's HEAD reflog
(`lanes/laneBranchHistory.ts`: `parseReflogBranchVisits`,
`selectLaneHistoryBranches`), keeps real local branches first visited after
the lane was created, records them as branch profiles, and reports them through
`setOnBranchHistoryObserved`.

- `prService.autoLinkLaneBranchHistory` looks each branch up on GitHub (`state:"all"`, at most six lookups per report per ten minutes) and links the best PR (`resolveLaneBranchHistoryOwner`, `pickLaneBranchHistoryPr` in `prs/laneBranchHistoryOwnership.ts`). It is the only path that recovers a PR opened and merged between two polls.
- The PR row keeps the lane's recorded branch as head. Chats open in the lane when the PR was created get a `pull_request_chat_sessions` edge.
- `autoMapPrToHistoryLane` applies the same suppression and one-PR-per-branch guards as the strict branch match.

## PR context loading

- Selected PR detail (status, checks, reviews, comments) loads on demand.
- Background refresh updates only the stale subset, by fingerprint.
- A refresh that changes only the sync time does not write the row (`pull_requests` syncs to every phone and peer). `prService` keeps that time in memory, applies it to every row read, and writes it only with a real change or when the stored `last_synced_at` is 15 minutes old. After a restart a row reads as stale and refreshes once.

## Merge flow

The merge surface mirrors GitHub's merge box. `prService.computeStatus` (and
`getStatusByGithub` for unmapped PRs) reads `mergeStateStatus`,
`reviewDecision`, review counts and `viewerPermission` over GraphQL (with the
`merge-info-preview` Accept header), falling back to the REST `isMergeable`
heuristic. While GitHub is computing (`mergeStateStatus === "unknown"` or REST
`mergeable == null`), the status carries `mergeabilityComputing: true` and the
renderer re-polls, so there is no dead "Checking mergeability…" spinner.

The Merge card (`PrMergeCard`, `shared/PrFloatingDock.tsx`) shows the next-step
headline and one requirement row per chip (conflicts, behind base, checks,
review). Behind base, the main action is **Update branch**
(`prService.updateBranch`, `strategy: "merge"`). `strategy: "rebase"` (local
rebase + `--force-with-lease` push) auto-aborts on conflict and returns
`hasConflicts`. On conflicts the detail pane gives a "resolve conflicts" prompt
(`buildPrChatPrompt("resolve_conflicts", …)`) to the lane's newest work chat,
or a new chat, on the lane's own machine.

`PrMergeDialog` (portaled in `LaneDialogShell`) runs the merge: the method
picker (remembered), an editable commit title/body from
`buildDefaultCommitMessage` (`commit_title` / `commit_message` on REST,
`--subject` / `--body` on the admin retry, ignored for `rebase`), command-line
instructions, and a stale-head guard. It captures the head SHA on open and
sends it as `expectedHeadSha`; it re-seeds the default message if the head
changes while open.

### A moved head refuses the merge and says what landed

ADE's copy of the PR can trail GitHub after a push, and a merge against a moved
head must not happen. `prHeadChange.ts` handles both paths (`land` and
`githubStackMerge.ts`):

- `land` reads the PR fresh, compares its head with `expectedHeadSha`, and refuses before any merge call when they differ.
- When the head moves between that read and the merge, GitHub refuses with "Head branch was modified" (REST, `gh --admin --match-head-commit`, or the async stack merge). `afterMergeRefusal` matches that text (not a bare 409), re-reads the head and reports the same way.
- `LandResult.headChanged` carries the old and new SHA, whether history was `appended`, `rewritten` or `unknown`, the count, and the newest ten commits from the compare API (past 250 commits it reads the last page). ADE refreshes its row, so the next click carries the new head.

The desktop merge-result banner (`PrDetailPane`, in the PRs tab and the Work
tools pane) lists those commits with **Merge with these** (the same merge
against the new head) and **See what changed** (GitHub's compare of the new
commits). Nothing merges without that click. iOS shows the server's message;
the next tap carries the new head.

`land` resolves through `resolvePrTarget`, so it needs no `pull_requests` row.
The admin retry runs `gh pr merge <number> --repo <owner>/<name>` from the lane
worktree, else from `projectRoot`.

### Deleting the head branch is opt-in

A merge **keeps the remote head branch** unless the caller passes
`LandPrArgs.deleteRemoteBranch: true`.

- **Desktop** never sets it. The **Delete branch** button of a merged PR calls `cleanupBranch` (local and remote) and confirms in place.
- **`ade prs land <pr>`** keeps the branch; `--delete-remote-branch` removes it. That is the only spelling: `--delete-branch` means the **local** branch in `ade lanes delete`.
- **Remote and mobile** callers pass it through `parseLandPrArgs` in `syncRemoteCommandService`.

For a PR with no row, `deleteMergedHeadBranchByCoords` deletes after the merge,
only for a same-repo head (a fork's branch name belongs to another
repository). A 404 counts as success (GitHub's auto-delete may win).

### Admin bypass

When the merge box is `blocked` or `behind` and the viewer can bypass
(`status.canBypass`, `viewerPermission === "ADMIN"`), "Merge anyway" becomes
"Bypass & merge". It opens `PrMergeDialog` with the bypass box ticked
(`preferBypass`) and the list of what it skips (`skips`). The checkbox is the
confirmation, so "Override & merge" submits on one click. It sets
`LandPrArgs.bypassRules = true`: `prService.land` retries with
`gh pr merge --admin` (same title/body) after the REST merge is blocked. GitHub
still decides whether the bypass is allowed.

### Auto-merge and draft

`prService.setAutoMerge` uses the `enablePullRequestAutoMerge` /
`disablePullRequestAutoMerge` GraphQL mutations; `prService.setDraft` uses
`convertPullRequestToDraft` / `markPullRequestReadyForReview`. Both are on
IPC, the `pr` action domain, the web adapter, and the sync commands
`prs.setAutoMerge` / `prs.setDraft`.

The merge-state read also returns `repository.autoMergeAllowed` and
`pullRequest.autoMergeRequest`, so `PrStatus` has `autoMergeAllowed`,
`autoMergeEnabled` and `autoMergeMethod` at no extra cost. The menu shows
"Enable auto-merge" only when the repo allows it (or an older runtime did not
say), "Turn off auto-merge" when armed, and for an admin a link to the repo
settings when it is off. A refused arm reads through `describeAutoMergeFailure`
(`shared/prAutoMerge.ts`); an unknown error keeps GitHub's words.

## Post-merge cleanup

After a GitHub merge, cleanup runs in an outer try-catch, so a cleanup failure
never hides the merge:

- remote head-branch deletion, **only when `deleteRemoteBranch` was asked for**
- group membership removal
- lane archiving (if configured)
- base branch fetch
- cache invalidation
- rebase-needs scan
- an immediate default-branch auto-pull when the live PR base is the project's default branch (unmapped and stack merges too)

Each failure logs a warning; the operation succeeds with a `cleanupError`
field. A merged PR with no row skips the lane steps (`finishSuccessfulMerge`
drops its activity memos and invalidates the snapshot cache), plus the branch
delete if asked. Stack merges check each merged PR's live base, so a stacked
parent does not pull the default branch.

### Standalone PR branch cleanup

`prService.cleanupBranch` cleans up the PR branch, not a lane. It is reached
from `PrLaneCleanupBanner` (a PR linked to the primary lane with a different
head branch) and from **Delete branch** on any merged PR. It works without a
`pull_requests` row (state and head come from GitHub).

- It refuses a PR outside this project's repository: it runs `git` in `projectRoot` on a branch *name*.
- It refuses a fork PR resolved by coordinates (`target.repo` is the *base* repo).
- It runs only for a `merged` or `closed` PR.
- It refuses any branch that matches a primary lane's branch ref.
- Local: `git branch -D` after `git show-ref --verify`. Remote: `git push <remote> --delete` after `git ls-remote --heads` confirms the branch.
- It returns `CleanupPrBranchResult` (`localDeleted`, `remoteDeleted`, per-side errors). A partial failure logs `prs.branch_cleanup_partial_failure` and does not throw.

## PR issue resolution

Agent-driven resolution of PR issues has three scopes: `checks` (all checks
completed and at least one failed), `comments` (unresolved, non-outdated
review threads), and `both`.

> **The launcher is not built; the tools are.** `prIssueResolver.ts` and
> `launchPrIssueResolutionChat` do not exist, so nothing auto-starts a
> resolution chat. The `pr_*` RPC tools in `apps/ade-cli/src/adeRpcServer.ts`
> work and an agent can call them: `pr_get_checks`, `pr_get_review_comments`,
> `pr_rerun_failed_checks`, `pr_reply_to_review_thread`,
> `pr_resolve_review_thread`. `pr_get_check_log` and
> `pr_refresh_issue_inventory` are named but not implemented. See
> [chat/tool-system.md](../chat/tool-system.md#pr-issue-resolution).

The intended launcher builds a prompt from live PR state (failing checks and
run detail, unresolved threads, changed files, recent commits) and starts a
chat in the lane worktree. Each session is one bounded round: fix the current
checks and threads, commit and push, and stop with a short note (what changed,
what was validated, whether it pushed, any blocker). The agent does not wait
for CI or review bots; the poller starts the next round if new work appears.

### PR episodes in chat

- **The PR companion panel answers "what is true now?"** It opens only by explicit toggle, never on PR events, and its open state persists per chat (`chatCompanionUiState`).
- **An `ade_card` transcript row answers "what happened then?"** It is one bounded episode, live while running and frozen when terminal.

The polling change hook writes durable cards into every explicitly linked,
non-archived Work chat of the PR: `pr_ci`, `pr_review`, `pr_merge_ready`,
`pr_merged` and `pr_conflict` (conflicts and behind-base).

- A `pr_conflict` card often arrives mid-turn, so desktop and iOS draw it as one quiet line ("PR #12 is 1 commit behind main", "PR #12 has merge conflicts with main", "open ›"); only a conflict tints the glyph.
- CI cards use a stable `prId + headSha + runAttempt` identity: all workflows of one attempt roll into one episode, and pending → terminal updates merge in place.
- Review cards include the latest reviewer and the unresolved-thread count.
- Every card has a PR `navTarget`; CI targets add `detailTab: "checks"`.
- Rows without a chat edge use the lane's recent eligible Work chat.

CI detail ranks failed → running → queued → unknown → skipped → passed and
shows at most three rows, then `+N more`. Rows split into **CI** and **Other**
(`isCiProducerCheck`); Other is capped at two rows. Required contexts that never
reported are named inline (up to three). The headline is the canonical
`checksStatus`, never a row count. A rejected runs/checks request is not an
empty result: with one source the card shows its detail; with neither, the
payload has `degradedReason`, no false status and a Retry action. A later
degraded re-emit keeps the last rich rows as stale.

`emitAdeCard` uses the durable transcript commit path, also for a cold or idle
session. It never depends on model prose or the live-only envelope path, so
cards replay after a restart and sync to mobile. An unknown variant degrades to
`fallbackText` plus the deeplink.

### PR Watch / Ship: waking the chat

Cards are news for the user and never start a turn. **Watch** and **Ship**
wake the chat when its PR changes. Sources: `shared/prWatch.ts` (evaluator,
wake text, wake card), `main/services/prs/prChatWatchStore.ts` (rows),
`main/services/prs/prWatchService.ts` (reactor),
`renderer/components/chat/PrWatchPill.tsx` (header control),
`renderer/components/chat/PrWatchWakeLine.tsx` (iOS `WorkPrWatchWakeLine`).

**Turning it on.**

- Beside the header PR pill, while the PR is open, is one icon button with a caret: a slashed eye (off), an eye (Watch, sky) or a rocket (Ship, amber), with a pulsing dot while Ship holds news. Its menu has Off / Watch / Ship, each with a two-word hint, and one status line ("Told 6m ago: …", "Holding for CI and reviews").
- A failed change shows a toast. A watch that could not be read shows "Couldn't read the watch" with no row checked; Off still sends. iOS matches.
- Agents arm it with `ade prs watch|ship|unwatch <pr>` (default `$ADE_CHAT_SESSION_ID`; `<pr>` is an ADE PR id, number or URL) or the CTO tool `watchPullRequest`; the status line adds "on by agent".
- Actions: `pr.setChatWatch` (`mode: null` stops it) and `pr.getChatWatches`, on IPC, preload, the web adapter and sync (`prs.setChatWatch`, `prs.getChatWatches`). The PR resolves through `getRow` (a URL keeps owner and repo); a bare number in two repos is ambiguous unless the chat is linked to one.
- An unknown mode is refused. Only an ADE chat can be watched (not a tracked CLI terminal), and only a PR attached to a lane.
- Watching links the chat to the PR, even over an earlier unlink; unlinking stops the watch. Every change emits `pr-chat-watch-changed` (`watch: null` once stopped).

**On the Work row.** Between wakes no turn runs, so the chat summary carries
`activePrWatch` (`SessionActivePrWatch`), built by the machine that runs the
watch (`prChatWatchStore.activeBySession`, one query per listing) and projected
onto the session row, so other machines read the same.

- `canonicalSessionState` promotes a resting watched chat to `running` with liveness `pr_watch`: blue **Shipping** (Watch and Ship alike), the time since the watch began, and the PR number on hover. It files under Working and the running section; its lane folds in Focus with no tile.
- Needs you, snooze, woke, a live turn, a failed turn, a usage limit and running background jobs outrank it; a missed scheduled wake still holds the lane out.
- It is never Stale (the reactor polls every minute). A chat detached by a brain restart still reads Shipping.
- Settling stops nothing: a settled chat stays settled until a wake brings it back. A chat moved to another machine claims no watch here.
- `pr-chat-watch-changed` sends `session_meta_updated` with `prWatchChanged`, which refreshes the row without moving it. iOS mirrors the rule in `WorkSessionCanonicalState.swift`.

**What wakes the agent.**

- Each check as soon as it fails (failure, cancelled, timed out, action required), and the required checks passing (`checksStatus` → `passing`).
- New comments, inline comments and submitted reviews from people and agent reviewers (deploy, CI and dependency bots are ignored), and a review bot's edit of its old comment (a person's edit does not wake).
- The branch starting to conflict, or a new head that stays conflicted.
- The PR merging or closing.
- A head with no CI check for 10 minutes (`PR_WATCH_NO_CHECKS_GRACE_MS`), told once per head and never as a pass. Review bots and deploy previews are not CI, and a head where CI reported never reads "no CI" later.
- GitHub's merge queue dropping the PR without merging (`prService.getMergeQueueRemoval`, the newest `RemovedFromMergeQueueEvent`), once, with GitHub's reason. A removal before the watch began, one followed by a re-enqueue, and the `merged` removal are not news. Hosts without the merge-queue schema are asked once.
- A new head resets the check state. The first pass reports the current state, so Watch on a red PR says what is red at once.

**What never wakes it.** Comments ADE posted (`addComment`,
`replyToReviewThread`, `postReviewComment`, `submitReview` record their ids in
`pull_request_ade_comments`, by the PR's row id). The account owner's own
comments still wake it, because agents post with the same account.

**Ship** holds its news until every check on the head is terminal and either an
agent reviewer has spoken on that head or 12 minutes passed since the push. An
empty check list right after a push is CI not registered yet; only the grace
releases a repository with no CI. A conflict releases at once. Switching Ship
to Watch releases what Ship held. The wake carries standing orders: fix CI and
review findings in one push, verify narrowly, rebase only on a real conflict,
answer the threads, merge when green. There is no round cap.

**Delivery.**

- The reactor runs every minute, and at once when the PR poller reports a change or a watch is armed. Watched PRs refresh their row each pass; checks and comments are re-read when the row changed, at least every 3 minutes.
- The wake goes through the ordinary message path with `kind: "wake"`: it starts a turn on an idle chat and queues at the turn boundary of a running one.
- What the agent was told is recorded only after delivery, guarded so a watch stopped or restarted mid-read is not overwritten. A mode switch mid-read keeps the told state, and the switched watch runs again right after.
- The transcript shows the wake as one divider (`pr_watch_wake`: "Watching PR #1991 · 8 new comments ›", a PR icon that opens the PR in the tools pane; "Shipping" or "Stopped watching" by state). A checks wake shows counts with check icons. A click shows what changed and the exact text the agent got. It is never a user bubble.

**Stopping.** The PR merging or closing (one last wake, with remarks left on
the way out), the user or agent turning it off, the chat archived or deleted,
or GitHub confirming the PR or repository is gone or access is lost. Transient
failures, rate limits, expired sign-in and offline periods leave it armed. A
settled chat keeps its watch and the wake un-settles it.

**Machine-local.** Both tables are excluded from CRR sync, so only the machine
that runs the watch wakes the chat.

## Overview (triage layout)

`PrDetailPane` renders `PrDetailTimelineRails` for Overview in the PRs tab and
the chat tools panel. It is one column; nothing resizes.

- **The thread** (`PrTimeline`, digest model). The "Needs you" line comes first: how many checks fail now (open and draft PRs only) and how many review threads are open ("2 checks fail · 6 open threads, 1 from people"). A click opens the list: failing checks, then open threads (people first), six rows, then "Show more". It stays one line so the description stays on top. Agents answer and resolve each thread they handle (`PR_THREAD_CLOSEOUT_RULE` in `shared/prWatch.ts`: the Ship and Watch wake text, the "Fix in chat" prompt, the footer of `ade prs comments`, the **ade-pr-workflows** skill). Then the description ([The Brief](#the-brief)), then one section per push with each bot folded into one row. People, lifecycle events, labels and deployments stay full rows.
- **The push tick rail** (`PrPushTickRail`) on the right edge.
- **The floating dock** (`PrFloatingDock`) at the bottom right; the thread pads its bottom so the last row clears it.

Bot detection (`shared/prBotIdentity.ts`): REST `user.type === "Bot"` (login
ends in `[bot]`) or GraphQL `__typename === "Bot"`, stored as `authorIsBot` /
`reviewerIsBot` / `isBot`. A distinctive agent login (`coderabbitai`,
`devin-ai-integration`) counts without the flag; a short product word
(`cursor`, `claude`) needs GitHub's flag or suffix.

The next step (`shared/prNextStep.ts`) has this priority: merged, closed,
draft, computing, conflicts, behind, checks failing, changes requested,
auto-merge armed, checks running, review required, rules blocked, ready. It
guides and does not gate: "Merge anyway" shows on every open, non-draft PR
with what it skips, disabled only where GitHub refuses (conflicts, a draft,
protection rules for a non-admin). `rules_blocked` keeps the card from saying
"Ready to merge" over GitHub's `blocked`.

Timeline identity (in `PrsContext`, not persisted): `viewerLogin` (highlights
the viewer's reactions; the fallback mutation identity) and `writeViewerLogin`
(see [Timeline comment identity](#timeline-comment-identity)). The Overview
has no thread filters.

**Deep links.** `prsRouteState` carries `eventId`, `threadId`, `commitSha` and
`detailTab`. `PRsPage` keeps them while the URL points at the selected PR.
`PrDetailPane` reads them on mount to scroll, open a card and pick the tab.
`PRsPage` stores the last `/prs...` path per project root
(`writeStoredPrsRoute`), so the sidebar's PRs tab (`projectSidebarTabs.ts`)
returns to it.

**Event sources.** `buildTimelineEvents` prepends a synthetic `pr_opened` event
(title, number, branches, draft flag, additions and deletions), then the
description, review threads, activity and check status. After the sort it
moves `description` back to the top (adopted PRs often have a wrong
`createdAt`).

- Bot review cards and long bot comments render collapsed (`CollapsibleCommentBody`).
- The activity stream has GitHub-event parity: commits, comments, reviews, labels, merges, deployments, lifecycle changes (closed, reopened, ready, converted to draft), cross-references, renames, branch ref changes, assignments, review requests and removals, and dismissals.
- Inline review threads render as grouped "X reviewed" blocks with the reply chain and diff hunks. Force-push entries read "from `<a>` to `<b>`".
- Usernames, SHAs and PR/issue references open on github.com (`window.ade.app.openExternal`). Authors have avatars (Gravatar identicon for unlinked commit authors).
- Commits are deduped across `PrActivityEvent.commit_push` and `getCommits` (the activity path wins, keeping force-push data) and render as a full-width divider. Comments and reviews in both sources are deduped by id.

### The Brief

A description reads as a Brief when it answers a reader's questions under
headings: **Why**, **What changed**, **Evidence**, **Not checked**, and the
optional **Choices I made**. `parsePrBrief` (`shared/prBrief.ts`) splits the
markdown at its top headings; other templates' names (Problem, Change,
Verification, Test plan) map to the same parts. An unknown heading stays as its
own part, and text before the first heading is the lead. Fewer than two known
parts render as a plain document. The parser returns null (plain document) when
a cut would break the markdown: a link or footnote defined on its own line
(`[1]: …`), or a `<details>` block across two parts.

`PrDescriptionBody` (`prs/shared/PrBrief.tsx`) draws each part as a document:
the author's heading at its own level (`PR_DOCUMENT_HEADING_CLASS`), then the
markdown, with no icons, labels or tints. A part adds "Add to chat" on hover,
and an Evidence heading whose text still holds a placeholder (`pending /test`)
gets a "Not final" mark. A Brief with no Evidence says so in one quiet line.

The Brief is plain markdown in the PR's own text; ADE stores nothing beside
it. `prBriefHints` is the checker `ade prs create` and `ade prs body` print
under "For the reader". It never refuses, and a text of 60 words or fewer with
no headings gets no hints.

### Proof in the PR text

An author cites proof as in a chat answer: `![caption](ade-proof://<id>)` and
the `proof-compare` fence. `ade prs create`, `ade prs body` and
`ade proof publish --pr <n> --in-body` upload the cited files with
`gh pr edit --attach` and rewrite each citation (`shared/prBodyProof.ts`); the
shell repair does the same for text a chat wrote with `gh`.

- Only the caller's own proof goes up: a lookup by id is scoped to its owner.
- A picture becomes an image; a comparison a `| Before | After |` table (two stacked videos when a side is a video, since GitHub plays a video only on its own line). Each item keeps its proof id in a hidden HTML comment.

`PrMarkdown` reads it back (`preparePrBodyProofForAde`):

- A picture with a proof id shows this machine's copy when it has one (`PrProofMedia`, with video chapters), else GitHub's copy (`PrRemoteMedia`).
- `PrRemoteMedia` tries a picture, then a video. A copy that loads as neither becomes an "open on GitHub" link. An attachment URL alone on a line is a video player, as on GitHub.
- The content policy lets video come only from the three attachment hosts (`GITHUB_ATTACHMENT_MEDIA_SOURCES` in `rendererCsp.ts`): `github.com/user-attachments/`, GitHub's asset bucket, `private-user-images.githubusercontent.com`.
- A Before/After table with one picture per cell becomes a side-by-side figure (`PrCompare`). A citation never uploaded still shows on the machine with the proof.
- Anyone who can comment can write these forms, so `parsePrCompareFence` and `prProofIdFromTitle` accept only an https URL and a well-formed proof id.

#### Private repository media

A private repository's attachment (`github.com/user-attachments/assets/<uuid>`,
or `github.com/<owner>/<repo>/assets/<n>/<uuid>`) answers 404 without a GitHub
credential.

- `PrImage` and `PrRemoteMedia` try the original URL first. Only after it fails, and only for those URL shapes inside a `PrMarkdown` that knows its repository, `useGithubMediaSrc` calls `prs.resolveMedia` once on the PR's machine (the `PrRuntimePinProvider` pin, else the chat's pin, else the tab's) and swaps in the signed copy, keeping the alt text meanwhile. If that fails, the fallback applies.
- `githubMediaResolver.ts` sends the read token only to a URL that `githubAttachmentCanonicalUrl` (`shared/githubMedia.ts`) accepted and rebuilt, with manual redirects. It takes the 302's `Location` only if `githubSignedMediaUrl` accepts it (the asset bucket with `X-Amz-Signature`, or `private-user-images` with a `jwt`), and never fetches the signed URL with the token.
- An HTML answer (SAML SSO / EMU) or a 401/403/404 falls back to `POST /markdown` with an image document in the PR's repository, and takes the signed `src` GitHub renders.
- The content type comes from the bucket's `response-content-type` or a tokenless one-byte ranged GET, and must be an image or a video (no SVG).
- Results cache until a minute before the signed URL expires, failures for two minutes, 500 entries, one request in flight per URL; the renderer caches per machine.
- No media bytes cross IPC or the remote-runtime socket, so seeking works. A video that fails after its URL expired re-resolves, at most once a minute. An older machine answers "unknown action", which reads as unavailable.

### Add to chat

Any part of a PR can be quoted in the chat that works on it: a Brief part, a
comment, a review, a thread, a picture, a comparison, or selected text
(`PrSelectionToolbar`, on `useSelectionAnchor`). The control shows on hover and
only when the PR has a lane. A picture gets it only at 160 × 80 pixels or more
and when it is not a link. `PrDetailPane.addQuoteToChat` makes an
`<ade-chat-context>` block whose first line names its source ("a review thread
on prService.ts:40 in pull request #12 …", the `source` of
`formatChatOutputContextBlock`) and queues it with
`queueAgentChatDraftHandoff(…, { collect: true })`. Quotes collect for up to 15
minutes and a toast offers "Open chat". The target is the chat whose tools
panel holds the pane, else the newest linked chat, else a new lane chat.

### Timeline comment identity

Comment edits and new reactions never run as the read-only GitHub App login.
`GitHubPrSnapshot.viewerLogin` is `githubStatus.userLogin`. `writeViewerLogin`
is `githubWriteLogin(status)`: `writeUserLogin` when present, else `userLogin`
only when the write source equals the read source, else `null`.

`PrTimeline` uses `mutationViewerLogin = writeViewerLogin !== undefined ?
writeViewerLogin : viewerLogin` for `PrTimelineCommentCards`,
`PrReviewThreadCard`, `PrReactionBar` and `usePrCommentEdit`. Explicit `null`
hides Edit and Add reaction. The service re-checks authorship on PATCH
(`updateGithubCommentByCoords`). `PrReactionBar` posts through
`ade.prs.reactToComment` on the subject's node id; existing chips stay visible
without a write viewer, the picker does not.

Keyboard shortcuts (Overview tab only):

| Chord | Action |
|------|--------|
| `g c` | Open the commit palette |
| `g t` | Open the unresolved-threads palette |
| `g f` | Open the changed-files palette |
| `[` / `]`, `p` / `n` | Previous / next unresolved thread |

## No AI PR summaries

ADE does not write AI PR or review summaries. The `pull_request_ai_summaries`
table is dropped when a database opens (desktop `kvDb.ts`, iOS
`Database.swift`).

## Delta polling cursor

`prPollingService` writes `last_polled_at` on every PR after a successful tick.
`getLastPolledAt(prId)` exposes it, so services that call GitHub with `since=`
(review threads, comments) skip work they saw. A failed write logs a warning
and does not abort the tick.

## Renderer wiring

- `PRsPage` reads URL state with `parsePrsRouteState` and writes it with `buildPrsRouteSearch`: the selected PR, lane, detail tab and sort. An unknown `tab` (such as `workflows`) is ignored.
- `PrsContext` mounts cheaply. The first `refreshCore` paints from local rows and the existing snapshot and starts no GitHub fan-out. It listens to lane lifecycle events, so lane changes refresh the PR mapping with no poll. It owns the PR list, stack state and timeline UI state (`viewerLogin`, `writeViewerLogin`, `detailReviewThreads`, `detailDeployments`), with `setViewerLogin` / `setWriteViewerLogin`.
- Chat-side PR surfaces (`ChatGitToolbar`, `ChatPrPane`) scope the lane's cached PR set to the chat's explicit edges, so a chat shows its PRs and not another chat's. Rows with no edge use the lane fallback.
  - Only a chat on the PR's own lane claims it: `PrSummary.crossLaneChatSessionIds` (from `prChatLinkStore`, which reads each linked chat's lane) lists linked chats on other lanes, and `shared/prChatScope.ts` does not count them. So a stack coordinator linked to every layer does not hide each layer's PR from its own chats. iOS reads the same set from the synced tables (`Database.swift`).
  - When the pane or menu opens, `renderer/lib/prReadCache.ts` coalesces and throttles a targeted `prs.refresh({ prIds })`, with no repo snapshot.
  - Manual sync is the ↻ in `ChatPrPane`'s title bar (`prs.syncLanePr`, then a re-read). `ChatGitToolbar` is a status strip with no manual sync; it heals through reconcile-on-focus and `prs-updated`. The pane spins for a manual sync or a backend `pr-reconcile`, with a 300 ms debounced hide.
  - The pane's open state persists per chat ([Composer and chat UI](../chat/composer-and-ui.md#source-file-map)). With no PR on the lane it embeds `ChatPrInlineCreator`, whose title defaults to the chat title, then `<lane> -> <target>`.
- Every chat-side PR surface takes a `runtimePin` (`ChatGitToolbar`, `ChatPrPane`, the PR pane surfaces), from `AgentChatPane`'s `chatRuntimePin` or the session's owning binding (`WorkSurfaceHeader`, `CliSessionWorkSurfaceHeader` / `GridTileSessionHeaderActions`, `WorkViewArea`'s CLI surface).
  - A chat or CLI session on another machine gets the same PR pill and pane; the pin routes the reads and the event subscription. It also asks that machine for a focus reconcile on header mount and window refocus (`requestMachinePrReconcile`).
  - Effects key on the pin's **key**, never its object (a local pin is rebuilt on every cross-machine merge).
  - Two things stay on the bound machine in a pinned toolbar: `diff.getChanges` is unpinned, so the dirty-file count is skipped; and PR creation shows the "switch machines" copy instead of the create-PR handoff.
- `PrDetailPane` holds most rich behavior: the issue resolver modal, the rebase banner, check/review/comment sections with running indicators (`PrCiRunningIndicator`), merge readiness with the bypass checkbox, and PR markdown with `rehype-sanitize` after `rehype-raw`.
- `GitHubTab` renders the repository snapshot; filter counts respect the ADE/unmanaged scope. Legacy `externalPullRequests` entries are ignored.

## Mobile snapshot

`prService.getMobileSnapshot()` builds a `PrMobileSnapshot` for the iOS PRs tab
in one call (sync `prs.getMobileSnapshot`; types in
`apps/desktop/src/shared/types/prs.ts`).

```ts
type PrMobileSnapshot = {
  generatedAt: string;
  prs: PrSummary[];
  stacks: PrStackInfo[];                              // lane chains with >=1 PR
  capabilities: Record<string, PrActionCapabilities>; // per-PR action gates
  createCapabilities: PrCreateCapabilities;           // which lanes can create
  live: boolean;                                      // false → phone banner
};
```

- **Stacks** (`buildStackInfos` / `collectStackMembers`): walks `laneService.list` parent → child, tagging each member with `role` (`root | middle | leaf`), `depth` and its PR fields. Stacks with no PRs drop.
- **Capabilities** (`capabilitiesForPr`): `canMerge` needs `state === "open"` and non-failing checks; drafts and closed/merged PRs get a `mergeBlockedReason`. `requiresLive` is always true.
- **Create eligibility** (`buildCreateCapabilities`): non-primary, non-archived lanes; a lane with an open or draft PR is not eligible; the base comes from `resolveStableLaneBaseBranch`. The lane read is metadata-only (`includeStatus: false`).

The snapshot is read-only; actions use the command surface (`prs.createFromLane`,
`prs.land`, `prs.close`, `prs.addComment`, `prs.rerunChecks`). The mobile create
wizard prefills the title from the lane name, with an optional empty body.

- The phone reads the snapshot on open, on focus and after a mutation.
- Unmapped projections are local to the host, so webhook changes also emit a small `prs_updated` sync invalidation. iOS coalesces bursts into one cached/projected snapshot read with background revalidation off; it never polls GitHub on a timer or per PR.
- The list reconciles that projection with replicated `pull_requests` rows, so mapped PRs show offline and a terminal state never falls back to Open.
- Open / Merged / Closed totals come from one batched GraphQL count query cached with the snapshot; row history pages on its own.

The iOS list row follows GitHub's hierarchy: state symbol and title, then
number, author and repository, then one compact row of branch, lane, check,
review and comment signals. It uses local symbols, not fetched avatars, and
precomputes filtered rows when inputs change.

The mobile detail screen (`PrDetailView`, a one-column version of the desktop
layout) reads its sidecars (review threads, activity, action runs,
deployments, capabilities) separately and keeps them live through a warm-cache
gate keyed on the replicated PR revision and the remote GitHub revision. Mapped
rows change through the changeset stream, projections through `prs_updated`.
It re-reads sidecars at most every 25 s. See
[iOS companion → PR detail screen](../sync-and-multi-device/ios-companion.md#pr-detail-screen).

An unmapped PR uses the synthetic id and `prs.getMobileGithubDetail`: the core
snapshot, list/header identity, review threads, action runs and activity in one
round trip, single-flight per PR. A failed optional sidecar is named, so the
phone keeps the last good value and shows a partial-data retry, never a cached
zero; the 25 s window is the retry backoff, and Retry bypasses it. The phone
shows the same description, files, checks, timeline **and mutation controls**
as for a PR with a lane (merge, close, reopen, labels, reviewers, re-run, the
comment composer): `hasLocalLane` in `PrDetailScreen.swift` decides only the
lane banner. `PrLocalLaneOfferBanner` is a collapsed offer ("Create a lane from
this branch, or link one you already have, to edit the code on your machine")
that remembers its state per PR for the scene. The swipe action reads **Link
lane**.

The detail header is compact: a back chevron, the title with
`#number · lane · branch` (no lane segment when there is no lane), and an
ellipsis button. A small summary shows a state/approval line and Checks,
Changes and Commits metrics; commit rows expand inline and tap into the same
timeline anchors as desktop. Descriptions turn safe embedded GitHub HTML into
Markdown and `<details>/<summary>` into native disclosure rows. Other bodies
normalize escaped newlines and use the shared Work markdown renderer. Folded
comment and thread previews stay plain text.

## Gotchas

- **Timeline mutations use `writeViewerLogin`, not `viewerLogin`.** The App credential can fill `viewerLogin` while writes are unavailable. `writeViewerLogin: null` must hide the controls; omitting the prop is the compatibility fallback.
- **`CreatePrModal` validates the branch name** before submission and rejects invalid ref characters.
- **`rehype-sanitize` must run after `rehype-raw`** in the PR body renderer, or attacker-controlled HTML gets through.
- **Fingerprint exclusion list.** `getPrFingerprint` omits four fields. A new volatile field not in the list makes polling notify on every tick.
- **Hot polling stays externally bounded.** Only service-owned mutations or new mappings start a hot window. Never reset a hot PR's start time from a refresh result.
- **A failure TTL is never shorter than the success TTL** (`githubReadBackoff.ts`). The floor is the fix, not the doubling.
- **Never classify a failure by message text.** IPC and JSON-RPC flatten errors to messages. Arm the backoff on **any** rejection and take the typed kind from `ade.github.getRequestBudget`.
- **Fetch a job log only for a failed job.** `getCheckLog` downloads a log when the job's state is `failed` or a user action sets `includeLog`. Other states render from `PrActionJob.steps`, already in the checks poll.
- **`PrCheckLogExcerpt.logStatus` is the three-way answer**, not `lines.length`: `excerpt`, `not-fetched`, `unavailable`.
- **A swallowed failure that returns an empty result is a quota bug.** Any best-effort read whose emptiness feeds a loop's stop test must tell "could not read" from "empty".
- **Every foreground GitHub timer consults the poll governor.** Gate a new automatic PR read on `isGithubPollStoodDown()` and take its interval from `githubPollPeriodFor(base)`. User actions stay exempt.
- **Search never live-fetches GitHub.** `searchService.processPr` indexes local titles, numbers and URLs only.
- **A lookup that falls back to cached data does not report success.** A failed per-branch lookup returns `null`, not `[]`. `refreshLaneGithubPrTags` returns `false` when it served the previous snapshot (that drives the retry), and `GitHubTab`'s error path returns the cached snapshot and still records the failure.
- **A non-null `lane_id` does not mean the lane exists.** A new lane-scoped query on `pull_requests` adds `detached_at is null`; a project-wide query does not.
- **Count lane provenance before the delete cascade**, or the counts freeze at zero.
- **New `pull_requests` columns are mirrored on iOS.** A column the phone does not know fails the changeset apply and freezes that device's sync. Add a nullable `ensureColumn` without a unique index in `apps/ios/ADE/Services/Database.swift`.
- **Post-merge cleanup is best-effort.** Never put the merge in the same try-catch.
- **Never delete a branch the caller did not ask about.** `deleteRemoteBranch` defaults to false on every transport, and every transport passes an explicit opt-in through.
- **A lane is never an authorization check.** Do not add `requireRow(prId)` to a PR mutation; guard the real hazard (`cleanupBranch` checks the repository and fork-ness).
- **A synthetic `gh:` id is attacker-influenced URL input.** Keep the `parseSyntheticGithubPrId` grammar strict.
- **`parseConflictMarkers` handles CRLF** (`\n` and `\r\n`) for Windows checkouts.
- **Review thread actions use GraphQL** (`getReviewThreads`, `replyToReviewThread`, `resolveReviewThread`). They work on unmapped PRs by synthetic id and key on the global node id. `assertThreadBelongsToPr` confirms the thread belongs to the PR.
- **`mergeStateStatus` needs** `Accept: application/vnd.github.merge-info-preview+json`. Without it the merge box falls back to the REST heuristic (logged at `warn`).
- **The direct reader never pins to ADE Cloud.** A PR read with no own computer online goes to GitHub with the account's sign-in (`usePrsReader`), and the account lane index is read once per list open. Do not add a per-row index read or a machine read to `DirectPrsList`.

### GitHub access and reminders

A working GitHub CLI login gives ADE GitHub access without a personal access
token. [GitHub settings](ade://settings/integrations.github) names the active
read and write credentials. The ADE GitHub App adds optional real-time updates.

- Dismissing setup reminders applies to the lower-cased repository (`owner/name`) across worktrees, with no expiry. GitHub settings has **Dismiss setup reminders** and **Show reminders again**. Older repo/path reminders migrate when the repository opens.
- Credential failures, unreadable stores and Git transport failures have their own alarm dismissals per machine and repository (or project path before the repository is known); setup snoozes never hide them. An alarm stays dismissed until its access recovers.
- API access, App authorization and Git transport recover independently: an API read does not re-arm a broken push alarm.
- Missing App issue-write permission is a setup reminder when another credential covers issue edits, and an alarm when none does. Recovery never clears the setup snooze. Outage notices keep their incident handling.

## Writing in a PR

Comments, reviews, replies and the new-PR description share
`PrWritingTextarea`: `@` suggests people (`searchMentionables`, a debounced
GraphQL read cached per repo and query) and `#` suggests issues and PRs
(`getRepoReferences`, cached per repo). The reviewer card searches people
(`assignableUsers` with `includeTeams`) and teams past GitHub's first page.
Task-list boxes in the description are clickable for its author and anyone with
write access: the box changes at once, saves go to GitHub in click order, and a
failed save returns to GitHub's text. Boxes use the renderer's markdown grammar
(look-alikes in code and HTML do not count), and a CRLF body keeps its line
endings.
