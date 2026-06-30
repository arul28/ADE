# ADE webhook relay

This is the cheap hosted ingress for ADE PR events. GitHub delivers webhooks to a
Cloudflare Worker, the Worker verifies the GitHub HMAC signature, writes the
event into D1, and ADE desktop/TUI/mobile sync paths poll the newest events with
the existing `automations.githubRelay` cursor.

No user repository needs ADE-specific code. The only repo-side step is installing
the GitHub App, or configuring an equivalent GitHub webhook, on the repositories
the user wants ADE to track.

## Why this shape

- One Worker and one D1 database; no always-on server, queues, cron, Durable
  Objects, or per-user compute.
- GitHub webhook writes are idempotent by delivery id.
- ADE polls with `after=<last-cursor>`, where new cursors are monotonic
  `seq:<n>` values. Legacy delivery-id cursors still work during migration.
- ADE checks per-repo GitHub App status with a cheap D1 lookup at
  `GET /projects/:projectId/github/repos/:owner/:repo/status`. If GitHub App
  API credentials are configured, it only calls GitHub when D1 has no installed
  state yet or the user explicitly presses Refresh.
- If relay config is missing or the relay fails, ADE keeps using the current
  GitHub polling/snapshot path.
- The event envelope is provider-neutral enough to add Linear later without
  replacing the ADE cache path.

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
printf '%s' "$ADE_GITHUB_RELAY_TOKEN" | npx wrangler secret put RELAY_ACCESS_TOKEN
printf '%s' "$GITHUB_APP_ID" | npx wrangler secret put GITHUB_APP_ID
printf '%s' "$GITHUB_APP_PRIVATE_KEY" | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npm run deploy
```

`GITHUB_WEBHOOK_SECRET` must match the GitHub App webhook secret.
`ADE_GITHUB_RELAY_TOKEN` is the relay root secret stored in Cloudflare. ADE
clients send a project-scoped `ade_proj_...` token derived from that secret and
`remoteProjectId`; if ADE is configured with an already-derived `ade_proj_...`
token it sends that value as-is.
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are optional but recommended. They
let the relay verify a repository installation live through GitHub's App API
when webhook state has not arrived yet or the user presses Refresh in Settings.
`GITHUB_APP_PRIVATE_KEY` should be the private key PEM downloaded from the
GitHub App settings.

## ADE project config

Put the relay settings in the ADE project's local secret config, not in source:

```yaml
automations:
  githubRelay:
    apiBaseUrl: https://ade-github-webhook-relay.<your-subdomain>.workers.dev
    remoteProjectId: <stable-project-id>
    accessToken: ${env:ADE_GITHUB_RELAY_TOKEN}
```

`remoteProjectId` is only a relay partition key. It can be a generated UUID or a
stable ADE project slug.

For dev/runtime launches, ADE also accepts env vars instead of
`local.secret.yaml`:

```sh
ADE_GITHUB_RELAY_API_BASE_URL=https://ade-github-webhook-relay.<your-subdomain>.workers.dev
ADE_GITHUB_RELAY_REMOTE_PROJECT_ID=<stable-project-id>
ADE_GITHUB_RELAY_ACCESS_TOKEN=<relay-token>
```

## GitHub App setup

Create or edit a GitHub App. Use the user-facing name `ADE`:

- Webhook URL:
  `https://ade-github-webhook-relay.<your-subdomain>.workers.dev/projects/<stable-project-id>/github/webhook`
- Webhook secret: the same `GITHUB_WEBHOOK_SECRET` stored in Cloudflare.
- SSL verification: enabled.
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
