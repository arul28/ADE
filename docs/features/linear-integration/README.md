# Linear Integration

ADE connects a Linear workspace to a project. With it, a person can:

- Browse, search and edit Linear issues in ADE (desktop, web and iPhone).
- Start a lane or an agent from an issue, and attach issues to lanes and chats.
- Carry the issue through the branch name, commit messages and the PR body,
  so Linear links the PR to the issue.
- Run the ADE agent in Linear, raise "needs you" from the Linear inbox, keep
  lanes in step with issue changes, and post a lane's proof to its issues.

The connection belongs to the project and follows it to every computer on the
account. With no computer on, the ADE account server reads Linear for the web
and the iPhone, and renews an ADE-app sign-in itself.

ADE has no autonomous Linear workflow engine. The CTO
([`../cto/README.md`](../cto/README.md)) reads and updates issues through its
tools; automations react to Linear events
([`../automations/README.md`](../automations/README.md)).

## Source file map

### Connection and client (`apps/desktop/src/main/services/cto/`)

The Linear services live in `cto/` as shared plumbing. The CTO does not own
them.

| File | What |
|---|---|
| `linearAppClient.ts` | `ADE_LINEAR_APP_CLIENT_ID` (the ADE app's public PKCE client) and `LinearOAuthClientSource` (`"ade-app"` or `"custom"`). |
| `linearCredentialService.ts` | The project's encrypted connection (token, auth mode, expiry, refresh token, `clientId`), a custom OAuth client, `ensureFreshToken()`. |
| `linearAccountSync.ts` | The connection's vault item and the "one owner renews" rule. |
| `../account/rotatingCredentialOwner.ts` | `decideRotatingRenewal`: renew, claim or read. |
| `linearOAuthService.ts`, `linearOAuthRefreshLock.ts`, `linearTokenRefresh.ts` | Sign-in (loopback and worker bounce), the cross-process renewal lock, the token exchange. |
| `linearClient.ts`, `linearClientShared.ts`, `linearQuickView.ts`, `linearIssueSearch.ts`, `linearInbox.ts` | The GraphQL client: reads, writes, the quick view, search, counts and the inbox. |
| `linearIssueTracker.ts`, `issueTracker.ts`, `linearGraphQLInput.ts` | Normalized reads and the write helpers. |
| `linearLaneCardService.ts` | "Open in ADE" attachments for lanes, PRs and chats. |
| `linearLiveStatusService.ts` | The optional launch → PR → merge status writes. |
| `linearAgentService.ts`, `linearAgentRuntime.ts`, `linearAgentRelayClient.ts` | The ADE agent in Linear. |
| `linearInboxAttentionService.ts` | "Needs you" on a lane's chat from the Linear inbox. |
| `linearLaneSync.ts` | Lane issue fields from `Issue` webhooks. |
| `linearProofPoster.ts` | A lane's proof posted to its issues when it opens a PR. |

Also:

- `apps/ade-cli/src/services/linear/headlessLinearCredentialService.ts`,
  `apps/ade-cli/src/headlessLinearServices.ts`: the same connection in the
  headless brain (ADE Cloud computers too).
- `apps/desktop/src/shared/linearIssueNormalize.ts`: issue normalization,
  shared by the desktop client and the account reads. Pure.

### With no computer

| File | What |
|---|---|
| `apps/account-directory/src/cloud/integrations.ts` | `POST /cloud/integrations/linear/query`: fixed Linear reads with the project's vault connection. |
| `apps/account-directory/src/cloud/linearRenewal.ts` | The server's renewal of an ADE-app grant. |
| `apps/account-directory/migrations/0041_cloud_linear_renewals.sql` | The renewal lease table. |
| `apps/push-relay/src/accountVault.ts` | `vault/item` and the directory's Linear lease publish. |
| `apps/desktop/src/shared/adeCloud/integrationReads.ts` | Maps the panes' Linear calls to the account route (desktop on ADE Cloud, web). |
| `apps/ios/ADE/Services/SyncService+LinearAccount.swift` | The iPhone's account reads. |

### Renderer and iOS

- `renderer/components/app/`: `LinearQuickViewButton.tsx` (top bar),
  `LinearIssueBrowser.tsx` (with `linearIssueBrowserModel.ts`,
  `LinearIssueBrowserRows.tsx`, `LinearIssueDetailPane.tsx`,
  `LinearIssuePropertyPickers.tsx`), `LinearPaneHeader.tsx`,
  `LinearIssueSelectModal.tsx`, `LinearIssueResolveModals.tsx`,
  `IssueLaunchHost.tsx`, `BatchLaunchStatusToast.tsx`.
- `renderer/lib/linearBatchLaunch.ts`, `issueLaunchRequests.ts`,
  `launchedLanesHighlight.ts`; `renderer/components/shared/SessionLaunchModelControls.tsx`.
- `renderer/components/settings/LinearSection.tsx`: Settings › Integrations.
- `renderer/components/lanes/LinearIssueBadge.tsx`, `linearBrand.tsx`,
  `linearIssueDisplay.ts`, `linearProjectIcon.tsx`.
- `renderer/components/issues/`: the issue viewer and create composer (see
  [Issues](../issues/README.md)).
- `apps/ios/ADE/Views/Linear/`: the Work top-bar Linear pane
  (`LinearPaneSheet`, `LinearIssueListScreen`, `LinearIssueDetailScreen`,
  `LinearLaunchScreen`/`LinearLaunchModel`, `LinearPaneStore`,
  `LinearPaneToolbarButton`, `LinearBrand`, `LinearSVGPath`),
  `LinearConnectionScreen.swift` and `LinearOAuthRunner.swift`.

### Shared and CLI

- `apps/desktop/src/shared/linearMagicWords.ts`: `Refs`/`Fixes` for commits
  and PR bodies, and the multi-issue block.
- `apps/desktop/src/shared/linearIssueBranch.ts`: lane and branch names.
- `apps/desktop/src/shared/chatContextAttachments.ts`: chat issue attachments.
- `apps/ade-cli/src/cli.ts` (`buildLinearPlan`) and
  `apps/ade-cli/src/issueCliFields.ts`: `ade linear`.

IPC channels are in `apps/desktop/src/shared/ipc.ts` (`window.ade.cto.*`).
Session attach channels are on `window.ade.lane.*`.

## The connection

Each project has its own Linear connection, so two projects can use two
workspaces. There are two kinds:

1. **OAuth** ("Sign in with Linear"). The default client is the ADE Linear
   app (`ADE_LINEAR_APP_CLIENT_ID`, PKCE, no secret). A custom OAuth client
   (`linear.oauthClient.v1`, kept on the machine) takes its place when set.
   The ADE app asks for `read,write,admin`, so Linear sets up the workspace
   webhook for automations; a custom client asks for `read,write`. The access
   token lasts about 24 hours, and each refresh returns a new refresh token.
2. **Personal API key.** Checked with a `viewer` query. It does not expire.

Until a token is stored, nothing runs.

### It follows the project

`linearAccountSync.ts` copies the connection to the account vault: scope
`repo:<host>/<owner>/<repo>`, kind `integration`, key `linear`, value
`{v: 1, authMode, token, refreshToken, expiresAt, clientId?}`. Every computer
that opens the project adopts it, ADE Cloud computers too.

- A project with no remote has no shared scope. Its connection stays on that
  computer, and the status says so.
- `clientId` names the OAuth client that issued the grant. ADE writes it only
  when a sign-in or a refresh with that client succeeded
  (`linear.tokenClientId.v1`). Without it, the server never renews the grant.
- An environment token (`LINEAR_API_KEY` and others) stays on its machine and
  is never published.
- The old account-wide row `all/linear_refresh_token/default` is retired by
  `accountMigrationRunner.ts`.

### One owner renews

An OAuth refresh token works once. Two computers that spend the same token can
make Linear revoke the grant. So the vault item's `refreshOwner` names the one
machine that renews (`rotatingCredentialOwner.ts`):

- The owner renews before expiry and publishes the new grant to the vault.
- Every other computer reads the new grant and never exchanges.
- When the token ran out more than 10 minutes ago and nothing new came, another
  computer claims the item (writes it with its own device id), waits 30 s for
  the claim to stand, and then renews.
- On one machine, the desktop app and the brain share a device id, and a file
  lock (`linearOAuthRefreshLock.ts`) keeps one renewal at a time.
- `invalid_grant` clears the connection, and the person signs in again. Other
  failures keep the token.

### Connecting and managing from mobile

The phone connects, reconnects and disconnects Linear through its paired
computer (`cto.startLinearMobileOAuth`, `cto.completeLinearMobileOAuth`,
`cto.setLinearToken`, `cto.clearLinearToken`). These are optional
capabilities, so an older brain shows no buttons.

- **Worker-bounce OAuth.** The computer makes the PKCE session with the
  `redirect_uri` set to the webhook relay's `/linear/oauth/callback`. The
  phone opens the authorize URL in an `ASWebAuthenticationSession`. The relay
  sends the code on to `ade://linear-oauth`, the session captures it, and the
  computer exchanges and stores it. The PKCE verifier and the token stay on
  the computer.
- **API key.** The phone sends the key to the computer, which stores it.
  `cto.clearLinearToken` disconnects and removes the vault item.

## With no computer

The web and iPhone Linear panes, and a desktop tab bound to ADE Cloud, read
Linear through the ADE account server when no computer answers:

```text
POST /cloud/integrations/linear/query   { origin, op, vars? }
```

- The server reads the project's vault item (`repo:<origin>/integration/linear`)
  with the caller's own bearer. The token stays in that request's memory. It
  is never stored, logged or sent back.
- `op` is one of the fixed reads in `CLOUD_LINEAR_OPS`: `identity`, `teams`,
  `projects`, `issues`, `searchIssues`, `issue`, `issuesByIds` (≤ 50),
  `comments`, `customViews`, `notifications`. The server never runs a
  caller's query. A search `filter` is at most 8,000 characters as JSON.
- The answer is Linear's own `data`. The client turns it into the panes'
  shapes with `linearIssueNormalize.ts` (desktop, web) or Swift (iPhone).
- Linear and Jira together allow 30 requests a minute per account. The iPhone
  reads at most two pages per load through this route.
- **Reads only.** Edits, comments and launches need a computer, and the panes
  say so.
- An older server answers `404`, and the client keeps its old behavior.

Refusals (clients show the server's `message`):

| Code | Status | When |
|---|---|---|
| `linear_not_connected` | 409 | The project has no Linear connection. |
| `linear_renewing` | 409 | The server is renewing the sign-in: "Linear is renewing its sign-in. Try again in a minute." |
| `linear_needs_renewal` | 409 | The token ran out and the server cannot renew it: "Linear needs one of your computers to renew its sign-in. Open ADE on a computer once." |
| `rate_limited` | 429 | Over 30 requests a minute. |
| `integration_failed` | 502 | Linear failed or timed out (15 s). |

### The server renews an ADE-app grant

When the token has run out and the grant's `clientId` is the ADE app, the
account server renews it under the same "one owner renews" rule
(`linearRenewal.ts`). Its owner name is `ade-cloud-directory`.

1. **Claim.** If the owner has been quiet past the 10-minute grace, the
   server writes the same value with itself as owner (a vault CAS on the
   revision), reads it back, and records a `claimed` row in
   `cloud_linear_renewals`. The request answers `linear_renewing`.
2. **Settle.** The claim must stand 30 s. A computer's later claim wins, and
   the server lets go.
3. **Exchange.** One request locks the row (`exchanging`), checks that the
   vault item still has the same owner, revision and value, and exchanges the
   refresh token at Linear. All of this runs after the response
   (`waitUntil`).
4. **Publish.** The server seals the new grant in the row (`publish`) and
   writes it to the vault with a CAS. Then the request uses the new token.
5. If the publish fails, the server keeps the sealed grant and uses it, and
   its minute cron publishes it through the push relay's lease route. That
   route writes only while the vault item still holds the spent refresh
   token.

Other rules:

- A grant from a custom OAuth client, a grant with no `clientId`, or an API
  key is never renewed by the server.
- `invalid_grant` drops the row and leaves the vault as it is. Other failures
  retry, and three failures drop the row.
- `CLOUD_LINEAR_RENEWAL=0` on the account directory turns renewal off. It also
  needs `CLOUD_CHAT_MASTER_KEY`, `DIRECTORY_AUTH_SECRET` and the relay binding.

## Read surface

`linearClient.ts` serves desktop and the headless brain.

- **Reads:** `fetchIssueById`, `listProjects`, `searchIssues` (paged),
  `countIssues`, `listCustomViews`, `getQuickView`, `fetchIssueComments`,
  `listLabels`, `listUsers`, inbox notifications.
- **Writes:** `updateIssue` (state, assignee, priority, labels in one
  `issueUpdate`), comments, labels, and the webhook methods automations use.
- **Search** uses Linear's `searchIssues(term:)`. Identifier-shaped queries
  (`VER-404`, `404`, `#404`) match number and team key first. If full-text
  search fails, the client uses a title and description filter
  (`linear.search_full_text_failed`).
- **Blockers** come from "blocked by" relations, not sub-issues.
- **Counts.** `countIssues` pages issue ids (250 per request, up to 10 filters
  in one request), caches each answer 60 s and shares a count in flight. When
  less than 20% of Linear's hourly budget is left, it skips new counts
  (`linear.count_issues_skipped_low_budget`) and the pane shows `+`.
- **Quick view.** One set of parallel GraphQL queries (viewer, organization,
  projects, teams), not the SDK's lazy relations.

On desktop:

- The top-bar `LinearQuickViewButton` opens the `LinearIssueBrowser`: a filter
  rail (All, My issues, Current cycle, custom views, projects with counts),
  multi-select, a virtualized list with state groups, and a detail pane with
  the shared `LinearIssueView`. Keys: `j`/`k`, `x`, `Enter`, `/`, `Esc`.
- One issue (a link, a chip, a deeplink, a lane badge) opens in the Work tools
  pane or the issue sheet (see [Issues](../issues/README.md)).
- Settings › Integrations › Linear (`LinearSection.tsx`) connects and
  disconnects, and shows the workspace logo and name.

On the iPhone, `apps/ios/ADE/Views/Linear/` is the Work top-bar Linear pane:
the issue browser, detail, and a launcher for "New lane" or "Launch agent".
It uses the computer's `cto.*` reads, or the account route with no computer.
`DeepLinkRouter.swift` routes `ade://linear-issue/<IDENT>` to the pane, and
ignores the `linear-oauth` host.

## Lanes, commits and PRs

- **Lane from an issue.** `CreateLaneDialog`, the quick view and the chat
  composer use one picker. The lane name is `IDENT title`. The branch is
  Linear's own `branchName` (the name Linear's GitHub integration matches),
  else `ident-title-slug` (`linearIssueBranch.ts`).
- **iPhone launch.** "New lane" makes a lane with the issue. "Launch agent"
  also starts a chat or CLI session with the issue and a kickoff prompt. If the
  agent fails to start, the phone deletes the new lane.
- **Storage.** `lane_linear_issues` holds a lane's primary issue;
  `lane_linear_issue_links` holds more.
- **Commits.** `gitOperationsService.commit` adds `Refs IDENT:` to the subject
  when it does not name the issue.
- **PR body.** `ensureLinearPrReference` adds `Fixes IDENT` (closes on merge)
  or `Refs IDENT`, from the `closeLinearIssueOnMerge` checkbox.
  `prService.applyLinearPrLinkage` writes one "Linked Linear issues" block
  (`<!-- ade:linear-links v=N -->`) for every linked issue.
- **Chat context.** A chat on a lane with an issue gets a `linear_issue`
  attachment; the composer can attach more.

## Session-scoped issue attachment and CLI context injection

A chat or CLI session can carry issues without a lane (`session_linear_issues`,
through `window.ade.lane.*`: `attachLinearIssueToSession`,
`detachLinearIssueFromSession`, `listLinearIssuesForSession`,
`listLinearIssuesForLaneSessions`, `unlinkLinearIssues`).

- When the session has a lane, the issue also goes to
  `lane_linear_issue_links` (source `chat_attach`). It never replaces the
  lane's primary issue.
- At agent start, `agentChatService` writes the issues to a context file and
  sets `ADE_LINEAR_ISSUE_IDS` and `ADE_LINEAR_CONTEXT_FILE`. The agent reads
  the issues with no Linear credentials.
- On PR open, `prService` links session issues to the PR too.

## Batch launch

Selecting several issues opens `IssueLaunchHost`, the one launch dialog for
Linear, GitHub and Jira. Each issue has a row (model, effort, Fast mode,
kickoff prompt, branch), a default row seeds them, and `laneOnly` makes lanes
only. `findIssueConflicts` refuses an issue that a lane already carries.

`runBatchLaunch` (`linearBatchLaunch.ts`) runs create lane → create session →
send kickoff, three at a time.

- One failure does not stop the others.
- A failure before the session exists deletes the new lane.
- A row stays `initializing-agent` until the session's first `user_message`
  or started event. A failed kickoff shows `agent-error` ("Needs attention").
- `IssueLaunchHost` announces each new session (`chatSessionEvents.ts`), so
  Work shows it at once. `BatchLaunchStatusToast.tsx` shows each row's state.
  The Lanes tab highlights the new lanes for 30 s.

## Live status

`linearLiveStatusService.ts` writes an agent's progress to Linear. It is off
unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.

- **Agent start:** move the issue to the team's "In Progress", assign it to
  the connected user, and comment the branch link.
- **PR open:** comment the PR link on each linked issue.
- **Merge:** move each linked issue to the team's Done state.

Each write is best effort (`linear_live_status.*`) and never blocks the
launch, PR or merge.

## The ADE agent and Linear events

- **The ADE agent** (`linearAgentService.ts`). The webhook relay sends each
  Linear `AgentSessionEvent` to the account of the person who delegated or
  mentioned the agent. A machine with a matching `linear.agent_*` automation
  rule claims the session (the first claim wins) and runs the rule. The chat's
  events go back to Linear as agent activities through the relay, which holds
  the workspace's app token. A Linear reply steers or stops the chat.
- **Inbox "needs you"** (`linearInboxAttentionService.ts`). A Linear inbox
  item about an issue a lane carries raises "needs you" on that lane's chat.
  Only items newer than the stored watermark count.
- **Lane sync** (`linearLaneSync.ts`). An `Issue` webhook updates the lane's
  copy of the issue's fields.
- **Proof** (`linearProofPoster.ts`). When a lane opens a PR for its issues,
  ADE posts the lane's screenshots and recordings to each issue, once.
- **Event wakes.** A Linear delivery wakes a resting ADE Cloud computer that
  listens to the organization (`linear-org:<id>`) or to a routed agent session
  (`linear-account:<id>`). See `apps/webhook-relay/README.md`.

## `ade linear`

`ade linear` (`buildLinearPlan` in `apps/ade-cli/src/cli.ts`) uses the brain's
Linear connection; no API key is needed.

- Attach and read: `attach`, `detach`, `issues`, `attached`, `my-issues`.
- `ade linear create --team ADE --title "..."` takes every field of the
  desktop form: `--description` or `--description-file <path|->`, `--state`,
  `--assignee`, `--priority`, `--label` (repeat it), `--project`,
  `--milestone`, `--cycle`, `--estimate`, `--due YYYY-MM-DD`, `--parent`,
  `--template`. Inside a session with an issue, the new issue links to it;
  `--blocks`, `--blocked-by`, `--sub-issue` and `--duplicate` pick the link,
  and `--standalone` skips it. A near-duplicate is refused unless
  `--allow-duplicate`.
- `ade linear edit <id>` changes those fields in one `updateIssue`, plus
  `--remove-label`.
- One field: `set-state`, `assign`, `set-priority`, `set-estimate`,
  `set-cycle`, `set-project`, `set-milestone`, `set-due`, `set-parent`,
  `label`, `unlabel`. `none` clears a field where Linear allows it.
- `ade linear relate <id> --blocks|--blocked-by|--related|--duplicate-of <other>`.

`issueCliFields.ts` matches names (states and labels in the issue's team,
users, projects, cycles, milestones, templates). `--assignee me` is the
connected user. A name that matches more than one item is an error that lists
them.

## Deeplinks and attachments

`linearLaneCardService.ts` builds "Open in ADE" attachments for lanes, PRs and
chats. Portable links use `https://ade-app.dev/open`. Machine-local chat and
lane links use `ade://session/<id>?lane=<lane-id>`. A person who clicks from
Linear sees a setup dialog when the project or connection is missing.

## Database tables

State is in `.ade/ade.db` and replicates through cr-sqlite:

- `lane_linear_issues`: a lane's primary issue, keyed by
  `(project_id, lane_id)`.
- `lane_linear_issue_links`: more issues on a lane (`role`, `source`,
  `include_in_pr`, `close_on_merge`, `evidence`).
- `session_linear_issues`: issues on a session. `upsertSessionLinearIssueLink`
  keeps `(project_id, session_id, issue_id, role)` unique (delete then insert).

The `linear_issue_claims`, `linear_workflow_*`, `linear_dispatch_*` and
`linear_ingress_*` tables stay in the schema for migration safety. No service
writes them.

The account directory keeps `cloud_linear_renewals` (D1): one lease row per
account and repository scope while the server renews.

## Gotchas

- **Nothing runs until connected.** Tests stub `getStatus().tokenStored`.
- **Desktop OAuth needs port 19836.** The loopback flow does not pick another
  port. The phone's worker-bounce flow does not use it.
- **Never exchange a refresh token outside the owner rule.** A second
  exchange of the same token can revoke the grant on every computer.
- **`clientId` is written only when proven.** Do not fill it from the
  configured client: a grant from a custom client renewed with ADE's client
  fails, and the server must not try.
- **The server keeps people on `linear_renewing` for up to the 10-minute
  grace** while a computer still owns an expired grant.
- **Account reads are reads.** A write from the web or the iPhone with no
  computer is refused with a sentence; it never queues.
- **Live status is off by default.** Every hook returns at once without
  `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.
- **CRR strips non-PK uniqueness.** Do not use `ON CONFLICT(<unique column>)`
  on Linear tables.

## Cross-links

- [`../cto/README.md`](../cto/README.md): the CTO's Linear tools.
- [`../lanes/README.md`](../lanes/README.md): lane creation and issue fields.
- [`../chat/README.md`](../chat/README.md): chat context attachments.
- [`../automations/README.md`](../automations/README.md): Linear triggers and
  the `linear.agent_*` rules.
- [`../issues/README.md`](../issues/README.md): the issue viewer and launcher.
- [`../passwords/README.md`](../passwords/README.md) and
  `apps/push-relay/README.md`: the account vault.
