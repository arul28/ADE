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
   to the `machine_key` declared back at `POST /device/code`, and valid for
   `PAIRING_GRANT_TTL_MS` (10 minutes). A removed machine holding only an old
   access token cannot obtain one: minting requires completing the browser half
   of the device flow.

The fallback exists because path 1 fails closed and ADE's brain authenticates
with a Clerk **OAuth access token**, whose documented claim set does not include
either claim. Claim-only freshness would therefore risk making every account
removal permanent — the same Blocker as an un-revocable machine, inverted.

A refusal answers `403` with `code: "pairing_authentication_required"` and an
actionable message rather than a bare status. An accepted re-pair clears the
relay's revocation first, so a machine is never back on the roster while still
unable to publish.

### Spending a grant takes two phases

A grant is spendable exactly once, but a spend is not a single `DELETE`. The
relay hand-off that follows can fail, and destroying the grant before knowing
the outcome meant a relay outage burned the only credential a reinstalled
machine had — the same lockout the grant exists to prevent, moved one step
later. So redemption is:

1. **Reserve.** One atomic `UPDATE ... SET reserved_at` whose `WHERE` still
   carries every rule (this user, this machine, inside its TTL, not already
   held). `changes === 1` is the whole proof, so two concurrent registrations
   can no more both spend it than they could before.
2. **Consume** (`DELETE`, scoped to that reservation) once the relay agrees, or
   **release** (`SET reserved_at = null`) when it does not.

A release restores the row exactly as it was. `expires_at` is never rewritten,
so an attacker who can force relay failures gains nothing beyond the TTL the
grant was minted with. A reservation older than `PAIRING_GRANT_RESERVATION_MS`
(60 s) is ignored, so a Worker that dies mid-hand-off strands the grant for a
minute rather than until it expires.

## Superseding a rotated machine key

Machines are keyed `(user_id, machine_key)`, so a client that rotates its
identity file — a reinstall, a wiped config directory, a restored backup —
arrives as a **second row for one physical computer**. The user then removes the
row that looks stale, and half the time that is the live install.

A register call whose `deviceId` matches other rows on the same account
therefore deletes those rows and reports them:

```json
{ "machineKey": "...", "supersededMachineKeys": ["<older key>"] }
```

The field is additive and omitted when nothing was superseded, so existing
clients are unaffected. Two rules bound it:

- **Same trust bar as a re-pair.** `deviceId` is caller-supplied and forgeable,
  so on a plain token it authorizes nothing — otherwise any machine could claim
  another's device id and delete its row. The call must carry proven-fresh
  interactive authentication or spend a pairing grant, exactly as un-revoking
  does. A grant is only spendable on `pairing: true`; the claim is honored on
  any register, because it is a property of a token this Worker verified.
- **At most 5 rows per call**, oldest-seen first. The rest go on the next proven
  re-pair.

Superseded keys get **no** `revoked_machines` row. The physical device holds the
new key, and blocking the old one would trapdoor any client that rolls its
identity file back into a permanent refusal; an absent key simply registers
again. The relay is not called either — the device never left the account, so
its Activity is still the user's own.

## Refusal logs

Every refusal on this Worker is a user who cannot get their computer back onto
their account, and by the time they ask for help the request is gone. Each
refusal path emits exactly one structured line to `console.log` (Workers
observability runs at `head_sampling_rate: 1`):

```json
{"event":"directory.register_refused","userId":"user_…","machineKeyPrefix":"abcdef12",
 "deviceIdPrefix":"01234567","code":"machine_revoked","correlationId":"…"}
```

`event` is one of `directory.register_refused`, `directory.remove_refused`, or
`directory.supersede_refused`; `code` is the wire code the client received
(`machine_revoked`, `pairing_authentication_required`,
`activity_relay_unavailable`, `activity_purge_failed`,
`supersede_authentication_required`), and an optional `reason` carries the finer
classification support actually needs — `no_proof` versus `grant_rejected`, or
the relay's own failure text. `correlationId` joins the line to the request the
client logged.

Identifiers appear as **8-character prefixes only**. A machine key is
capability-shaped and a grant is a live credential; no full key, token, or grant
is ever logged.

There is no admin route for restoring a machine by hand, and this change did not
add one: the Worker has no secret-gated inbound surface to extend
(`DIRECTORY_AUTH_SECRET` is outbound provenance for the relay, not an inbound
credential), and adding one would be a new authentication boundary guarding
exactly the tables `wrangler d1 execute --env production` already reaches.
Support recovery is a direct D1 statement — typically
`delete from revoked_machines where user_id = ? and machine_key = ?` — after the
refusal logs above identify the row.

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
   production environment. Each deploy script validates only the environment it
   is about to publish, so an unconfigured development Worker cannot block a
   production deploy. The check refuses to deploy unless
   `DIRECTORY_AUTH_SECRET` and `PUSH_RELAY_URL` are configured for that
   environment — without either one, every machine removal answers 502 and every
   re-pair 503. Release builds use the production origin; local
   development uses the development origin. Set the machine-level
   `ADE_ACCOUNT_DIRECTORY_URL=https://<worker-host>` only for a trusted
   self-hosted override.

`ONLINE_WINDOW_MS` defaults to 90 seconds and can be adjusted as a Worker var.
