# ADE account directory Worker

Cloudflare Worker + D1 directory for account-scoped ADE machines. Clerk JWTs
are verified against the configured remote JWKS before any machine row is read
or changed.

The Worker also hosts ADE's device-authorization bridge for headless sign-in:

- `POST /device/code` creates a short-lived code bound to a daemon secret
  (stored as a SHA-256 only). Its `verification_uri` is this Worker's
  `/device`, or `<DEVICE_PAGE_ORIGIN>/device`. Production sets
  `https://ade-app.dev`, which opens ADE Mobile as a universal link and
  redirects a browser here. Deploy the website before a Worker that sets it:
  the deploy preflight refuses when the page does not redirect. An optional
  `machine_key` names the machine a pairing grant can be spent on; an optional
  `machine_name` (cleaned, at most 80 characters) is display text only.
- `GET /device` renders a read-only confirmation page. With a `machine_name`,
  it says "A computer named … asked to sign in to ADE" and to continue only if
  the reader started it there.
- `POST /device` confirms the code and opens Clerk OAuth + PKCE. It accepts
  only a same-origin form POST (`Origin`, else `Sec-Fetch-Site: same-origin`
  when `Origin` is missing or `null`). The page uses
  `referrer-policy: same-origin`, because `no-referrer` makes `Origin: null`.
  It answers with a small page (meta refresh and link), not a 302, because
  `form-action 'self'` applies to every redirect after a form POST.
- `GET /device/approve?user_code=` and `POST /device/approve` are the approval
  from a signed-in ADE app (a phone that scanned the QR code), with an account
  bearer. `GET` answers `{ status, machine_name }` (`pending`, `started`,
  `approved`, `failed`). `POST` mints a 120-second Clerk sign-in ticket for
  the verified caller (`CLERK_SECRET_KEY`) and answers `{ url }`, whose
  `redirect_url` is this sign-in's authorize URL. The computer gets the
  approver's own session. Errors: 401 `unauthorized`, 404 `not_found`, 410
  `expired`, 409 `already_used`, 429 `rate_limited`, 503/502 `unavailable`
  (the app then offers the `/device` page).
- `GET /device/callback` exchanges the Clerk code and holds the token pair
  until `POST /device/token` redeems it once (with a `pairing_grant` when the
  request declared a `machine_key`) or the code expires.

## Which install a machine row is

Stable (`~/.ade`) and Alpha (`~/.ade-alpha`) on one computer are two machines
with the same hostname. A register call may send `channel` (`stable`, `beta`
or `alpha`) and `adeHome` (`~/.ade-alpha` or a folder name, never a full
path), stored by migration `0011` and returned on every row. A register that
omits them keeps the stored values.

Shown client text (`adeHome`, the device flow's `machine_name`) goes through
`boundedDisplayText` (`src/displayText.ts`): it replaces control and format
characters, folds whitespace and cuts the length. It cleans, never refuses.

## A resting ADE Cloud computer in the machine list

The machine list, the single read and the rename answer read each ADE Cloud
computer's state from the server's row (`cloudComputerTruth` in
`src/directory.ts`). A resting computer reads `online: false`,
`sleepState: "asleep"` and `cloud: { state, stateAt }`. A failed read logs
`directory.cloud_truth_read_failed` and leaves the fields out.

## Removing a machine

`DELETE /account/machines/:machineKey` also clears the machine's Activity in
the push relay (another Worker and D1), whose rows have no expiry.

1. Record a `revoked_machines` row first, so a half-done removal fails closed.
   While it stands, `POST /account/machines/register` answers
   `403 machine_revoked`, which stops the heartbeat from re-registering.
2. Delete the machine row.
3. Forward to the relay's `DELETE /attention/account/machines/:machineKey`
   (`PUSH_RELAY_URL` or the `ACTIVITY_RELAY` binding) with the caller's bearer
   and `x-ade-directory-auth: DIRECTORY_AUTH_SECRET` (the same secret on both
   Workers; unset fails closed).

A relay failure is retried once, then answers `502`
`activity_purge_failed` with `machineRemoved: true`.

## Re-pairing a removed machine

The revocation clears only on a register request with `pairing: true` AND a
proof that a person just signed in. `pairing` and `deviceId` alone are client
claims and prove nothing. Either proof is enough:

1. **Claim freshness.** The verified token carries `auth_time` (OIDC) or `fva`
   (Clerk) inside `PAIRING_AUTH_FRESHNESS_MS` (10 minutes). A refresh never
   renews these claims.
2. **A pairing grant.** 32 random bytes minted at `POST /device/token` (the one
   interactive sign-in this Worker runs end to end), stored as a SHA-256 in
   `machine_pairing_grants`, bound to the user and to the `machine_key` sent
   at `POST /device/code`, valid `PAIRING_GRANT_TTL_MS` (10 minutes). ADE's
   brain signs in with a Clerk OAuth access token that has neither claim, so
   the grant is its path.

A refusal answers 403 `pairing_authentication_required` with a message. An
accepted re-pair clears the relay's revocation first.

**A grant is spent in two phases**, so a relay failure does not burn it:

1. **Reserve:** one atomic `UPDATE ... SET reserved_at` with every rule in its
   `WHERE` (this user, this machine, inside its TTL, not held).
   `changes === 1` is the proof.
2. **Consume** (`DELETE` of that reservation) once the relay agrees, or
   **release** (`reserved_at = null`) when it does not. `expires_at` never
   changes. A reservation older than `PAIRING_GRANT_RESERVATION_MS` (60 s) is
   ignored.

## Superseding a rotated machine key

Machines are keyed `(user_id, machine_key)`, so a client that rotates its
identity file (a reinstall, a wiped config, a restored backup) arrives as a
second row for one computer. A register call whose `deviceId` or `hardwareId`
matches other rows of the account deletes those rows and answers
`supersededMachineKeys` (omitted when empty).

- `deviceId` catches an in-place reinstall. `hardwareId` (an optional sha256
  of the OS machine id, salted with the account id) catches a full `~/.ade`
  wipe. Rows with no `hardware_id` match by `deviceId` only.
- Both are client claims, so the call needs the same proof as a re-pair
  (fresh sign-in or a pairing grant).
- At most 5 rows per call, oldest-seen first.
- The newest superseded `custom_name` moves to the surviving row when that
  row has none, in one `DB.batch()` with the deletes.
- Superseded keys get no `revoked_machines` row and no relay call: the device
  never left the account.

## Refusal logs

Each refusal path writes one structured `console.log` line. Workers keep 10%
of request logs (`head_sampling_rate: 0.1`), so most refusals are also a
Sentry warning (`<event>: <code>`, tagged `refusal.code` and
`correlation_id`, no account id), within `admitEvent`'s budget. Three cases
write the console line only, because the heartbeat repeats them:
`directory.supersede_refused`, and `directory.register_refused` with
`machine_revoked` or `pairing_authentication_required` (the client shows
"sign in again"). For these, ask the user for the `correlationId`.

```json
{"event":"directory.register_refused","userId":"user_…","machineKeyPrefix":"abcdef12",
 "deviceIdPrefix":"01234567","code":"machine_revoked","correlationId":"…"}
```

- `event`: `directory.register_refused`, `.remove_refused` or
  `.supersede_refused`. `code`: the wire code (`machine_revoked`,
  `pairing_authentication_required`, `activity_relay_unavailable`,
  `activity_purge_failed`, `supersede_authentication_required`). `reason`:
  the finer cause (`no_proof`, `grant_rejected`, the relay's text).
- Identifiers appear as 8-character prefixes only. No key, token or grant is
  logged.
- There is no admin route to restore a machine. Support runs a D1 statement,
  usually `delete from revoked_machines where user_id = ? and machine_key = ?`.

Machine rows may carry a `pubkey` (`ed25519:<raw-32-byte-base64>`), opaque
here and at most 128 characters.

## Diagnostic report uploads

`POST /diagnostics/upload` receives ADE's "Send to ADE" button and
`ade report-issue --send`. The client builds and redacts the report, so a
person whose ADE does not start can still send it.

| | |
|---|---|
| Method | `POST` (and `OPTIONS`); else `405` |
| Body | `text/plain` (the report, metadata as query parameters) or JSON `{ report, installId?, appVersion?, auto?, failureCode? }` |
| `auto`, `failureCode` | Optional. `auto` marks a send the client made on its own. A `failureCode` that does not match `^[a-z][a-z0-9_-]{0,47}$` is dropped, not refused |
| Auth | Optional `Bearer <Clerk token>`. A header that does not verify is `401`, never anonymous. No Clerk configuration: `503` |
| Origin | `403` for `sec-fetch-site: cross-site` from a real remote origin. The CLI, `Origin: null` and loopback are exempt |
| Size | `413` above 512 KB, counted as the stream arrives |
| Per-caller limit | 5 stored per UTC day per user or per `cf-connecting-ip` → `429 {"error":"rate limited"}`, `retry-after: 86400`. `x-forwarded-for` is never read |
| Fleet limit | `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` stored per UTC day (default 400; `0` refuses all; a bad value means 400) → `429 {"error":"daily diagnostics budget exhausted"}`. A different body from the per-caller `429`, so an auto-sender does not retry it as its own quota |
| Budget unavailable | `503 {"error":"diagnostics upload unavailable"}` (fails closed) |
| Success | `200 {"ok": true, "id": "<uuid>"}`. The report is never echoed |
| Storage | `reports/<utc-date>/<u-userId or anon-sha256(ip) prefix>/<uuid>.md` in the `DIAGNOSTICS` R2 bucket, metadata `userId`, `installId`, `appVersion`, `auto` (only when true), `failureCode`. No binding: `503` |

- CORS is `*` on this route only: a packaged renderer sends `Origin: null`,
  and the route reads no account state. Every `/account/*` route keeps its
  exact-origin rule.
- The per-caller quota is a per-isolate counter backed by an R2 listing of
  the caller's day. Both count stored objects, never attempts, so a refusal
  the caller did not cause never counts against it.
- The fleet slot is one upsert on `diagnostics_upload_days` (migration
  `0009`): `on conflict(day) do update set count = count + 1 where count < ?`,
  with `changes === 1` as the proof. It is claimed after the per-caller check
  and before the R2 `put`; a failed `put` refunds it. The cron prunes rows
  older than seven days.
- **The cost ceiling:** 400 uploads × 512 KB × 30 days (the bucket's expiry
  rule) ≈ 6 GB, under R2's 10 GB free tier. The Worker never deletes a report.
  If you change one term, do the multiplication again.

## Usage research reports

`POST /usage-research/daily` (`src/usageResearch.ts`) receives one compact
usage report per ADE install per local day, for the model router research.
The reports share this Worker's D1 database with machines and sign-in. A full
D1 refuses every write, so the route can never fill it.

| | |
|---|---|
| Method | `POST`, else `405`. No CORS: the senders are the desktop main process and the CLI |
| Content type | `application/json`, else `415 usage_research_unsupported_media_type` |
| Body | Exactly `{ schemaVersion, installId, day, appVersion, platform, arch, utcOffsetMinutes, report }`. New fields go in `report` |
| Field rules | `schemaVersion` 1; `installId` `^[0-9a-f]{32}$`; `day` a real date in the window; `appVersion` 1–40, `platform` and `arch` 1–16 printable ASCII; `utcOffsetMinutes` −840…840; `report` an object. Else `400 usage_research_invalid` |
| Accepted days | `utcDate(now − 12 h − 8 days)` to `utcDate(now + 14 h)`: a seven-day backfill from any time zone, nothing in the future |
| Size | `413 usage_research_too_large` above 32 KB, also after re-serialization |
| Auth | None |
| Per-caller limit | 20 writes per `cf-connecting-ip` (IPv6 cut to /64) per UTC day → `429 usage_research_identity_limit` |
| Fleet limit | `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT` (default 20000; `0` stops writes) → `429 usage_research_daily_limit` |
| Storage ceiling | `USAGE_RESEARCH_STORAGE_CEILING_MB` (default 4096, at most 6144; `0` stops growth) → `429 usage_research_storage_full` |
| `retry-after` | On every `429`: seconds to the next UTC midnight |
| Success | `201 stored: "inserted"`, or `200 stored: "replaced"` for a re-send |
| Unavailable | `503 usage_research_unavailable`: no `DB`, a D1 error, or a lost race. Every limit fails closed and gives back its claims |

- **No duplicates.** The key is `(install_id, day)`. A byte-identical re-send
  is answered from one read and claims no budget.
- **Storage is the real bound.** The write cap alone allows about 116 GB in
  181 days. `usage_research_totals` keeps a running total of each report's
  bytes plus 256. Each growing write claims its growth first, then writes with
  a compare-and-swap on the row's `bytes`; a lost race gives back every claim.
  A lost refund only makes the total too high. To resync it:

  ```sql
  update usage_research_totals
  set bytes = (select coalesce(sum(bytes), 0) from usage_research_daily)
  where id = 1;
  ```

- **Capacity at the defaults** (Workers Paid: 10 GB per database, 5 GB
  included): 4 GB ÷ (10 KB × 180 days) ≈ 2,300 daily-active installs. Past it,
  new reports get `storage_full` and each day becomes a sample. To get more
  room, lower the retention, raise the ceiling (to 6,144) or export the data.
  An accepted write is about five rows written. On the Free plan, lower all
  three vars first.
- **Cleanup.** The minute cron deletes up to 500 reports older than
  `USAGE_RESEARCH_RETENTION_DAYS` (default 180, never below 9, so a backfill
  never re-inserts swept days), prunes fleet rows older than seven days, and
  deletes ended per-caller rows. Each cleanup has its own guard
  (`scheduled_cleanup_failed`).
- **Privacy.** Rows hold no user id, IP or token. Per-caller rows hold a
  SHA-256 of `day + address` and go when the day ends. The log line
  (`usage_research_upload`) carries the outcome, status, reason and byte count
  only.
- **Limits.** Edit a var in `wrangler.jsonc` under both `vars` and
  `env.production.vars`, then deploy. A dashboard edit is lost on the next
  deploy. A bad value means the default.
- **Queries** need `--remote` (and `--env production` with the `DB` name):

  ```sh
  npx wrangler d1 execute DB --remote --env production \
    --command "SELECT day, count(*) AS reports, sum(bytes) AS bytes FROM usage_research_daily GROUP BY day ORDER BY day"
  npx wrangler d1 export DB --remote --env production \
    --table usage_research_daily --output usage-research.sql
  ```

- **Migration** `0012_usage_research.sql` applies before the deploy (see
  [Cloudflare deployment](#cloudflare-deployment)). Without it this route
  answers `503` and nothing else breaks.

## Model registry

`GET /router/registry` serves one snapshot of public model data to signed-in
ADE machines. ADE's model router reads it to rate each route (harness × model
× effort). The Worker builds a new snapshot once a day.

The contract is `src/modelRegistryContract.ts`. Its desktop copy is
`apps/desktop/src/shared/routerRegistry.ts`, and
`test/modelRegistryContract.test.ts` fails when the two disagree. The contract
names each field and its units.

| | |
|---|---|
| Method | `GET` or `HEAD`, else `405`. No CORS: only the ADE brain calls it |
| Auth | An account bearer, as `/account/machines`. `401` without one; `503` with no Clerk configuration |
| Success | `200` with the newest `ModelRegistrySnapshot`, an `ETag`, `Cache-Control: private, max-age=3600` |
| Revalidation | A matching `If-None-Match` is `304`, from the stored ETag only |
| Unavailable | `503 model_registry_unavailable`: no snapshot yet, no `DB`, or a D1 error |

**A snapshot holds:**

- `models`: every Artificial Analysis model variant, one per effort level,
  with its index, evals, cost, speed, prices and an optional profile.
  `profile` says where the data came from: `record`, `leaderboard`, or
  `carried` (no current page lists it; the deprecated models).
  `timeToFirstTokenSeconds` includes hidden reasoning for a model that does
  not stream it.
- `agents`: every Coding Agent Index row (harness × model). `modelSlug` names
  a variant only on an exact name match or the row's `hostModelSlug`; pairs
  and unknown names are `null`, never guessed.
- `media`: the three speech leaderboards, scores in
  `MODEL_REGISTRY_MEDIA_SCORES`. `modelSlug` names an LLM only on an exact
  name match.
- `prices`: models.dev per-token prices for each channel in
  `MODEL_REGISTRY_PRICE_CHANNELS`, with context tiers.
- `sources`: per source (`artificialAnalysis`, `modelsDev`, `media`), the
  last read and whether it worked.

**Rules:**

- **Compatibility.** Every field past the first schema is optional, and
  `schemaVersion` stays 1. Bump `MODEL_REGISTRY_SCHEMA_VERSION` only for a
  change an older desktop would misread: it refuses any other version.
- **Sources.** Artificial Analysis has no API. A refresh reads
  `/leaderboards/models`, one model page, `/agents/coding-agents` and the three
  speech leaderboards (six fetches), with the user agent
  `ADE model registry (+https://ade-app.dev)`. A leaderboard row's effort
  comes from the previous snapshot's slug, else the name, else none. Prices
  come from `https://models.dev/api.json`. Anything that shows the data
  carries `MODEL_REGISTRY_AA_ATTRIBUTION`.
- **Terms.** Artificial Analysis terms restrict automated collection; the
  owner accepted this risk. Set `MODEL_REGISTRY_REFRESH=0` to stop collection
  at once. Serving continues from stored snapshots.
- **Cadence.** The minute cron refreshes when the newest snapshot is 24 hours
  old. A one-row claim (`model_registry_refresh_claim`, 15 minutes) stops two
  refreshes at once. A refresh that stores nothing waits ten minutes, doubling
  per failure up to 24 hours (`failures`).
- **Failure isolation.** A source that fails (HTTP error, fewer than 100
  variants, no agent rows, bad JSON, no channel) keeps its previous data with
  `ok: false` and the reason. The model page, the agents page and each speech
  leaderboard fail apart. Nothing is stored when both Artificial Analysis and
  models.dev fail. Each refresh logs `model_registry_refresh` with counts; a
  parser break shows as `artificialAnalysisError` or `mediaError`. A partial
  refresh counts as the day's refresh.
- **Size.** A snapshot is under 1 MB; the Worker refuses one over 1.9 MB
  (D1's row cap is 2 MB). Seven are kept. `limits.cpu_ms` stays unset.
- **Migration** `0013_model_registry.sql`. Until the first refresh (at most a
  minute after a deploy with `MODEL_REGISTRY_REFRESH` on), the route answers
  `503`. To look at the store:

  ```sh
  npx wrangler d1 execute DB --remote --env production --command \
    "SELECT id, generated_at, bytes, etag FROM model_registry_snapshots ORDER BY id DESC"
  ```

## Apple Music developer tokens

`GET /music/developer-token` returns `{ token, expiresAt }` (ms) to a signed-in
ADE caller (the registry's bearer check, GET only, no CORS,
`cache-control: no-store`).

- The token is an ES256 JWT (`kid: MUSICKIT_KEY_ID`, `iss: MUSICKIT_TEAM_ID`),
  lifetime `MUSICKIT_TOKEN_TTL_SECONDS` (default 30 days, at most six months).
- One token per isolate is reused until it has under seven days left, because
  a desktop player keeps the token it started with. The token is public by
  design; the key is not.
- The key is the secret `MUSICKIT_PRIVATE_KEY` (the `.p8` PEM text). Without a
  valid key the route answers 503 `music_unavailable`, and the desktop Music
  tab says it is unavailable. The deploy preflight does not require it.
- Logs: `music_developer_token_request` with status, reason and duration,
  never the token.

```bash
cd apps/account-directory
wrangler secret put MUSICKIT_PRIVATE_KEY < "<path to AuthKey_….p8>"
wrangler secret put MUSICKIT_PRIVATE_KEY --env production < "<path to AuthKey_….p8>"
```

## Latest ADE releases

`GET /releases/latest` returns `{ stable, beta }`: the newest published ADE
build on each track. It runs the desktop's own reader
(`apps/desktop/src/shared/latestByTrack.ts`) over the same two release
manifests (`release-manifest.json` of the latest stable release, and
`beta.json` on the `beta-feed` release). A track takes only a build of that
track.

- The phone and ADE Web use it for "Update & restart" on another machine,
  because a browser cannot read GitHub's release downloads itself.
- It takes the account bearer, answers GET only and allows the web client's
  exact origin.
- Each isolate reuses one read for ten minutes. A track whose manifest fails
  keeps its last value (null until it has one).
- Path and shape: `src/latestReleasesContract.ts`.

## Jev bonus

`POST /jev/systemone` answers a signed-in ADE caller's Jev question with ADE's
key (the registry's bearer check, POST only, no CORS,
`cache-control: no-store`). The brain sends it the same `{ state, questions }`
as to OpenCode's free Jev, but only once that day's free allowance is out.
The Worker forwards it to `https://api.typesafe.ai/v1/systemone` with
`JEV_MODEL` (default `jev-latest`) and answers unchanged, plus
`x-ade-jev-remaining`.

- Each account gets `JEV_BONUS_DAILY_LIMIT` calls a UTC day (default 500), the
  fleet `JEV_BONUS_DAILY_GLOBAL_LIMIT` (default 100,000), in `jev_bonus_days`
  (migration `0015`, one capped upsert per call). Over a cap: 429
  `jev_bonus_exhausted` with `retry-after` at the next UTC midnight.
- A call TypeSafe did not answer gives its slot back. TypeSafe's 429 passes
  through; its 402 (ADE's spend cap) becomes the same 429; a refused key
  answers 503. The cron sweeps rows older than a week.
- The fleet cap holds the key to about $4 a day.
- The key is the secret `JEV_API_KEY` (`wrangler secret put JEV_API_KEY`,
  also with `--env production`). Without it the route answers 503
  `jev_unavailable`, and the brain uses its built-in rules.
- Logs: `jev_bonus_request` with status, reason, TypeSafe's status, token
  counts and duration, never the question or the answer. Failures ADE must fix
  are Sentry issues, one per reason.

## ADE Cloud timed wakes and event wakes

A sleeping ADE Cloud computer is frozen, so its timers (a chat's scheduled
wake-up, an automation's cron) can't fire there.

**Timed wakes** (`src/cloudWake.ts`, `cloud_wakes`). Before its ADE lets it
sleep, the computer sends its next time, and the minute cron wakes it two
minutes early.

- `PUT /cloud/wake` `{instanceId, url, at}` (account bearer) records the
  computer's one row. `url` must be its own `https://<slug>.agent37.app`
  origin; `at` is within 32 days; 50 computers per account at most.
  `DELETE /cloud/wake` `{instanceId}` forgets it.
- The cron sends a plain GET to `url`. Any answer, a 502 too, wakes the
  computer, so this Worker holds no ADE Cloud key. The row reads `waking` at
  once (`cloud.timed_wake_recorded`). A woken row goes; one that didn't
  answer is retried each minute for 30 minutes.

**Event wakes** (`src/cloud/eventWakes.ts`, migration `0040`):

- `PUT /cloud/instances/:id/event-wakes {topics}` replaces the computer's
  topics: at most 20, each `linear-org:<id>`, `linear-account:<id>` or
  `hooks-account:<id>`. An account topic must name the caller's own user id
  (else 400). `[]` clears it. Another account's computer answers 404.
- `POST /cloud/internal/event-wake {topic}` comes from the webhook relay with
  `x-ade-event-wake-secret` (`CLOUD_EVENT_WAKE_SECRET`, constant-time, before
  auth; unset 503, wrong 404). It skips awake computers and ones the idle
  cleanup claimed in the last 20 minutes, wakes each at most once in 5
  minutes under the normal wake checks, and answers `{subscribed, woken}`.

## ADE Cloud account

The server holds the provider key and owns every ADE Cloud computer
(`src/cloud/`, migration `0018_cloud_account.sql`, secret `AGENT37_API_KEY`).
`src/cloud/contract.ts` lists the routes and shapes. Every route takes the
account bearer. The plan rules, hours, disk and cleanups are in
[ADE Cloud](../../docs/features/ade-cloud/README.md).

| Route | What it does |
| --- | --- |
| `GET /cloud/access` | `{ enabled }`; a blocked account gets `{ enabled: false, readOnly: true, reason }` |
| `GET /cloud/account` | Plan, hours, disk, billing notice, `blocked` |
| `GET/POST /cloud/instances` | The account's computers (`idleSaving` while an idle save runs; a 5-second Cache API copy of the provider's list, skipped after a change of the account's rows), or a create |
| `POST /cloud/instances/:id/<action>` | `sleep`, `idle` (the brain asks to sleep; `{backupReportId}` rests it with that lane backup report), `start` (every wake is use; none at 0 hours), `stop`, `update`, `booted`, `keep`, `resize`, `fork`, `exec`, `disk-usage`, `cpu-report`, `backups`, `signed-url`, `public-ports`, `sign-ins`, and `use` (a person's use during the idle save, `last_active_at`; 409 `computer_deleting` once the delete runs). `PUT` `auto-sleep`, `name`, `metadata` |
| `GET /cloud/instances/:id/update-check` | Whether the computer is behind its channel's image |
| `PUT /cloud/instances/:id/event-wakes`, `PUT/DELETE /cloud/wake` | [Timed wakes and event wakes](#ade-cloud-timed-wakes-and-event-wakes) |
| `/cloud/instances/:id/messages…`, `/cloud/chats…`, `/cloud/sessions…`, `/cloud/git…`, `/cloud/capsules…`, `/cloud/backups…`, `/cloud/projects/overview` | [Saved copies](#saved-chats-and-other-saved-copies) and [the queue](#the-message-queue-of-an-existing-chat-or-cli) |
| `/cloud/launches…`, `/cloud/sign-ins…`, `/cloud/models` | [Launches](#launches-from-the-web-and-the-phone) |
| `POST /cloud/billing/{checkout,portal,extra-hours,plan-cleanup,free-unlock}` | [Payments](#payments) |
| `GET /cloud/referrals`, `POST /cloud/referrals/redeem` | Referral summary and invite redeem |
| `GET /cloud/lanes/without-computer`, `POST /cloud/projects/computers/delete`, `/cloud/automations…` | Kept lanes, a project's computers (with `dryRun`), automations whose home is ADE Cloud |

- `cloud_computers` records each computer's owner. A call for another
  account's or an unknown instance id is 404.
- Every wake, start, send and create refusal is `{ code, message }` from
  `CLOUD_REFUSAL_CODES`. Clients show `message`. `computer_limit` adds
  `CloudComputerLimitDetail` (`planId`, `limit`, `total`, `lanes`,
  `nextPlan`) flat on the error.
- A create ignores the client's template and uses the channel's image in
  `cloud_settings` (an exact `ade@N`). Sizes are the eight in
  `src/cloud/plans.ts`; disk is 4 GB on create (or the repository's
  remembered setup disk), and grows to the size's `diskMaxGb`: there is no
  account-wide disk and no extra disk (Pricing v2). Each plan allows a
  number of computers (`computerLimit`: Free 2, Plus 3, Pro 10, Max 20);
  asleep ones count. `reserveComputer` counts them in its one conditional
  insert (pending reservations until they time out; a move's pair once), so
  concurrent creates can't pass the limit; past it, 403 `computer_limit`. A
  move's own count leaves its source out, so a move at the limit goes; another
  running move's source counts (it can outlive its move), so two moves at once
  can't leave the account over, and an account over its plan gets
  `over_plan_limits` for a move as for a create. About 25 may be awake at once
  (`AWAKE_COMPUTER_CAP`).
- An outside agent (ADE MCP: lane metadata `ade_made_by_agent: "mcp"`, a
  launch's `madeBy.agent: "mcp"`, or `origin: "mcp"` on a copy, move, start or
  sent message) on the free plan (`past_due` included) is refused with 403
  `outside_agent_free_plan`.
- Every delete writes `cloud_delete_log` (after it reads the provider's
  history); every power change writes `cloud_power_log`.

**The minute cron:**

- It reads the provider's list once when a computer exists, and writes only on
  change. Hours settle when an awake stretch ends; live hours add the open
  stretches. Hours are integer thousandths of a Medium-hour, and a Small
  computer uses none (`usesHours`; migration `0052_pricing_v2.sql` converted
  the stored numbers from Small-hours). Free accounts
  reset on the 1st UTC; paid accounts follow Stripe's `period_end`
  (`applyCloudPlanChange` is the one place a plan changes).
- At 0 hours with extra hours off, it runs
  `ade cloud prepare-stop --timeout 40 --json` on each awake computer that
  uses hours (every computer on an account with no free plan:
  `free_refused_at` or `free_github_hold`; Small keeps running otherwise) (it
  stops the agents and saves the chats and each lane's backup), then stops
  it (409 retries; 400 is cold storage and stays). When that save's report
  is current, the computer rests with it (`backup_rest_at`). Every start and
  create of a size that uses hours is refused; no wake is free. Those
  computers' timed wakes are dropped; Small's stay.
- It sleeps an awake computer with no check-in for 10 minutes.
- Daily after 02:00 UTC, it corrects each computer-day to the provider's
  `awake_minutes` and alerts the owner to unexplained minutes. Every 10
  minutes it checks the wallet (`$15` floor, top-up) and the provider's awake
  limit (80%).

**Email** (`src/cloud/email.ts`) goes through Resend (`RESEND_API_KEY`) to the
address from Clerk (`CLERK_SECRET_KEY`); owner alerts go to
`CLOUD_ALERT_EMAIL`. A skipped email logs `cloud.email_skipped` (warn) with
`no_resend_key`, `no_clerk_key`, `no_recipient` or `no_alert_address`. No
email log line has the subject or a lane name.

**The day-2 getting-started email** (`src/welcomeEmail.ts`, migration
`0053_welcome_emails.sql`). Clerk's `user.created` webhook writes one
`welcome_emails` row per new account (none for an internal one), due a day
after sign-up. At minute 4 of every ten the cron sends up to 20 due rows:
`start` when the account has no machine in the directory and no ADE Cloud
computer (two ways in: ADE in the browser on ADE Cloud, free with unlimited
Small computers, or the desktop app), `first_chat` (steps 1 and 2
shown done) when it has either. A row ends once, as `sent`,
`failed`, or `skipped_*`. A Clerk or Resend answer a later try can change
(Clerk unreachable or not 404; Resend 401, 403, 429 or 5xx) frees the claim
for the next run, up to three tries; another Resend 4xx fails at once, and
Resend's 409 (the same idempotency key after a lost answer) counts as sent.
Each retry and each `failed` is a Sentry warning (`welcome_email.retrying`,
`welcome_email.failed`, closed code only). The skips are `opted_out`,
`no_account` (Clerk's 404), `internal` (flagged since sign-up), `no_address`, or
`stale` (more than two days past due, so a late webhook never says
"yesterday" a week later). A claim keeps overlapping ticks from both sending,
and Resend's `Idempotency-Key` is the row's. A sent email is one
`ade_welcome_email_sent` PostHog event; its links carry
`utm_campaign=welcome_day2`. Every email has an unsubscribe link and the
RFC 8058 one-click headers: `GET /email/unsubscribe?u=&t=` shows a button and
only `POST` writes `email_opt_outs`; `t` is an HMAC of the user id under a key
derived from `CLOUD_CHAT_MASTER_KEY`. `user.deleted` removes both rows. It
needs `RESEND_API_KEY`, `CLERK_SECRET_KEY`, `CLOUD_CHAT_MASTER_KEY` (without
it a link could be forged from the development constant, so the unsubscribe
route answers 503 too) and `BILLING_RETURN_ORIGIN`; without one, due rows
wait (`welcome_email.waiting`, warn) and later end as stale. `WELCOME_EMAILS=0` stops sends. Log lines carry the outcome and the
variant only.

### The ADE Cloud iPhone

An iOS Simulator in the cloud, one per account, run by NoMac or Revyl and
driven from any machine with `ade apple` (`src/cloud/phones.ts` for the rows,
credits, access and routes; one provider record each in `phoneNomac.ts` and
`phoneRevyl.ts` behind `phoneProvider.ts`; which provider (lock, router,
failover) in `phoneRoute.ts`; Revyl's viewer page in
`phoneViewerPage.ts`; the owner's beta list in `phoneBeta.ts`; migrations `0047_cloud_phone_beta.sql`,
`0048_cloud_phone_usage.sql` and `0057_cloud_phone_provider.sql`, shapes in
`contract.ts`). The owner sets each beta email to `nomac` or `revyl` (a lock:
only that provider, never a fallback; refused when it can't start or lacks
what the command needs) or `both` (the router: `CLOUD_PHONE_PROVIDER` first,
default NoMac, then the other, keeping providers that can start, that the
client lists in the start's `providers`, and that have every ability in the
start's `needs`; a failed start moves on). Revyl starts phones only with the
owner's switch `CLOUD_PHONE_REVYL=on`. Each phone row keeps the provider it
started on, and a Revyl phone is still read and stopped with the switch off.
No answer names a provider; what differs is `abilities`. Without a tester's
pick, a free plan's phone is NoMac's alone (a refusal answers 503 `phone_busy`
with the paid plans' line) and a paid plan's falls back to Revyl, up to what
the plan itself costs each period at Revyl's rate (`revylLimitMicros`: about
80 minutes on Plus, 330 on Pro, 830 on Max; the phone's `stop_at` stops at
it). Past that, a paid plan's phone is NoMac's alone and a refusal is the same
`phone_busy` without the upgrade line. The limit is internal: no answer names
it. The daily cost report lists paid iPhone minutes and Revyl's share. Who may use it is the
var `CLOUD_PHONE_ACCESS`: `beta` (the default: only accounts the owner adds;
everyone else reads `off`, and a start answers 403 `phone_not_on_account`),
`all`, or `off`. `CLOUD_PHONES_PAUSED=1` refuses
new phones (503 `phone_paused`) while running ones finish. The launch plan is
`docs/plans/ade-cloud-iphone-launch.md`.

- `GET /cloud/phone` answers `CloudPhoneState`: `access` (`on` or `off`; older
  servers sent `soon`),
  `minutes` (what the credits run the phone for this period: `left`, `used`), the live `phone`, and `abilities` (the live phone's,
  or what a new one could have). `POST /cloud/phone`
  `{ device?, providers?, needs? }` starts the account's phone (or answers its live one).
  `providers` lists the providers the client drives (`["nomac", "revyl"]`);
  a client that sends none (older brains) only ever gets NoMac. A NoMac phone
  comes with a token for that phone (sent again, a fresh one); a Revyl phone's
  token is empty, and the brain calls it through `POST /cloud/phone/call`.
  409 `phone_lacks` when the live phone lacks a need, `phone_cant` when no
  allowed phone has it, `phone_starting` while another start of the account
  runs. 503 `phone_unavailable` while a live phone can't be read, and while a
  start whose answer was lost (a timeout, a 5xx) may still be bringing a phone
  up at a provider this start can't use: for 15 minutes the next starts go to
  that provider alone, which finds the phone (`heldToUnsureStart`).
  `DELETE /cloud/phone` stops it.
- `POST /cloud/phone/view` `{ control? }` answers a view link for it: NoMac's
  page (signed for the account when `NOMAC_EMBED_SECRET` is set), or for a
  Revyl phone `GET /cloud/phone/viewer` (no sign-in; the page is static) with
  the stream and input links after `#`.
- `POST /cloud/phone/call` `{ action, body?, query? }` (Revyl phones only, which
  have no per-phone token): one call to the account's live phone, Revyl's answer
  passed back as it is. `proxy.<name>` is an allowlisted device call;
  `build.upload_url|start|status|logs|install` build the brain's packed source
  (or a prebuilt `.app`) on Revyl's runners into the workspace's app.
- The phone draws from the account's credits at one a minute (`credits.ts`):
  the plan's, then earned ones, then any minute while extra credits (the
  extra-hours switch) are on. Each phone is a `cloud_phones` row (label
  `ade:<userId>` at NoMac), settled by NoMac's webhook and by the ten-minute
  check, which also reads live phones again and sends the credit balance's
  warnings to accounts that used the phone. A settled phone's minutes go into
  `used_milli`. Rows from before credits (`credits = 0`) are history only and
  charge nothing. The account read (`CloudAccountState.phone`) comes from D1
  only.
- Out of credits with extra credits off: a start answers 402
  `phone_credits_out`, and a running phone stops. A NoMac phone starts with
  NoMac's spend cap and time limit set to what the account may still use, so
  it stops by itself there. A Revyl phone has no limit of its own: the Worker
  writes its `stop_at` at the start and the minute tick stops it.
- `GET /cloud/instances/:id/status` (`src/cloud/computerStatus.ts`,
  migration `0050_cloud_computer_status.sql`): a lane computer's status menu,
  read when it opens and kept 15 seconds. Up since (the provider webhook's
  change to running, else the tick's), the brain's last word on its work
  (`POST /cloud/instances/:id/activity`: working or idle, when it sleeps,
  running agents; sent when that changes, never on a timer), restarts since
  then, the memory verdict and the disk, from the provider's logs and
  metrics. Nothing here wakes the computer.
- `POST /cloud/agent37/webhook`: the provider's signed `instance.status.updated`
  deliveries (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
  `webhook-signature`, refused past 5 minutes), checked against
  `AGENT37_WEBHOOK_SECRET`. Each `webhook-id` is kept once, for the account's
  computers only, in `cloud_instance_events` (14 days per computer); readers
  order by the change's own time, so out-of-order deliveries are fine. A
  change to running also keeps the provider's restart count. Register it once
  with `node scripts/register-agent37-webhook.mjs https://<worker-origin>`
  (needs `AGENT37_API_KEY` in the shell; prints the secret once), then
  `npx wrangler secret put AGENT37_WEBHOOK_SECRET [--env production]`.
- `POST /cloud/nomac/webhook`: NoMac's deliveries, checked against
  `NOMAC_WEBHOOK_SECRET` (`nomac-signature`, refused past 5 minutes), each id
  taken once. `phone.*` settle a phone; `credit.low` emails the owner.
  Make the webhook at NoMac with `phone.ready`, `phone.ended` and `credit.low`.
- Secrets: `NOMAC_API_KEY` (`nmk_…`), `NOMAC_WEBHOOK_SECRET`, and optional
  `NOMAC_EMBED_SECRET` (`nme_…`) for NoMac; `REVYL_PARTNER_API_KEY` for Revyl,
  which makes one workspace per account (`ade-<userId>`, a synthetic
  `revyl+<hash>@ade-app.dev` owner, `cloud_phone_revyl`) and mints short
  session credentials kept in memory only; deleting the account disconnects
  it. With neither key set the read answers `off` and the other phone routes
  503. The account key stays in this Worker; a brain gets a token for one phone (2 hours)
  that cannot start, list or stop phones. Apply
  `0047_cloud_phone_beta.sql`, `0048_cloud_phone_usage.sql` and
  `0057_cloud_phone_provider.sql` before the Worker that reads them deploys.
- The owner adds accounts with `POST /cloud/owner/phone-beta`, below.

### Payments

`src/cloud/billing.ts` sells the plans through Stripe Managed Payments.

- Configuration (from `scripts/stripe-setup.mjs`): secrets
  `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; vars `STRIPE_PLAN_PRICE_ID`,
  `STRIPE_PRO_PRICE_ID`, `STRIPE_MAX_PRICE_ID`,
  `STRIPE_EXTRA_HOURS_{PLUS,PRO,MAX}_PRICE_ID` (flat, one meter; the older
  `STRIPE_EXTRA_HOURS_PRICE_ID` serves older subscriptions until renewal),
  and `STRIPE_METER_EVENT` (4¢ a Medium-hour on every plan). Extra disk is
  no longer sold: `STRIPE_DISK_PRICE_ID` and `STRIPE_DISK_METER_EVENT` are
  unread, and `POST /cloud/billing/extra-disk` is a 404.
- Each plan and add-on is its own product, so Checkout names each line. The
  customer gets the account's email from Clerk.
- Checkout, the portal and free-unlock answer a URL; Stripe returns to
  `/billing/return`. With `returnTo: "web"`, it returns to this server's own
  `WEB_CLIENT_ORIGIN` at `/?cloudReturn=<outcome>`, never an address from the
  request. Any other `returnTo` is 400. `extra-hours` takes `{ enabled }`,
  paid plans only.
- `POST /webhooks/stripe` checks the signature, not a bearer. Production
  (`SENTRY_ENVIRONMENT=production`) drops `livemode: false` events with a 200.
  `cloud_stripe_events` runs each event once, and a handler re-reads the
  subscription, so event order does not matter.
- Checkout sets the plan, then adds the $5 threshold. `invoice.paid` for a
  renewal starts fresh hours; `active` again restores from `past_due`. A
  failed payment moves the account to free rules with extra hours off, an
  email and `billing.notice`.
- Each tick reports every whole extra Medium-hour as one meter event, keyed by
  the hour's place in the period, so a retry never counts twice.

### ADE Cloud safety

Anti-spam and fast owner alerts, not usage limits (`src/cloud/blocks.ts`,
`src/cloud/safety.ts`, migration `0037_cloud_safety.sql`). The free plan is
50 hours (Medium-hours; Small is unlimited) and 2 computers with the GitHub rules (`freePlanGithub.ts`: a GitHub account at
least 30 days old, one free plan per GitHub account).

- **Kill switch.** `CLOUD_CREATES_PAUSED=1` refuses every new computer, copy
  and launch start with 503 `creates_paused`. Existing computers keep working.
  A repeated start of an existing launch is never refused.
- **Block list** (`cloud_blocks`: `user_id`, `github_user_id`,
  `card_fingerprint`, `reason`, `created_at`). The owner routes take
  `Bearer <CLOUD_OWNER_TOKEN>` (unset 503), never an account bearer.
  - `POST /cloud/owner/block {userId, reason}` sets each computer to the
    provider's `deny-all` network policy, stops it, deletes its timed wakes,
    cancels the subscription at once (`prorate=false`, `invoice_now=false`),
    and lists its GitHub id and cards. `{githubUserId}` or `{cardFingerprint}`
    blocks an identity alone. It is safe to repeat.
  - `POST /cloud/owner/unblock` with the same keys gives back `allow-all`; the
    computers stay stopped. An identity unblock never unblocks an account.
  - The minute tick stops any running computer of a blocked account and sets
    `deny-all` again where it didn't land (`network_denied_at`; stopped ones
    hourly, `network_deny_tried_at`; 10 a tick). A start, update, resize, exec
    wake, sign-in start or `PUT /cloud/wake` reads the block fresh, not the
    30-second cache.
  - A blocked account is read-only: the GET routes in
    `CLOUD_BLOCKED_READ_ROUTES` (`blockedMayRead` in `routes.ts`) work, among
    them `/cloud/chats`, `/cloud/sessions`, `/cloud/git`, `/cloud/limits`,
    `/cloud/account-secrets` and `/cloud/cto`. Every other `/cloud/*` route
    answers 403 `account_blocked`. `GET /cloud/account` carries
    `blocked: true`.
  - A blocked GitHub account on a new ADE account reads as `github_used`; a
    blocked card can't unlock free hours. Both alert the owner.
- **The account test tool and instant switches.** `POST /cloud/owner/account`
  `{ email | userId, plan?, computers?, hours?, phone?, days?, note?, tester?, reset? }`
  and `POST /cloud/owner/settings` `{ key?, value?, note? }`
  (`ownerAccounts.ts`, `settings.ts`, migration 0056; script
  `scripts/cloud-owner.mjs`; guide `docs/features/ade-cloud/account-test-tool.md`).
  A test plan changes limits, hours, cards and Small's rate, never billing,
  and ends at `test_until` (minute tick). The iPhone draws from the credits
  in force, so `hours` reaches it too; `phone` sets the account's place on
  the iPhone beta list.
  Every change goes to `cloud_owner_log`.
- **The iPhone beta list.** `POST /cloud/owner/phone-beta` `{ "email": "…" }`
  or `{ "userId": "user_…" }` adds an account (an email is looked up in Clerk
  once; the row keeps the id, and the address for the owner's reading). An
  email Clerk doesn't know yet waits in `cloud_phone_beta_pending` (answer
  `pending: true`); the account that first appears with it as a verified
  address takes it (`claimPhoneBetaInvite`, `cloud.phone_beta_claimed`).
  `{ …, "enabled": false }` removes it (a waiting email too), and `{}` lists
  the rows (with the server's provider and each row's) and the waiting emails
  (`pending`). `"provider": "nomac" | "revyl" | null` with an add sets that
  tester's provider (null: the server's). See "The ADE Cloud iPhone".
- **One card, one free unlock** (`cloud_free_card_claims`, unique on the
  fingerprint). The free-unlock Checkout takes cards only, asks for 3D Secure
  (`request_three_d_secure=any`), and the webhook reads the fingerprint from
  the SetupIntent. A used or blocked card is refused, detached from the
  customer, and alerts the owner. Paid plans take any card.
- **Rate limits.** 10 new computers an hour per account (creates, moves,
  copies, launches, automations) and 15 launch starts an hour. Over it: 429
  `rate_limited`.
- **The owner's cap counts free use only.** `owner_cost_limit_usd` is compared
  with this month's free-rules cost (`free_cost_mtd_micros`; each stretch
  stamps `cloud_computer_days.free_cost_micros` and `cloud_disk_days.free`). A
  disk-day is free only if the account was on free rules at every write that
  day. At the cap, free accounts get no new computer, copy or disk grow (503,
  no reason given); paid accounts are never refused. The backfill `update`s at
  the end of `migrations/0037_cloud_safety.sql` are safe to run again.
- **Owner alerts, at once** (`sendOwnerAlert` to `CLOUD_ALERT_EMAIL`).
  `cloud_owner_alerts` keys each event, so one event sends one email (a failed
  send gives the key back). Each names the account, plan, ages, GitHub login,
  reason, counts and the `curl` that blocks it. The alerts:
  - a sign-up burst from one hashed IP (`SIGNUP_BURST_PER_IP_HOUR`, on each
    Clerk `user.created`)
  - free use at 50%, 80% and 100% of the cap (once each a month per cap value)
  - a card used again for a free unlock
  - a blocked GitHub account or card on a new account
- **Logging.** `reportCloudAbuse` (`store.ts`) logs, sends a Sentry error each
  time (`area: cloud-abuse`) and writes `cloud_abuse_events`. PostHog
  `ade_cloud_safety` records `first_chat` (`cloud_accounts.first_chat_at`),
  cap steps, refusals, blocks, rate limits, kill-switch refusals and sign-up
  bursts.
- **The month's cost.** Every 10 minutes `costReport.ts` estimates
  `cost_mtd_micros` and `free_cost_mtd_micros` at the provider's prices. Each
  time the estimate passes another $50 (`OWNER_COST_STEP_USD`), the owner gets
  one email with the top three accounts (`owner_cost_step_alert`, a
  conditional claim before the send).
- **The daily run** writes `cloud_account_days` (cost and income per
  account), raises alarms (a paid account that costs more than it pays, a
  free one past $3 a month, a day at twice the week's mean), and emails the
  owner the daily report.

## Launches from the web and the phone

A person with no computer of their own starts a chat on ADE Cloud straight
from the web (`app.ade-app.dev`) or the phone (`src/cloud/launches.ts`,
migration 0038, shapes in `src/cloud/contract.ts`). Every route takes the
account token (a Clerk session token or the ADE OAuth token) and the
`/cloud/*` CORS rule: the web client's exact origin, `GET, POST, PUT, DELETE`,
headers `authorization, content-type`.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /cloud/launches` | web, phone, desktop | Starts a launch (`CloudLaunchStartRequest`). `project` may be `{ accountProjectId }`; `lane` and `sizeId` may be left out (a new lane named from the first message, Small). |
| `GET /cloud/launches?active=1` | web, phone | The caller's launches still in progress, and the ones that failed in the last day, newest first, at most 50 (`CloudLaunchList`). |
| `GET /cloud/launches/:id/messages` | web, phone, the computer | The launch's messages in order. Row 1 is the first message. |
| `POST /cloud/launches/:id/messages` | web, phone | Queues a message while the chat doesn't exist yet (`{ messageId, text }`). The same id answers the same message. 409 `chat_ready` once it exists. |
| `POST /cloud/launches/:id/messages/:msg/claim` | the computer | Takes one queued message to send (`{ claimId }`). 409 `message_taken` otherwise. |
| `PUT /cloud/launches/:id/messages/:msg` | the computer | Says the claimed message was sent, or not. |
| `GET /cloud/sign-ins` | web | What the account vault holds for ADE Cloud: saved or not, never a value. |
| `PUT /cloud/sign-ins/:id` | web | Saves a key (`{ key }`) to the account vault; for `claude`, a Claude pass (`sk-ant-oat…`). |
| `DELETE /cloud/sign-ins/:id` | web | Removes it (for `claude`, every pass). |
| `GET /cloud/models` | web, phone | Models per provider with a default, for a picker before any computer exists. |

The launch flow (files, start, Git check, join, run, sign-in, queued
messages, continue) is in
[ADE Cloud › the server launcher](../../docs/features/ade-cloud/README.md#a-new-lane-with-no-computer-of-your-own-the-server-launcher).
The server's own rules:

| Topic | Rule |
| --- | --- |
| Queued launch messages | The first message (`chat.prompt`, id `chat.messageId` or the launch id) is row 1, stored with the launch. Later sends are rows 2 and on, at most 20 before the chat starts. The text is plain in D1, like `request_json`. A claim is one conditional write, written before the send; only its claim id finishes it. A send the computer can't confirm is reported failed, never sent twice. |
| Continue launches | `continueChat { machineKey, chatId, kind?: "chat" \| "cli" }`. One active launch per lane and chat (`cloud_launches_continue`); a second start answers the running one. For a CLI the agent comes from the tool type and `modelId` is "". The end of a launch fails its queued messages, but `delivered` stays (`chatMessagesDeliveredStatement`). A Retry answers 409 `computer_busy` while a newer launch continues the chat. |
| Sign-in on the computer | `waiting_for_sign_in` with `signIn` (`CloudLaunchSignIn`): a device code, `url_paste` (to `POST /cloud/instances/:id/sign-ins/:job/code`), `api_key` (`PUT /cloud/sign-ins/:id`) or `desktop`. Claude is `url_paste` (`claude setup-token`; the pass goes to the vault). Cursor, OpenCode and Pi read account keys; Antigravity and Qwen sign in only on the desktop (`CLOUD_REMOTE_SIGN_IN`). The computer waits 30 minutes; the cron ends the launch at 45 and deletes its computer. |
| Clone check | Before a create: a vault Git credential or the GitHub App sign-in (one `GET /repos/{owner}/{repo}`). App connected but not installed for a private repository: 403 `github_app_not_installed` with `installUrl`. A public repository goes on. |
| The sign-ins route | The web's path to the vault on the push relay, through the `ACTIVITY_RELAY` binding with the caller's own bearer, so it reaches only the caller's vault (`integration/cloud-key-<id>`, `provider_login/claude-pass/<hex>`). A value passes through memory only. |

## Saved chats and other saved copies

ADE Cloud computers can't answer while asleep, stopped, out of hours or
deleted. So each computer saves here what a person reads, and every client
reads it with no wake. The R2 bucket behind `CLOUD_CHATS` holds all of it
under the prefixes `chats/`, `sessions/`, `capsules/` and `backups/`.

- **Sealing** (`src/cloud/seal.ts`): AES-GCM with one random key per user.
  That key is sealed with `CLOUD_CHAT_MASTER_KEY` and kept in D1, apart from
  the data. The additional data names the row, so a copy can not move to
  another row. Platform encryption, not end-to-end. List text (title, lane
  name, status, model) is sealed too; only ids the lists filter on are plain.
- **Owner checks.** Only a computer the account owns writes (the body
  `instanceId` or the `x-ade-instance` header). Every read checks the owner:
  another account's id answers 404.

| Route | What it holds | Caps |
| --- | --- | --- |
| `GET/PUT/DELETE /cloud/chats[/:m/:c]` (`chats.ts`) | Saved chats, one R2 object per part. Parts append by sequence and every upload can be replayed: the same part answers 200, the newest part may be resent with more text, anything else is `409 sequence_conflict` and the computer starts that chat over. Each part carries the chat's row; its `settings` (model, preset, thinking level, Fast, access modes; `cloudChatRowSettingsOf` keeps only known fields) are sealed in the summary and come back on the row, so a client shows them while the computer rests. | 8 MiB a part; 2 GiB an account (`cloud.chat_account_full`) |
| `POST /cloud/chats/:m/:c/move` (`chats.ts`) | From the new computer after a continue: the D1 row takes the new machine key and keeps its R2 key, so old parts stay readable. It records `forked_from_*`, deletes the old capsule, and moves the queued messages. A GET of the old key finds the moved row; a PUT to it answers 409. The same move again answers `moved: false`. | |
| `GET/PUT/DELETE /cloud/sessions[/:m/:s]` (`sessionCopies.ts`) | CLI and shell copies, one sealed object each. A shell keeps its last 5,000 lines. | 2 MiB a copy; 512 MiB an account; 50 copies a computer |
| `GET/PUT /cloud/git/:m/:lane` (`gitSummaries.ts`) | One sealed Git summary per lane. A PUT with an older `checkedAt` answers `kept: false`. | |
| `PUT /cloud/capsules/:m/:c/parts/:n`, `POST .../commit`, `GET` (`forkCapsules.ts`) | A provider's native history for a continue on a new computer. Part 1 starts a new upload; parts come in order (409 `capsule_out_of_order`). The commit checks each part and deletes the old parts. | 6 MiB a part; 20 MiB a capsule; 1 GiB an account |
| `/cloud/backups[/:m/:lane[/...]]` (`laneBackups.ts`) | One lane backup per lane and machine key: the lane's work that is not on GitHub (a sealed git bundle and a sealed patch). An upload goes to its own prefix (`backups/<user>/<m>/<lane>/<upload>/`) and replaces the row only at its commit, so the old backup stays whole until then. Only a computer whose machine key is `:m` writes. A browser (`Origin`) gets the list, the manifest and the patch, never the bundle, and writes nothing. `POST /cloud/backups/report` records the computer's state after each save. | 6 MiB a part; 50 MiB a lane (bundle and patch); 1 GiB an account (413 `backup_too_large`, `backup_account_full`, with the sentence) |
| `GET /cloud/projects/overview?origin=` (`projectOverview.ts`) | One project's view: computers, lanes without a computer, the first 50 chats, 100 sessions and the Git summaries. One fixed set of indexed reads, no provider call. | |

Deleting a computer keeps its copies. Deleting a chat removes its parts,
messages and capsule. Deleting a lane removes its sessions, capsules and Git
summaries, and its backups (`DELETE /cloud/instances/:id` with no `keepLane`,
or `DELETE /cloud/lanes/without-computer/:lane`). A computer deletes the
backup of a lane whose work is all on GitHub, with every backup of that lane
it restored. Deleting the account (Clerk `user.deleted`) removes the R2
prefixes, the rows and the user key.

**Lane backups and cleanups.** A cleanup (idle, plan, project delete, the
end of an automation run) never starts a computer. A resting computer goes
only when it rested right after a backup report that saved every lane:
its own idle sleep names the report (`POST .../idle {backupReportId}`), or
the 0-hours stop follows a prepare-stop whose report is current. Any start
clears that. Else it stays with "ADE couldn't save this lane's work." and the
lanes' reasons. An awake computer is saved in place first (`prepare-stop`,
then `save-for-rest --capsules`). Nothing is committed or pushed. Every
delete but the idle cleanup runs `prepare-stop --for-delete`: from that
prepare until the delete, the computer refuses new turns, terminals and
remote work, so nothing written after the save is lost. When the server
keeps the computer after all, it runs `ade cloud unfreeze`; the freeze also
ends on its own after 10 minutes.

Migrations `0039_cloud_no_computer.sql` and `0044_cloud_lane_backups.sql`. The bucket and
`CLOUD_CHAT_MASTER_KEY` are in [Cloudflare deployment](#cloudflare-deployment).

## The message queue of an existing chat or CLI

A send to a chat or CLI whose computer rests or is gone goes here
(`src/cloud/chatMessages.ts`, migration `0039`).

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /cloud/chats/:m/:c/messages` | web, phone, desktop | Queues `{ messageId, text, attachments?, provider?, modelId? }`. `messageId` is the client's `clientSendId`; the same id answers the same row and wakes nothing. A CLI session copy's id takes the chat id's place; a shell answers 404. |
| `GET /cloud/chats/:m/:c/messages` | web, phone, desktop | The chat's messages, open ones first, at most 50. |
| `DELETE /cloud/chats/:m/:c/messages/:msg` | web, phone, desktop | Takes back a queued message. Any other state answers 409 `message_taken`. |
| `GET /cloud/instances/:id/messages` | the computer | Its queued messages, each with `targetKind` (`chat` or `cli`). |
| `POST /cloud/instances/:id/messages/:msg/claim` | the computer | Takes one message with `{ claimId }` in one conditional update. |
| `PUT /cloud/instances/:id/messages/:msg` | the computer | Reports `delivered` or `failed`. Only the claim that took the message can report; a final state stays final. |

- **The checks.** The wake checks run before the insert, so a refusal stores
  nothing: blocked, hours and disk (`wakeBlocker`), `update_in_progress`,
  `update_needed` (a computer whose boot report did not list `chat_queue`; the
  client then wakes it and sends), `plan_past_due`, the awake cap (a 12 s wait), and the
  idle cleanup.
- **The wake.** In `waitUntil`, the server starts an asleep computer and runs
  `ade cloud messages drain --json` there over exec (120 s). The booted route
  stores the computer's `ade_version` and `features` (`ade_features`).
- **A deleted computer.** The send starts a server launch with `continueChat
  { machineKey, chatId, kind }` on the old lane and branch and answers
  `wake.state: "launching"` with the `launchId`. The row is inserted only
  after the launch answers, with `via_launch = 1`, and reads its state from
  the launch's message. A second send while that launch runs joins it.
- **Caps.** 60 sends a minute per account (429 `rate_limited`), 20 open
  messages a chat and 200 an account (429 `too_many_messages`), 100,000
  characters of text. An attachment must already be in R2 at
  `launches/<user>/<launchId>/<fileId>`.
- **The sweep.** The minute cron runs `expireChatMessages` first, before the
  provider key check: it settles `via_launch` rows from their launch, fails
  queued messages after 24 hours, and prunes final rows after 7 days, in
  batches of 200.
- **A move.** While a server move of the chat's computer runs (`moves.ts`,
  from `make` to `register`), a send is stored for the old computer, wakes
  nothing and answers `wake.state: "moving"`; the old computer's list and
  claim leave it out (`MOVE_HOLDS_MESSAGES_SQL`). `register` gives the queued
  messages the new computer's instance id (their chat address stays) and runs
  a detached drain there; one the old computer had claimed ends failed (it
  may have reached the chat). A send after that, and after the move, follows
  the move to the new computer (`moveMessageRouteOf`). A failed or
  cancelled move gives them back to the old computer and asks it to drain.
  A chat with no saved copy on a moved computer still takes a message by the
  old address.
- The message text is sealed. Its additional data has no machine key, so a
  chat move keeps it readable. No log line has the text.

## Account reads for a client with no computer

These routes let the web and the phone show account data with no computer
online.

| Route | What it does | Errors |
| --- | --- | --- |
| `GET/PUT /cloud/limits` (`limits.ts`) | The agent limits from the account vault. PUT takes `{ limits, ifRevision }` and writes conditionally. | 409 `limits_changed`, `limits_unreadable` |
| `GET /cloud/account-secrets?kind=&origin=` (`accountSecrets.ts`) | Saved secret names and times, never a value. Only the kinds `secret`, `provider_api_key`, `provider_key`, `integration` and `project_secret`. | |
| `GET /cloud/cto?origin=` (`ctoCopy.ts`) | The CTO account copy (at most 1 MB decoded, notes 20,000 characters, 50 routines). | `cloud.cto_copy_unreadable` in the log |
| `POST /cloud/integrations/linear/query` (`integrations.ts`) | Fixed Linear documents only, with the account's Linear sign-in. The server renews a sign-in made with ADE's own Linear app (`linearRenewal.ts`, migration `0041`, off with `CLOUD_LINEAR_RENEWAL=0`). | 409 `linear_renewing`, `linear_needs_renewal`, `linear_not_connected` |
| `POST /cloud/integrations/jira/search`, `.../jira/issue` | Jira through the account's Jira sign-in. Only `https://<label>.atlassian.net`, no redirects, answers capped at 4 MB. | `jira_not_connected`, `jira_site_unsupported`, `integration_failed` |

The three integration routes share 30 requests a minute per account
(`cloud_request_windows`, 429 `rate_limited`). Tokens stay in memory, and the
logs carry the op name and status only.

Writes have two more minute budgets per account in the same table
(`store.ts` `takeRequest`, 429 `rate_limited`):

- `uploads`, 1,200: session copies, Git summaries, fork capsule parts and
  commits, and lane backup writes. A delete's save sends one capsule for each
  chat.
- `settings`, 120: `PUT /cloud/limits`, `PUT /cloud/instances/:id/event-wakes`
  and `PUT /account/lanes`.

## The account lane index

`GET/PUT /account/lanes` (`src/accountLanes/routes.ts`, migration `0039`)
keeps each machine's lanes (name, branch, machine, PR) so a client can offer
them as mentions with no computer awake.

- A brain's PUT replaces the lanes of one machine. The same hash does nothing.
  The caps are 500 lanes a machine and 5,000 an account. A browser PUT answers
  403; CORS allows GET only.
- GET filters by `project_id` or `project_key` and by `pr`. Each row has the
  machine name, `online` (with the cloud state), and `cloud: true` for an ADE
  Cloud computer.
- The rows go when the machine leaves the account (`dropAccountLanes`, best
  effort; a failure logs `account_lanes.machine_lanes_delete_failed`).

## Lane sharing

One account (the giver) gives another account (the receiver) limited access
to one lane on one of the giver's machines (`src/laneShares/routes.ts`,
migrations 0023–0025, shapes in `src/laneShares/contract.ts`). This Worker is
only the index and the revocation list. It holds no detailed rights, and a
grant here never opens a machine: the host keeps the rights and redeems the
guest's ticket on each guest connection. A guest's account token goes only to
the directory; a host sees a one-use ticket. The product rules are in
[Lane sharing](../../docs/features/lanes/lane-sharing.md).

**Host rules under any rights.** A guest's input reaches services written for
the owner, so the host turns off each interpretation it does for the owner:

- A guest's text is a plain prompt: no slash command, `!` line, `/side`,
  `/memory`, custom command, skill or `@chat:`-style expansion. The host
  refuses a guest message that starts with `/` or `!`
  (`lane_share_plain_text_only`): a send, a steer, a draft and its edits, a
  card answer, and the first input of a CLI session. A guest's draft goes
  only to an existing chat.
- Only the owner answers a permission or secret card (a project secret, an
  MCP server, an integration connect, the Mac real-input lease, a
  shared-desktop consent, an MCP App call) or a card kind with no mapped
  right. A guest sees "Waiting for the owner". With Decide, a guest can't
  choose "for the whole session", and approves a plan only when its return
  mode is one the owner allowed.
- A guest's thread comment goes with a send only when the owner names it, and
  the agent reads it as another person's text.
- Typing into a CLI session gives a shell's reach, so only the typing right
  allows it, and never on a Windows host. Each submitted line counts as one
  message.
- A guest reads no git-ignored file (such as `.env`) and nothing under
  `.ade/`, also through a link.
- The mode lock holds the mode a turn really runs in, from the provider's
  settings. A mode the host can't map is refused. A guest changes only a chat
  it started. With no model in the lock, a guest starts nothing.
- The host enforces the end date on every action. When a share ends, is
  revoked or left, or loses send and steer, the host removes its guest's
  unstarted queued messages.
- The host admits a guest only when its rights row names the grant's lane.
  Message and draft limits are counted in one step.
- "Hide machines" removes every device and machine name, id and platform.
  "History before the share" off removes earlier previews, summaries, goals,
  comments and subagents from every read.
- `lane_share.*` actions are user-only, except three (see the lanes doc). A
  guest's commands are a fixed list, with no runtime RPC channel. An agent can
  only list shares, make a Watch share (at most 5 an hour per machine) and
  stop one.

**The directory's rules:**

- Every route takes the account bearer and checks the caller against the row.
  A pending invite matches only an address Clerk VERIFIED for the caller, read
  on each call with `CLERK_SECRET_KEY` (without it, invitee routes answer 503).
- A grant the caller may not see answers 404, as an unknown id does.
- At most 5 guests (pending and active) per lane. An invite lasts 24 h. A
  second invite to the same address refreshes the pending one.
- Spam limits (`lane_share_invite_days`): 20 invites and re-sends per giver
  per UTC day, 5 invite emails per canonical address per day (lowercase, no
  `+tag`, no Gmail dots), 2,000 invite emails a day in all, and one email per
  invite per 10 minutes, 5 in its life.
- 120 Clerk reads per account per UTC hour. Past that, routes that need Clerk
  answer 429, and "Shared with me" leaves out pending invites.
- The invite email (Resend) names the cleaned giver name, no project or lane,
  and has only ADE's invite link. A failed send still succeeds with
  `emailSent: false`.
- The host read lists every live grant of the machine with `createdAt`, and
  once active `acceptedAt` and `receiverName` (the cleaned Clerk name stored
  at accept, `receiver_label`). The host drops a cached grant not in the list
  and uses only this name as the guest's author. `closed` lists final grants.
- `POST /lane-shares/:id/connect` gives the receiver of an ACTIVE grant the
  relay address (`wss://…/connect/<machineKey>`, never LAN or tailnet), the
  host's last report, and a one-use ticket bound to the guest's DPoP key
  (`dpopThumbprint`). The giver gets 404; a closed grant 410. The ticket is 32
  random bytes, lives 2 minutes, is stored as a hash, and a grant mints at most
  30 an hour.
- `POST /lane-shares/host/redeem` (a giver's machine only, no browser Origin)
  spends the ticket in one conditional UPDATE and answers the receiver, lane,
  DPoP key and the grant list. Every failure is the same 404. The host admits
  only a hello signed by that key.
- A revoked guest still knows the relay address, but the host drops a hello
  without a valid ticket and DPoP proof before it calls the directory.
- Clerk `user.deleted` closes every live grant given by or to the account.
- The cron writes the clock-derived states, deletes rows closed 90 days ago,
  budget rows older than a week and tickets older than an hour.

### Moving a chat to the other person

The owner, or a guest with Collaborate, can move a chat of the shared lane,
with its unpushed work, to a computer of the other person (see
[the lanes doc](../../docs/features/lanes/lane-sharing.md#moving-a-chat-to-the-other-person)).
The directory carries none of it: the move goes over the guest connection
(`laneShare.move`) and the machines' runtime actions.
`POST /lane-shares/:id/move` is different: it moves the owner's grants to
another machine of the same account.

- The receiving person consents on their own machine: refused by default, 15
  minutes, once, ended by a revoke, a leave, the share's end or a pause. One
  move at a time per share.
- The host binds each step to the guest's grant and lane (from its own role),
  the move id and the consent. No chunk moves without an accepted consent.
- Only a fixed list of fields moves; the receiver refuses any other. No
  sign-in, token, credential, provider session, environment, MCP
  configuration or secret moves.
- The bundle goes in 384 KiB chunks, at most 50 MiB, SHA-256 checked. The
  receiver runs `git bundle verify`, accepts one expected ref, fetches with
  hooks off and no submodules, and puts the work in a NEW lane on a new
  branch, in plan mode, with its own sign-ins.
- When the owner starts a move, the owner's account email goes to the guest,
  so the guest's computer can share the new lane back.

## Account projects

The account keeps a list of its projects (`src/accountProjects`, tables in
migration 0028, shapes in `src/accountProjects/contract.ts`). A project is a
GitHub repository. A copy is one folder of that repository on one machine.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /account/projects?since=<cursor>` | phone, web, brain | Projects that changed after `since`. No `since`, or an old one, gives the whole list with `reset: true`. |
| `POST /account/projects` | phone, web, brain | An explicit add. It returns the existing project when the account has it, and brings back a removed one. |
| `POST /account/projects/:id/remove` | phone, web, brain | Removes the project. The row stays as a tombstone. The machines keep their folders. |
| `PUT /account/projects/copies` | brain only | Replaces all copies of one machine in one request. A browser Origin is refused. |

Every route takes the account token, and every statement names the caller's
`user_id`. An id of another account answers 404, the same as an unknown id.

Identity rules:

- The key of a project is the host plus GitHub's numeric repository id.
  The address (`repo:github.com/owner/name`) is an alias, and one project
  has many aliases.
- An add with only an address returns the project that has that address.
- When an id arrives for an address-only row and another row has that id,
  the two rows merge. The address-only row keeps its id with `merged_into`
  set, and its aliases and copies move.
- A fork has its own id, so it is its own project.
- A removed project stays removed when a machine publishes it again. Only
  an explicit add brings it back.
- Each write plans against a snapshot and goes as one D1 batch. The batch
  first checks that the account's counter has not moved since the snapshot.
  A write that loses that check, or a race on a unique key, plans again
  (up to eight tries, with a short random wait).
- Copies are listed only for a machine that is still on the account.

Limits per account: 500 live projects, 1,000 rows (the oldest tombstones go
first, and a client with an older cursor then gets the whole list), 20
aliases per project, 200 copies per machine, 2,000 copies in all, and 256 KB
per request body. The list does not go in the push relay's account settings
(5,000 keys).

A machine does not ask on a timer. The heartbeat answer
(`POST /account/machines/register`) carries `accountProjectsCursor`, and the
machine reads the list only when that number changed. A machine publishes its
copies only when they changed. Removing a machine, or replacing its key,
deletes its copies (best effort; a failure goes to Sentry as
`account_project.machine_copies_delete_failed`). A failed cursor read leaves
the field out of the heartbeat answer and goes to Sentry as
`account_project.heartbeat_cursor_failed`. A Clerk `user.deleted` deletes
every row of the account.

## GitHub App sign-in

The account holds one ADE GitHub App sign-in (`src/githubApp`, tables in
migration 0029, shapes in `src/githubApp/contract.ts`). This Worker keeps the
refresh token sealed and renews the access token. Clients get the access
token only. The refresh token and the client secret never leave the Worker.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /github/app/sign-in` | desktop, CLI, web, phone | Starts a web-flow sign-in (state + PKCE S256) and returns the GitHub authorize URL. 10 per account per 10 minutes. |
| `GET /github/app/callback` | the browser, from GitHub | Spends the state (once, 10 minutes), exchanges the code, saves the grant. Desktop and CLI get a page; the phone gets `ade://github/connected?...`; the web gets its `returnTo`. |
| `GET /github/app/sign-in/:id` | the client that started it | `pending`, `done`, `failed` or `expired`. Another account gets 404. |
| `POST /github/app/token` | every signed-in client | The access token and `useForSec`. Renews it when due. 120 per account per hour. |
| `GET /github/app/status` | every signed-in client | Connected or not, the state, and the GitHub login. No token. |
| `DELETE /github/app/grant` | every signed-in client | Deletes the token at GitHub and the grant. |
| `POST /github/app/adopt` | machines only | Moves a machine's device-flow token to the account when the account has none. |
| `POST /github/app/retire` | machines only | Deletes a machine's old token at GitHub. Refuses the account's live token. |
| `GET /github/app/installed` | the browser | The App's Setup URL page. Ignores `installation_id`. |

Renewal with one writer:

- A served token carries `useForSec`, counted to 20 minutes before GitHub's
  expiry. A client stops 30 s before that and asks again, so all clients
  share one stop time.
- The Worker refreshes 15 s after that stop time. A request in those 45 s
  waits on the Worker for at most 15 s, then renews.
- One request takes the lease (one conditional D1 update, 45 s). The others
  read the row for up to 3 s, then answer 503 `renewing` with `retry-after`.
- `bad_refresh_token` ends the grant (409 `needs_reauth`). 429, 5xx, a
  network failure and a 200 with no token back off 1 minute, doubling to
  1 hour. Meanwhile the old token is served for a short time while it is
  safe, else 503 `github_unavailable`.
- A lease left past its time means the holder died. If GitHub had taken
  that refresh, the next one gets `bad_refresh_token` and the reason is
  `unpersisted_refresh`.
- A client that gets a 401 sends the token's SHA-256. The Worker asks GitHub
  about it at most once a minute per account and renews at once when GitHub
  no longer knows it.

The cron makes no query except at minute 17 of each hour (it deletes
sign-ins and limit rows older than a day) and at 03:17 UTC (it renews up to
50 grants whose refresh token ends within 30 days and whose access token no
client can still use). A new sign-in deletes the previous token at GitHub
(one token, never the whole authorization). A Clerk `user.deleted` deletes
the token at GitHub where it can, then every row of the account.

Secrets `GITHUB_APP_CLIENT_SECRET` and `GITHUB_APP_TOKEN_KEY` (32 bytes,
base64) turn the routes on. Without them every bearer route answers 503
`github_app_not_configured` and nothing else changes. The vars
`GITHUB_WEB_BASE_URL` and `GITHUB_API_BASE_URL` let a local run point at a
fake GitHub.

## Sign-up analytics

`POST /webhooks/clerk` takes Clerk's `user.created` and `user.deleted`
webhooks (Svix-signed with the secret `CLERK_WEBHOOK_SIGNING_SECRET`) and
sends one PostHog event each, `ade_signed_up` or `ade_account_deleted`, with
the secret-free project token `POSTHOG_PROJECT_TOKEN`. The Clerk webhook must
subscribe to both event types. The event uuid comes from the Clerk user id, so
a retry, or the weekly backfill, never makes a second copy. An account whose
Clerk private or public metadata holds `ade_internal: true` (tests, smoke
users, the team) is sent with `is_internal: true`. Details and the weekly
reconcile (`scripts/analytics/reconcile-signups.mjs`,
`.github/workflows/analytics-reconcile.yml`) are in `docs/logging.md`,
"Sign-up (server-side)".

Before its event, a `user.deleted` deletes what the account server keeps for
the account (`accountErasure.ts`: lane shares, the getting-started email,
projects, the GitHub App grant, then `cloud/accountDeletion.ts`, which ends
with the push relay's purge). The machine list and the computers' logs go too
(`forgetDeletedAccountComputers`). Some rows stay under the one-way hash
`deleted:<sha256>`: the anti-abuse claims, blocks and referrals, and the
computers' usage and cost rows for the cost report. The `cloud_accounts` row
stays under the account ID, marked deleted, so the minute cron deletes a
computer whose create was still running.

Tokens are checked offline, so a computer still signed in can write again
until its token expires (about an hour for a device sign-in). The webhook
records the account in `account_erasures` first, and the minute cron runs the
whole deletion again at 15 min, 75 min, 3 h and 24 h; the row goes after the
last run. While the row is there, a machine register call for the account
answers `403 machine_revoked`, re-pair included: the deletion also deleted the
account's revocations, and the brain stops its heartbeat on that code. The webhook relay reads that list (`GET
/cloud/internal/deleted-accounts`, secret `CLOUD_EVENT_WAKE_SECRET`) on each
cron run after the deletion and after each repeat, and purges its own rows
for each account. The privacy
policy's Retention section lists what stays; change it with this code.

## Sentry

Only `production` reports: `env.production` sets `SENTRY_ENVIRONMENT`, and
anything else (this development Worker, `wrangler dev`) is `development`,
which `src/sentry.ts` never sends. The minute cron checks in to one Sentry
cron monitor, `account-directory-cleanup` (`CLEANUP_MONITOR_CONFIG` in
`src/index.ts`); change its schedule with `triggers.crons`.

## Local checks

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run build` is a Wrangler dry run and does not deploy.

## Cloudflare deployment

Development and production are separate, so development users and heartbeats
never enter the production directory:

- Development: `https://ade-account-directory.arulsharma1028.workers.dev`
- Production: `https://ade-account-directory-production.arulsharma1028.workers.dev`
  (D1 `ade-account-directory-production`)

To set up either one:

1. Create the D1 database and put its UUID in `wrangler.jsonc`.
2. Set the Clerk values: `CLERK_JWKS_URL`, `CLERK_ISSUER`,
   `CLERK_OAUTH_CLIENT_ID` and the secret `CLERK_SECRET_KEY` (approvals, emails,
   lane share invites). Register `https://<worker-host>/device/callback` as a
   redirect URI of the Clerk OAuth application.
3. Set `WEB_CLIENT_ORIGIN` (the only cross-origin caller that may send an
   account bearer), `PUSH_RELAY_URL`, and the secret `DIRECTORY_AUTH_SECRET`
   (the same value as on the push relay).
4. Create the R2 buckets before the first deploy that binds them
   (`wrangler deploy` does not create buckets): `ade-diagnostics`,
   `ade-cloud-chats` and their `-production` copies. A missing diagnostics
   bucket only makes `/diagnostics/upload` answer `503`.
5. Give both diagnostics buckets a 30-day expiry rule. The Worker never
   deletes a report, and the 30 days are a term of the cost ceiling (90 days is
   about 18 GB, past the free tier):

   ```sh
   npx wrangler r2 bucket lifecycle add ade-diagnostics-production \
     expire-reports reports/ --expire-days 30
   ```

6. Set the ADE Cloud secrets (`npx wrangler secret put <NAME> [--env production]`;
   `wrangler.jsonc` explains each):
   - `AGENT37_API_KEY` (required for ADE Cloud).
   - `AGENT37_WEBHOOK_SECRET` (the status webhook; from
     `scripts/register-agent37-webhook.mjs`).
   - `CLOUD_CHAT_MASTER_KEY` (saved copies, the queue, the per-computer free
     plan key) and `CLOUD_LAUNCH_JOIN_KEY` (the server launcher).
   - `RESEND_API_KEY` and `CLOUD_ALERT_EMAIL` (else `cloud.email_skipped`).
   - `CLOUD_EVENT_WAKE_SECRET`, the same value on the webhook relay. It
     also lets the webhook relay read the list of deleted account IDs.
   - `CLOUD_OWNER_TOKEN`, and the Stripe secrets.
7. Deploy with `npm run deploy:production` (or `npm run deploy` for
   development). Each script checks only its own environment's configuration
   (it refuses without `DIRECTORY_AUTH_SECRET` and `PUSH_RELAY_URL`), applies
   the remote migrations, then deploys. A merge to `main` that touches this
   app runs the production deploy (`.github/workflows/deploy-web.yml`). Check
   with `npx wrangler d1 migrations list DB --remote --env production`.
   `0052_pricing_v2.sql` converts stored hours from Small-hours to
   Medium-hours and must not run twice or apart from its Worker: the deploy
   script's order (migrations, then the Worker at once) is the one that is
   safe. It leaves `extra_reported_milli` (and its `cloud_account_days`
   snapshot) as it is: Stripe's meter identifiers count from it, so halving
   it would bill reported hours twice. Computers made and free periods rolled
   by the old Worker between the migration and the deploy keep old numbers
   (Small 1000, free 100,000): right after the deploy, run the follow-up SQL
   in the migration's header once (it is safe to run again). Rerun `scripts/stripe-setup.mjs` (new 2¢ Pro and Max extra-hours
   prices, new product descriptions) and update the
   `STRIPE_EXTRA_HOURS_{PRO,MAX}_PRICE_ID` vars before that deploy. The old
   Pro and Max ids are already in `STRIPE_EXTRA_HOURS_RETIRED_PRICE_IDS`, so
   a subscription that holds one moves to the new price at its renewal.

Release builds use the production origin. Set `ADE_ACCOUNT_DIRECTORY_URL` on a
machine only for a trusted self-hosted override. `ONLINE_WINDOW_MS` (default
150 seconds) is a Worker var.
