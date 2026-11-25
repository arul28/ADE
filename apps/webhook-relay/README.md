# ADE webhook relay

A Cloudflare Worker (`ade-github-webhook-relay`) that receives events for ADE:

- GitHub App webhooks (pull requests, reviews, checks, workflow runs).
- Linear webhooks and the Linear agent (`actor=app`).
- Cursor Cloud `statusChange` webhooks.
- Custom webhook URLs that any service can call to run an ADE automation.

The Worker checks each provider's signature, writes the event to D1, and ADE
reads the new events with a monotonic cursor. A hibernating Durable Object
(`RepoEventsDurableObject`) sends connected ADE brains a short WebSocket
wake-up. The wake-up is never the event transport.

For ADE Cloud, the relay also wakes resting cloud computers for Linear and
custom-webhook deliveries, and forwards a custom webhook whose automation runs
on ADE Cloud to the account directory (see "ADE Cloud").

A user repository needs no ADE code. The person installs the ADE GitHub App on
the repositories ADE should track.

## Design

- One Worker, one D1 database, one hibernating Durable Object per active
  repository or topic. No always-on server, no queues, no process per user.
- GitHub writes are idempotent by delivery id. Linear deliveries dedupe by
  `Linear-Delivery`.
- ADE reads with `after=seq:<n>`. Old delivery-id cursors still work.
- If the relay fails, ADE keeps its GitHub polling path.
- D1 bills rows scanned, so every hot query is an index seek (check with
  `EXPLAIN QUERY PLAN`). Retention deletes run at most once per 10 minutes per
  isolate (`claimPeriodicRun`). Events are kept 7 days by default
  (`EVENT_RETENTION_DAYS`).
- Check-family events are slimmed before storage. WebSocket fan-out sends at
  most one frame per second per repository.

Check Cloudflare's current [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
and [D1](https://developers.cloudflare.com/d1/platform/pricing/) pricing before a launch.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness. |
| POST | `/github/webhook` | GitHub HMAC | GitHub App deliveries. |
| GET | `/github/repos/:owner/:repo/status` | GitHub App user token or account token | Installation status for one repository. |
| GET | `/github/repos/:owner/:repo/events` | same | Stored repository events after a cursor. |
| WebSocket | `/github/repos/:owner/:repo/subscribe` | same | Wake-up frames for one repository. |
| POST | `/github/repos/:owner/:repo/webhook/heal` | GitHub App user token, admin | Repair the App webhook. |
| GET | `/github/repos/:owner/:repo/webhook/deliveries` | GitHub App user token, admin | List recent App webhook deliveries. |
| GET, DELETE | `/account/integrations` | account token | List, or unlink, the account's repositories and Linear organizations. |
| POST | `/linear/webhook` | Linear HMAC | Linear deliveries. |
| POST | `/linear/orgs/register` | Linear token | Store an organization's webhook signing secret. |
| GET | `/linear/orgs/:organizationId/events` | Linear token or account token | Stored Linear events after a cursor. |
| WebSocket | `/linear/orgs/:organizationId/subscribe` | same | Wake-up frames for one organization. |
| GET | `/linear/oauth/callback` | none | Sends a Linear OAuth code on to `ade://linear-oauth`. |
| various | `/linear/agent/(install\|status\|members/register\|settings\|subscribe)`, `/linear/agent/sessions/:id/(claim\|activities\|update\|start)` | account token | The Linear agent (see "Linear agent"). |
| POST | `/cursor/register` | none | Register a Cursor webhook signing secret. |
| POST | `/cursor/webhook` | Cursor HMAC | Cursor `statusChange` deliveries. |
| GET | `/cursor/events` | bearer = the signing secret | Stored Cursor events after a cursor. |
| GET, POST, PUT, PATCH | `/hooks/:hookId/:token` | the URL token | A custom webhook delivery. |
| POST, DELETE | `/hooks/register` | account token | Create, rotate or remove a custom webhook. |
| POST | `/hooks/forward` | account token | Point a custom webhook at ADE Cloud, or back at the machines. |
| GET | `/hooks/events?hooks=<ids>` | account token | Held custom-webhook deliveries. |
| POST | `/hooks/ack` | account token | Delete the deliveries ADE processed. |
| WebSocket | `/hooks/subscribe` | account token | Wake-up frames for the account's custom webhooks. |
| POST | `/projects/:id/github/webhook`, GET `/projects/:id/github/events` | legacy project token | Self-hosted legacy routes. |

"Account token" is the Clerk access token in `x-ade-account-token`.

## GitHub

### Authorization

1. The person installs the ADE GitHub App for all repositories, or for some.
2. ADE gets a GitHub App user access token: the account directory's web flow,
   or GitHub's device flow on older desktops. ADE keeps the token locally.
3. ADE sends that expiring App user token, never the person's general GitHub
   token, as `Authorization: Bearer <token>` to the repository routes.

The relay sends the token to GitHub only to check access. It never stores,
logs or echoes it. It refuses a caller without push, maintain or admin access,
so a stranger cannot read a public repository's webhook history.

A signed-in client can send the account token in `x-ade-account-token` next to
the GitHub header. A matching account can read a repository or Linear
organization that is already linked to it. `DELETE /account/integrations`
unlinks them and writes a tombstone, so a later request cannot link them again
by itself. It does not delete events, signing secrets or legacy access.

### The access cache

The checks are cached, so a 30-second poll does not spend the account's GitHub
REST quota:

- An allow is cached 5 minutes in the isolate and 60 minutes in D1
  (`github_repo_auth_cache`), keyed by a SHA-256 of the token, the repository
  and the access level. The token is never stored. A read revocation can take
  up to 60 minutes.
- Admin checks (webhook heal) are never cached.
- A denial (404, too little access) is cached 5 minutes in the isolate only.
  Denials never go to D1, because a caller picks the token.
- Transport failures and GitHub 5xx are never cached.
- When GitHub rate-limits a check, the relay records the reset in
  `github_token_rate_limits`. A known allow keeps working for up to 24 hours
  (`github_repo_auth_stale_served`). An unknown token is refused with
  `Retry-After`, so a quota outage never fails open.
- A GitHub 401 deletes the D1 rows for that token and the isolate's copy.
  Other isolates can keep their copy for up to 5 more minutes.

### Repository events: wake-up and gap-free reads

Connect to `wss://<relay>/github/repos/:owner/:repo/subscribe` with the same
credentials as the events route. After about one second of debounce, the
Durable Object sends one frame for any number of deliveries:

```json
{"t":"github_delivery","repo":"owner/repo"}
```

The frame has no payload and no cursor. On connect and after each frame, read:

```text
GET /github/repos/:owner/:repo/events?after=seq:<n>&order=asc&limit=100
```

1. Process `events` in the order they come.
2. Save `nextCursor` only after the page is processed.
3. Read the next page while `hasMore` is true.

`order=asc` is required for gap-free reads. The default order is descending
with no `hasMore`, for older clients.

Open the socket before the first read. Keep a 30-second safety poll. Reconnect
with exponential backoff and jitter (1 s to 30 s). The server closes each
socket after about four hours with code `4401`, so credentials are checked
again. The text frame `ping` gets `pong` without waking the Durable Object.

### Self-hosted and legacy project tokens

A self-hosted relay can use project tokens. Put the settings in the project's
local secret config, not in source:

```yaml
automations:
  githubRelay:
    apiBaseUrl: https://ade-github-webhook-relay.<your-subdomain>.workers.dev
    remoteProjectId: <stable-project-id>
    accessToken: ${env:ADE_GITHUB_RELAY_TOKEN}
```

The env vars `ADE_GITHUB_RELAY_API_BASE_URL`,
`ADE_GITHUB_RELAY_REMOTE_PROJECT_ID` and `ADE_GITHUB_RELAY_ACCESS_TOKEN` do the
same. ADE derives a project token `ade_proj_...` from the relay's
`RELAY_ACCESS_TOKEN` and `remoteProjectId`, or sends a derived token as it is.

## Linear

### Organization webhooks

After the person connects a workspace with an admin API key or an OAuth token
with the `admin` scope:

1. ADE makes a 32-byte signing secret and a Linear webhook that targets
   `https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/webhook`.
2. ADE calls `POST /linear/orgs/register` with `{ "secret": "…" }` and the
   Linear authorization header.
3. The relay asks Linear for `viewer.organization.id` and stores the secret for
   that organization. It does not store the token.
4. ADE reads `GET /linear/orgs/:organizationId/events?after=seq:<n>`. The relay
   checks that the token belongs to the organization, and caches the answer 5
   minutes in memory.

The webhook covers `Issue`, `Comment` and `IssueLabel` for all public teams.
The relay refuses a bad raw-body HMAC and a `webhookTimestamp` more than 60 s
from its clock. It acknowledges an unknown organization without storage, so
Linear does not turn the webhook off during setup.

`LINEAR_API_BASE_URL` points the Worker at a Linear-compatible server for
tests (a GraphQL URL, or an origin to which it adds `/graphql`).

### ADE Linear OAuth app deliveries

The ADE Linear OAuth app signs every workspace's deliveries with one app
secret. With `LINEAR_APP_WEBHOOK_SECRET` set, the relay stores app-signed
deliveries with no organization registration. The payload's `organizationId`
scopes them. The app needs the `admin` scope for data-change webhooks.

### Linear agent

The ADE agent (Linear `actor=app`) uses `/linear/agent/*`. The relay keeps each
workspace's app token, sealed with `LINEAR_AGENT_TOKEN_KEY` (base64, 32 bytes).
It sends each `AgentSessionEvent` to the account of the person who delegated or
mentioned the agent. A machine of that account claims the session (the first
claim wins) and posts agent activities back through the relay. The brain never
holds the app token. `LINEAR_APP_CLIENT_ID` (a var) is the app's public PKCE
client id, for app token refresh. Without the key, the routes answer `503
agent_not_configured`.

## Cursor Cloud

Cursor deliveries use their own table (`cursor_events`).

- Cursor posts `statusChange` to `POST /cursor/webhook` with
  `X-Webhook-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body),
  `X-Webhook-ID` and `X-Webhook-Event: statusChange`. A bad signature gets
  `401`.
- ADE registers the secret at `POST /cursor/register` and reads
  `GET /cursor/events?after=seq:N`, only while a project has an enabled
  `cursor.*` automation rule.
- The read looks up the bearer secret by index and stamps `last_polled_at` at
  most hourly. Registration sweeps secrets unused for 30 days. A client with a
  swept secret gets `401` and registers it again.

## Custom webhook URLs

Any service can call an automation's URL: `GET|POST|PUT|PATCH
/hooks/:hookId/:token` (`src/customHooks.ts`).

- **The relay stores; ADE judges.** The relay keeps only a SHA-256 of the URL
  token and compares it in constant time. A wrong token and an unknown hook
  both get `404`. The relay never sees the automation's signing secret: the
  machine that runs the automation checks signatures.
- **Held until read.** Each request (method, query, headers without `cf-*`,
  `x-forwarded-*`, `proxy-*`, cookies and hop-by-hop headers, and the raw body,
  base64 when not UTF-8) goes to `custom_hook_events`. The relay answers
  `202 {queued: true}` at once. Limits: 1 MiB per body (`413`), 200 held
  requests per hook (`503 inbox_full`), 100 hooks per account. Held requests
  expire after 3 days.
- **Read, then acknowledge.** `GET /hooks/events?hooks=<ids>` returns the held
  requests, oldest first. ADE processes them, then `POST /hooks/ack {eventIds}`
  deletes exactly those. There is no cursor. A lost acknowledgement only
  delivers again, and ADE's duplicate check stops a second run.
- **Wake-ups.** `GET /hooks/subscribe` joins the `hooks-account:<accountId>`
  topic. Each delivery sends one `hook_delivery` frame after the response.
- **Registration.** `POST /hooks/register {hookId, token, label?}` creates or
  rotates a hook. A rotation replaces the hash, so the old URL stops at once.
  `DELETE` removes the hook and what it holds. `DELETE /account/integrations`
  removes all of the account's hooks.

## ADE Cloud

### Forwarded custom webhooks

When a custom webhook's automation runs on ADE Cloud, the person's brain calls
`POST /hooks/forward { hookId, forward: { url, secret } | null }`. The URL
token stays the same, so the public URL keeps working.

- The forward URL must be an account directory's
  `/cloud/automations/:ruleId/deliveries/:hookId` route. The relay reaches it
  through the `ACCOUNT_DIRECTORY` or `ACCOUNT_DIRECTORY_PRODUCTION` binding.
- Each delivery goes in one signed POST (`x-ade-hook-id`,
  `x-ade-hook-timestamp`, `x-ade-hook-signature`: HMAC-SHA256 of
  `<timestamp>.<body>` with the hook's forward key). The relay keeps it until
  the directory answers 2xx.
- The relay tries held deliveries again on the hook's next delivery and from
  the cron (`17,47 * * * *`): 20 hooks and 10 deliveries per hook in each pass.
- A `410` means the rule left ADE Cloud. The relay clears the forward, and the
  machines read the hook again. A `400`, `413` or refused signature drops that
  one delivery (logged and reported).
- Machines never list a forwarded hook's deliveries, so each delivery runs in
  one place.

### Event wakes

A resting ADE Cloud computer holds no socket, so a wake-up frame cannot reach
it. After the relay stores a Linear delivery or a delivery for a custom webhook
that is not forwarded, it names the delivery's topics to each account
directory (`src/cloudEventWakes.ts`):

```text
POST /cloud/internal/event-wake   { topic }   header x-ade-event-wake-secret
```

- Topics: `linear-org:<organizationId>`, `linear-account:<accountId>` (a routed
  agent session) and `hooks-account:<accountId>`. A topic is an id; the relay
  sends nothing of the event.
- The directory wakes the computers that listen to the topic, at most once
  every 5 minutes each. The computer reads the stored events when it is up.
- A topic with no listener is not asked about again for 60 s in that isolate.
- GitHub repository events do not wake cloud computers. Their timed wakes and
  people's actions wake them.
- The call runs after the response. A failure only logs.

Without `CLOUD_EVENT_WAKE_SECRET` (see "Secrets"), no event wakes a resting
cloud computer.

### Deleted accounts

Rows here carry the raw account ID, and the relay hears of no account
deletion itself. On each cron run (`src/accountPurge.ts`) it asks both account
directories for the accounts deleted in the last day, with the same secret:

```text
GET /cloud/internal/deleted-accounts   header x-ade-event-wake-secret
```

- For each account, one batch deletes its custom hooks and their events, its
  GitHub, Linear and Cursor events, its Cursor secrets and its Linear agent
  memberships. Shared rows stay with the account cleared: repositories and
  Linear workspaces (another account can link them), agent sessions, and
  agent installs (no runner means replies).
- An account stays listed for a day. The relay purges it on the first run
  after its deletion, and again on the first run after each time the
  directory runs the deletion again (15 min, 75 min, 3 h, and 23 h, before
  the account leaves the list). So rows that a sign-in token still valid
  wrote after the deletion go too. One run purges at most 40 accounts.
- `deleted_account_purges` keeps when the relay last purged each account. An
  account is due until a run purges it after its latest repeat, so an
  account that the cap or an outage skipped goes first on the next run. A
  record goes 25 hours after its last purge.
- A directory that does not answer is skipped with a warning and asked next
  run. A refusal from the production directory, and a failed purge, are
  reported after the other accounts ran.

## Beta timer

The cron (`17,47 * * * *`) also starts ADE's Beta workflow
(`.github/workflows/beta.yml`) through the GitHub API (`src/betaTimer.ts`). The
workflow decides if a beta is due. The timer skips a tick while a Beta run (not
a preview) is queued or building.

`GITHUB_BETA_DISPATCH_TOKEN` is a fine-grained token for `arul28/ADE` with
**Actions: read and write** only. With no token, the timer does nothing; a
refused token reaches Sentry on each tick.

## Setup

### Local development

The five Workers are one npm workspace, so one `npm install` at the repo root
installs this one too (from the root `package-lock.json`).

```sh
npm install
npm --prefix apps/webhook-relay run typecheck
npm --prefix apps/webhook-relay run test
npm --prefix apps/webhook-relay run build
npm --prefix apps/webhook-relay run dev
```

### Cloudflare

If the Cloudflare account never used Workers, open Workers & Pages once and
register a `workers.dev` subdomain. Create the D1 database, put its id in
`wrangler.jsonc`, then deploy. `npm run deploy` applies the remote D1
migrations before it publishes the Worker, so use it for every deploy.

```sh
cd apps/webhook-relay
npx wrangler d1 create ade-github-relay
npm run deploy
```

### Secrets

Do not commit these values.

| Secret | Needed for |
|---|---|
| `GITHUB_WEBHOOK_SECRET` | GitHub deliveries. Same value as the GitHub App's webhook secret. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Optional. A live installation check through GitHub's App API when no webhook state has arrived, or on Refresh. The key is the App's PEM. |
| `CLERK_JWKS_URL`, `CLERK_ISSUER`, `CLERK_OAUTH_CLIENT_ID` | Account tokens. |
| `CLERK_SECONDARY_JWKS_URL`, `CLERK_SECONDARY_ISSUER`, `CLERK_SECONDARY_OAUTH_CLIENT_ID` | Optional. One more Clerk instance; all three or none. |
| `LINEAR_APP_WEBHOOK_SECRET` | Optional. ADE Linear OAuth app deliveries. |
| `LINEAR_AGENT_TOKEN_KEY` | Optional. The Linear agent. |
| `CURSOR_WEBHOOK_SECRET` | Optional. Cursor deliveries. |
| `CLOUD_EVENT_WAKE_SECRET` | Optional. ADE Cloud event wakes and the list of deleted accounts; same value on both account directories. Without it, no deleted account leaves this relay. |
| `GITHUB_BETA_DISPATCH_TOKEN` | Optional. The Beta timer. |
| `RELAY_ACCESS_TOKEN` | Only for self-hosted legacy project tokens. |

Set each with `printf '%s' "$NAME" | npx wrangler secret put NAME`, then
`npm run deploy`. An account token must pass RS256, the exact issuer, expiry,
subject and the OAuth client of its Clerk instance.

## GitHub App setup

Create or edit a GitHub App named `ADE`:

- Webhook URL:
  `https://ade-github-webhook-relay.<your-subdomain>.workers.dev/github/webhook`.
- Webhook secret: the `GITHUB_WEBHOOK_SECRET` value. SSL verification on.
- Device flow: on (older desktops sign in with it).
- Expire user authorization tokens: on.
- Callback URL:
  `https://ade-account-directory-production.arulsharma1028.workers.dev/github/app/callback`
  and the development Worker's `/github/app/callback`, with wildcard matching
  off. The account directory's web sign-in uses it.
- Setup URL:
  `https://ade-account-directory-production.arulsharma1028.workers.dev/github/app/installed`,
  with "Redirect on update" on.
- Request user authorization during installation: off. A code with no ADE
  state cannot be tied to an ADE account.
- Client secret: only in the account directory's `GITHUB_APP_CLIENT_SECRET`.
- Repository permissions: Contents, Pull requests, Issues, Actions and
  Workflows read and write; Checks, Commit statuses and Metadata read-only.
  The App also asks for Actions variables, organization Actions variables,
  organization secrets and organization self-hosted runners; no ADE code uses
  them.
- Events: Pull request, Pull request review, Pull request review comment,
  Issue comment, Check run, Check suite, Status, Workflow run, Meta.

GitHub also sends `installation` and `installation_repositories` deliveries
without a checkbox. `Meta` tells ADE when the App webhook was removed, so
Settings can show that live PR updates are off. If ADE still shows a
repository as not installed, change the App's repository selection once, or
check the App's Recent deliveries for a failed delivery.

## Logs

The Worker writes single-line JSON to `npx wrangler tail`. ADE Cloud lines:

- `cloud_event_wake_sent` (`directory`, `topicKind`, `woken`).
- `cloud_event_wake_refused`, `cloud_event_wake_failed`.
- `hook_forward_refused`, `hook_forward_failed`, `hook_forward_dropped`
  (Sentry too), `hook_forward_gone`, `hook_forward_key_refused`.

## Source file map

| File | What |
|---|---|
| `src/index.ts` | The Worker entry and the cron (Beta timer, forward retries, deleted accounts). |
| `src/relay.ts` | Routing, GitHub deliveries and reads, the access cache, account integrations. |
| `src/repoEventsDurableObject.ts` | Wake-up sockets for repositories and topics. |
| `src/linearEvents.ts` | Linear deliveries, organization registration and reads. |
| `src/linearAgent.ts`, `linearAgentCore.ts` | The Linear agent. |
| `src/cursorEvents.ts` | Cursor Cloud deliveries. |
| `src/customHooks.ts` | Custom webhook URLs and ADE Cloud forwards. |
| `src/cloudEventWakes.ts` | ADE Cloud event wakes. |
| `src/accountPurge.ts` | Purges deleted accounts, listed by the account directories. |
| `src/betaTimer.ts` | The Beta timer. |
| `src/auth.ts` | Account token checks. |
| `src/shared.ts` | The Worker env and shared helpers. |
| `src/cloudflareTransient.ts`, `sentry.ts`, `sentryScrub.ts`, `posthogLogs.ts` | D1 retries, error reports and logs. |
| `migrations/` | D1 schema (`0015_custom_hook_forward.sql` adds the forward columns). |

## Gotchas

- **A wake-up frame is a hint.** Clients always read D1 after a frame and on
  connect.
- **A forwarded hook is invisible to machines.** If the directory keeps
  failing, its deliveries wait here for up to 3 days.
- **The event-wake quiet cache is per isolate**, so a new listener can miss
  one wake for up to 60 s.
