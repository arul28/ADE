# ADE Push Relay

A Cloudflare Worker (`ade-push-relay`) that holds the account-wide state of a
signed-in ADE account:

- **Activity:** machines publish sanitized Activity items. The relay merges
  them into one account stream for desktop, iPhone, APNs alerts and Live
  Activities.
- **Account settings:** settings that follow the account to every machine.
- **Account vault:** API keys, integration connections and provider sign-ins
  that every machine of the account uses, ADE Cloud computers too.
- **Passwords:** sealed Passwords & Secrets items and the wrapped vault key.

The product name is Activity. Routes, tables and payloads keep the older
`attention` names for wire and storage compatibility.

This Worker is separate from `apps/webhook-relay` (GitHub, Linear and webhook
ingress). It uses one D1 database, one service binding
(`PASSWORD_KEY_SERVICE`), no Durable Objects and no queues.

## Trust model

- A machine claims an unguessable `machineKey` (32–64 hex characters) with
  `POST /machines/:machineKey/claim { secret }`. The first writer wins. A
  claim again with the same secret is idempotent.
- Every other machine call is HMAC-signed with that secret:
  - `x-ade-push-timestamp`: unix seconds (±5 min skew).
  - `x-ade-push-signature`:
    `sha256=HMAC(secret, "<timestamp>.<METHOD>.<path>.<sha256(body)>")`.
- `POST /machines/:key/attention` also needs the account's Clerk bearer. The
  bearer says who the caller is. The signature binds the path key, and the
  publish handler checks that binding again.
- Account routes (`/attention/account/*`) need a Clerk bearer whose issuer and
  audience or authorized party match this deployment.
- Directory routes (`/directory/accounts/*`) and the machine pairing restore
  need the `x-ade-directory-auth` header (see "Directory provenance").
- Activity stores only bounded presentation data: titles, previews,
  destinations, progress and acknowledgements. It never stores transcripts,
  prompts, diffs or artifact contents. Entries expire, and the relay prunes
  tombstones.

## Browser access

The hosted web client (`WEB_CLIENT_ORIGIN`, `https://app.ade-app.dev`) may
call only the account routes in `BROWSER_ACCOUNT_ROUTES` (`src/relay.ts`):

| Route | Methods |
|---|---|
| `/attention/account/snapshot` | GET |
| `/attention/account/ack`, `/attention/account/presence` | POST |
| `/attention/account/preferences` | GET, PUT |
| `/attention/account/preferences/(devices\|machines\|sessions)/:id` | PATCH |
| `/attention/account/settings` | GET, PUT |
| `/attention/account/settings/:scope/:key` | DELETE |

None of these routes returns a secret value.

- A request with an `Origin` header comes from a browser page. On any other
  account path, or with another method, the relay answers `403` before
  authentication or D1 work. The CORS preflight allows only the listed
  methods.
- The vault, Passwords, device registration, machine removal and `notify`
  routes are native-only. A script on the ADE Web origin cannot read a secret,
  even with a valid session.
- `vault/item`, `vault/keys` and the directory lease route refuse an `Origin`
  again in their own handlers. A D1 outage answers the same `403`.
- The web client reads secret-backed account data through the account
  directory's `/cloud/*` routes, which return status and names only.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, and whether APNs and account auth are configured. |
| POST | `/machines/:key/claim` | Claim a machine key with a relay secret. |
| PUT, DELETE | `/machines/:key/devices/:deviceId` | Upsert or remove a device registration (`apnsToken`, `pushToStartToken`, `bundleId`, `apsEnvironment`, `platform`, `deviceName`). An omitted `pushToStartToken` stays; `clearPushToStartToken: true` removes it. |
| GET | `/machines/:key/devices` | List registrations (diagnostics). |
| POST | `/machines/:key/live-activity-tokens` | Upsert or remove one activity's update token (an empty token removes it). |
| POST | `/machines/:key/publish` | Publish alert `notifications` and `liveActivity` events. |
| POST | `/machines/:key/attention` | Publish the machine's Activity items (HMAC and Clerk bearer). |
| GET | `/attention/account/snapshot?since=<revision>` | Read account Activity changes. |
| POST | `/attention/account/ack` | Mark items seen or dismissed on every device. |
| POST | `/attention/account/presence` | Report foreground presence, for desktop-first alerts. |
| POST | `/attention/account/notify` | Send a custom push (`ade notify`): `title` (≤ 64), `body` (≤ 160), `deepLink` (`ade://` only), `machineKey`. 60 per account per hour, then `429` with `retryAfterSeconds`. |
| GET, PUT | `/attention/account/preferences` | Read or replace the notification preferences. |
| PATCH | `/attention/account/preferences/devices/:deviceId` | Merge one device's overrides. |
| PATCH | `/attention/account/preferences/machines/:machineKey` | Merge one machine's overrides ("mute this Mac"). |
| PATCH | `/attention/account/preferences/sessions/:sessionId` | Mute or unmute one session. |
| PUT, DELETE | `/attention/account/devices/:deviceId` | Register or remove an account APNs destination. The body needs a positive, monotonic `ownershipEpoch`; an older epoch gets `409` with the latest one. DELETE keeps the epoch, so a late request cannot claim the install again. |
| PUT, DELETE | `/attention/account/devices/:deviceId/activities/:activityId` | Register or remove an account Live Activity update token. |
| DELETE | `/attention/account/machines/:machineKey` | Remove a machine from the account: purge and tombstone its items, drop its presence link, its seeded installs and its legacy registrations, and revoke it. The account directory calls it when the person removes a machine. |
| POST | `/attention/account/machines/:machineKey/pairing` | Clear that revocation when the person pairs the machine again (directory provenance too). |
| GET | `/attention/account/settings?since=<iso>&scope=<key>` | Read settings changed after a cursor. `scope` is `all` or `repo:<normalized-repo>`. |
| PUT | `/attention/account/settings` | Upsert a batch of settings. |
| DELETE | `/attention/account/settings/:scope/:key[?writtenAt=&sentAt=]` | Remove one setting. Idempotent. |
| GET | `/attention/account/vault?since=<iso>&scope=<key>` | Read vault items changed after a cursor, opened. |
| GET | `/attention/account/vault/item?scope=&kind=&key=` | Read one item, opened. `item: null` when there is no row. For the account directory's binding; never a browser. |
| GET | `/attention/account/vault/keys?scope=[&kind=]` | List the live item keys of one scope, with no value. For status views; never a browser. |
| PUT | `/attention/account/vault` | Upsert a batch of items. Values arrive as plaintext over TLS and the relay seals them. |
| DELETE | `/attention/account/vault/:scope/:kind/:key[?writtenAt=&sentAt=&ifRevision=&deviceId=]` | Remove one item. Idempotent. A key with `/` is sent as `%2F`; a key a proxy decoded arrives as several segments and the relay joins them. |
| GET | `/attention/account/passwords/items?since=` | Read sealed Passwords items, paged by revision. |
| PUT | `/attention/account/passwords/items` | Write sealed items (`{ items: [{ id, ciphertext, ifRevision?, deleted? }], deviceId? }`). |
| POST | `/attention/account/passwords/key` | Release the account's vault key to a signed-in device (`{ deviceId, machineKind }`). |
| POST | `/attention/account/passwords/reset` | Start a new, empty vault (`{ deviceId, confirm: "reset" }`). |
| GET | `/attention/account/passwords/releases` | The last key releases. |
| PUT | `/directory/accounts/:userId/vault/linear-lease` | Publish a Linear grant that the account directory renewed (see "Linear lease publish"). Directory provenance only. |
| DELETE | `/directory/accounts/:userId` | Delete a deleted account's vault items and settings. Directory provenance only. Idempotent. |

## Account Activity

- The relay merges every linked machine into one revisioned account stream.
  Tombstones let desktop and iPhone converge after removals.
- **Publish protocol 2.** `POST /machines/:key/attention` takes a `mode`:
  - `reconcile`: the full roster, paged, with `final: true` on the last page.
  - `delta`: changed items only. A delta never deletes.
  - `presence`: no items. It holds presence and lets a due alert retry.
- Each publish stamps a monotonic `rosterEpoch`. The `final` page of a
  reconcile seals it, and the relay drops the machine's items on an older
  epoch. A cut publish answers `itemsTruncated`, and the brain starts a new
  reconcile. Every response carries `protocol: 2` and the current `acks`.
- **Two fingerprints.** An unchanged `contentFingerprint` skips the write.
  `alertFingerprint` names one phase entry and survives a remove and publish
  again, so a reconnect does not alert again.
- **Alerts.** Only items with `activityTier: signal` and an `updatedAt` in the
  last 15 minutes can notify. A delivery receipt claims each send, and
  `attention_alert_log` (30 days) records it. Needs-input, failure,
  checks-failing, review and merge-ready changes can notify; running and
  progress stay quiet.
- A foreground Mac holds back the phone alert. If the item stays unseen after
  the escalation window, a later heartbeat sends it.
- Seen and dismissed belong to the account. An acknowledgement on one device
  clears the item on all of them. `stale` in the answer means "no live row for
  that id".
- **Machine lifecycle.** The hourly cron (`17 * * * *`) removes expired items
  and the items of machines silent for 14 days. Both leave tombstones.
- **Live Activity.** The relay owns one account-wide Live Activity per iPhone.
  Its content state can carry `groups` (`[{group, count}]` over
  `needs_you | failed | planning | working | done`) and `moreCount`. Both are
  left out when empty, so an older client is not affected. A push goes only
  when the alert projection changes: exact `needs_you` and `failed` counts,
  and PR alert fingerprints.
- **Preferences.** Account preferences override the device registrations. The
  document has `project`, `machines` (by machine key) and `devices` scopes. A
  phone writes with the device PATCH; an account or project write keeps
  `devices` as it is.

## Account settings

- One row per setting. The merge rule is "last writer wins" for each key.
- The Worker stamps `updated_at`. A caller's `changedAt` is kept for
  diagnostics only.
- Machine-scoped settings (paths, ports, hardware) never come here. `scope_key`
  is `all` or `repo:<normalized-repo>`.
- Without `itemResults`, one bad item refuses the whole batch. The `400` names
  the first refused item (`index`, `reason`).
- Limits: 16 KB per value, 200 settings per write, 1,000 per read page (with
  `truncated` and `cursor`), 5,000 per account.

## Account vault

API keys (`provider_api_key`), integration connections (`integration`, for
example `repo:<origin>/integration/linear` and `.../jira`), provider sign-ins
(`provider_login`) and ADE's own account items. Every machine of the account
reads them, ADE Cloud computers too.

- **Platform encryption.** The relay seals each value with
  `VAULT_ENCRYPTION_KEY` before it writes it to D1. A database dump alone shows
  nothing. A person who can read the Worker's secret can read the values.
- **Fail closed.** With no key, every vault route answers `503`, and
  `npm run deploy` refuses. A caller cannot send its own ciphertext.
- **An unopenable row returns `value: null`**, so a client does not replace a
  value that is good elsewhere.
- **`provider_login`** holds a provider CLI's login, up to 16,000 characters
  (other kinds: 6,000). The relay never refreshes one.
- **`refresh_owner`** names the machine that may exchange a rotating
  credential, such as Linear's OAuth refresh token. The relay stores the owner
  the writer names. The stale-write rules, not the owner, protect a grant from
  an old copy. The account directory's own owner name is `ade-cloud-directory`.
- **Item keys** are `/`-separated segments, 200 characters at most, none empty
  or starting with a dot (first: `[A-Za-z0-9][A-Za-z0-9._:-]*`).

### Per-item answers and stale writes

Settings and the vault use one write protocol. With `itemResults: true`, the
caller gets one answer per item, in request order:

- `{status: "written"}`.
- `{status: "rejected", reason}`: this item cannot be stored as sent. The
  others are still written.
- `{status: "stale", current}`: the stored row is newer, so the relay did not
  apply the write. `current` is that row.

An item can carry `writtenAt` (the machine's clock), and the body `sentAt`. The
relay moves `writtenAt` onto its own clock by `now - sentAt`. It refuses the
item when the stored `updated_at` is later by more than 5 s. This stops a
machine that was offline for days from replacing newer rows. `DELETE` takes the
same values as query parameters and answers `409 {code: "stale", current}`.

### Vault revisions

A vault row's `updated_at` is its revision. Each write and delete moves it
forward by at least 1 ms, so a revision never repeats. An item can carry
`ifRevision`: the `updatedAt` the client read, or `absent` when it read no
row. The relay then writes only while the row has that revision, in the
statement's own `where`.

- A row that this same device (`deviceId`) wrote last also passes.
- `absent` passes only when there is no row, a tombstone included.
- A named revision with no row is refused.
- An item with no `ifRevision` follows the `writtenAt` rule.

The brain sends `ifRevision` only for a background sync that decides from what
it read. A write that a person asks for names no revision. Against an older
relay, the brain's `accountCacheStore` splits a refused batch, keeps the
refused items locally and retries them hourly.

### Linear lease publish

`PUT /directory/accounts/:userId/vault/linear-lease` with
`{ scope, refreshOwner, spentRefreshToken, value }` publishes a Linear grant
that the account directory renewed (`apps/account-directory/src/cloud/linearRenewal.ts`).
Its minute cron calls it when the person's request ended before the publish.

- It needs directory provenance. It refuses an `Origin` (`403`) and any method
  but PUT (`404`).
- It changes only `integration/linear` of one `repo:` scope.
- It changes the row only while the row is live and still holds
  `spentRefreshToken`. A deleted row, or a row with another grant, stays as it
  is.
- `value` must be a v1 Linear OAuth grant with a new refresh token, 16 KB at
  most. The row's writer and owner become `refreshOwner`.
- It answers `{ ok: true, written: <rows> }`, one row for each configured
  issuer.

## Passwords

`src/passwords.ts`. The relay never sees a Passwords item's contents. Items
arrive sealed under the account's vault key and are stored as opaque text.

The vault key is stored only wrapped (`password_keys`); the key service
(`apps/password-key-service`, `PASSWORD_KEY_SERVICE` binding) wraps and unwraps
it. Each key release is recorded (`password_key_releases`). The cloud
computer's own brain enforces the "ADE Cloud computers can use Passwords"
switch. See `docs/features/passwords/README.md`.

## Publish (APNs)

- **Alert pushes** carry `title`, `subtitle`, `body`, an optional `deepLink`,
  `threadId`, `collapseId` and a `phase`. The phase sets the APNs TTL:
  `running` is 2 h; `waiting` and `terminal` are 24 h.
- **Live Activity** events (`start`, `update`, `end`) go to
  `<bundleId>.push-type.liveactivity`. `start` uses the push-to-start token;
  `update` and `end` use the per-activity tokens.
- **Dedupe.** A publish with the same content hash as the last one for its
  `dedupeKey` is skipped. Alerts dedupe per machine; Live Activities per device
  (rows pruned after 48 h).
- The relay clears dead tokens (APNs 410, `BadDeviceToken`, `Unregistered`,
  `DeviceTokenNotForTopic`, `ExpiredToken`).
- It prunes registrations idle for `REGISTRATION_RETENTION_DAYS` (120).

## Abuse and spend limits

Cloudflare has no hard billing cap, so the Worker keeps its own. Change these
`wrangler.jsonc` vars and deploy again:

| Var | Default | Limit |
|---|---|---|
| `DAILY_REQUEST_BUDGET` | `750000` | Requests per UTC day. Over it, every request gets `429` until midnight UTC. An isolate reserves the budget in blocks of 50 with one D1 upsert. A month at the cap costs about $7. |
| `IP_RATE_LIMIT_PER_MIN` | `120` | Requests per client IP per 60 s, per isolate, in memory. |
| `CLAIM_RATE_LIMIT_PER_MIN` | `10` | Requests per IP to `/claim`, in D1 (`rate_counters`). |

`notify` has its own cap: 60 per account per hour (`notify:<account>` in
`rate_counters`, kept two hours). `/health` skips every gate.

## Observability

Logs are single-line JSON in Workers Logs (**ade-push-relay** → Logs) and in
`npx wrangler tail ade-push-relay`. Event kinds:

- `rate_limited`, `budget_exceeded`.
- `auth_failed` (`reason`: unknown machine, bad signature, stale timestamp).
- `apns_error` (APNs `status` and `reason`).
- `claim_conflict`.
- `cloudflare_transient` (the D1 outage kind).

D1 has short outages. The relay retries every read statement through them
(three tries, about 1 s, `src/cloudflareTransient.ts`), and the few writes
that are safe twice. A request that still fails gets `503` with
`Retry-After: 5`, not Sentry.

## Deploy

Deploy order for a vault change: this Worker, then the tunnel relay, then the
app. Deploy this Worker before the account directory when the directory calls a
new relay route (`vault/item`, `vault/keys`, the Linear lease publish).

```bash
cd apps/push-relay
npm install
npx wrangler d1 create ade-push-relay   # one time; put the id in wrangler.jsonc
npm run deploy                          # checks the schema, applies D1 migrations and triggers, deploys
```

Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (from
`ade secrets get …`). Do not print the values.

### APNs signing key

```bash
npx wrangler secret put APNS_KEY             # the full .p8 PEM
npx wrangler secret put APNS_KEY_ID          # 10-character key id
npx wrangler secret put APNS_TEAM_ID         # Apple team id
npx wrangler secret put APNS_DEFAULT_TOPIC   # optional fallback, e.g. com.ade.ios
```

The relay picks the APNs sandbox or production host from each registration's
`apsEnvironment`, and uses its `bundleId` as `apns-topic`. Without the key,
`publish` answers `503` and `/health` reports `apnsConfigured: false`.

### Vault encryption key

```sh
npx wrangler secret put VAULT_ENCRYPTION_KEY   # openssl rand -base64 32
```

The key must be exactly 32 bytes. A rotation orphans every stored item: rows
sealed with the old key return `value: null`, and people must enter those
credentials again.

### Clerk verification

```bash
npx wrangler secret put CLERK_JWKS_URL
npx wrangler secret put CLERK_ISSUER
npx wrangler secret put CLERK_OAUTH_CLIENT_ID
# The development Clerk instance (iOS Debug builds):
npx wrangler secret put CLERK_SECONDARY_JWKS_URL
npx wrangler secret put CLERK_SECONDARY_ISSUER
npx wrangler secret put CLERK_SECONDARY_OAUTH_CLIENT_ID
```

Without them, account routes answer `503`; a bad session token answers `401`.
Account keys are namespaced by issuer, so the same user id on two instances
never collides.

### Directory provenance

```bash
npx wrangler secret put DIRECTORY_AUTH_SECRET   # same value on ade-account-directory
```

Routes that need the `x-ade-directory-auth` header:

- `POST /attention/account/machines/:machineKey/pairing`. It clears a
  revocation, and a removed machine can still hold a valid bearer.
- `DELETE /directory/accounts/:userId`. A deleted account has no token.
- `PUT /directory/accounts/:userId/vault/linear-lease`.

A missing or wrong header answers `403 directory_auth_required`. With the
secret unset, the routes answer `503 directory_auth_unavailable`, and
`npm run deploy` refuses. The header proves provenance for a service binding
(`ACTIVITY_RELAY`) and for a public fetch alike.

A revoked machine key also gets `403 machine_revoked` on the machine-signed
routes (`publish`, `live-activity-tokens`, device upsert). Device registrations
and Live Activity tokens are dropped when a machine leaves an account and when
its key links to another account.

### Passwords key service

`KEY_SERVICE_AUTH_SECRET` has the same value here and on
`ade-password-key-service`. Deploy the key service first.

### Deploy checks

`npm run deploy` refuses without both Clerk secret sets,
`ADE_PUSH_RELAY_SMOKE_TOKEN` and `ADE_PUSH_RELAY_SECONDARY_SMOKE_TOKEN`.
`npm run deploy:ci` mints fresh smoke tokens from the Clerk backend keys and
`ADE_PUSH_RELAY_SMOKE_USER_ID` / `ADE_PUSH_RELAY_SECONDARY_SMOKE_USER_ID`, and
never prints them. After the upload, it checks `/health` and one authenticated
snapshot for each issuer.

## Source file map

| File | What |
|---|---|
| `src/index.ts` | The Worker entry and the cron. |
| `src/relay.ts` | Routing, the browser gate (`BROWSER_ACCOUNT_ROUTES`), machine routes, spend gates. |
| `src/attention.ts`, `attentionAuth.ts`, `attentionShared.ts` | Account Activity, Clerk auth, directory provenance, machine removal and account deletion. |
| `src/accountSettings.ts` | Account settings. |
| `src/accountVault.ts` | The account vault, `vault/item`, `vault/keys` and the Linear lease publish. |
| `src/passwords.ts` | Passwords items, the wrapped key and key releases. |
| `src/apns.ts`, `liveActivity.ts` | APNs sends and the account Live Activity. |
| `src/spendGuards.ts`, `cloudflareTransient.ts` | Spend limits and D1 retries. |
| `src/sentry.ts`, `sentryScrub.ts`, `posthogLogs.ts` | Error reports and logs, scrubbed. |
| `test/relay.test.ts` | The browser gate table, among others. |
| `test/accountVault.test.ts` | Vault reads, revisions and the Linear lease publish. |

## Gotchas

- **A new account route is native-only by default.** Add it to
  `BROWSER_ACCOUNT_ROUTES` only when it returns no secret value.
- **`vault/item` and `vault/keys` answer "no row" as `item: null` or `[]`.** A
  `404` means an older relay, and callers fall back to the full `GET vault`.
- **The vault key cannot rotate without loss.**

## Local dev

```bash
npm run d1:migrate:local
npm run dev
npm test
npm run typecheck
```
