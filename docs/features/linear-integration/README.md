# Linear Integration

DAEX connects a Linear workspace to a project: browse and edit issues, start
lanes and agents from them, link them to branches, commits and PRs, and run the
DAEX agent in Linear. The connection follows the project to every computer on
the account; with no computer on, the account server reads Linear. The CTO uses
Linear through its tools; automations react to Linear events. The CLI is `daex`
(`ade` still works). Identifiers keep `ade` names (`ADE_LINEAR_*`,
`ade-cloud-directory`).

## Source file map

Connection and client (`apps/desktop/src/main/services/cto/`, shared plumbing
the CTO does not own):

- `linearAppClient.ts` — `ADE_LINEAR_APP_CLIENT_ID` (DAEX's public PKCE client),
  `LinearOAuthClientSource`.
- `linearCredentialService.ts` — the project's encrypted connection,
  `ensureFreshToken()`.
- `linearAccountSync.ts`, `../account/rotatingCredentialOwner.ts`
  (`decideRotatingRenewal`) — the vault item and "one owner renews".
- `linearOAuthService.ts` (loopback on port 19836, and worker bounce),
  `linearOAuthRefreshLock.ts`, `linearTokenRefresh.ts`.
- `linearClient.ts`, `linearClientShared.ts`, `linearQuickView.ts`,
  `linearIssueSearch.ts`, `linearInbox.ts`, `linearIssueTracker.ts`,
  `issueTracker.ts`, `linearGraphQLInput.ts` — the GraphQL client.
- `linearLaneCardService.ts` (Open in DAEX attachments),
  `linearLiveStatusService.ts`, `linearAgentService.ts`, `linearAgentRuntime.ts`,
  `linearAgentRelayClient.ts`, `linearInboxAttentionService.ts`,
  `linearLaneSync.ts`, `linearProofPoster.ts`.
- Headless brain: `apps/ade-cli/src/services/linear/headlessLinearCredentialService.ts`,
  `apps/ade-cli/src/headlessLinearServices.ts`.
- `apps/desktop/src/main/services/automations/linearIngressService.ts` — Linear
  webhook ingress for automations (`linear_ingress_events`).

Account server and relay: `apps/account-directory/src/cloud/integrations.ts`
(`POST /cloud/integrations/linear/query`), `linearRenewal.ts`
(`cloud_linear_renewals`, migration `0041`), `apps/push-relay/src/accountVault.ts`;
client `apps/desktop/src/shared/adeCloud/integrationReads.ts`,
`shared/linearIssueNormalize.ts`; iOS `Services/SyncService+LinearAccount.swift`.

Renderer and iOS: `renderer/components/app/LinearQuickViewButton.tsx`,
`LinearIssueBrowser.tsx` (+ model, rows, detail pane, property pickers),
`LinearPaneHeader.tsx`, `LinearIssueSelectModal.tsx`,
`LinearIssueResolveModals.tsx`, `IssueLaunchHost.tsx`; `renderer/lib/linearBatchLaunch.ts`,
`launchedLanesHighlight.ts`; `settings/LinearSection.tsx`;
`lanes/LinearIssueBadge.tsx`; iOS `apps/ios/ADE/Views/Linear/`
(`LinearPaneSheet`, list, detail, launch, `LinearConnectionScreen`,
`LinearOAuthRunner`).

Shared and CLI: `shared/linearMagicWords.ts` (`Refs`/`Fixes`),
`shared/linearIssueBranch.ts`, `shared/chatContextAttachments.ts`;
`apps/ade-cli/src/cli.ts` (`buildLinearPlan`), `issueCliFields.ts`.

## Gotchas

- **Desktop OAuth needs port 19836**; the loopback flow does not pick another.
- **Never exchange a refresh token outside the owner rule.**
- **`clientId` is written only when proven** (a sign-in or refresh with that
  client succeeded); never fill it from the configured client.
- **The server keeps people on `linear_renewing`** for up to the 10-minute grace
  while a computer still owns an expired grant.
- **Writes need a computer; reads may not.** With no computer answering, panes
  read through the fixed `CLOUD_LINEAR_OPS`; every write goes to a machine that
  holds the project, by its pin. A new write must not fall back to the account
  route.
- **CRR strips non-PK uniqueness**: no `ON CONFLICT(<unique column>)` on Linear
  tables.

## The connection

Each project has its own connection:

1. **OAuth** ("Sign in with Linear"): the DAEX Linear app (PKCE, no secret, scopes
   `read,write,admin` so Linear sets up the workspace webhook), or a custom client
   (`linear.oauthClient.v1`, `read,write`). Access tokens last about 24 h; each
   refresh rotates the refresh token.
2. **Personal API key**: checked with a `viewer` query; never expires.

### It follows the project

`linearAccountSync.ts` stores the connection in the account vault (scope
`repo:<host>/<owner>/<repo>`, kind `integration`, key `linear`, value `{v: 1,
authMode, token, refreshToken, expiresAt, clientId?}`); every computer that opens
the project adopts it, DAEX Cloud included. A project with no remote keeps it on
that computer. Environment tokens (`LINEAR_API_KEY`, …) are never published.

### One owner renews

A refresh token works once, so the vault item's `refreshOwner` names the one
machine that renews: the owner renews early and publishes; others only read; a
token expired over 10 minutes with nothing new lets another computer claim the
item, wait 30 s, then renew. On one machine the app and the brain share a device
id and a file lock. `invalid_grant` clears the connection; other failures keep
it.

### Connecting and managing from mobile

The phone works through its paired computer with the optional
`cto.startLinearMobileOAuth`, `cto.completeLinearMobileOAuth`,
`cto.setLinearToken` and `cto.clearLinearToken` (the last two are not
viewer-allowed). Worker-bounce OAuth: the computer makes the PKCE session with the
webhook relay's `/linear/oauth/callback` as redirect; the phone opens it in an
`ASWebAuthenticationSession`, the relay forwards the code to
`daex://linear-oauth`, and the computer exchanges and stores it. Verifier and
token never leave the computer.

## With no computer

```text
POST /cloud/integrations/linear/query   { origin, op, vars? }
```

- The server reads the project's vault item with the caller's bearer; the token
  stays in that request's memory.
- `op` is one of `CLOUD_LINEAR_OPS`: `identity`, `teams`, `projects`, `issues`,
  `searchIssues`, `issue`, `issuesByIds` (≤50), `comments`, `customViews`,
  `notifications`. It never runs a caller's query; a filter is ≤8,000 characters.
- The answer is Linear's `data`, normalized by the client
  (`linearIssueNormalize.ts`, or Swift on iOS).
- Linear and Jira together: 30 requests a minute per account. Reads only; an older
  server's 404 keeps the old behavior.

| Code | Status | When |
|---|---|---|
| `linear_not_connected` | 409 | No connection. |
| `linear_renewing` | 409 | The server is renewing. |
| `linear_needs_renewal` | 409 | Expired and only a computer can renew. |
| `rate_limited` | 429 | Over 30 a minute. |
| `integration_failed` | 502 | Linear failed or timed out (15 s). |

### The server renews a DAEX-app grant

When the token ran out and the grant's `clientId` is the DAEX app, the server
renews under the same owner rule (`linearRenewal.ts`, owner `ade-cloud-directory`):
claim with a vault CAS after the owner's 10-minute grace (answering
`linear_renewing`), let the claim stand 30 s, lock the row and check the vault is
unchanged, exchange after the response (`waitUntil`), seal and publish with a CAS
(a failed publish is retried by the minute cron through the push relay's lease
route). Custom-client grants, grants with no `clientId` and API keys are never
renewed. `invalid_grant` drops the row; three other failures drop it.
`CLOUD_LINEAR_RENEWAL=0` turns renewal off.

## Read surface

`linearClient.ts` serves desktop and the headless brain: issue reads, projects,
paged search (`searchIssues(term:)`; identifier-shaped queries match number and
team key first; title/description fallback), counts (`countIssues`: 250 ids per
request, cached 60 s, skipped under 20% hourly budget so the pane shows `+`),
custom views, the quick view (parallel queries), comments, labels, users, inbox.
Writes: `updateIssue` (one `issueUpdate`), comments, labels, webhooks. Blockers
come from "blocked by" relations. The desktop pane is `LinearIssueBrowser`; one
issue opens per [Issues](../issues/README.md). iOS routes
`daex://linear-issue/<IDENT>` to its pane.

## Lanes, commits and PRs

- **Lane from an issue**: name `IDENT title`, branch Linear's `branchName` (what
  Linear's GitHub integration matches), else `ident-title-slug`.
- **Storage**: `lane_linear_issues` (primary), `lane_linear_issue_links` (more).
- **Commits**: `gitOperationsService.commit` adds `Refs IDENT:` when the subject
  does not name the issue.
- **PR body**: `ensureLinearPrReference` adds `Fixes IDENT` or `Refs IDENT`
  (`closeLinearIssueOnMerge`); `prService.applyLinearPrLinkage` writes one "Linked
  Linear issues" block (`<!-- ade:linear-links v=N -->`).
- **Chat context**: a chat on a lane with an issue gets a `linear_issue`
  attachment.

## Session-scoped issue attachment and CLI context injection

A session can carry issues without a lane (`session_linear_issues`, through
`window.ade.lane.*`: `attachLinearIssueToSession`, `detachLinearIssueFromSession`,
`listLinearIssuesForSession`, `listLinearIssuesForLaneSessions`,
`unlinkLinearIssues`). With a lane, the issue also goes to
`lane_linear_issue_links` (source `chat_attach`), never replacing the primary. At
agent start the issues go to a context file and the agent gets
`ADE_LINEAR_ISSUE_IDS` and `ADE_LINEAR_CONTEXT_FILE` (no Linear credentials
needed). On PR open, session issues link to the PR.

## Batch launch

Several issues open `IssueLaunchHost` (see
[Issues](../issues/README.md#starting-work-from-an-issue)); `findIssueConflicts`
checks each lane's primary issue and links. New lanes highlight for 30 s in Lanes
(`launchedLanesHighlight.ts`). On iPhone, "Launch agent" deletes the new lane if
the agent fails to start.

## Live status

`linearLiveStatusService.ts`, off unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`:
agent start moves the issue to In Progress, assigns it and comments the branch;
PR open comments the PR link; merge moves linked issues to Done. Best effort,
never blocking.

## The DAEX agent and Linear events

- **The DAEX agent** (`linearAgentService.ts`): the webhook relay sends each
  `AgentSessionEvent` to the delegating account; a machine with a matching
  `linear.agent_*` automation claims it (first claim wins) and runs the rule;
  activities go back to Linear through the relay, which holds the app token.
- **Inbox "needs you"** (`linearInboxAttentionService.ts`) on the chat of a lane
  carrying the issue (newer than the watermark only).
- **Lane sync** (`linearLaneSync.ts`) from `Issue` webhooks.
- **Proof** (`linearProofPoster.ts`): a lane's screenshots and recordings post to
  its issues once when it opens a PR.
- **Event wakes**: a Linear delivery wakes a resting DAEX Cloud computer that
  listens to its organization or agent session.

## `daex linear`

Uses the brain's connection (no key needed): `attach`, `detach`, `issues`,
`attached`, `my-issues`; `create --team <KEY> --title "…"` with every form field
(`--description[-file]`, `--state`, `--assignee`, `--priority`, `--label`,
`--project`, `--milestone`, `--cycle`, `--estimate`, `--due`, `--parent`,
`--template`; links to the session's issue unless `--standalone`; near-duplicates
refused without `--allow-duplicate`); `edit <id>`; single-field `set-*`, `assign`,
`label`, `unlabel` (`none` clears); `relate <id> --blocks|--blocked-by|--related|--duplicate-of`.
`issueCliFields.ts` resolves names; `--assignee me` is the connected user; an
ambiguous name is an error listing matches.

## Deeplinks and attachments

`linearLaneCardService.ts` builds "Open in DAEX" attachments: portable links use
`https://ade-app.dev/open`; machine-local chat and lane links use
`daex://session/<id>?lane=<lane-id>` (old `ade://` links still open).

## Database tables

In `.ade/ade.db` (CRR): `lane_linear_issues` (by `(project_id, lane_id)`),
`lane_linear_issue_links` (`role`, `source`, `include_in_pr`, `close_on_merge`,
`evidence`), `session_linear_issues` (delete-then-insert keeps `(project_id,
session_id, issue_id, role)` unique). `linear_ingress_events` is written by the
automations' Linear ingress (a webhook replay guard; never pruned). The
`linear_issue_claims`, `linear_workflow_*` and `linear_dispatch_*` tables stay in
the schema with no writer. The account directory keeps `cloud_linear_renewals`.

## Cross-links

[CTO](../cto/README.md), [Lanes](../lanes/README.md), [Chat](../chat/README.md),
[Automations](../automations/README.md), [Issues](../issues/README.md),
`apps/push-relay/README.md`, `apps/webhook-relay/README.md`.
