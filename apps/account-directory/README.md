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

A register call whose `deviceId` **or** `hardwareId` matches other rows on the
same account therefore deletes those rows and reports them:

```json
{ "machineKey": "...", "supersededMachineKeys": ["<older key>"] }
```

The field is additive and omitted when nothing was superseded, so existing
clients are unaffected. Three rules bound it:

- **Two identifiers, one union.** `deviceId` catches an in-place reinstall,
  where `~/.ade/secrets` survived. `hardwareId` — an optional, per-account
  sha256 of an OS-level machine identifier (`IOPlatformUUID`, `MachineGuid`,
  `/etc/machine-id`) — catches a full `~/.ade` wipe, where the device id was
  minted fresh alongside the machine key and matches nothing. It is salted with
  the account id, so one machine seen by two accounts stores two unrelated
  values and the column cannot correlate users. Rows with a null `hardware_id`
  (written before it shipped, or by a host that cannot read one) are matched by
  `deviceId` only, and nothing back-fills them.
- **Same trust bar as a re-pair.** `deviceId` and `hardwareId` are both
  caller-supplied and forgeable, so on a plain token they authorize nothing —
  otherwise any machine could claim another's identifiers and delete its row.
  The call must carry proven-fresh interactive authentication or spend a pairing
  grant, exactly as un-revoking does. A grant is only spendable on
  `pairing: true`; the claim is honored on any register, because it is a
  property of a token this Worker verified.
- **At most 5 rows per call** across both identifiers, oldest-seen first. The
  rest go on the next proven re-pair.

It **folds**, it does not merely delete: the one thing a superseded row holds
that the new one cannot rebuild is `custom_name`, the name the user typed. The
most recently seen superseded name is carried onto the surviving row, and only
when that row has no name of its own — a name set on the new row is the fresher
statement of intent. The carry-forward and the deletes go out as a single
`DB.batch()`, because the pairing grant is already spent by the time they run
and a half-finished loop would leave phantoms behind with no credential left to
clear them.

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

## Diagnostic report uploads

`POST /diagnostics/upload` is the destination for ADE's "Send to ADE" button and
`ade report-issue --send`. It exists because support round-trips were the real
cost of a broken install: the report is already built and fully redacted on the
user's machine, and asking someone whose ADE will not start to run terminal
commands and paste output is where most of them stalled.

**Contract**

| | |
|---|---|
| Method | `POST` (plus `OPTIONS` preflight; anything else is `405`) |
| Body | `text/plain` — the report itself; or `application/json` — `{ report, installId?, appVersion? }` |
| Metadata on `text/plain` | `?installId=` / `?appVersion=` query parameters |
| Auth | **Optional** `Authorization: Bearer <Clerk token>`, verified exactly as the account routes verify it. Absent, the upload is anonymous. A header that is sent and does not verify — or does not even parse as `Bearer <token>` — is `401`, never silently downgraded. A Worker with no Clerk configuration answers `503`, exactly as the account routes do |
| Origin | `403` when the browser reports `sec-fetch-site: cross-site` from a real remote origin. ADE's own senders are unaffected: the CLI sends no fetch-metadata header, and the Electron renderer's `null` (packaged `file://`) and loopback (development) origins are exempt |
| Size | `413` above 512 KB. `content-length` is checked first, then the stream is counted as it arrives, so a missing or dishonest length changes nothing |
| Rate limit | 5 per UTC day per user (signed in) or per `cf-connecting-ip` (anonymous) → `429` with `retry-after: 86400`. Off Cloudflare there is no trustworthy address, so anonymous callers share one bucket; `x-forwarded-for` is caller-controlled and is never read |
| Success | `200 {"ok": true, "id": "<uuid>"}`. The report is **never** echoed back |
| Storage | `reports/<utc-date>/<userIdOrAnon>/<uuid>.md` in the `DIAGNOSTICS` R2 bucket, with `userId` / `installId` / `appVersion` as custom metadata |
| No binding | `503`, and the in-app button says sending is unavailable |

The key's identity segment is `u-<clerk user id>` when signed in and
`anon-<sha256(ip) prefix>` otherwise — the *same* segment the quota is counted
on, so one prefix listing answers both "where does this go" and "has this caller
had enough today".

CORS is `*` on this route only. The desktop button runs in Electron's renderer,
whose origin is `file://` (`Origin: null`) in a packaged build, so no fixed
allow-list can name it; `*` is safe here because the route reads no account
state, returns only an opaque id, and cannot be used with
`credentials: "include"`. Every `/account/*` route keeps its exact-origin rule.

**Rate limiting without a migration.** The device flow counts attempts in the
`device_approval_rate_limits` D1 table. This route deliberately does not: it
ships without touching `migrations/`, so the quota is enforced by a per-isolate
counter (fast, but lost when Cloudflare recycles the isolate) backed by an R2
prefix listing (durable and global, one class-A operation per upload). The
listing is not transactional, so genuinely simultaneous requests can land a
couple of objects over five. For a bound whose only job is "one person cannot
fill the bucket", that is an acceptable trade; if volume ever justifies exact
counting, move it to the D1 pattern the device flow already uses.

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
3. Create the R2 bucket behind the `DIAGNOSTICS` binding, **before** the deploy
   that first references it — `wrangler deploy` does not create buckets, and a
   Worker bound to a bucket that does not exist fails to start:

   ```sh
   npx wrangler r2 bucket create ade-diagnostics              # default environment
   npx wrangler r2 bucket create ade-diagnostics-production   # production
   ```

   The binding is optional in code, so an already-deployed Worker whose bucket
   was removed answers `503` on `/diagnostics/upload` and keeps every other
   route working.
4. Give both diagnostics buckets an expiry lifecycle rule. **Nothing in the
   Worker ever deletes a report**, so without this the bucket grows forever and
   every report a user ever sent stays readable indefinitely. Ninety days is the
   default because it is far longer than any support thread and far shorter than
   "forever" — shorten it if your retention policy says so:

   ```sh
   npx wrangler r2 bucket lifecycle add ade-diagnostics \
     expire-reports reports/ --expire-days 90
   npx wrangler r2 bucket lifecycle add ade-diagnostics-production \
     expire-reports reports/ --expire-days 90
   ```

   Confirm with `npx wrangler r2 bucket lifecycle list <bucket>`.
5. Apply the remote migrations and deploy the Worker. Use
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
