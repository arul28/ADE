# Pull requests

DAEX's PR surface manages lane-backed PRs, native GitHub stacks and GitHub
inspection. There is one view, the GitHub list; a link with an unknown `tab`
opens it. Local git is the source of truth for merge simulation; layered caches
keep GitHub state warm.

Detail docs:

- [`github-stacked-prs.md`](./github-stacked-prs.md): native GitHub stacks.
- [Conflicts](../conflicts/README.md): conflict prediction, `prs.getConflictAnalysis` and rebase needs.

Commands are spelled `daex prs …`; `ade prs …` still works.

## Source file map

Services (`apps/desktop/src/main/services/prs/`; they run in the runtime
daemon, and the desktop main process serves local-bound windows):

| File | Owns |
|---|---|
| `prService.ts` | PR CRUD, GitHub sync and snapshots, status/checks/reviews/comments, merge (`land`), `updateBranch`, post-merge and branch cleanup, lane PR resolution, reconcile-on-focus, `syncLanePr`, the mobile snapshot, Linear PR cards. Every mutation resolves through `resolvePrTarget` (row id or synthetic `gh:` id). |
| `prPollingService.ts` | Webhook-first freshness plus the polling safety net, hot windows, discovery, `last_polled_at`. |
| `githubReadBackoff.ts` | The failure ladder shared by snapshot and per-branch reads. |
| `requiredChecks.ts` | A base branch's required contexts: rulesets → classic protection → `mergeStateStatus === "blocked"` (corroboration only); `null` means unknown. 5-minute cache. |
| `mergeStateGraphqlBrake.ts` | Per-repo brake on the merge-box GraphQL read. |
| `prGithubReadCache.ts` | Shared and while-quiet reuse of GitHub answers for an open PR. |
| `pullRequestRowCleanup.ts` | The only writer of the detach columns; PR↔chat edge cleanup. |
| `prMergeAutoSettlementService.ts` | Files sessions after a merge ([Merge settlement scope](#merge-settlement-scope)). |
| `prChatCards.ts` | Durable `ade_card` episodes for linked chats (CI, review, merge ready, conflict, merged, stack land). |
| `prChatLinkStore.ts` | PR↔chat edges, dismissals, cross-lane chat ids, stack-layer parent attach. |
| `prShellLinkWatcher.ts`, `prShellBodyRepair.ts`, `prBodyProofStaging.ts` | Link a PR from a chat's `gh pr create`/`merge`; repair text a chat wrote with `gh`; stage cited proof for `gh pr edit --attach`. |
| `prWatchService.ts`, `prChatWatchStore.ts` | PR Watch / Ship ([below](#pr-watch--ship-waking-the-chat)). |
| `prCommentMutations.ts` | Comment PATCH (author must be the write viewer) and reaction decoding. |
| `prListFilters.ts` | GitHub-side label/author/assignee filters and assignee writes. |
| `workflowGraph.ts`, `checkLogParser.ts` | CI DAG from the workflow YAML that ran (`needs`, `strategy.matrix` only; never guesses an edge); failing-step log excerpts. |
| `githubStackStore.ts`, `githubStackMerge.ts` | Native stacks and the async stack merge ([github-stacked-prs.md](./github-stacked-prs.md)). |
| `prHeadChange.ts`, `resolverUtils.ts` | Stale-head refusal and merge error wording. |
| `laneBranchHistoryOwnership.ts` | Which lane owns a PR on a branch from the lane's reflog history. |
| `prRowMetadata.ts`, `prTranscriptGists.ts` | Row decoding (merge facts, detached lane); opt-in chat transcripts as secret gists. |

GitHub access (`apps/desktop/src/main/services/github/` unless noted):

| File | Owns |
|---|---|
| `githubService.ts`, `apps/ade-cli/src/headlessLinearServices.ts` | Desktop and daemon request paths: credential chain, retries, transport-failure recording, `getStatus`, `getRequestBudget`. Keep both in step. |
| `githubCredentialHealth.ts`, `githubRateLimit.ts` | Per-token health, cooldowns, rate-limit resets, the 500-request reserve, failure classification. |
| `githubRequestGate.ts`, `githubRequestAccounting.ts` | Six requests in flight per process; a usage summary log every 10 minutes. |
| `githubAppUserAuth*.ts` | The DAEX GitHub App user credential; see [automations](../automations/README.md#how-ade-stops-a-github-app-refresh-storm). |
| `githubStatusPage.ts`, `apps/desktop/src/shared/githubServiceHealth.ts` | Outage corroboration. |
| `githubMediaResolver.ts` | Signed URLs for private-repo attachments. |
| `credentialReadState.ts` | Credential plus store-readability verdict in one read. |
| `apps/desktop/src/shared/githubOperationCredential.ts` | Credential order per capability; 30 s credential cache, 2-minute status cache. |
| `apps/desktop/src/main/services/git/ghOpenPrLookup.ts`, `ghPrHeadRepo.ts` | `gh`-based open-PR lookup for a lane branch. |
| `apps/desktop/src/main/services/git/gitTransportAuth.ts` | Git push/fetch sign-in fallback. |

Renderer (`apps/desktop/src/renderer/components/prs/`):

| File | Owns |
|---|---|
| `PRsPage.tsx`, `prsRouteState.ts` | Page shell and URL state; last route per project root. |
| `state/PrsContext.tsx` | List, selection, stacks, viewer logins, optimistic terminal states, poll governor. |
| `state/githubPollGovernor.ts`, `state/useGithubPollGovernor.ts` | The brake on automatic reads. |
| `state/prsReader.ts`, `DirectPrsList.tsx`, `LaneMentionChip.tsx`, `state/accountLaneMentions.ts` | Reader choice and the no-machine list. |
| `tabs/GitHubTab.tsx`, `tabs/githubTabModel.ts` | The repository list and its pure model. |
| `detail/PrDetailPane.tsx`, `detail/PrDetailHeader.tsx`, `detail/PrDetailTimelineRails.tsx` | Detail pane, header, Overview. |
| `detail/PrChecksTab.tsx`, `detail/prChecks*.ts(x)`, `detail/PrChecksGraph*.tsx` | CI workspace (Graph / List / Failures). |
| `shared/PrTimeline.tsx`, `shared/prDigestTimelineModel.ts`, `shared/PrTimelineDigestRows.tsx` | The virtualized triage thread. |
| `shared/PrFloatingDock.tsx`, `shared/PrMergeDialog.tsx`, `shared/prMergeRailUtils.ts` | Merge card and dialog. |
| `shared/PrActionsMenu.tsx`, `shared/prChatActions.ts` | The `⋯` menu; chat actions fill a composer and never send. |
| `shared/PrMarkdown.tsx`, `shared/prMarkdownContext.tsx`, `shared/PrBrief.tsx`, `shared/PrProofMedia.tsx`, `shared/useGithubMediaSrc.ts` | PR markdown, Brief, proof media. |
| `shared/PrCheckLogDrawer.tsx`, `shared/PrChangeSplit.tsx`, `shared/prListGrouping.ts` | Job detail, code-vs-tests diff split, terminal-bucket grouping. |

Outside the PRs tab: `renderer/lib/lanePrBadge.ts` (`openLanePr`, the one
"open this PR"), `renderer/components/terminals/useLanePrs.ts` (lane→PR map),
`renderer/lib/prReadCache.ts` (coalesced reads), `renderer/components/lanes/lanePageModel.ts`
(`selectLanePrs` / `selectChatPrs`), `renderer/components/chat/PrWatchPill.tsx`.

Shared (`apps/desktop/src/shared/`): `types/prs.ts` (DTOs; `syntheticGithubPrId`
/ `parseSyntheticGithubPrId`), `prChecksRollup.ts`, `prPipelineState.ts`,
`prNextStep.ts`, `prChatScope.ts`, `prBotIdentity.ts`, `prConversationDigest.ts`,
`prBodyBotSections.ts`, `prBrief.ts`, `prBodyProof.ts`, `prWatch.ts`,
`prAutoMerge.ts`, `linearMagicWords.ts`, `ghPrShellCommands.ts`.

CLI and agents: `apps/ade-cli/src/cli.ts` (`daex prs …`),
`apps/ade-cli/src/adeRpcServer.ts` (`create_pr_from_lane` returns `{ pr,
githubUrl, adeUrl }`; `pr_*` tools), `apps/ade-cli/src/prEventFanout.ts`.

## Gotchas

- **Timeline mutations use `writeViewerLogin`.** The App can fill `viewerLogin` while writes are unavailable; explicit `null` hides Edit and Add reaction.
- **`rehype-sanitize` must run after `rehype-raw`** in `PrMarkdown`.
- **Poll fingerprint.** `getPrFingerprint` (`prPollingService.ts`) drops `projectId`, `lastSyncedAt`, `createdAt`, `updatedAt`. A new volatile field must join the list or every tick notifies.
- **Hot windows start only from service-owned activity.** Never reset a hot PR's start time from a refresh result.
- **A failure TTL is never shorter than the success TTL** (`githubReadBackoff.ts`).
- **Never classify a failure by message text.** IPC and JSON-RPC flatten errors. Arm on any rejection; read the kind from `ade.github.getRequestBudget`.
- **An empty result from a swallowed failure is a quota bug.** A read whose emptiness feeds a loop's stop test must tell "could not read" from "empty" (`getChecks` rejects when neither source answered; a failed branch lookup returns `null`, not `[]`).
- **Every automatic GitHub timer in the renderer consults the poll governor** (`isGithubPollStoodDown()`, `githubPollPeriodFor(base)`). User actions are exempt.
- **Fetch a job log only for a failed job**, or when a user action sets `includeLog`. `PrCheckLogExcerpt.logStatus` (`excerpt` / `not-fetched` / `unavailable`) is the answer, not `lines.length`.
- **Search never fetches GitHub.** `searchService.processPr` indexes local fields only.
- **A non-null `lane_id` does not mean the lane exists.** Lane-scoped queries add `detached_at is null`.
- **New `pull_requests` columns must be mirrored on iOS** (`apps/ios/ADE/Services/Database.swift`, nullable `ensureColumn`, no unique index), or the phone's changeset apply fails and its sync freezes.
- **Post-merge cleanup is best-effort.** Never share a try-catch with the merge.
- **Never delete a branch nobody asked about.** `deleteRemoteBranch` defaults to false on every transport.
- **A lane is never an authorization check.** Do not add a row requirement to a mutation; guard the real hazard.
- **A synthetic `gh:` id is attacker-influenced.** Keep the `parseSyntheticGithubPrId` grammar strict ([below](#synthetic-pr-ids-are-an-authorization-input)).
- **`mergeStateStatus` needs** `Accept: application/vnd.github.merge-info-preview+json`, else the REST heuristic is used.
- **The direct reader never pins to DAEX Cloud** and reads the account lane index once per list open.
- **Count lane provenance before the delete cascade**, or the counts freeze at zero.

## Where this runs

PR mutations, polling, stack reconciliation and agent dispatch run in the
active runtime: local for a local window, remote for a remote one.
`window.ade.prs.*` (`apps/desktop/src/preload/preload.ts`) is the routing
boundary.

- A local window calls in-process IPC for high-volume reads (`listWithConflicts`, `getDetail`, `getStatus`, `getChecks`, `getReviews`, `getComments`, `getDetailBundle`, `getFiles`, `getCommits`, `getDeployments`, `getGitHubSnapshot`).
- A remote window reads through `callPrReadRuntimeActionOr` (`domain: "pr"`).
- Polling: a runtime-bound window's daemon owns `prPollingService` (`apps/ade-cli/src/bootstrap.ts`) and the relay ingress loop ([automations](../automations/README.md#runtime-ownership)). A local-bound window's main process starts its own at project init (`prs.polling_start`, gated by `ADE_ENABLE_PR_POLLING`) or on the first PR read (`ensurePrPolling` in `registerIpc.ts`).

## Which machine answers a PR read

A lane's PR row lives in the `.ade` database of the lane's machine, so a PR
read names a machine.

- Every `pr` read in preload takes an optional trailing `OpenProjectBinding` pin and routes through `callPinnedOrBoundRuntimeActionOr`. `prs.onEvent(cb, pin)` subscribes to that machine's events.
- Lane mutations go to the lane's owner. Creating a lane from a PR asks for a machine when several qualify. Merge is unavailable while the owner is offline. The GitHub inventory is repository-wide.
- `openLanePr` is shared by every Work surface. A foreign PR opens on GitHub (a PR id resolves only on its machine).
- Cross-machine rows come through the Work union (`renderer/state/crossMachineLanes.ts`): each machine slice carries `prs`, read with `pr.listAll` in parallel with lanes and sessions. The read is best-effort; a machine that fails it keeps its last rows. `decodeForeignPrs` drops rows missing a badge field.
- Lane ids are not unique across machines, so `useLanePrs` keys its map three ways: `bound:<laneId>` (`boundMachineLanePrs`), `<machineId>:<laneId>` (`lanePrsForMachine`), `any:<laneId>` (`laneHasAnyPr`, the Has PR filter only).
- `prReadCache.ts` keys by pin before project root, and the snapshot read also by `automaticRefresh`.
- The web client has one host: its `prs` adapter runs every pin through `assertWebRuntimePinRoutable`.

## With no computer awake

`usePrsReader` (`state/prsReader.ts`) picks the reader:

| Reader | When | Shows |
|---|---|---|
| `machine` | An online copy of the repository | The full tab, pinned to that copy. |
| `direct` | No machine online, a github.com repo, `window.ade.githubDirect` | `DirectPrsList`: open PRs, read-only, via the account's GitHub sign-in. |
| `none` | Neither | "No computer is online"; no call. |

A DAEX Cloud tab never pins a PR read to DAEX Cloud.

The direct list (`lib/accountGithubReadStore.ts`) shares one read per request,
refreshes every 60 s only while shown and visible, uses ETags, skips timed
refreshes under 10 % rate limit, waits 5 minutes on a state only a person can
fix, and drops stored data when the DAEX account changes.

**Lane chips** come from one read of the account lane index (`GET
/account/lanes`, `useLaneMentionsByPr`) per list open. A lane on an online
machine opens in Lanes; on a resting DAEX Cloud computer it wakes it first
(`wakeRestingCloudMachine`); on an offline own computer it says so and does not
open. A failed index read shows a Retry banner and keeps the old rows.

## Core model

`PrSummary` (`apps/desktop/src/shared/types/prs.ts`) carries identity
(`repoOwner`, `repoName`, `githubPrNumber`), `laneId`, `state`
(`open | closed | merged`), branches, `checksStatus`
(`passing | failing | pending | none | not_run`), `checksReason`,
`checksMissingRequired`, `reviewStatus`, labels, and optional `detached`,
`mergedBy`, `mergeMethod`, `commitCount`, `changedFiles`. `PrStatus` adds live
merge-box fields (`mergeStateStatus`, `reviewDecision`, approvals,
`mergeabilityComputing`, `canBypass`, `headSha`, auto-merge state).

`unmapped: true` marks a summary built from a `github_pr_projections` row (no
`pull_requests` row). Its id is the synthetic `gh:owner/repo#num`.

## Checks rollup (what counts as a pass)

`apps/desktop/src/shared/prChecksRollup.ts` is the only place that decides
whether a commit was verified. Every surface (PR rows, Lanes, detail, the
`pr_ci` card, CLI, iOS) reads its verdict. It answers "was this code
verified?", not "did anything succeed?":

1. States map through `prPipelineState`; `skipped` and `neutral` are not success.
2. A CI producer must have succeeded. Non-CI producers are a denylist (`NON_CI_PRODUCER_APP_SLUGS`: review bots, preview deploys, dependency bots), so unknown CI systems count. Legacy commit statuses (`commit_status`) are CI.
3. Required contexts that never reported hold the rollup back; a satisfied required gate overrides the producer guess, but only after the in-flight check.

Precedence: failure → in flight → missing required → satisfied required → any
CI pass → all CI skipped → only non-CI or `blocked` → nothing.

- `none`: nothing observed and nothing expected. `not_run`: something was expected and nothing verified the commit. `not_run` always reads muted, never in the danger colour.
- `CI_PENDING_GRACE_MS` (5 min) holds `pending` after a push, clocked from the earliest check start (else the PR's `updated_at`).
- `checks_reason` and `checks_missing_required` columns on `pull_requests` (a CRR table; ALTERs go through `crrAwareDb`). On `PrSummary`, absent means "keep", null means "clear".
- Webhooks only say which PR changed; `computeStatus` re-derives, as the poll does. A failed checks fetch keeps the previous rollup instead of storing a false `not_run`.

## IPC surface

PR channels are in `apps/desktop/src/shared/ipc.ts` and preload. Reads that
take a trailing pin: `getForLane`, `syncLanePr`, `reconcileOnFocus`, `listAll`,
`refresh`, `getStatus`, `getChecks`, `getComments`, `getReviews`, `onEvent`.
Notable contracts:

- `land`: one PR, or a stacked PR through GitHub's async merge. `deleteRemoteBranch` is opt-in.
- `updateBranch`: `merge` uses GitHub's API and works for any PR; `rebase` needs a local checkout and reports `hasConflicts`.
- `getDetailBundle`: status, checks, reviews, comments; a failed piece does not drop the others.
- `getGitHubSnapshot({ force?, includeExternalClosed?, historyPageLimit?, automaticRefresh? })`: `automaticRefresh: true` keeps a timer's call inside the failure ladder. The renderer ignores the legacy `externalPullRequests`.
- `reconcileNow`, `reconcileOnFocus(pin)`, `syncLanePr`: see [Keeping PR status fresh](#keeping-pr-status-fresh).
- `ade.github.getRequestBudget`: zero-network budget (reserve pause, worst recent failure kind, retry instant), on IPC, the `github` action domain and sync.
- `listOpenForRepo`: open PRs as `BranchPullRequest[]` for the lane-creation branch picker.

## GitHub data-loading model

The GitHub tab lists the repository's PRs, newest update first. **Blocked**
floats rows whose next step needs a person (`prNextStepBlocker`) without moving
rows across buckets. Scope is `all` / `ade` (DAEX-managed) / `external`.
Cross-repo PRs are not fetched.

1. **Runtime cache.** Snapshot TTL 120 s (open) / 600 s (with history), shared in-flight. After the repo page, at most 12 targeted head-branch lookups for lane branches it missed; backed-off branches drop out first, and the open path skips never-pushed branches.
2. **Renderer cache.** `PrsContext` keeps the last snapshot; a detail pane hydrates from `listSnapshots` and applies each live piece as it resolves.
3. **Refresh** forces a pull and is the only caller past the failure ladder. Every timer sends `automaticRefresh: true`.

Label, author and assignee filters search GitHub (`pr.searchGithubPrs`, GraphQL
`search`, 50 a page). Until GitHub answers, the loaded rows are narrowed
locally with a note. Filters live in the warm cache, not the URL.

### GitHub read failure ladder

`githubReadBackoff.ts` keys `snapshot:<owner>/<repo>` and
`branch:<owner>/<repo>#<branch>`.

- A failure arms 20 s → 40 s → 80 s …, capped at 15 minutes and floored at the success TTL (the open-list 120 s for the snapshot key).
- Only errors tagged by `markGithubRequestError` arm it; a local failure never silences GitHub.
- A backed-off read replays the recorded error unless cache or a projection can answer.
- Any success clears its key; dropping auth clears all keys and bumps an auth generation. A user `force` is exempt.

### Terminal-state precedence

When DAEX holds a terminal state (`merged`, `closed`), it beats a stale
non-terminal row (`isTerminalPrState`, `renderer/lib/prState.ts`).
`reconcileLinkedPrState` rewrites linked rows; `computeTerminalOverlayItems`
keeps a just-merged row visible when an open-only snapshot drops it;
`applyOptimisticTerminalState` moves a row the user just merged or closed at
once (only into a terminal bucket, expiring after 5 minutes). Reopen clears it.
The selection follows a PR into its new bucket, and the pane shows
`PrBucketTransitionBanner` instead of blanking. Merged/Closed lists are grouped
by period (`prListGrouping.ts`); Open is flat.

## A lane link is not a permission

The link between a `pull_requests` row and a lane is internal plumbing. The UI
has no "map" or "unmap" words. The link decides only:

- local bookkeeping after a mutation (`refreshAfterMutation`);
- lane side effects of a merge (archive, group removal, rebase-needs scan);
- provenance (chats, proof, frozen `was: <lane>` counts);
- `updateBranch` with `rebase`, which needs a local checkout.

Everything else (merge, close, reopen, comments, reviews, labels, re-run,
graph, logs, branch cleanup) is a GitHub call through `resolvePrTarget`.
`cleanupBranch` refuses fork PRs and PRs outside this project's repository.
The one offer is **Open as lane**, hidden for terminal PRs and where a lane
exists.

### Synthetic PR ids are an authorization input

The id decides which endpoint a write hits on the user's token.
`parseSyntheticGithubPrId` matches GitHub's name grammar and rejects `/`, `..`
and `#`. A looser group would let `gh:x/../../user/repos#999#1` normalise to a
caller-chosen endpoint.

## Lane PR resolution (mapped + unmapped)

A lane badge reads mapped `pull_requests` rows and unmapped
`github_pr_projections` rows (same repo, not a fork, the active repo).
`selectLanePrDisplayCandidate` filters to the lane's branch;
`compareLanePrDisplayCandidates` ranks open/draft → merged → closed, then
recency, then number. `getForLane` and `listPrsByLane` use it. A primary lane
on its base branch has none.

- **Open-PR lookup** (`ghOpenPrLookup.ts`, `ade.git.getOpenPrForBranch`): `gh pr list --head <branch> --state open --limit 10` in the lane worktree, filtered to the `origin` owner's head repo. 8 s timeout, never throws. An old `gh` (< 2.47) that rejects the head-repo fields gets one retry with `GH_PR_LIST_LEGACY_JSON_FIELDS`.
- A material refresh also writes the projection row and emits `prs-updated`.
- In the daemon, `createPrEventFanout` isolates each event sink.

## Multi-PR lane ownership and chat edges

A PR row resolves by `(repo_owner, repo_name, github_pr_number)`, never by
branch: two PRs from one chat share the lane's branch.

- `linkToLane` accepts a PR on another branch or owned by another lane; the owner keeps ownership. A PR the lane does not own gets no description rewrite or Linear cards.
- `createLaneFromPrBranch` refuses a PR that already has an owning lane, and records a one-shot chat origin that the lane's first ordinary user chat claims in the same transaction as its edge.
- `pull_requests.lane_id` is not unique. A row whose head matches the current branch is `active`, others `previous`, derived at read time. A branch switch never detaches.

Chat edges live in `pull_request_chat_sessions`; unlink writes a PK-only
tombstone in `pull_request_chat_session_dismissals`. Both are CRR tables:
never add a unique secondary index.

- `selectPrsForChat` is edges-first; a chat with no edge may show unedged current-branch PRs and never another chat's.
- Links climb the spawn tree to the root, one way. A new chat starts linked to its parent's open or draft PRs.
- Only chats on the PR's own lane claim it (`crossLaneChatSessionIds`), so cross-lane links get no cards except the stack-land card.
- Cards go only to `draft` and `open` PRs, plus the merged card.
- Deleting a chat or lane removes its edges, not the PR row. A session this machine never saw is not treated as deleted.

### Lane surfaces and chat surfaces need two different selectors

In `lanePageModel.ts`:

- **`selectLanePrs`** is strictly lane-owned (`pr.laneId === lane.id`), for lane tags, badges and Work cards over the project-wide list. A primary lane on its base branch returns nothing.
- **`selectChatPrs`** adds any PR this chat linked, even one another lane owns, because `linkToLane` leaves `lane_id` on the owner.

`shared/prChatScope.ts` (`selectPrsForChatInLane`) narrows either set for the
chat toolbar and PR pane. iOS mirrors both (`apps/ios/ADE/Views/Lanes/LaneHelpers.swift`).

`#` in the composer inserts a PR chip from `prs.listAll` on the chat's pin.
⌘K finds a chat by its PR number, URL or title (`searchService`).

### Merge settlement scope

`prMergeAutoSettlementService` resolves a `MergeSettlementScope`:

| Scope | When | Files |
|---|---|---|
| `linked` | The PR has `chatSessionIds` | Exactly those sessions, once each has no other open/draft linked PR. |
| `sweep` | No declared chats, every other lane PR closed or merged | Eligible non-chat sessions in the lane minus those another PR claims. |
| `ambiguous` | No declared chats, another lane PR open or draft | Nothing. |

Each PR is handled once. A first-sight merge (backfill, first snapshot after
restart) files silently with no toast. Chats reach `linked` for PRs opened
outside DAEX through auto-map (up to three agent sessions open when the PR was
created) and `prShellLinkWatcher.ts`, which reads `gh pr create` / `gh pr merge`
in a chat's shell commands; GitHub must confirm the PR is this repo's, not a
fork, with the lane's branch as head.

**PR text repair.** When a chat writes PR text with `gh pr create` or
`gh pr edit --body`, the watcher reads it back, restores the "Open in DAEX"
footer and Linear reference, and uploads proof the text cites (owned by the chat
or lane only). One repair per PR at a time; it skips if the text changed
meanwhile. Without `gh` 2.99+ only the footer goes back.

### Active-turn deferral

A merge outranks pending input and background work, not a running chat turn:
the settle check ([settle-teardown-design](../terminals-and-sessions/settle-teardown-design.md))
refuses with `turn_running`. So `hasActiveChatTurn` and
`sessionHasOpenLinkedPrs` run before each settle.

- Liveness comes from `getChatLiveness` (`chatLivenessReader(agentChatService)`), wired in desktop `main.ts` and `apps/ade-cli/src/bootstrap.ts`. Only `status` counts; `awaitingInput` is resting.
- No liveness settles at once; the persisted row is never read. A thrown read counts as active.
- The gate re-checks every poll with no cap. A deferral logs `prs.auto_settle_deferred_active_turn`.

## Detached PR rows

Deleting a lane soft-detaches its PR rows so the record of DAEX's work stays:
`detached_at`, `detached_lane_name`, `detached_lane_color`,
`detached_provenance` (`{ chats, artifacts, checkpoints }`).

- `detached_at` is the flag. `lane_id` keeps the dead id (it is `NOT NULL` in a CRR table).
- `countLaneProvenance` runs before the lane-delete cascade. The first detach wins.
- Lane-scoped reads apply `LIVE_PR_ROWS`; project-wide reads do not (that is how the merged view gets provenance). `conflictService` and `laneService` apply it too.
- Only lane delete and explicit destructive cleanup detach. Detach nulls the snapshot JSON columns after lifting `commit_count` / `changed_files`; `prunePrSnapshots` (60 days) is the backstop.
- Only `upsertRow` reclaims a detached row, when the lane exists and still tracks the head branch. `getLiveRowForRepoPr` backs ownership guards; `getRowForRepoPr` is unfiltered so upserts never duplicate.

`recordMergeOutcome` stores merger, method, commit count and changed files
(from `land()` or `computeStatus`) with `coalesce`, and never fails a merge.

## GitHub connectivity model

`getStatus()` returns one `GitHubStatus`. UI reads `connected` for reads and
`writeAuthSource` for mutations, never token-storage fields.

- `authSource`: environment → DAEX GitHub App → GitHub CLI → stored PAT. The App is read-only (except `issue-write` when its installation grants Issues: write).
- `writeAuthSource`: first usable environment, CLI or PAT; `none` means reads may work while writes do not. `writeUserLogin` becomes the snapshot's `writeViewerLogin`.
- `gitTransport`: can `git push` to the https origin sign in. Remote git commands run through `runGitWithGithubAuthFallback` (`gitTransportAuth.ts`): git's own credential first, then DAEX's write credential as an `http.extraheader` in the environment (never persisted, never on the command line). `auth_failed` raises the **Git can't sign in to GitHub** banner.
- `credentialStoreUnreadable`: the store could not be decrypted, so it reads as empty. Never show it as "never connected": a reconnect overwrites the credentials. Checked first, before `!tokenStored` and outages (`describeGithubCliBanner`, `prService.buildGithubSnapshotAuthError`).
- `authFailure.kind`: `rate_limited`, `invalid_token`, `permission_denied`, `service_unavailable`, `network`, `renewing`, `unknown`. `service_unavailable` never offers reconnect; `renewing` means another process holds the App refresh lease.
- `backgroundRefreshPausedUntil`: set when core or GraphQL quota reaches the 500 reserve.
- `connected`: needs `userLogin`; the App and fine-grained tokens also need the repo probe; classic/oauth need the required scopes.

Status caches 30 s; `getStatus({ forceRefresh: true })` bypasses it. Token
changes broadcast `ade.github.statusChanged`. `renderer/lib/githubIntegrationStatus.ts`
is the one interpreter for Settings and the App Shell banner.

GitHub setup reminders are dismissed per lower-cased `owner/name`. Credential,
store and transport alarms have their own per-machine dismissals and stay
dismissed until access recovers.

## Telling a GitHub outage apart from a broken credential

DAEX never pushes a reconnect that can destroy a working credential.

- **The response.** `isGithubServiceUnavailable` (`shared/githubServiceHealth.ts`) treats any 5xx and GitHub's own outage bodies as `service_unavailable`. That kind gets no credential cooldown, and `resolveGithubStatusCredentials` stops walking the chain on it.
- **Corroboration.** `githubStatusPage.ts` reads githubstatus.com's `summary.json` only after a `service_unavailable` or `unknown` failure (never as a poll), 60 s cache, 2 s timeout. It needs a component DAEX uses to be non-operational. Attribution is one-way: an incident stops DAEX blaming the credential; a healthy page proves nothing.
- `attachGitHubServiceHealth` wraps `getStatus` in both GitHub service owners.

### What the UI does during a corroborated outage

`describeGithubOutage(status)` gates every GitHub-blaming surface: the banner
family collapses into one neutral notice linking the incident, `GitHubSection`
reads "GitHub outage" and hides `gh auth login` steps, and PAT verification
says "unverified", not bad. Without corroboration, `service_unavailable` reads
"GitHub isn't responding" and never suggests reconnecting.

## Keeping automatic GitHub reads inside the quota

DAEX slows its request rate when GitHub fails; it never blanks a pane, hides a
PR or stops polling. A Checks-tab poll every 5 s costs 7–10 REST calls, so an
unbounded hour would spend the 5,000/hour quota.

- **One brake** (`state/githubPollGovernor.ts`) for every automatic PR read in the renderer. Any rejection arms a stand-down. Unclassified: one flat 30 s rung. Classified: `base * 2^(n-1)` to 5 minutes (base 60 s for `service_unavailable` / `invalid_token` / `permission_denied`, 30 s for `network` / `unknown`); `rate_limited` goes to the ceiling or GitHub's reset. Timers stretch their period instead of waking and returning.
- The failure ladder and the 500-request **reserve** are separate stand-downs; only the ladder clears on success.
- **The budget read is zero-network and zero-subprocess.** It reads in-memory credential health across every credential (quota is per account), reports the worst kind seen in the last 90 s by `REQUEST_BUDGET_FAILURE_SEVERITY`, which must stay in step with the governor's `ladderBaseMs`. Transport failures (hangs, timeouts, stalled bodies) are recorded too.
- **The background sweep rethrows only a GitHub-wide failure** (`isGithubWideFailure`), so one row that permanently 404s cannot pin the poller at max backoff.
- **Merge-box brake** (`mergeStateGraphqlBrake.ts`): a typed `rate_limited` arms a per-repo cooldown of `max(reset, now + 5 min)`; a missing `stack` field is memoized per repo. A failure must not resolve to `null`, which the renderer would count as success.
- **Delta sweeps** stop at the first page older than the last sweep (minus 60 s). The cursor stays in memory on the service: a CRR `kv` cursor would tell machine B that machine A swept. Only automatic sweeps stop early.
- **Fewer reads per PR**: one gate of six requests in flight; status/checks/reviews share reads (in-flight join, 5 s reuse); the merge box and review threads are reused while the PR is quiet (≤ 3 min, never while GitHub is computing; any DAEX write clears them); hidden windows skip detail ticks.

## Background polling

- With a healthy relay, webhooks drive targeted refreshes and the poller runs a 15-minute safety sweep. Without one, the configured 60 s interval (clamped 5 s–5 min, jittered).
- Each sweep fingerprints PRs and emits only changes: opened, reopened, closed, merged, checks failing, review requested, changes requested, merge ready.
- `checks_failing` fires once per red stretch; a new head toasts only on a later poll that still fails; a PR already failing at startup is not announced. Review events fire once per round; `none` does not end a round.
- **Webhook bursts fold**: a 500 ms quiet window, at most one `prs-updated` per 2 s.
- **Hot refresh** (relay down only): 15 s for the first minute, 30 s until three minutes, after service-owned activity.
- **Rate limits**: the poller waits for the reset plus a buffer, and pauses at 500 remaining core or GraphQL. Search does not pause it.
- **Discovery**: a full snapshot at most every 30 minutes (healthy relay) or 10, whether or not PRs are tracked, so a PR an agent opened with `gh pr create` maps to its lane for viewers on other machines.
- Toasts' "View PR" opens `/prs` with `detailTab` by kind.
- `last_polled_at` lets `since=` reads skip known work.

## Keeping PR status fresh

1. **Webhooks** via the relay feed `prService.ingestGithubWebhook`; linked ids coalesce into one targeted refresh after each cursor-committed page. Webhook results never start a hot window.
2. **Background polling** (above).
3. **Reconcile-on-focus** (`prService.reconcileOnFocus`) on project open and focus, for projects open on this computer. A chat on another machine asks that machine (`prs.reconcileOnFocus(pin)`, 60 s client cooldown in `requestMachinePrReconcile`). Phases: open sweep + auto-map, merged-heal of up to 25 stale rows, a 30-minute `state:"all"` closed sweep. Throttle (90 s) and single-flight live in memory on the service; `main.ts` limits to one at a time. `ADE_DISABLE_PR_RECONCILE=1` turns it off.
4. **Manual sync** (`syncLanePr`, the ↻ in `ChatPrPane`): a mapped PR refreshes by id; an unmapped lane looks for an open PR on its branch, then sweeps.

Both emit `pr-reconcile` (`running` / `idle`) for the "syncing…" spin.

- **Branch switch before create.** `createFromLane` reads the checked-out branch and adopts it through `laneService.updateBranchRef`; it pushes to `origin/<branch>` unless the upstream names the same branch.
- **Lane branch history.** `laneService` reads the worktree's reflog (`lanes/laneBranchHistory.ts`) and `prService.autoLinkLaneBranchHistory` links the best PR per visited branch (≤ 6 lookups per report per 10 min). It is the only path that recovers a PR opened and merged between polls.
- A refresh that changes only the sync time does not write the row; the time is kept in memory and persisted at most every 15 minutes.

## Merge flow

`computeStatus` / `getStatusByGithub` read the merge box over GraphQL, with
the REST heuristic as fallback. While GitHub computes, `mergeabilityComputing`
makes the renderer re-poll. The Merge card shows the next step and requirement
chips; behind base, the action is **Update branch** (`merge`). On conflicts the
pane offers a "resolve conflicts" prompt to the lane's newest chat on the
lane's machine.

`PrMergeDialog`: method (remembered under `ade:prs:lastMergeMethod`), editable
commit title/body (ignored for `rebase`), and `expectedHeadSha` captured on
open. It offers no branch deletion.

### A moved head refuses the merge and says what landed

`prHeadChange.ts` serves `land` and `githubStackMerge.ts`. `land` re-reads the
head and refuses before merging when it differs from `expectedHeadSha`; GitHub's
"Head branch was modified" refusal is handled the same way.
`LandResult.headChanged` carries old/new SHA, `appended` / `rewritten` /
`unknown`, and the newest ten commits. The desktop banner offers **Merge with
these** and **See what changed**; nothing merges without that click.

### Deleting the head branch is opt-in

A merge keeps the remote head unless `deleteRemoteBranch: true`. Desktop never
sets it; **Delete branch** on a merged PR calls `cleanupBranch`.
`daex prs land --delete-remote-branch` is the CLI spelling (`--delete-branch`
means the local branch in `daex lanes delete`). Remote/mobile pass it through
`parseLandPrArgs`. For a PR without a row, `deleteMergedHeadBranchByCoords`
deletes only a same-repo head; a 404 counts as success.

### Admin bypass and auto-merge

When the merge box is `blocked` or `behind` and `canBypass`
(`viewerPermission === "ADMIN"`), "Merge anyway" becomes "Bypass & merge":
`bypassRules = true` retries with `gh pr merge --admin` after REST refuses.
GitHub still decides.

`setAutoMerge` and `setDraft` use GraphQL mutations. "Enable auto-merge" shows
only when the repo allows it; a refusal reads through `describeAutoMergeFailure`.

## Post-merge cleanup

In an outer try-catch so it never hides the merge: remote branch delete (only
if asked), group removal, lane archive (if configured), base fetch, cache
invalidation, rebase-needs scan, and a default-branch auto-pull when the live
base is the default branch. Failures return `cleanupError`. A PR without a row
skips the lane steps.

`cleanupBranch` deletes a PR branch (local `git branch -D`, remote
`git push --delete` after `ls-remote` confirms) for a merged or closed PR. It
refuses forks, other repositories and any primary lane's branch, and reports
per-side results without throwing.

## PR issue resolution

Scopes: `checks`, `comments`, `both` (`shared/prIssueResolution.ts`). Nothing
auto-starts a resolution chat. Agents use the `pr_*` RPC tools
(`pr_get_checks`, `pr_get_review_comments`, `pr_rerun_failed_checks`,
`pr_reply_to_review_thread`, `pr_resolve_review_thread`). `pr_get_check_log`
and `pr_refresh_issue_inventory` are listed in `ai/tools/systemPrompt.ts` but
have no handler. See [chat/tool-system.md](../chat/tool-system.md#pr-issue-resolution).

### PR episodes in chat

The PR companion panel answers "what is true now" (opens only by toggle). An
`ade_card` row answers "what happened then": `pr_ci`, `pr_review`,
`pr_merge_ready`, `pr_merged`, `pr_conflict`, written through the durable
transcript path so cards replay after restart and sync to mobile.

- CI cards key on `prId + headSha + runAttempt` and update in place; at most three failure-first rows, CI and Other split by `isCiProducerCheck`. A failed read sets `degradedReason` with Retry, never a false status.
- `pr_conflict` is one quiet line.

### PR Watch / Ship: waking the chat

Cards never start a turn. **Watch** and **Ship** wake the chat when its PR
changes. Sources: `shared/prWatch.ts`, `prChatWatchStore.ts`,
`prWatchService.ts`, `PrWatchPill.tsx`, `PrWatchWakeLine.tsx` (iOS
`WorkPrWatchWakeLine`).

- Armed from the header pill menu, `daex prs watch|ship|unwatch <pr>` (default `$ADE_CHAT_SESSION_ID`), or the CTO tool `watchPullRequest`. Actions `pr.setChatWatch` (`mode: null` stops) and `pr.getChatWatches` on IPC, preload, web and sync. Only a DAEX chat, only a PR attached to a lane. Watching links the chat; unlinking stops the watch.
- **Wakes on**: each failing check; required checks passing; new comments and reviews from people and agent reviewers (not deploy/CI/dependency bots); a review bot editing its comment; a new conflict; merge or close; no CI on a head for 10 minutes (`PR_WATCH_NO_CHECKS_GRACE_MS`); removal from the merge queue. Comments DAEX posted (`pull_request_ade_comments`) never wake it.
- **Ship** holds news until every check on the head is terminal and an agent reviewer has spoken or 12 minutes passed (`PR_SHIP_REVIEW_BOT_GRACE_MS`); a conflict releases at once. Its wake text carries standing orders (fix CI and review in one push, answer threads, merge when green).
- **Delivery**: the reactor ticks every minute and on poller changes; checks and comments are re-read when the row changed, at least every 3 minutes. The wake is a normal message with `kind: "wake"`, shown as one `pr_watch_wake` divider, never a user bubble.
- **Work row**: `activePrWatch` on the session summary makes a resting watched chat read as running with liveness `pr_watch` (blue **Shipping**). Needs-you, live turns, failures and limits outrank it. iOS mirrors it in `WorkSessionCanonicalState.swift`.
- **Stops** on merge/close (one last wake), turn-off, archive/delete, or GitHub confirming the PR or access is gone. Transient failures leave it armed.
- **Machine-local**: both tables are excluded from CRR sync, so only the machine running the watch wakes the chat.

## Overview (triage layout)

`PrDetailTimelineRails` renders one column in the PRs tab and the chat tools
panel:

- **The thread** (`PrTimeline`): a one-line "Needs you" summary (failing checks, open threads; opens into a list), the description, then one section per push with each bot folded into one row. People, lifecycle events and deployments stay full rows. `n` / `p` step through unresolved threads; `g c` / `g t` / `g f` open palettes.
- **The push tick rail** on the right edge; **the floating dock** (Merge, Comment, Reviewers, Labels, Assignees) at bottom right.
- **Next step** (`shared/prNextStep.ts`): merged, closed, draft, computing, conflicts, behind, checks failing, changes requested, auto-merge armed, checks running, review required, rules blocked, ready. It guides, not gates: "Merge anyway" shows on every open non-draft PR, disabled only where GitHub refuses.
- **Bots** (`shared/prBotIdentity.ts`): GitHub's bot flag or `[bot]` suffix, or a distinctive agent login. `prBodyBotSections.ts` lifts bot-written blocks out of the description into that bot's row; no text is dropped.
- **Deep links**: `prsRouteState` carries `eventId`, `threadId`, `commitSha`, `detailTab`.

### The Brief

A description reads as a Brief when it has at least two known parts: **Why**,
**What changed**, **Evidence**, **Not checked**, optional **Choices I made**
(other templates' Problem / Change / Test plan map in). `parsePrBrief`
(`shared/prBrief.ts`) returns null when a cut would break the markdown. DAEX
stores nothing beside the text. `prBriefHints` prints advice in
`daex prs create` / `daex prs body` and never refuses.

### Proof in the PR text

Authors cite proof as in chat: `![caption](ade-proof://<id>)` and the
`proof-compare` fence. `daex prs create`, `daex prs body` and
`daex proof publish --pr <n> --in-body` upload the caller's own cited files with
`gh pr edit --attach` and rewrite the citations (`shared/prBodyProof.ts`).
`PrMarkdown` reads them back: this machine's copy when it has one, else
GitHub's. Video loads only from GitHub's attachment hosts
(`GITHUB_ATTACHMENT_MEDIA_SOURCES`). Parsers accept only https URLs and
well-formed proof ids, since anyone who can comment can write these forms.

**Private repository media.** After the original URL fails,
`useGithubMediaSrc` calls `prs.resolveMedia` once on the PR's machine.
`githubMediaResolver.ts` sends the token only to a canonical attachment URL,
takes a redirect only to a signed bucket URL, and never fetches the signed URL
with the token. No media bytes cross IPC.

### Add to chat

Any part of a PR (Brief part, comment, thread, picture, selection) can be
quoted into a chat when the PR has a lane. `PrDetailPane.addQuoteToChat` builds
an `<ade-chat-context>` block and queues it with
`queueAgentChatDraftHandoff(…, { collect: true })`. Target: the chat holding
the pane, else the newest linked chat, else a new lane chat.

## Renderer wiring

- `PrsContext` mounts cheaply: the first refresh paints from local rows and the cached snapshot with no GitHub fan-out.
- Chat-side surfaces (`ChatGitToolbar`, `ChatPrPane`) take a `runtimePin` from the chat's binding; effects key on `pin.key`. A pinned toolbar skips the dirty-file count (`diff.getChanges` is unpinned) and shows "switch machines" instead of create-PR.
- Opening the chat PR pane triggers a coalesced `prs.refresh({ prIds })`, no repo snapshot.

## Mobile snapshot

`prService.getMobileSnapshot()` (sync `prs.getMobileSnapshot`) returns
`PrMobileSnapshot`: `prs`, per-PR `capabilities`, `createCapabilities`,
`live`, plus `stacks` and `workflowCards`, always empty but kept because older
phones decode them as required. Actions go through sync commands
(`prs.createFromLane`, `prs.land`, `prs.close`, …).

- Webhook changes also emit a small `prs_updated` invalidation; iOS coalesces into one cached snapshot read and never polls GitHub on a timer.
- An unmapped PR uses `prs.getMobileGithubDetail`; a failed optional sidecar is named in `unavailableParts`, so the phone keeps the last good value instead of showing a zero. Unmapped PRs get the same mutation controls.
- See [iOS companion → PR detail screen](../sync-and-multi-device/ios-companion.md#pr-detail-screen).

## Odds and ends

- **No AI PR summaries.** The `pull_request_ai_summaries` table is dropped on open (desktop `kvDb.ts`, iOS `Database.swift`).
- **PR chat transcripts** (opt-in, `github.prTranscriptGists.enabled`): on PR create, up to 20 of the lane's chat transcripts go up as secret gists linked from the PR text.
- **Writing in a PR** (`PrWritingTextarea`): `@` people, `#` issues and PRs. Description task boxes are clickable for the author and writers; saves go in click order and a failed save reverts to GitHub's text.
- **Linear.** On PR open, `publishLinearPrCardsForLane` also includes issues attached only to a chat in the lane. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection).
