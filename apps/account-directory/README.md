# ADE account directory Worker

Cloudflare Worker + D1 directory for account-scoped ADE machines. Clerk JWTs
are verified against the configured remote JWKS before any machine row is read
or changed.

The Worker also hosts ADE's device-authorization bridge for headless sign-in:

- `POST /device/code` creates a short-lived code bound to a daemon-generated secret.
  An optional `machine_key` names the machine signing in, which is what a pairing
  grant (below) can later be spent on.
- `GET /device` renders a read-only human-code confirmation page.
- `POST /device` confirms the code and redirects through Clerk OAuth + PKCE.
- `GET /device/callback` exchanges the Clerk code and holds the token pair briefly.
- `POST /device/token` lets the initiating daemon redeem the pair once, and returns
  a `pairing_grant` alongside it when the request declared a `machine_key`.

Device codes and approval-attempt rate limits are stored in D1. The daemon
secret is stored only as a SHA-256 digest; approved token pairs are cleared by
the one-time redemption update or when the device code expires.

## Removing a machine

`DELETE /account/machines/:machineKey` is not just a row delete. The machine's
Activity lives in the push relay — a different Worker over a different D1 — and
its idle rows carry no expiry, so a delete that stopped here would leave a
de-authorized machine's agents on every surface of the account. The handler:

1. records a `revoked_machines` row (before dropping the machine row, so a
   half-completed removal fails closed) — `POST /account/machines/register` is
   refused with `403 machine_revoked` while it stands, which is what stops the
   removed machine's 30-second heartbeat from re-registering itself;
2. deletes the machine row;
3. forwards the removal to `DELETE /attention/account/machines/:machineKey` on
   the relay (`PUSH_RELAY_URL`, or the optional `ACTIVITY_RELAY` service
   binding), passing the caller's already-verified bearer token so the relay
   authenticates the account itself, plus an `x-ade-directory-auth` header
   carrying `DIRECTORY_AUTH_SECRET` so the relay can tell a directory hand-off
   from a machine replaying the account token it still holds. Both workers must
   hold the same secret; unset, every relay hand-off fails closed.

A relay failure is retried once and then reported as `502` with
`code: "activity_purge_failed"` and `machineRemoved: true` — never as a clean
removal.

## Re-pairing a removed machine

The revocation clears only on a register request carrying `pairing: true` AND a
proof that a human just authenticated. `pairing` alone is an unauthenticated
client boolean on a route the removed machine can still call, so on its own it
proves nothing; `deviceId` is caller-supplied for the same reason and authorizes
nothing at all. Two proofs are accepted, either one sufficient:

1. **Claim freshness (fast path).** The verified caller token carries an
   `auth_time` (OIDC) or `fva` (Clerk factor-verification-age) claim placing an
   interactive sign-in inside `PAIRING_AUTH_FRESHNESS_MS` (10 minutes). A token
   refresh renews `exp`/`iat` but never these, so a token idling on a removed
   machine can never qualify.
2. **A pairing grant (fallback).** 32 random bytes minted at `POST /device/token`
   — the one interactive sign-in this Worker runs end to end — stored as a
   SHA-256 digest in `machine_pairing_grants`, bound to the signing-in user and
   to the `machine_key` declared back at `POST /device/code`, valid for
   `PAIRING_GRANT_TTL_MS` (10 minutes), and redeemed by a single conditional
   `DELETE` so it is spendable exactly once. A removed machine holding only an
   old access token cannot obtain one: minting requires completing the browser
   half of the device flow.

The fallback exists because path 1 fails closed and ADE's brain authenticates
with a Clerk **OAuth access token**, whose documented claim set does not include
either claim. Claim-only freshness would therefore risk making every account
removal permanent — the same Blocker as an un-revocable machine, inverted.

A refusal answers `403` with `code: "pairing_authentication_required"` and an
actionable message rather than a bare status. An accepted re-pair clears the
relay's revocation first, so a machine is never back on the roster while still
unable to publish.

Machine registration and list records may carry a `pubkey` string. Current ADE
hosts publish `ed25519:<raw-32-byte-base64>` so clients can verify and seal
account adoption on direct or relay routes. The Worker treats the value as
opaque metadata and rejects values longer than 128 characters.

## Local checks

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` is a Wrangler dry run and does not deploy.

## Cloudflare deployment

Development and production are isolated so development Clerk users and machine
heartbeats never enter the production directory:

- Development: `https://ade-account-directory.arulsharma1028.workers.dev`
- Production: `https://ade-account-directory-production.arulsharma1028.workers.dev`

The `production` Wrangler environment binds a separate
`ade-account-directory-production` D1 database. To reproduce or move either
deployment:

1. Create the matching D1 database and put its UUID in `wrangler.jsonc`.
2. Set `CLERK_JWKS_URL`, `CLERK_ISSUER`, and
   `CLERK_OAUTH_CLIENT_ID=<your-clerk-oauth-client-id>` as Worker vars/secrets. Register
   `https://<worker-host>/device/callback` as an allowed redirect URI for the
   Clerk OAuth application. Set `WEB_CLIENT_ORIGIN` to the exact HTTPS origin
   of the hosted ADE web client; this is the only cross-origin caller allowed
   to send an account bearer to `GET /account/machines`. Set `PUSH_RELAY_URL`
   to the push relay origin; machine removal fails loudly without it. Set
   `DIRECTORY_AUTH_SECRET` (`npx wrangler secret put DIRECTORY_AUTH_SECRET`) to
   the same value configured on the push relay; machine removal and re-pairing
   both fail loudly without it.
3. Apply the remote migrations and deploy the Worker. Use
   `npm run d1:migrate:production` and `npm run deploy:production` for the
   production environment. Both deploy scripts run
   `npm run verify:deploy-config` first, which refuses to deploy unless
   `DIRECTORY_AUTH_SECRET` and `PUSH_RELAY_URL` are configured for the default
   AND production environments — without either one, every machine removal
   answers 502 and every re-pair 503. Release builds use the production origin; local
   development uses the development origin. Set the machine-level
   `ADE_ACCOUNT_DIRECTORY_URL=https://<worker-host>` only for a trusted
   self-hosted override.

`ONLINE_WINDOW_MS` defaults to 90 seconds and can be adjusted as a Worker var.
