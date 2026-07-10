# ADE webhook relay

This is the cheap hosted ingress for ADE GitHub and Linear events. Providers
deliver webhooks to a Cloudflare Worker, the Worker verifies the provider HMAC
signature, writes the event into D1, and ADE polls the newest events with a
monotonic cursor.

No user repository needs ADE-specific code. The repo-side step is installing the
ADE GitHub App on the repositories the user wants ADE to track.

## Why this shape

- One Worker and one D1 database; no always-on server, queues, cron, Durable
  Objects, or per-user compute.
- GitHub webhook writes are idempotent by delivery id.
- ADE polls with `after=<last-cursor>`, where new cursors are monotonic
  `seq:<n>` values. Legacy delivery-id cursors still work during migration.
- ADE checks per-repo GitHub App status at
  `GET /github/repos/:owner/:repo/status`. Hosted ADE clients authenticate this
  route with an expiring ADE GitHub App user access token from GitHub's device
  flow, not the user's general PAT/OAuth token. If GitHub App API credentials
  are configured, the relay only calls GitHub when D1 has no installed state
  yet or the user explicitly presses Refresh.
- If the hosted relay fails, ADE keeps using the current GitHub polling/snapshot
  path.
- Linear webhook signing secrets are scoped per organization and stored in D1;
  Linear API/OAuth tokens are used only to verify organization ownership and
  are never stored.

Cloudflare pricing changes, so check the official pages before launch:

- Workers: https://developers.cloudflare.com/workers/platform/pricing/
- D1: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/

As of 2026-06-30, this design should stay inside Cloudflare's free tier for a
single ADE install and should remain very small on the paid tier for a 100-user
pilot, because each GitHub delivery is one Worker request plus a small D1 write
and each ADE poll is one Worker request plus a bounded D1 read.

## Local development

```sh
npm --prefix apps/webhook-relay install
npm --prefix apps/webhook-relay run typecheck
npm --prefix apps/webhook-relay run test
npm --prefix apps/webhook-relay run dev
```

## Cloudflare setup

If the Cloudflare account has never used Workers before, open Workers & Pages in
the Cloudflare dashboard once and register a `workers.dev` subdomain. Wrangler
cannot publish a public `workers.dev` URL until that account-level onboarding is
done.

Create the D1 database, paste the returned database id into `wrangler.jsonc`,
then apply migrations:

```sh
cd apps/webhook-relay
npx wrangler d1 create ade-github-relay
npm run d1:migrate:remote
```

Set Worker secrets. Do not commit these values:

```sh
cd apps/webhook-relay
printf '%s' "$GITHUB_WEBHOOK_SECRET" | npx wrangler secret put GITHUB_WEBHOOK_SECRET
printf '%s' "$GITHUB_APP_ID" | npx wrangler secret put GITHUB_APP_ID
printf '%s' "$GITHUB_APP_PRIVATE_KEY" | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npm run deploy
```

`GITHUB_WEBHOOK_SECRET` must match the GitHub App webhook secret.
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are optional but recommended. They
let the relay verify a repository installation live through GitHub's App API
when webhook state has not arrived yet or the user presses Refresh in Settings.
`GITHUB_APP_PRIVATE_KEY` should be the private key PEM downloaded from the
GitHub App settings.

Linear support requires no new Wrangler secrets. Each ADE client generates its
own webhook signing secret and registers it into the
`linear_organizations` D1 table through the authenticated registration route.
For local tests or a Linear-compatible proxy, `LINEAR_API_BASE_URL` overrides
the default `https://api.linear.app/graphql` endpoint. It may be the GraphQL URL
itself or an origin, in which case the Worker appends `/graphql`.

Only self-hosted legacy project-token routes need `RELAY_ACCESS_TOKEN`:

```sh
printf '%s' "$ADE_GITHUB_RELAY_TOKEN" | npx wrangler secret put RELAY_ACCESS_TOKEN
```

`ADE_GITHUB_RELAY_TOKEN` is the relay root secret stored in Cloudflare. Legacy
ADE clients send a project-scoped `ade_proj_...` token derived from that secret
and `remoteProjectId`; if ADE is configured with an already-derived
`ade_proj_...` token it sends that value as-is.

## ADE project config

Normal ADE users should not edit project files for realtime GitHub updates. ADE
uses the hosted relay by default. The hosted auth path is:

1. Install the ADE GitHub App for all repositories, or for the selected
   repositories that should receive realtime updates.
2. In ADE, authorize the ADE GitHub App. Desktop/headless ADE uses GitHub's
   device flow and stores the returned GitHub App user access token locally.
3. ADE sends that expiring app/user token, never the user's general ADE GitHub
   PAT/OAuth/`gh auth` token, as `Authorization: Bearer <GitHub App user token>`
   for:

- `GET https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/:owner/:repo/status`
- `GET https://ade-github-webhook-relay.arulsharma1028.workers.dev/github/repos/:owner/:repo/events`

The relay forwards the token to GitHub's REST API only for authorization checks
and does not store, log, or echo it. It rejects callers unless GitHub reports
push/write, maintain, or admin access for the authenticated user, so public-repo
webhook history is not readable by arbitrary GitHub accounts. Keep the ADE
GitHub App's repository permissions read-only so the token the hosted relay sees
cannot write repository data; it is app-limited and user-scoped, and ADE
refreshes it locally when GitHub marks it near expiry.

If the App is installed for all repositories, every GitHub project opened in ADE
can use the relay automatically. If the App is installed for selected
repositories, Settings shows whether the current repository is selected.

For self-hosted relay development, or for legacy project-partitioned deployments,
you can still put explicit relay settings in the ADE project's local secret
config, not in source:

```yaml
automations:
  githubRelay:
    apiBaseUrl: https://ade-github-webhook-relay.<your-subdomain>.workers.dev
    remoteProjectId: <stable-project-id>
    accessToken: ${env:ADE_GITHUB_RELAY_TOKEN}
```

`remoteProjectId` is only a legacy relay partition key. It can be a generated
UUID or a stable ADE project slug.

Self-hosted legacy project-token routes do not use the hosted app-user token and
continue to authenticate with the derived `ade_proj_...` relay token.

For dev/runtime launches, ADE also accepts env vars instead of
`local.secret.yaml`. Setting these opts the runtime into the legacy
project-token route for self-hosted relays:

```sh
ADE_GITHUB_RELAY_API_BASE_URL=https://ade-github-webhook-relay.<your-subdomain>.workers.dev
ADE_GITHUB_RELAY_REMOTE_PROJECT_ID=<stable-project-id>
ADE_GITHUB_RELAY_ACCESS_TOKEN=<relay-token>
```

## Linear setup

ADE performs the Linear setup flow after the user connects a workspace with a
workspace-admin API key or OAuth token carrying the `admin` scope:

1. ADE creates a 32-byte random signing secret and creates a Linear webhook
   targeting
   `https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/webhook`.
2. ADE calls `POST /linear/orgs/register` with `{ "secret": "…" }` and the
   user's Linear authorization header. API keys are sent raw; OAuth tokens are
   sent as `Bearer <token>`.
3. The Worker asks Linear for `viewer.organization.id`, then upserts the secret
   for that organization. It does not store or log the authorization token.
4. ADE polls `GET /linear/orgs/:organizationId/events?after=seq:<n>`. The Worker
   rechecks that the caller's Linear token belongs to the requested organization
   and caches that token-to-organization verdict in memory for five minutes.

Configure the Linear webhook for `Issue`, `Comment`, and `IssueLabel` resources,
with all public teams enabled. The single global ingest URL is:

```text
https://ade-github-webhook-relay.arulsharma1028.workers.dev/linear/webhook
```

Incoming deliveries are deduplicated by `Linear-Delivery`, retained according
to `EVENT_RETENTION_DAYS` (30 days by default), and rejected when the raw-body
HMAC is invalid or `webhookTimestamp` is more than 60 seconds from the Worker
clock. An unknown organization receives a successful acknowledgement without
storage so Linear does not disable the webhook while setup is still converging.

### Linear OAuth app deliveries (optional)

An ADE Linear OAuth application signs every workspace's deliveries with one
app-level signing secret instead of a per-organization secret. To accept
those, store the app's signing secret on the Worker:

```bash
npx wrangler secret put LINEAR_APP_WEBHOOK_SECRET
```

App-signed deliveries are stored without prior `POST /linear/orgs/register`
(the payload's `organizationId` scopes them), and per-organization workspace
webhooks keep working alongside. When creating the OAuth app in Linear
(Settings → API → OAuth applications), enable webhooks with the same ingest
URL above; data-change webhook categories require the app to request the
`admin` scope.

## GitHub App setup

Create or edit a GitHub App. Use the user-facing name `ADE`:

- Webhook URL:
  `https://ade-github-webhook-relay.<your-subdomain>.workers.dev/github/webhook`
- Webhook secret: the same `GITHUB_WEBHOOK_SECRET` stored in Cloudflare.
- SSL verification: enabled.
- Device flow: enabled.
- Expire user authorization tokens: enabled.
- Request user authorization (OAuth) during installation: optional. ADE starts
  device authorization itself, so this is not required for the hosted relay to
  work; enabling it can reduce a later authorization step for some users.
- Repository permissions:
  - Metadata: read-only
  - Pull requests: read-only
  - Checks: read-only
  - Commit statuses: read-only
  - Actions: read-only
  - Issues: read-only, for PR issue comments and labels
- Subscribe to events:
  - Pull request
  - Pull request review
  - Pull request review comment
  - Issue comment
  - Check run
  - Check suite
  - Status
  - Workflow run
  - Meta

Install the GitHub App only on the repositories ADE should track. Keep the
current GitHub auth path enabled as fallback.

GitHub also sends GitHub App install-status deliveries such as `installation`
and `installation_repositories`. Those are not shown as normal selectable event
checkboxes in the GitHub App "Subscribe to events" list, and the visible
`Installation target` event is not required for ADE repository status. `Meta` is
useful because it tells ADE when the App webhook itself was removed, so Settings
can show that realtime PR updates are off even if the App is still installed on
a repo. If ADE still shows a repository as not installed after the App is
installed, open the App's installation settings in GitHub and change the
repository selection once or check the GitHub App's Recent deliveries for a
failed install-status delivery.
