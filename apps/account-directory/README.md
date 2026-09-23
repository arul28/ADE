# ADE account directory Worker

Cloudflare Worker + D1 directory for account-scoped ADE machines. Clerk JWTs
are verified against the configured remote JWKS before any machine row is read
or changed.

The Worker also hosts ADE's device-authorization bridge for headless sign-in:

- `POST /device/code` creates a short-lived code bound to a daemon-generated secret.
  An optional `machine_key` names the machine signing in, which is what a pairing
  grant (below) can later be spent on. An optional `machine_name` (cleaned, at
  most 80 characters) is display text only.
- `GET /device` renders a read-only human-code confirmation page. With a
  `machine_name`, it says "A computer named … asked to sign in to ADE" and tells
  the reader to continue only if they started it there, because the name is
  the client's claim. Without one, it says "ADE on your computer".
- `POST /device` confirms the code and opens Clerk OAuth + PKCE.
  It accepts only a same-origin form POST: the `Origin` must match, or, when a
  browser sends no `Origin` or the text `null`, `Sec-Fetch-Site` must be
  `same-origin`. The page is served with `referrer-policy: same-origin`, because
  under `no-referrer` a browser sends `Origin: null` for its own form. A
  confirmed POST answers with a small page that opens the Clerk sign-in (a
  meta refresh and a link), not a 302: browsers apply the page's
  `form-action 'self'` to every redirect after a form POST, and Clerk's
  authorize URL redirects on through more hosts.
- `GET /device/callback` exchanges the Clerk code and holds the token pair briefly.
- `POST /device/token` lets the initiating daemon redeem the pair once, and returns
  a `pairing_grant` alongside it when the request declared a `machine_key`.

Device codes and approval-attempt rate limits are stored in D1. The daemon
secret is stored only as a SHA-256 digest; approved token pairs are cleared by
the one-time redemption update or when the device code expires.

## Which install a machine row is

Stable (`~/.ade`) and Alpha (`~/.ade-alpha`) on one computer are two machines
in the account, and both report the same hostname. A register call may say
which install it is: `channel` (`stable`, `beta` or `alpha`; any other value is
dropped) and `adeHome` (the ADE home as `~/.ade-alpha`, or a folder name, never
a full path). Migration `0011` stores them in `machines.channel` and
`machines.ade_home`, and every machine row returns them. A register that omits
them keeps the stored values, because an older host sends neither.

Client-supplied text that a page or a list shows (`adeHome`, and the device
flow's `machine_name`, which migration `0010` stores on
`device_authorizations`) goes through `boundedDisplayText` in
`src/displayText.ts`. It replaces control and format characters (bidi
overrides, zero-width marks), folds whitespace, and cuts the text to a fixed
length. It cleans rather than refuses, so an odd name never blocks the request
that carried it.

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
| Body | `text/plain` — the report itself; or `application/json` — `{ report, installId?, appVersion?, auto?, failureCode? }` |
| Metadata on `text/plain` | `?installId=` / `?appVersion=` / `?auto=` / `?failureCode=` query parameters |
| Automatic sends | `auto` (boolean, or `1`/`true`/`yes` as a string) marks a report the client sent on its own rather than one a human pressed send on. `failureCode` names what broke and is bound to `^[a-z][a-z0-9_-]{0,47}$`. Both are optional; absent means a manual send. A `failureCode` that does not match the shape is **dropped, not refused** — the label is cosmetic and the report is not |
| Auth | **Optional** `Authorization: Bearer <Clerk token>`, verified exactly as the account routes verify it. Absent, the upload is anonymous. A header that is sent and does not verify — or does not even parse as `Bearer <token>` — is `401`, never silently downgraded. A Worker with no Clerk configuration answers `503`, exactly as the account routes do |
| Origin | `403` when the browser reports `sec-fetch-site: cross-site` from a real remote origin. ADE's own senders are unaffected: the CLI sends no fetch-metadata header, and the Electron renderer's `null` (packaged `file://`) and loopback (development) origins are exempt |
| Size | `413` above 512 KB. `content-length` is checked first, then the stream is counted as it arrives, so a missing or dishonest length changes nothing |
| Per-caller limit | 5 **stored** per UTC day per user (signed in) or per `cf-connecting-ip` (anonymous) → `429 {"error":"rate limited"}` with `retry-after: 86400`. Off Cloudflare there is no trustworthy address, so anonymous callers share one bucket; `x-forwarded-for` is caller-controlled and is never read |
| Fleet limit | `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` uploads **stored per UTC day across every caller** (default 400) → `429 {"error":"daily diagnostics budget exhausted"}` with `retry-after` counting the seconds to the next UTC midnight. A **distinct body** from the per-caller `429` on purpose: only one of the two is about the caller, and an auto-sender that reads a fleet-wide stop as its own quota retries forever |
| Budget unavailable | `503 {"error":"diagnostics upload unavailable"}`. The claim **fails closed** — a ceiling that is skipped whenever D1 hiccups is not a ceiling |
| Success | `200 {"ok": true, "id": "<uuid>"}`. The report is **never** echoed back |
| Storage | `reports/<utc-date>/<userIdOrAnon>/<uuid>.md` in the `DIAGNOSTICS` R2 bucket, with `userId` / `installId` / `appVersion` / `auto` / `failureCode` as custom metadata (`auto` is written only when true, so a manual upload stores exactly what it always did) |
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

**Two limits, because they bound different things.**

The *per-caller* quota answers "one person cannot fill the bucket". It is
enforced by a per-isolate counter (fast, but lost when Cloudflare recycles the
isolate) backed by an R2 prefix listing on the caller's day (durable and global,
one class-A operation per upload). The listing is not transactional, so
genuinely simultaneous requests can land a couple of objects over five — an
acceptable slop for an abuse bound.

Both halves count **stored objects**, never attempts, and the counter is
advanced only after the `put` returns. The durable half cannot do otherwise —
it is a listing of what is in the bucket — and the fast path has to agree with
it or it is not a cache of it. Counting attempts let refusals the caller did
not cause (a fleet budget that was out for the day, a bucket having a bad
minute) lock an install out until UTC midnight having stored nothing, which is
the same reasoning as the fleet budget's refund below.

The *fleet* budget answers a different question, and it is not allowed any slop
at all, because it is the storage bill. ADE clients now send reports
**automatically on failure**, so a single bug that fires for every install at
once multiplies "five each" by the install base, and no per-caller limit can see
that coming. `diagnostics_upload_days` (migration `0009`) holds one row per UTC
day, and every upload claims a slot from it in a single statement:

```sql
insert into diagnostics_upload_days (day, count)
values (?, 1)
on conflict(day) do update set count = count + 1
where count < ?
```

`changes === 1` is the whole proof — the same upsert idiom
`device_approval_rate_limits` uses, and for the same reason: a read followed by
a write lets two concurrent uploads both observe the last free slot. No
`RETURNING`, so nothing depends on a D1 version.

**The cost ceiling is arithmetic, not an estimate.** This Worker is the *only*
writer the bucket has, so the numbers below are the whole spend:

```
400 uploads/day        DIAGNOSTICS_DAILY_GLOBAL_LIMIT
×  512 KB/upload       MAX_DIAGNOSTIC_REPORT_BYTES (413 above it)
×   30 days            the bucket's expiry lifecycle rule
≈  6 GB steady-state maximum, against R2's 10 GB free tier
```

Every term is enforced somewhere a client cannot reach: the first by the claim
above, the second by the streaming size cap, the third by the bucket lifecycle
(see the deployment steps — **nothing in the Worker ever deletes a report**).
Change any one of them and redo the multiplication.

Ordering matters and is deliberate: the fleet slot is claimed **after** the
per-caller quota and **before** the R2 `put`. After, because one caller
hammering their own limit must not spend the fleet's budget on requests that
were never going to be stored. Before, because that ordering is what makes the
cap unraceable — the day's stored count cannot exceed the day's claimed count. A
`put` that then fails **refunds** the slot, so an R2 outage does not quietly eat
the day's ceiling for reports that do not exist.

`0` is a kill switch: it refuses every upload without a code deploy. An unset or
unparseable value falls back to 400, so a typo can neither uncap the bill nor
close the route. The cron sweep prunes budget rows older than seven days;
today's row is never in range, so a sweep can never hand back budget the running
day has already spent.

## Usage research reports

`POST /usage-research/daily` receives one compact usage report per ADE install
per local day. The owner collects them to study how to build a model router.
The reports go into **this Worker's D1 database**, the same one that holds
machines, device authorizations and pairing grants. A full D1 database refuses
every write, sign-in included, so this route is built so that research data can
never fill it.

**Contract** (`src/usageResearch.ts`; the desktop client mirrors it)

| | |
|---|---|
| Method | `POST`. Anything else is `405` with `allow: POST`. No `OPTIONS` preflight and no CORS headers: the senders are the desktop main process and the CLI, never a browser, and a web page cannot make a visitor's browser post JSON here |
| Content type | `application/json` (a `charset` parameter is fine). Anything else is `415 {"error":"usage_research_unsupported_media_type"}` |
| Body | Exactly `{ schemaVersion, installId, day, appVersion, platform, arch, utcOffsetMinutes, report }`. Any other top-level key is a `400`. `report` is the only place to add fields without bumping `schemaVersion` |
| Field rules | `schemaVersion` is the number `1`. `installId` matches `^[0-9a-f]{32}$`. `day` is a real `YYYY-MM-DD` inside the accepted window (below). `appVersion` is 1–40, `platform` 1–16 and `arch` 1–16 printable ASCII characters. `utcOffsetMinutes` is an integer in −840…840. `report` is a JSON object, stored re-serialized compactly and never interpreted. Anything else is `400 {"error":"usage_research_invalid"}` |
| Accepted days | From `utcDate(now − 12 h − 8 days)` to `utcDate(now + 14 h)`, inclusive: any local date on Earth from eight days ago to today. That covers a seven-day backfill from any time zone, and nothing in the future |
| Size | `413 {"error":"usage_research_too_large"}` above 32 KB for the whole body, counted as the stream arrives. A report that grows past 32 KB when re-serialized (`1e20` becomes 21 digits) is also `413`. A body stream that breaks mid-read (the client went away) is `400` with one log line |
| Auth | None. The senders post without an account token, and the route reads no `Authorization` header |
| Per-caller limit | 20 writes per caller address per UTC day → `429 {"error":"usage_research_identity_limit"}`. The address is `cf-connecting-ip` (never `x-forwarded-for`), with an IPv6 address cut to its /64 so one customer's prefix is one caller |
| Fleet limit | `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT` writes per UTC day across all callers (default 20000; `0` stops all writes) → `429 {"error":"usage_research_daily_limit"}`. A stopped or already spent fleet answers from one read, before any quota is claimed, so a refusal writes nothing |
| Storage ceiling | `USAGE_RESEARCH_STORAGE_CEILING_MB` of report bytes in total (default 4096, clamped to 6144; `0` stops growth) → `429 {"error":"usage_research_storage_full"}` |
| `retry-after` | On every `429`: the seconds until the next UTC midnight |
| Success | `201 {"ok":true,"stored":"inserted"}` for the first report of an install and day. `200 {"ok":true,"stored":"replaced"}` for a re-send |
| Unavailable | `503 {"error":"usage_research_unavailable"}` when there is no `DB` binding, D1 refuses any statement, or another write to the same install and day won a race. Every limit **fails closed**, and claims already taken are given back |

**No duplicates, by construction.** The primary key is `(install_id, day)`, so
a re-send replaces the row and never adds a second one. `received_at` keeps the
first arrival and `updated_at` moves.

**What the budgets count: writes that change a row.** A re-send whose envelope
and report are byte-for-byte what the row already holds is answered from a
single read. It writes nothing and claims no budget, so a client retrying a send
whose response it lost costs nothing. A changed re-send is a real D1 write and
counts like an insert. Counting only first inserts would have left a client
stuck re-sending changed reports bounded only by the per-identity limit.

**Four bounds, and why the write cap alone is not enough.**

```
body            32 KB hard cap (413 above it); typical reports are 4–12 KB
rows            one per install per local day; the sweep deletes rows older
                than USAGE_RESEARCH_RETENTION_DAYS (default 180, never below 9)
writes          20 per identity per UTC day; 20,000 fleet-wide per UTC day
storage         4,096 MB of stored bytes in total (clamped to 6,144 MB);
                each row counts its report plus a fixed 256 bytes
```

The write cap does not bound storage on its own:

```
20,000 new rows/day × 181 days × 32 KB ≈ 116 GB worst case
```

That is more than ten times D1's 10 GB per-database limit. The storage ceiling
is the bound that holds the line. `usage_research_totals` keeps a running total
of `usage_research_daily.bytes`, which is each report's UTF-8 length plus a
fixed 256 bytes for the key, the envelope columns and the day index, so a flood
of tiny reports cannot fill pages the total never counted. Every write that
grows the table claims its growth against the ceiling first, in one statement,
the same upsert idiom as the budgets. The row write is then a compare-and-swap
on the size that claim was computed from: a first send inserts with
`on conflict do nothing`, and a re-send updates only while the row still has
the `bytes` it read. A write that loses a race to another write of the same
install and day matches no row, gives back every claim, and answers `503`, so
the total stays equal to `sum(bytes)`. The sweep subtracts what it deletes in
the same transaction as the delete. The one way the total drifts is a refund
lost to a D1 error, and that errs **upward**: the ceiling trips early, never
late. To resync it:

```sql
update usage_research_totals
set bytes = (select coalesce(sum(bytes), 0) from usage_research_daily)
where id = 1;
```

**Storage arithmetic.** Assumptions: the account is on **Workers Paid**, since
the push relay's sizing already relies on the Paid plan's 50 M D1 rows written
per month. D1 limits and pricing are as Cloudflare documented them when this
was written; nothing in this repo pins them, so re-check
<https://developers.cloudflare.com/d1/platform/limits/> and
<https://developers.cloudflare.com/d1/platform/pricing/> before changing a
default:

- 10 GB maximum per database on Paid (500 MB on Free).
- 5 GB of D1 storage included per account on Paid, then $0.75/GB-month.
- 50 M rows written and 25 B rows read included per month on Paid.

```
1,000 daily-active installs × 10 KB × 180 days  ≈ 1.8 GB of reports
+ ~10–15% for keys, the day index and page slack ≈ 2.1 GB on disk
  (the 256 bytes per row the ceiling counts is ~2.5% of a 10 KB report;
  it matters for small reports, which it keeps from under-counting)

ceiling  4,096 MB of stored bytes ≈ 4.6 GB on disk
         inside the 5 GB Paid storage allowance, under half of the 10 GB limit
max      6,144 MB of reports ≈ 7 GB on disk, leaving ~3 GB for everything else

capacity at the defaults: 4 GB ÷ (10 KB × 180 days) ≈ 2,300 daily-active installs
```

Past that capacity the table fills and new reports get `429 …_storage_full`.
Then each daily sweep frees one day of old rows, and each day's earliest
senders fill it again. Collection degrades to a sample of each day. Machines
and sign-in are unaffected. When `usage_research_totals.bytes` approaches the
ceiling, lower the retention (90 days doubles capacity), raise the ceiling (up
to 6,144), or export and archive the data.

Write cost: an accepted write is about five D1 rows written (identity slot,
fleet slot, byte total, the row, its day-index entry) and two rows read (the
report row and today's fleet row). At the full 20,000 a day that is about 3 M
rows written a month, 6% of the Paid allowance. An identical re-send is one row
read, and a refusal for a stopped or spent fleet is two rows read and none
written. On the **Free** plan the defaults do not fit: the database is
500 MB and the whole account gets 100,000 rows written a day. Lower all three
vars before deploying there.

**Retention and cleanup.** The existing once-a-minute cron (`scheduled` in
`src/index.ts`) runs each cleanup on its own guard, so one that throws logs a
`scheduled_cleanup_failed` line and the others still run. The usage research
cleanup is one D1 batch per tick:

- it deletes up to 500 reports whose `day` is older than
  `USAGE_RESEARCH_RETENTION_DAYS`, oldest first, and subtracts their bytes;
- it prunes fleet-budget rows older than seven days;
- it deletes per-identity rows once their UTC day is over.

500 rows a minute is 720,000 a day, so shortening retention on a full table
drains in days. Retention is never shorter than 9 days. A shorter one would
sweep days the route still accepts, and a backfill would re-insert them every
minute.

**Privacy.** Report rows hold only the envelope fields above and the report.
There is no user id, no IP address and no token. Per-caller quota rows hold a
SHA-256 of `day + address` (an IPv6 /64), so they cannot be joined across days,
and they are deleted when the day ends. An address hash is pseudonymous, not
anonymous (IPv4 can be enumerated), so its protection is that one-day lifetime.
The log line (`kind: "usage_research_upload"`) carries only outcome, status,
reason and the report's byte count. It never includes the install id or any of
the report.

**Changing the limits.** Edit the var in `wrangler.jsonc`, under both the
top-level `vars` and `env.production.vars` (wrangler environments do not
inherit vars), then deploy. A dashboard edit takes effect at once, but the next
deploy resets it to the committed value. `USAGE_RESEARCH_DAILY_GLOBAL_LIMIT=0`
stops every write. `USAGE_RESEARCH_STORAGE_CEILING_MB=0` stops every write that
would grow the table. An unset or unparseable value falls back to the default,
so a typo can neither uncap nor close the route.

**Querying.** `--remote` is required. Without it, wrangler queries the local
development database.

```sh
# Reports and bytes per day (default environment)
npx wrangler d1 execute ade-account-directory --remote \
  --command "SELECT day, count(*) AS reports, sum(bytes) AS bytes FROM usage_research_daily GROUP BY day ORDER BY day"

# The same against production
npx wrangler d1 execute DB --remote --env production \
  --command "SELECT day, count(*) AS reports, sum(bytes) AS bytes FROM usage_research_daily GROUP BY day ORDER BY day"

# Headroom under the storage ceiling, and the last week of fleet writes
npx wrangler d1 execute DB --remote --env production \
  --command "SELECT bytes FROM usage_research_totals"
npx wrangler d1 execute DB --remote --env production \
  --command "SELECT day, writes FROM usage_research_days ORDER BY day DESC"

# `report` is JSON text, so SQLite's JSON functions work on it
npx wrangler d1 execute DB --remote --env production --json \
  --command "SELECT day, platform, json_extract(report, '\$.someField') FROM usage_research_daily WHERE day >= '2026-09-01'"

# Full export for offline analysis
npx wrangler d1 export DB --remote --env production \
  --table usage_research_daily --output usage-research.sql
```

**Deploying it** (instructions only; nothing here runs automatically from a
branch):

1. **Production** is deployed when this merges to `main`.
   `.github/workflows/deploy-web.yml` runs `npm run deploy:production`, which
   applies `migrations/0012_usage_research.sql` to
   `ade-account-directory-production` and then deploys. To do it by hand:
   `npx wrangler d1 migrations apply DB --remote --env production`, then
   `npx wrangler deploy --env production`.
2. The **default (development)** environment is not deployed by CI. Run
   `npm run deploy`, or by hand
   `npx wrangler d1 migrations apply ade-account-directory --remote`, then
   `npx wrangler deploy`.
3. Apply the migration **before** the deploy (both scripts do). If a Worker
   ships without the tables, this route answers `503` and the sweep fails,
   until the migration lands. No other route is affected and nothing is lost.
4. Check that it landed: `npx wrangler d1 migrations list DB --remote --env
   production` should show nothing pending, and
   `SELECT bytes FROM usage_research_totals` should return one row, `0` on a
   fresh table. (A malformed request is refused before D1 is touched, so a
   `400` from the route proves nothing about the migration.)

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
4. Give both diagnostics buckets a **30-day** expiry lifecycle rule. **Nothing
   in the Worker ever deletes a report**, so without this the bucket grows
   forever and every report a user ever sent stays readable indefinitely. Thirty
   days is not a taste preference: it is the third term of the cost ceiling
   above (400/day × 512 KB × 30 days ≈ 6 GB, inside R2's 10 GB free tier), and
   it is the one term this repository cannot enforce in code. Lengthen it and
   the ceiling moves with it — 90 days is ~18 GB and off the free tier:

   ```sh
   npx wrangler r2 bucket lifecycle add ade-diagnostics \
     expire-reports reports/ --expire-days 30
   npx wrangler r2 bucket lifecycle add ade-diagnostics-production \
     expire-reports reports/ --expire-days 30
   ```

   Confirm with `npx wrangler r2 bucket lifecycle list <bucket>`. Thirty days is
   still far longer than any support thread; a report nobody has read in a month
   is not going to be read.
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
