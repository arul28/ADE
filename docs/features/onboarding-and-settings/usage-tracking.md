# Usage tracking

DAEX treats **live provider limits** and **token/cost history** as two
workloads. Live limits must stay fast for desktop, CLI, web and the phone;
history scans walk large local ledgers and run only on the history path. The
design follows [CodexBar](https://github.com/steipete/CodexBar).

## Source file map

Under `apps/desktop/src/main/services/usage/` unless noted.

- `usageTrackingService.ts`: the live quota snapshot (poll, cadence, backoff,
  carry-forward, cache) and `getAdeUsageStats`. `usageProviderStrategies.ts`:
  per-provider quota polls. `providerQuotaParsers.ts`: payload normalization.
  `extraProviderQuota.ts`, `museLiveQuota.ts`: Cursor, Copilot, Grok, OpenCode,
  Kimi and Muse.
- `sharedUsageTracking.ts`: one tracker per DAEX home. `bootedUsageScope.ts`:
  unbound windows borrow a booted brain scope.
- `accountBalance.ts`: smart balance. `windowAutoStart.ts`: auto-start windows.
- `providerAccountIdentity.ts`: which account the numbers belong to (local
  files only, no Keychain, no token stored). `usageAccountId.ts`: the one
  account-id rule.
- `usageLedgerWorkerClient.ts`, `usageLedgerWorker.ts`,
  `usageLedgerScanners.ts`, `ledgers/`: history scans in a child process.
  `providerUsageHomes.ts`: which config homes are scanned.
- `usagePricing.ts`, `usagePriceOverrides.ts`, `usageModelDetail.ts`,
  `usageCostBreakdown.ts`: prices and cost reads.
- `accountUsageRollup.ts`, `accountUsageRollupStore.ts`,
  `accountUsageLiveRefresh.ts`, `accountUsageSource.ts`, `peerLiveQuota.ts`:
  account scope across machines.
- `turnUsageLedger.ts`, `turnUsageReconcilers.ts`, `cursorDashboardUsage.ts`,
  `cursorBilledUsageStore.ts`, `quotaBurnRate.ts`, `tokenSplit.ts`: the
  per-turn ledger.
- `usageResearchReport.ts`, `usageResearchUploader.ts`: the daily research
  report; contract `shared/usageResearch.ts`.
- `usageStatsStore.ts`: project-DB aggregates and `usage_events`. `localDay.ts`:
  day keys in the user's timezone.
- `claudeResetCredits.ts`, `shared/usageResetCredit.ts`: banked resets.
- `main/services/router/`: the model router (shadow).
- `shared/types/usage.ts`, `shared/usageLiveQuota.ts`,
  `shared/usageLimitsReport.ts`: contracts.
- Renderer: `renderer/components/usage/` (header popover, `UsageLimitsBand`,
  `UsageAccountRow`, gauges, charts, `usageLimitModel.ts`, `usageDesign.ts`,
  `providerColors.ts`), `settings/AdeUsageSection.tsx` (Settings › Usage).
- iOS: `SettingsUsagePage.swift`, `WorkUsageLimitsModule.swift`,
  `ADEUsageDesign.swift` (the counterpart of `usageDesign.ts`).

## One poller per machine

Provider quota is a machine fact. The brain polls once per machine and every
project scope attaches to the same poller (one timer, one demand lease, one
snapshot). A window with no local project borrows a booted brain scope
(`bootedUsageScopeRoot`), and `main.ts` relays brain usage events on
`ade.usage.event`. The in-process tracker polls only when no brain scope runs.

- **Ordering**: each snapshot has `revision.producerId` and `revision.seq`.
  Consumers order by `seq` within one producer and always accept another
  producer (`usage/usageSnapshotOrdering.ts`), so wall clocks are never
  compared.
- **Cadence**: an adaptive demand lease, 60 s while usage is visible, 2 min
  normally, 5 min after 15 min idle. One provider batch at a time.
- **Quota refresh never scans history.** `forceRefresh()` is quota-only;
  `refreshHistory()` owns ledger scans.
- **Stale is visible.** Each provider keeps unexpired last-good windows with
  `updatedAt`, `lastAttemptAt`, error kind and next retry. Errors are classified
  (auth, forbidden, conflict, rate limit, timeout, network, invalid response,
  unavailable); `Retry-After` and backoff apply per account.
- **Claude**: background polls never prompt the Keychain (see
  [Claude credential hygiene](#claude-credential-hygiene)); an explicit refresh
  may run a bounded CLI fallback, except after a 403/429.
- **Codex**: HTTP success returns at once; app-server RPC runs only for 401
  recovery or an unrecognized schema. Windows are classified by their advertised
  duration, position only as a fallback. `spendControlReached` is carried
  forward and shown as "Codex spending cap reached".
- Only provider-authoritative data may create a live limit; local token
  estimates stay history.
- `usage.refresh.phase` log entries time each phase without credentials or
  payloads.

## Live limits beyond Claude and Codex

Cursor, Copilot, Grok, OpenCode and Kimi join the header as soon as a local
credential exists; no credential means no row, not an error. Each HTTP call is
bounded to 4 s; a failed refresh keeps unexpired windows as stale. They are one
login per machine.

| Provider | Credential | Request |
|---|---|---|
| Cursor | `cursorAuth/accessToken` in Cursor's `state.vscdb` (not refreshed) | `cursor.com/api/usage-summary` with the `WorkosCursorSessionToken` cookie |
| Copilot | `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`, Copilot `hosts.json`, else `gh auth token` (at most every 15 min) | `api.github.com/copilot_internal/user`; the SDK's account quota as fallback |
| Grok | bearer in `~/.grok/auth.json` (`GROK_HOME`) or `GROK_OAUTH_TOKEN` | `cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` or an OpenCode/Zen key in `auth.json`, else the Go console login in `opencode.db` | `opencode.ai/zen/go/v1/usage`, or the console status with `x-org-id` |
| Kimi | Kimi Code's own token file, found as Kimi does (`shared/kimiCodeLogin.ts`); keyring logins not read | `{base}/usages` and `{base}/me` |
| Muse | none; readings arrive over MSP from a running Muse chat (`usage/read`, `usage/changed`) | none (in-process only) |

Gemini, Droid, Pi and Qwen have no remaining-quota source; their spend comes
from history. Droid session credits come from the Factory API only with an
optional Factory key. Kimi writes no token counts to disk, so it is not
scanned.

**Cursor billed usage**: after a Cursor turn on a saved API key, DAEX asks
`Agent.getUsage` (up to 12 s before `done`) and records one billed row in
`cursorBilledUsageStore.ts`. A stored Cursor login never calls it; plans without
the API answer `feature_unavailable`, which is not an error. The production
history scan does not read billed rows.

## Smart balance and auto-start windows

Smart balance (Claude and Codex, per provider, `accountBalance.ts`):

- Candidates are signed-in accounts on this machine, each judged on its
  freshest reading from any machine
  ([Quota belongs to the login](#quota-belongs-to-the-login)). A window past
  its reset reads as empty.
- Each account's required rate (weekly room ÷ hours to reset) minus its
  committed burn (measured rate, else a model-weighted prior from chats
  mid-turn, plus decaying pending assignments and reservations for idle open
  chats) ranks it; the largest deficit wins. Ties within 0.15 points per hour go
  to the sooner reset.
- **The five-hour window is a gate**: under 10% five-hour or 5% weekly room is
  out, and the projected five-hour burn over 1.5 h must cover a first turn. When
  every account is blocked, the chat still starts on the one that lasts longest.
  `UsageSnapshot.balanceIssues` drives the amber pill. An explicit account pick
  always wins.
- **At a usage limit** a chat moves in place: the provider thread file is copied
  into the other account's home (`chat/providerThreadMove.ts`) and resumes
  there, once. If the thread cannot move, a new chat on the other account takes
  the task. With balance off, the limit pill offers the move.

Auto-start windows (off by default, `windowAutoStart.ts`): five seconds after a
Claude or Codex five-hour reset, one small request through the account's own
home (Haiku 5.5 / GPT-6 Luna, low effort), recording no response text. Early
window ends (a random Codex reset, a spent credit) start the next window, at
most once per account per 15 minutes. No timer state is persisted.
`AUTOSTART_WINDOW_TYPE` (`shared/types/providerInstances.ts`) gates providers;
other providers' windows are rolling or calendar periods with no first-request
start.

## History scans

History reads provider-owned files in place and never copies or rewrites them.

- **Bounded Codex reader**: streams `.jsonl` and `.jsonl.zst` newest first, at
  most 5,000 files per root, 256 MiB per file and 2 GiB total; lines over 16 MiB
  are discarded incrementally; detail stops at 250,000 entries; callers share
  one in-flight scan. The all-time headline reconciles with the newest
  `state_*.sqlite` (read-only, bounded), adding a zero-cost `lifetimeOnly`
  remainder so the total is exact without inventing attribution.
- **OpenCode** selects only token, cost and model fields from `opencode.db`
  (`json_extract`, paged).
- **Other ledgers** (`ledgers/`): Pi, Qwen, Grok and Copilot CLI
  (`acpProviderLedgers.ts`), Droid (session totals spread over calls;
  `thinkingTokens` are already in output), Gemini.
- **Every account home is scanned.** `adeProviderUsageHomes` lists every
  directory under `provider-homes/` (removed accounts too) plus registry homes,
  and `machineProviderUsageHomes` adds each CLI's own default home, so a brain
  started from an agent shell with an inherited `CLAUDE_CONFIG_DIR` still counts
  the machine's main history. They reach the worker as
  `ADE_USAGE_EXTRA_<PROVIDER>_HOMES`; scanners never discover homes themselves.
- **The worker runs in a separate process** (`usageLedgerWorker.cjs`, or a
  hidden entrypoint in the static runtime) so disk and SQLite work never stall
  the event loop.
- **The worker streams NDJSON**: a roster header, then one line per provider,
  so a timeout keeps finished providers. `incompleteProviders` becomes
  `publishLocalRollup`'s `skipReconcileProviders` and carries previous totals
  forward: **a partial round never deletes or lowers totals**, here or on
  peers.
- **Timeouts derive from one constant**: `LEDGER_WORKER_TIMEOUT_MS` (10 min, a
  bound on a wedged child), then the remote transport (+15 s), then the
  renderer IPC (+30 s).
- **Lifetime stats survive lane deletion**: deleting a lane writes one
  aggregate `lane_usage_tombstones` row first
  ([Lanes](../lanes/README.md#what-a-deleted-lane-leaves-behind)).

## Where a token price comes from

Cost is an estimate, but the same estimate everywhere (`usagePricing.ts`).

- **models.dev is the single price source.** A bare model id takes the vendor's
  own row (`pickModelsDevEntries`); a `provider/model` name takes that
  provider's row. Fetched with a 10 s timeout, cached in
  `~/.ade/models-dev-pricing.json`, refreshed daily, dropped after 30 days.
- `resolveTokenPrice` order: a user price override; an exact models.dev match;
  the registry price (`model-manifest.json` can set one for a launch-day model);
  the longest models.dev key the name extends; then zero.
  `tokenPriceSource(model)` reports `list` or `fallback`.
- Cache rates: a missing write rate is the input rate, or `input × 1.25` for
  vendors with a write premium; no cache rates at all fall back to `input × 0.1`
  / `input × 1.25`.
- Long-context tiers apply only to ledger entries that record one request with
  `requestContextTokens`. DeepSeek peak hours double the rate. Faster tiers
  (`fast`, `ultrafast`, from models.dev `experimental.modes`) bill at their own
  rate; a Claude model with no published fast rate uses
  `FAST_MODE_PRICE_MULTIPLIER`. Bump `USAGE_SNAPSHOT_CACHE_VERSION` when a
  pricing rule changes.
- Each provider's stats carry `pricingSource` and the payload
  `pricingUpdatedAt`; Settings › Usage turns them into one sentence under the
  cost.
- **Set price / Map to** (`usage.setModelPriceOverride`, CTO role) write
  `<adeHome>/usage-price-overrides.json`. A price wins over every list; a Map to
  buckets and prices one model id as another. A save triggers a background
  history refresh to re-price.
- `AdeUsageCostSplit` splits dollars by token type and tier premium on the
  host. The replicated rollup table does not store it, so a machine fed only by
  its saved rollup shows no split.
- `usage.getCostBreakdown {by: chat | lane | account}` ranks the per-turn ledger
  with list-price value, `billedUsd` and `planValueUsd`.

## Account scope: usage across every machine

`ADE_USAGE_SCOPES` is `account`, `machine`, `project`, one three-way control.

- **Aggregates only.** A machine publishes day × provider × model totals; no
  transcript, session id or path leaves it.
- **History merges; live quota pools.** Cost and tokens merge as durable rows;
  live windows travel only in memory (storing them would churn the CRR clock).
- **Every stat about the user is account-wide**: the activity module reads
  `getAdeStats` with `scope: "account"`.
- **Activity counts** (chats, shells, commits, PRs per database per day) ride
  in the retired `source_window` column of `usage_machine_rollup_meta`, so
  older peers ignore them safely. They dedupe by database id (oldest `projects`
  row id), not by machine. No machine reporting means unknown, not zero; an
  older machine makes counts a floor ("12+").
- **GitHub is excluded** (repo-scoped; three clones would triple it).

**Transport**: each machine writes `usage_machine_rollups` (primary key
`(machine_key, day, provider, model)`; a CRR table allows no other UNIQUE
index; no-op upserts skipped; 400 days kept) and the CRR pump replicates it.
That durable copy is the floor. On top, `accountUsageLiveRefresh.ts` asks up to
12 reachable machines (online, paired, already connected; never dials) for
`usage.getUsageRollup` and `usage.getLiveQuota`. The brain has its own fan-out
over the agents' connections (`cli.ts`). A machine without the methods is "too
old to share usage". Failures are per machine and never empty the page. Both
tables are in `MOBILE_CHANGESET_EXCLUDED_TABLES`.

**Dedupe** (`accountUsageSource.ts`): two machines mounting the same home would
double tokens. A `.ade-usage-source` marker id in the transcript home travels
with the files; `isSameTranscriptSource` compares markers, else hashed roots.
Machines cloned from one image share a marker and show as `deduped`; deleting
the marker mints a new id.

**Machines list** states: `live`, `rollup`, `stale` (older than six hours),
`deduped`, `failed`.

### Quota belongs to the login

Every screen shows each login's freshest reading from any machine.
`peerLiveQuota.ts` holds peers' readings in memory (pulled at most once a minute
while limits show, held up to six hours), and `poolPeerQuota` builds two views:

- **For picking** (smart balance, budget caps): this machine's logins, each
  with its freshest reading. A working token's reading beats one from an
  expired login.
- **For display**: that plus logins signed in only elsewhere, marked
  `notSignedInHere` ("Not signed in here"), never picked.

Freshness comes from each window's `readAt`. `lastSnapshot` stays this
machine's own reading, and `usage.getLiveQuota` answers unpooled, so a peer's
number is never echoed back as this machine's.

## Claude credential hygiene

Anthropic rotates the refresh token on every refresh and the Claude CLI keeps
the only copy, so **DAEX never spends a Claude refresh token**: it reads logins
(`readClaudeLogin`: `ok`, `expired`, `signed_out`, `unreadable`) and lets the CLI
renew.

- Background polls do not touch the default login's Keychain item until a poll
  in this process has read it. A scoped account (`CLAUDE_CONFIG_DIR`) reads its
  own namespaced item (`Claude Code-credentials` plus the first 8 hex of the
  directory's SHA-256), never the default's token.
- An expired token is reported, not refreshed. A background poll may run the
  CLI fallback at most every 30 minutes per account
  (`refreshClaudeLoginInBackground`) so idle accounts stay readable; on macOS
  the base account is left out until its Keychain item was read.
- A 401 drops only the cached access token
  (`invalidateCachedClaudeCredentials`).
- "Couldn't refresh Claude — showing last reading" means a fresh poll returned
  no windows while unexpired windows exist (a transient 5xx, timeout or 429); it
  self-heals.

## Banked resets

Codex and Claude report banked reset credits (`parseCodexResetCredits`,
`parseClaudeResetCredits`) onto `UsageAccount.resetCredits`, which gates **Use
reset** (`ade.usage.consumeResetCredit`).

- The spend goes to the machine that produced the row. When this machine cannot
  read a login's credits, the freshest peer's count is shown
  (`UsageAccount.resetCreditsOn`) and the spend runs on that peer
  (`consumeOwnResetCredit`), carrying the email so a re-signed folder refuses.
- A Claude spend holds its pending claim (grant id and request id) until Claude
  answers, so a retry repeats the exact request.
- A failed read is not a confirmed zero; last known credits stay.
- **Codex app-server reads hold stdin open** until every response id arrives
  (`runCodexAppServerJsonRpc`); closing it early aborts the request and once
  cached a false zero.

## Per-turn usage ledger

`turnUsageLedger.ts` writes one JSON line per finished chat turn to
`<adeHome>/usage/turns-YYYY-MM.jsonl`, with quota readings in
`quota-YYYY-MM.jsonl`. Machine-local, never synced; three months kept.

- **Fields**: session, lane, provider, account key (`usageAccountId.ts`:
  `<provider>:<instanceId>`, else `:<email>`, else `:local`, the same rule as
  the poller), requested and served model, token split, context, requests,
  provider cost, plan units, compactions, and `apiEquivalentUsd` (the turn at
  list price, the one currency comparing plan and API turns). Unknown fields are
  null.
- `inputTokens` is uncached input for every provider. OpenCode bills reasoning
  separately (`reasoningBilledSeparately` in `tokenSplit.ts`).
- **Observe only**: the chat service calls `observe` and `settle`; a ledger
  failure never reaches a turn.
- **Late corrections** (`turnUsageReconcilers.ts`): Cursor's dashboard events
  (served model, charge; `ADE_CURSOR_DASHBOARD_USAGE=0` turns it off) and
  Droid's Factory credits append amendment lines.
- **Quota readings** are written when the percent moves half a point or a new
  window starts (resets within five minutes are one window).
- **Burn rate** (`quotaBurnRate.ts`): API-equivalent dollars of DAEX turns per
  percent a window moved, over 14 days. API-key, local and `routedAway` turns do
  not count. Other clients on the login also move the percent, so it is a lower
  bound.
- Read with `daex usage turns --days 14 --text` (`usage.getTurnUsageSummary`).

## Model router (shadow)

`main/services/router/` rates routes (harness × model × effort) from the daily
model registry (`GET /router/registry` on the account directory, cached at
`<adeHome>/router/registry.json`, refreshed at most every 12 h;
`ADE_MODEL_REGISTRY_FILE` overrides). `routerCore` classifies a subagent's task
from its type, label and brief and picks the cheapest route that keeps quality.
It is **shadow**: it changes no turn and logs decisions to
`<adeHome>/usage/router-shadow-YYYY-MM.jsonl` (`ADE_MODEL_ROUTER_SHADOW=0` turns
it off).

- `daex router shadow | routes | pick | refresh | efficiency` and `daex models
  catalog | sheet` read it (`usage.getRouterShadowSummary`,
  `usage.getRouterEfficiency`, `usage.getModelCatalog`, `usage.getModelSheet`).
  None changes routing.
- Efficiency replays the turn ledger, changing route only at free switch points
  (first turn, after compaction, after cache expiry, a user model change).
- Known limits: burn rates count DAEX turns only, so cross-plan picks are not
  yet trustworthy.

## Daily usage research report

Each machine sends one compact report per finished local day to the account
directory (`POST /usage-research/daily`; contract
`apps/desktop/src/shared/usageResearch.ts`, checked by the Worker's
`usageResearchContract.test.ts`).

- **Sent**: grouped turn counts, token sums, costs, percentiles, quota ranges
  and burn rates per provider/model/plan tier, plus install id, day, version,
  platform and UTC offset.
- **Never sent**: emails, account or instance ids, paths, lane/session/turn ids,
  prompts, file names, hostnames, keys or tokens. Path-, email- or URL-like
  names become `_redacted`. `installId` and `accountRef` are salted hashes; the
  salt never leaves the machine. The upload sends no account token.
- **Consent**: only while product analytics is effective
  (`productAnalyticsService.getStatus().effective`); `DO_NOT_TRACK=1`, a stored
  opt-out or `ADE_USAGE_RESEARCH=0` stops it, checked before every request.
- **Schedule** (`usageResearchUploader.ts`, started by
  `apps/ade-cli/src/bootstrap.ts`): 2 minutes after start, then hourly, the 7
  days before today, oldest first. `<adeHome>/usage/research-uploads.json` holds
  the salt and per-day outcome; nothing is sent until the salt is on disk.
- Body at most 32 KB (hour histograms dropped, then small groups merged into
  `_other`); the same day always gives the same bytes.

## Surfaces

- **Header popover** (`HeaderUsageControl.tsx` → `UsageLimitsBand` →
  `UsageAccountRow`): one row per login named by email, windows as headroom
  meters (`usageHeadroomColor`). Accounts get no colour of their own. Mount
  reads the cached snapshot and records demand, never forcing a provider
  request. Each provider can be hidden from the compact header (eye control;
  **Show usage in header** on the providers page).
- **One login is one row**: two config homes on one email collapse to the owner
  (`sameLoginOwner`); copies add no quota (`countProviderLogins`). Accounts are
  named by `providerAccountName` and selected by email (`--instance <email>`).
- **Settings › Usage** (`AdeUsageSection.tsx`): totals with trends, rate-limit
  gauges (`UsageLimitGauges`, `usageLeftLevel`: amber at 20% left, red at 5%),
  the daily chart, breakdown by model, chat, lane or account, model detail with
  Set price and Map to, and pooled live limits on the account scope.
- **CLI**: `daex usage limits` (`usage.getUsageLimits`,
  `shared/usageLimitsReport.ts`) is the small agent-sized read of the cached
  snapshot, one row per account with state and marks, never refreshing;
  `--machine` / `--all-machines` read others. `daex usage refresh [--history]`,
  `daex usage stats [--by …] [--provider P --model M]`, `daex usage prices`.
  The DAEX MCP tool `usage_limits` runs the same read.
- **iOS** reads `usage.getQuotaSnapshot` and refreshes with `usage.refreshQuota`
  (bounded, no Keychain prompts), caches per host, and never receives
  credentials. Older hosts show update guidance.
- **Web**: `usage.liveReadings()` is false when no computer answers; the band
  says limits show while a computer is on.
