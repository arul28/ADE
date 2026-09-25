# Usage tracking strategy

ADE treats live provider limits and retrospective token/cost history as two
different workloads. Live limits must remain fast enough for the desktop,
terminal, CLI, and paired mobile clients; history scans may walk large local
ledgers and therefore run only through the Activity path.

This design was reviewed against CodexBar `main` at
[`8489002e19eed002016b29faa7de0f8c5371c65c`](https://github.com/steipete/CodexBar/tree/8489002e19eed002016b29faa7de0f8c5371c65c)
on 2026-07-10. The relevant upstream references are
[`claude.md`](https://github.com/steipete/CodexBar/blob/8489002e19eed002016b29faa7de0f8c5371c65c/docs/claude.md),
[`codex.md`](https://github.com/steipete/CodexBar/blob/8489002e19eed002016b29faa7de0f8c5371c65c/docs/codex.md),
[`providers.md`](https://github.com/steipete/CodexBar/blob/8489002e19eed002016b29faa7de0f8c5371c65c/docs/providers.md), and
[`refresh-loop.md`](https://github.com/steipete/CodexBar/blob/8489002e19eed002016b29faa7de0f8c5371c65c/docs/refresh-loop.md).

## One poller per machine

Provider quota is a machine fact, not a project fact. The ADE brain polls it
once per machine and every project scope in that process attaches to the same
poller: one poll timer, one demand lease, one snapshot. Two ADE windows on one
computer — on two projects, or one on a project and one on Welcome or the Hub —
read the same numbers, and a refresh from any of them benefits all of them.

Every snapshot carries a producer revision: `revision.producerId` names the
service instance that built it and `revision.seq` counts the snapshots that
instance has handed out. Consumers order by `seq` within one `producerId` and
always accept a snapshot from a different producer, which is what stops two
unrelated wall clocks from being compared. A snapshot returned to a caller was
always also emitted to every subscriber, so no window ever holds a value the
others could not receive.

Project-scoped answers stay per project. Each scope brings its own project
database and repository root, so ADE's own token/cost stats, GitHub activity,
and the `project` scope of the Usage page are still about the project that
asked — the transcript ledgers are simply walked once for the whole machine and
projected per project root.

A window with no local project — Welcome, the Hub, an Account page, a
remote-machine tab — reads through the brain as well, borrowing a project scope
the brain has already booted (`bootedUsageScopeRoot`). Desktop usage IPC
proxies those reads to that scope, and `main.ts` relays the brain's usage
events onto `ade.usage.event` so the window stays live without a runtime
binding of its own. Bound windows ignore that channel and keep the runtime
event stream. The in-process tracker is the fallback producer only when no
brain scope is running, which is also the only time that tracker polls.

## Smart balance and auto-start windows

Smart balance applies to Claude and Codex when it is enabled for that provider.
New chats consider only signed-in instances. Each instance is scored as
`five-hour headroom × (1 − w) + weekly headroom × w`, where `w` increases
linearly from `0.35` at the start of the weekly window to `0.85` at its reset.
When the weekly duration is unknown, `w` is `0.5`. The default instance wins a
tie, and a snapshot with no usable quota data falls back to the default without
guessing. An explicit account selection always wins over balancing.

A chat that is already running stays on the account it started on: the provider
thread lives in that account's config directory and cannot be handed to another
login. When that chat hits a usage limit and another signed-in account still
has immediate room, smart balance starts a new chat on that account and sends
the interrupted task there. The original chat does not also auto-resume. With
smart balance off, the same move is only an offer on the usage-limit pill
(Continue on that account). A chat created by that handoff does not hop
again on its own, and a subagent never does. An account with no readable
windows, or with a window already at 100%, is not a candidate.

Auto-start windows are off by default. When enabled, the usage service arms one
unref'd timer per Claude or Codex instance that has a future five-hour reset.
Five seconds after that reset, ADE sends one small provider request through the
instance's own config home, using Claude Haiku 4.5 or Codex GPT-5.6 Luna, then
refreshes quota data. The timer is replaced when a newer reset arrives and is
reconstructed from the next snapshot; no timer state is persisted. Accounts
without a five-hour window, including API-key-only accounts, never run the
request. ADE records only the provider, instance, model, success, and duration,
never the response text.

## ADE versus CodexBar

| Concern | ADE before ADE-117 | CodexBar reference | ADE after ADE-117 |
|---|---|---|---|
| Claude source | Anthropic OAuth usage endpoint only | App auto: OAuth → Claude PTY → web | OAuth first; explicit user refresh may use a bounded Claude PTY fallback. Automatic refresh never opens the interactive CLI. |
| Claude auth | Every macOS credential lookup could invoke `security`, including background work | Explicit Keychain prompt policy; background reads can be no-UI | Background reads skip Keychain and use the credentials file/cache. Keychain repair is reserved for explicit user refresh. |
| Codex source | HTTP quota endpoint, then redundant app-server work even when HTTP returned complete windows | OAuth HTTP or CLI RPC, with source-specific fallback and bounded subprocesses | HTTP success returns immediately. RPC runs only for 401 recovery or a successful but unrecognized HTTP schema. |
| Cost/history source | Provider JSONL/SQLite scans could run as part of explicit quota refresh | Cost scans have separate caches and scheduling | `refreshHistory()` owns ledger invalidation/scans. `forceRefresh()` is quota-only. |
| Refresh cadence | Fixed two-minute polling | Fixed or adaptive cadence with coalescing | Adaptive demand lease: 60 s while usage is visible/recently requested, 2 min normally, 5 min after 15 min idle. One provider batch is in flight at a time. |
| Cache | Last snapshot plus provider/GitHub scan caches | Separate usage, cookie, and cost caches | Separate in-flight quota and history work. Each provider retains its last-good windows and last-success timestamp. |
| Stale behavior | A failed refresh could leave source/freshness ambiguous | Stale/error state remains visible | Provider status carries `updatedAt`, `lastAttemptAt`, error kind, optional next retry, and the source when one is known. Unexpired last-good windows remain visible with their source and an explicit stale/re-auth state. |
| Latency | User refresh could wait on every provider ledger and GitHub scan | Expensive storage scans do not block normal usage refresh | Quota refresh performs only provider credential/quota work. Large history scans can remain pending while a quota refresh completes. |
| Errors | Mostly provider-prefixed strings | Provider-specific surfaced errors and bounded timeouts | Structured classification for auth, forbidden, conflict, rate limit, timeout, network, invalid response, and unavailable. `Retry-After` and exponential backoff prevent refresh storms. |

Codex quota payloads are normalized in `providerQuotaParsers.ts`. Current HTTP
responses can report only one weekly bucket in `primary_window`, while older
responses and app-server snapshots may expose five-hour and weekly buckets in
primary/secondary positions. ADE therefore prefers the bucket's advertised
duration (`limit_window_seconds`, `window_duration_seconds`, or the equivalent
minute fields) and uses position only when duration metadata is absent. This
keeps the compact header and detailed Limits panel truthful when a provider
omits one window or changes its ordering.

Codex 0.145 also reports an account-level spending cap. `parseCodexRateLimitSnapshot`
returns `{ windows, spendControlReached? }` (reading `spendControlReached` /
`spend_control_reached` from any of the rate-limit envelope shapes), and both the
HTTP and CLI-RPC poll paths carry the flag through `UsageProviderPollResult`.
`parseCodexRateLimitWindows` is retained as a windows-only wrapper. The
coordinator stores `spendControlReached` on the published `UsageSnapshot`; when
Codex is skipped or returns no windows for a round, the last known value is
carried forward rather than dropped. Surfaced state: the header warning line adds
"Codex spending cap reached", the Codex card in the Limits panel shows a
"Spending cap reached" banner, and the paired iOS `WorkUsageActivityCarousel`
shows the same note under the Codex compact row (`MobileUsageQuotaSnapshot.spendControlReached`).

## Why Claude appeared to take forever

The slow path was not only Anthropic's endpoint. An explicit refresh invalidated
cost caches and could wait for broad Claude, Codex, Cursor, OpenCode, Droid,
Copilot, Gemini, and GitHub history scans. A macOS credential read could also
spend five seconds in `security`, and overlapping UI/startup requests were
coalesced behind whichever large operation started first. The result was a
correct quota response queued behind unrelated disk and subprocess work.

ADE now records a structured `usage.refresh.phase` entry for credentials,
quota HTTP, CLI fallback, and history phases, including provider, trigger,
duration, outcome, and error kind. These entries identify network/auth latency
without logging credentials or quota payloads.

## Bounded local ledger scanning

Activity reads provider-owned history in place. ADE does not copy, rewrite, or
delete Codex session JSONL under `~/.codex`; Codex remains the owner of chat
history and retention. A single JSONL record can nevertheless be enormous when
it contains embedded command or tool output. That is valid JSONL, but treating
the whole physical line as one JavaScript string can exhaust the runtime before
the parser has a chance to ignore the irrelevant payload.

The Codex history reader is therefore a bounded byte-stream pipeline:

- candidate session and archived-session files are considered newest first,
  with at most 5,000 files per root, 256 MiB per file, and 2 GiB distributed
  across both roots;
- physical JSONL lines are accumulated only up to 16 MiB. An oversized record
  is discarded incrementally until its newline, then scanning resumes at the
  next record instead of retaining or parsing the giant line;
- detailed history stops at 250,000 token entries; and
- concurrent production callers share one in-flight Codex scan, so two open
  projects cannot duplicate the same CPU work and retained entry set.

These limits bound ADE's work; they do not truncate the source files. The
tradeoff is intentionally visible in the data model: an extreme old record or
history beyond the detail budget may be absent from per-day, per-model,
per-project, and estimated-cost attribution.

The all-time token headline has a separate reconciliation path. ADE opens the
newest Codex `state_*.sqlite` read-only, computes the state index's authoritative
thread total, point-looks up the bounded set of JSONL thread ids to avoid double
counting, and treats the result as the union of JSONL history and the current
state index. Per-thread remainders are added newest first within the remaining
entry budget. If detail capacity is exhausted, one zero-cost `lifetimeOnly`
remainder preserves the exact union total without inventing a timestamp,
project, ADE-originated share, or recent-day activity. Daily charts skip that
entry, while the all-time token breakdown includes it.

SQLite reconciliation is bounded too: observed-thread lookups use batches of
500, detailed state rows are capped at 250,000 and by remaining entry capacity,
and the production scanner remains single-flight. History aggregation runs in a
separate process, so filesystem and SQLite work cannot stall the desktop or
headless runtime event loop while terminals, project switching, and remote sync
remain active. Packaged desktop and ordinary CLI builds ship the worker as
`usageLedgerWorker.cjs`; the static ADE runtime invokes the same worker through
its hidden embedded entrypoint because a single-executable build cannot load a
sidecar. Desktop packaging validation derives its required ADE CLI payload from
`build.extraResources`, so a newly built worker cannot be omitted silently.
This keeps Activity useful on large Codex histories without putting live Limits
refreshes or the ADE runtime behind an unbounded disk/memory pass.

`usageLedgerScanners.ts` is the one list of history scanners. The worker walks
it one provider at a time. The in-process scan (a test harness that injects
scanners by their `scan…Logs` names) walks the same list. The worker reads its
whole stdin input as bytes and decodes it once, so a multi-byte character in a
project path is not split at a chunk boundary.

### The worker streams, so a timeout is partial rather than total

The worker used to buffer every provider and write one JSON object at the very
end, which meant a timeout — or any failure — threw away eight finished scans
along with the one still running. It now writes NDJSON: a
`ade-usage-ledger-stream/1` header naming the full roster it is about to walk,
then one line per provider as that provider finishes. The header is what lets
the client tell "this provider reported nothing" from "this provider never got
to run" and mark the latter incomplete rather than removed. On timeout the
client folds whatever arrived and returns it.

`incompleteProviders` is the load-bearing half of that result. It carries both
providers the scan reached but could not read in full and providers whose root
exists and yielded nothing, and it is consumed in exactly one place: as
`publishLocalRollup`'s `skipReconcileProviders`. Rows a round failed to produce
must not be read as a deletion, or one partial scan would wipe replicated
history on every peer; the same set carries the previous round's cost snapshots
forward so a partial scan cannot lower a provider's totals.

The worker's own ceiling (`LEDGER_WORKER_TIMEOUT_MS`, ten minutes) is a bound on
a wedged child, not a budget for a normal scan — 32 GB of Codex sessions
measured at 78 s for all nine providers. Every budget in front of it is derived
from it rather than guessed, and increases monotonically outward: the remote
JSON-RPC transport (`USAGE_REFRESH_HISTORY_REMOTE_TRANSPORT_TIMEOUT_MS`,
worker + 15 s), then the renderer IPC and local-runtime action budget
(`USAGE_REFRESH_HISTORY_TIMEOUT_MS`, worker + 30 s). On the old 30 s IPC default
the renderer rejected with a raw timeout and blanked the page while the daemon
kept scanning for another nine minutes.

## Where a token price comes from

Cost is an estimate, but it must be the *same* estimate everywhere: two machines
reporting different dollars for identical usage is the failure the ordering in
`usagePricing.ts` exists to prevent.

models.dev (`https://models.dev/api.json`) is the single source of token prices.
The same model is listed there by its vendor and by dozens of resellers at
different prices, so a bare model id (`claude-sonnet-4-5`) always takes the
vendor's own row (`pickModelsDevEntries` in `services/ai/modelsDevCatalog.ts`,
shared with registry enrichment); a `provider/model` name
(`openrouter/anthropic/claude-sonnet-4-5`) takes that provider's row.

`resolveTokenPrice` answers, in order: an exact models.dev match; the
registry's price for that exact model — which `model-manifest.json` can set for a
launch-day model models.dev has not listed yet; the longest models.dev key the
name extends (`claude-sonnet-4-5-thinking` → `claude-sonnet-4-5`); then zero.
`tokenPriceSource(model)` reports `list` (models.dev) or `fallback`, so a
headline cost figure can say where its rates came from. There is no
hand-maintained rate table.

Mechanics:

- models.dev is fetched with a 10 s timeout, cached to
  `~/.ade/models-dev-pricing.json`, and refreshed once a day; a failed refresh
  keeps whatever is loaded.
- a cached copy is dropped after 30 days, so a machine that went offline in
  March does not price this year's usage at March's rates.
- a models.dev `cost` gives USD per million tokens for `input`, `output`,
  `cache_read`, and `cache_write`. A row with a read rate but no write rate
  bills a first-time cached prefix at the plain input rate, unless the model's
  vendor charges a write premium (Claude, and OpenAI from GPT-5.6 on), where a
  missing write rate is `input × 1.25`. A row with neither cache rate falls back
  to the `input × 0.1` / `input × 1.25` ratios. An entry with no usable input or
  output rate is skipped.
- long-context tiers come from `cost.tiers` (`{ tier: { type: "context",
  size } }`), else `cost.context_over_200k`. OpenAI (GPT-5.4 and later, above
  272k), xAI Grok (200k), Google Gemini Pro, Alibaba Qwen, and MiniMax bill a
  whole request at the tier rate once its context passes the threshold. A tier
  applies only to a ledger entry that records ONE request and carries
  `requestContextTokens` (Claude, Codex per-response, Pi, Qwen, Copilot CLI);
  turn and session aggregates are priced at the base rate.
- DeepSeek rates double in DeepSeek's published peak window (UTC Monday–Friday
  01:00–04:00 and 06:00–10:00); models.dev lists the off-peak price. Chinese
  public holidays are not modelled. OpenCode entries carry OpenCode's own cost
  figure, which uses the off-peak price, so the peak rule does not reach them.
- lookup tries the provider-prefixed name, then the canonical name, then an
  alias, then the longest key the canonical name extends — so a dated model id
  resolves to its family without a per-release table edit.

The answer reaches the page rather than staying an implementation detail. Each
provider's stats carry `pricingSource` (`list`, `fallback`, or `mixed` when its
models resolved both ways) and the payload carries `pricingUpdatedAt` — when the
loaded copy of the list was fetched, or null when nothing but the built-in table
priced anything. Settings > Usage turns the two into one plain sentence under
the cost figures. The number is the page's headline, and an unexplained headline
cost has burned users before.

## Lifetime stats survive lane deletion

Lane deletion cascades away `lanes`, `terminal_sessions`, `claude_sessions`,
`session_deltas`, and the lane's `operations` rows, so every all-time ADE figure
used to count only the lanes nobody had tidied up. Deleting a lane now writes one
aggregate `lane_usage_tombstones` row first — integer counters, the created and
deleted calendar days, and a hex active-day bitmap, and nothing that could
reconstruct what the lane was doing. `usageStatsStore` range-filters those rows
by the lane's active span, excludes duplicate-absorb rows from creation and
deletion counts, and folds their decoded active days into streaks. AI token
totals were never affected: they come from provider transcript files ADE does
not own or delete. See
[Lanes: what a deleted lane leaves behind](../lanes/README.md#what-a-deleted-lane-leaves-behind).

## Account scope: usage across every machine

`ADE_USAGE_SCOPES` is `account`, `machine`, `project` — one three-way control,
not two independent axes. A project normally lives on one machine, so "this
project across all machines" is a combination worth neither the second control
nor the four states to test.

Two rules shape the account scope:

- **Aggregates only.** A machine publishes day × provider × model totals and
  nothing else. Raw transcript records never leave the machine that scanned
  them, never enter the sync layer, and are never held in memory by the merge.
  A heavy year of use is a few thousand small rows.
- **Historical only.** Cost, tokens, and code history merge; the live quota
  windows do not. Provider rate limits are tied to the provider account rather
  than the machine, so every machine already reports the same window, and
  merging them would either double a shared limit or imply a per-machine
  difference that does not exist.

GitHub metrics are excluded from the merge for the same reason in a different
direction: they are repo-scoped, so three machines with the same clone each
report the same pull requests and summing them would triple work that happened
once. The account page shows the local machine's GitHub numbers and says so in
`sourceNotes`.

### Transport: a durable floor plus an opportunistic refresh

Each machine writes its own rollup to `usage_machine_rollups` and
`usage_machine_rollup_meta`, and the existing cr-sqlite CRR pump replicates
those tables desktop-to-desktop. That durable copy is the floor the page renders
from, which is what lets an offline laptop still count toward account totals.
On top of it, `accountUsageLiveRefresh.ts` asks whichever machines are reachable
right now for a fresh rollup over the paired remote-connection pool
(`usage.getUsageRollup`, `viewerAllowed`), capped at 12 machines per refresh so
a large fleet cannot turn one page open into a fan-out storm. Everything in that
path is best effort: an asleep, unpaired, or slow machine produces a failure
entry and keeps its published rollup rather than taking the other machines'
numbers down with it. An account-scoped read has a rate floor because the read
starts a refresh whose update causes another read; `force` (set only by the
Refresh button) bypasses it.

Both tables are in `MOBILE_CHANGESET_EXCLUDED_TABLES`. The phone reads its usage
from the host over `usage.getAdeStats` and never queries them, so shipping every
machine's rows to it would be pure churn.

`usage_machine_rollups` carries its uniqueness in the composite primary key
`(machine_key, day, provider, model)`: a CRR-converted table may not carry any
UNIQUE index besides its primary key. Writers upsert on that key and skip no-op
updates so republishing unchanged history does not churn the CRR clock.

### Dedupe: one transcript source, counted once

Two machines that mount the same home directory — a synced home, an SMB/NFS
share, a roaming profile — scan the same transcript files and would otherwise
double every token. Nothing about a machine's own identity detects that: both
report distinct machine keys and hostnames, and usually the very same
`/Users/<name>` path, so comparing paths is both a false-positive risk across
separate machines with the same username and a false negative when one side
mounts the share elsewhere.

So the identity travels with the files: a `.ade-usage-source` marker id written
once into the transcript home. `isSameTranscriptSource` is marker-then-roots and
nothing else:

- when both sides carry a marker, equal ids are the same source and different
  ids are not — full stop;
- when either side has no marker (a read-only mount, a locked-down profile), the
  folded roots must match exactly.

Roots are sha256 digests of `pathKey`-normalized paths, so no absolute path
leaves the machine that scanned it, and no comparison uses `===` on a raw path.

The marker is terminal. The trade it buys: two machines cloned from one disk
image share a marker, merge, and under-count. That failure is visible — the
Machines list shows the second machine as `deduped` against the first — and
deleting `.ade-usage-source` on one of them mints a fresh id on its next scan.
It is deliberately the opposite direction from silently doubling every number on
the page.

### What the Machines list reports

Every machine appears with a state: `live` (refreshed while the page was open),
`rollup` (counted from its last published rollup), `stale` (counted from a
rollup older than the six-hour freshness horizon, with the lag stated),
`deduped` (excluded, with the machine it was deduped against), or `failed`
(reported nothing usable — missing from the totals, never an error that empties
the page).

## Claude credential hygiene (refresh storms)

`~/.claude/.credentials.json` can be a stale leftover while the live login sits
in the macOS Keychain (the Claude CLI's default store). The default account's
background polls must not touch the Keychain, so these rules prevent a dead
file token from turning into an OAuth storm that gets the whole client
rate-limited (429) by Anthropic. A scoped account (`CLAUDE_CONFIG_DIR`) often
has no credentials file at all, so its background polls may open that
account's namespaced Keychain item; the successful read is cached for the
process and later polls reuse it:

- Claude Code namespaces the Keychain item per config directory: the machine's
  default login is the bare `Claude Code-credentials`, and a
  `CLAUDE_CONFIG_DIR` login (`~/.ade/provider-homes/claude/<id>`) appends the
  first 8 hex characters of the SHA-256 of that directory. ADE reads the item
  matching the account it is asking about, so a scoped login is never mistaken
  for signed out — and never handed the default account's token.
- Any successful Keychain read (explicit refresh, provider-status checks)
  populates the in-memory credential cache *under that account's own key*, so
  background polls reuse the live login instead of the file.
- A refresh token the token endpoint *definitively* rejects — a non-transient
  4xx such as `invalid_grant`, or a 200 with no `access_token` — is
  negative-cached for 24 h and never re-tried per poll. Transient conditions
  are cached for only 10 min so a temporary blip can't lock out an otherwise
  valid token: 5xx, plus token-endpoint 429 (rate-limited) and 408, plus
  network/timeout aborts. A rate-limited refresh is treated as transient, not
  as a rejection.
- When a token is expired and cannot be refreshed, the reader reports "no
  usable credentials" (→ reconnect state) instead of returning the dead token,
  which would guarantee a 401 plus another doomed refresh on every cycle.
- A 401 from the usage API drops only the cached access token
  (`invalidateCachedClaudeCredentials`) and forces the next read to re-consult
  its sources. It deliberately preserves the refresh-token refusal memory, so a
  revoked-but-unexpired file token can't reopen per-poll refresh attempts
  against a refresh token the token endpoint already rejected.

## Reproducible baseline

The pre-change baseline came from ADE structured logs for 2026-07-10. Measure
the same events with:

```sh
rg 'usage\.(forceRefresh|getUsageSnapshot)' ~/.ade/logs -g '*.log'
```

Observed wall time:

| Operation | Samples | min | p50 | p90 | max | mean |
|---|---:|---:|---:|---:|---:|---:|
| `forceRefresh` | 44 | 6.648 s | 19.138 s | 27.204 s | 30.002 s | 20.414 s |
| `getUsageSnapshot` | 71 | 0.501 s | 7.359 s | 37.091 s | 121.395 s | 14.676 s |

For regression coverage, run:

```sh
npm --prefix apps/desktop exec -- vitest run src/main/services/usage/usageTrackingService.test.ts
```

The suite fixes the behavioral baseline: quota-only refresh must not start any
ledger scanner, must complete while a deliberately pending large-ledger scan is
still unresolved, Codex HTTP success must not spawn the CLI, and 401/403/409/429,
timeout, schema drift, `Retry-After`, stale carry-forward, and Claude CLI parsing
must remain covered. Codex parser coverage also pins duration-based window
classification so weekly-only and reordered five-hour/weekly responses cannot
be mislabeled by their primary/secondary positions.

## Provider strategy boundary

`UsageProviderStrategy` defines the live-quota boundary, while the coordinator
keeps four concerns separate:

- `poll(context)` obtains a provider-authoritative limit snapshot.
- local history scanners intentionally remain outside the strategy and never
  run from the live refresh path.
- source and auth behavior are provider-owned.
- the coordinator owns coalescing, adaptive cadence, backoff, cache persistence,
  stale carry-forward, phase timing, and publication to every client.

Only provider-authoritative quota or billing data may create a live limit. Local
token estimates remain Activity/history data and must not be presented as a
personal subscription quota.

## Live limits beyond Claude and Codex

The top-bar usage control and the Limits popover list every live-quota provider
that is signed in on this machine. Claude and Codex stay on their existing
connection signal. Cursor, Copilot, Grok, OpenCode, and Kimi join in that order as
soon as a local credential exists, and a provider with no credential is absent
— it is not an error row and it does not take a mark. Each top-bar mark is the
provider logo inside a thin ring, drawn tight around the mark. The pale arc
is usage: it starts at 12 o'clock and grows clockwise. What is left is drawn
in a headroom colour that is the same for every provider: green from 50% left,
yellow from 25% to under 50%, red under 25% (`USAGE_HEADROOM_THRESHOLDS` and
`usageHeadroomColor` in `usageDesign.ts`, on the theme's `--color-success`,
`--color-warning`, `--color-error`). The pale tint is opaque and much lighter
than the headroom colour. The ring is the week when the
provider reports one, otherwise the month. The control's accessible name still says `wk`
or `mo`, the percent left, and a five-hour window when that provider reports
one. The popover rows keep their text meters. iOS and the TUI have no top-bar
ring; they keep the text meters. Quota window bars in the popover use the
same headroom colours; charts and the extra-usage spend bar keep the provider
colour from `providerColors.ts` (Cursor slate, Copilot green, Grok gray,
OpenCode purple).

The poller checks for a credential before any network call. The five extra
providers run in the same parallel batch as Claude and Codex, each HTTP call
bounded to 4 seconds. A missing credential returns immediately and clears any
previous windows for that provider. A failed refresh of a provider that was
signed in keeps the last unexpired windows and marks them stale, the same way
Claude and Codex already do. These providers are one login per machine: there
is no second account and no "continue on another account".

| Provider | Credential ADE reads | Quota request | What the bar shows |
|---|---|---|---|
| Cursor | `cursorAuth/accessToken` in the local Cursor `state.vscdb` (macOS `~/Library/Application Support/Cursor/User/globalStorage`, Linux `$XDG_CONFIG_HOME/Cursor/...` or `~/.config/Cursor/...`, Windows `%APPDATA%\Cursor\...`). A token whose JWT expiry is inside 60 seconds is skipped. ADE does not refresh it. | `GET https://cursor.com/api/usage-summary`. The `WorkosCursorSessionToken` cookie is `userId::accessToken`, with the user id taken from the JWT `sub` after the last `\|`. A bare access token is rejected as signed out. No browser-cookie import, and not the team Admin API. | Plan percent for the billing cycle, labeled monthly. |
| Copilot | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`, else `oauth_token` in `github-copilot/hosts.json`. If those are empty and a Copilot config or `gh` hosts file exists, `gh auth token` runs at most once every 15 minutes (immediately on a user refresh). | `GET https://api.github.com/copilot_internal/user`. Premium interactions remaining becomes used percent. ADE reads account email from `GET https://api.github.com/user` with the same token. If that call fails, ADE keeps the last email it read with the same token; a different token gets no remembered email. | Monthly premium quota, including the top-level `quota_reset_date`/`quota_reset_date_utc` when present. |
| Grok | Non-expired bearer in `~/.grok/auth.json` (`GROK_HOME` overrides the directory), else `GROK_OAUTH_TOKEN`. Management keys (`xai-…`) and cookie-shaped values are ignored. | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`. No grok.com cookie import. | `creditUsagePercent` for the current period, labeled weekly or monthly from the period length. |
| OpenCode | `OPENCODE_API_KEY`, else an OpenCode or Zen key in the local OpenCode `auth.json`. Other providers' keys in that file are not sent. When neither exists, the Go plan's own console login is read from `opencode.db` (`account.access_token` plus `account_state.active_org_id`; skipped when past `token_expiry`). ADE refreshes neither credential. | `GET https://opencode.ai/zen/go/v1/usage` for an API key. For the console login, `GET https://opencode.ai/console/api/go/status` with the `x-org-id` header (the header the console requires). | Rolling 5-hour, weekly, and monthly percents. The API-key path reads the reported percents (a value of 1 is 1%, not 100%); the console path computes `100 × usedMicroCents / limitMicroCents` from the string meters and uses the subscription's `access.endsAt` for the month reset, which carries none of its own. An account without a Go plan answers `access: null` and shows no OpenCode row. Both paths are fixture-verified; the console path is live-verified against a Go account on the development machine. |
| Kimi | Non-expired `access_token` in the token file Kimi Code itself reads (`$KIMI_CODE_HOME`, `~/.kimi-code` by default). `shared/kimiCodeLogin.ts` finds it the way Kimi does. First it reads `[providers."managed:kimi-code"]` in `config.toml`, which holds the API base (`base_url`) and the credential slot (`oauth.key`). The mainland-China default slot is `credentials/kimi-code.json`. Any other host and base, including `kimi login --region global`, has its own `credentials/kimi-code-env-<hash>.json`. `KIMI_CODE_BASE_URL` and `KIMI_CODE_OAUTH_HOST`/`KIMI_OAUTH_HOST` override that entry, as they do for Kimi. With no entry, ADE reads `kimi-code.json`, and the `region` marker picks the mainland-China or global base. A login kept in the OS keyring is not read. ADE never refreshes the token. | `GET {base}/usages`, plus `GET {base}/me` with the same bearer token for email and nickname. The top-level `usage` block (`used`, `limit`, `resetTime`) is the weekly quota. Each `limits[]` row reads `used`, `limit`, and `resetTime` from its `detail`, and its length from `window.duration` times `window.timeUnit` (`TIME_UNIT_MINUTE`, `_HOUR`, `_DAY`, or `_WEEK`). Counts may arrive as numeric strings, and an omitted `used` is 0. If `/me` fails, ADE keeps the last email it read with the same token, so the account id does not fall back to `kimi:local`. A different token gets no remembered email, because it may belong to a different account. Kimi rotates its token when it refreshes, so a refresh that lands on a failed `/me` shows `kimi:local` for that one poll. | The weekly quota plus each limit, typed by length: 8 hours or less is the 5-hour window, 10 days or less is weekly, longer is monthly. The first window of each type is kept. The response shape matches Kimi Code's own client (`packages/oauth/src/managed-usage.ts`). ADE's parsing is fixture-verified. Kimi has not been live-verified on the development machine. |

Gemini, Droid, Pi, and Qwen have no remaining-quota source, so ADE adds no
limits card for them; their spend comes from local history. The history scan
reads Pi (the session root Pi itself uses: `PI_CODING_AGENT_SESSION_DIR`,
else the `sessionDir` in Pi's `settings.json` with `~` expanded, else
`sessions/` under `PI_CODING_AGENT_DIR` or `~/.pi/agent`),
Qwen (`QWEN_HOME` or `~/.qwen`, `usage/token-usage-YYYY-MM.jsonl`), and Grok
(`GROK_HOME` or `~/.grok`, `sessions/**/updates.jsonl`) alongside Gemini and
Droid, and reads Copilot CLI's measured `session-store.db` as well as the
`session-state` event log and VS Code transcripts — a measured SQLite turn wins
over the same session's estimated event-log turn. Kimi writes no token counts to
disk, so it is not scanned; its spend appears in live chats only.

Droid writes session totals to a `.settings.json` file beside each session
log. The history scan spreads those totals over the session's assistant calls.
Droid's `thinkingTokens` are already inside `outputTokens`, so the scan bills
the output count only and never adds thinking to it.

Primary references: [CodexBar Cursor](https://github.com/steipete/CodexBar/blob/main/docs/cursor.md),
[CodexBar Copilot](https://github.com/steipete/CodexBar/blob/main/docs/copilot.md),
[CodexBar Grok](https://github.com/steipete/CodexBar/blob/main/docs/grok.md), and
[CodexBar OpenCode Go](https://github.com/steipete/CodexBar/blob/main/docs/opencodego.md).

Droid has no remaining-quota endpoint, and ADE shows no limits card for it.
When the user supplies an optional Factory API key (`fk-…`) in Settings, ADE
reads the credits that each Droid session used from the
[Factory API](https://docs.factory.ai/api-reference). ADE reads per-session
credits only. It does not read monthly consumption. Without the key, Droid
reports no quota source, not an error.

After each Cursor chat turn on a saved Cursor API key, ADE asks
`Agent.getUsage` for the turn's usage. A cloud turn asks for its own run. The
turn's `done` event waits for the answer, up to 12 s. ADE puts the run's tokens
on `done` and records one billed row, `cursor:getUsage:<runId>`, in
`usage.cursor.billedEntries.v1` (`cursorBilledUsageStore.ts`). The row keeps
Cursor's `chargedCents` as its cost override. A stored Cursor login (no API
key) never calls `getUsage`, and its `done` event is sent at once. Plans
without the usage API answer
`[feature_unavailable] This feature is not available for your account`. The
worker returns a `CursorSdkUsageUnavailableResult` marker for that answer
instead of an error. The marker has no usage, so the turn gets no billed row
and its `done` event does not change. Every Cursor `done` event carries
`account: { provider: "cursor", kind: "subscription", email? }`.

The Usage tab's production scan runs in the ledger worker, and the worker does
not read the billed rows. For an ADE Cursor chat, the tab shows the `cursor-agent`
character estimate from the chat's Cursor Agent transcript. Only the in-process
scan (a test harness that injects scanners) adds the billed rows to the `cursor`
provider, one row per message id.

The per-turn ledger (see below) gets the Cursor turn's tokens and, when a hook
named it, the served model from `done`. `done.costUsd` stays unset for Cursor.
The dashboard reconcile adds Cursor's charge and the served model later. It
reads the per-request Cursor dashboard feed
(`cursor.com/api/dashboard/get-filtered-usage-events`) for the ledger only and
writes no Usage rows.

## Per-turn usage ledger (router input)

The usage page answers "what did this machine spend". A model router needs a
finer answer: what one turn of each provider, account, and model costs here.
`turnUsageLedger.ts` writes that answer as one JSON line for each finished
chat turn.

- **Where.** The ledger lives in `<adeHome>/usage/turns-YYYY-MM.jsonl`, and the
  quota readings live in `quota-YYYY-MM.jsonl` next to it. The files stay on
  the machine and never enter the synced project database, so a new field
  never has to reach an older phone or desktop. Files older than three months
  are deleted on the first write of a month.
- **What.** Each row holds the session, lane, provider, account key, requested
  model, served model, token split, context size, request count, the
  provider's cost (with its source), plan units, the number of context
  compactions the provider finished in the turn (`compactions`), and
  `apiEquivalentUsd`: the turn at the served model's public list price. That last figure is the one
  currency that compares a subscription turn with an API-key turn. The ledger
  writes every field on every row. A field it could not learn is null.
- **Account key.** `usageAccountId.ts` holds the one rule for an account id:
  `<provider>:<instanceId>`, else `<provider>:<email>`, else
  `<provider>:local`. The quota poller uses the same rule, so a ledger row
  always joins its quota window.
- **One token meaning.** `inputTokens` is the uncached input for every
  provider. Codex counts cached input inside its input figure and sends no
  cache split on `done`, so the ledger takes Codex turn totals from the change
  in the thread totals that `codex_token_usage` carries during the turn.
- **Reasoning.** Most providers count reasoning inside `outputTokens`, so the
  price does not add it again. OpenCode reports reasoning apart from output,
  so its `apiEquivalentUsd` prices output plus reasoning at the output rate.
  `reasoningBilledSeparately` in `tokenSplit.ts` names that set and cites the
  evidence for each provider.
- **Subagents.** `subagentTokens` holds the tokens of the turn's subagents.
  It also holds the helper-agent usage that a provider reports on `done`
  (`done.subagentUsage`, for example a Copilot subagent or a Qwen memory
  extractor). These tokens are not in the main token fields.
- **Observe only.** The chat service calls `observe` for each event and
  `settle` on each `done` (in `notifyTurnSettled`). Both catch every error. A
  ledger failure logs one warning and never reaches a turn. Hosts without a
  ledger (tests, the in-process desktop fallback) pass none.
- **Late corrections.** Two providers write their own record after the turn.
  `turnUsageReconcilers.ts` reads it on a timer and appends an amendment line;
  readers apply amendments in time order.
  - Cursor: `cursorDashboardUsage.ts` reads Cursor's dashboard usage events
    with the Cursor desktop login, 20 s, 90 s, and 300 s after the turn. ADE
    does not send an expired login token. An event's `conversationId` is the
    Cursor SDK agent id (verified live), so the match is exact. A turn takes
    the events from 10 s before its first event up to 60 s after its `done`.
    When the same chat starts its next turn sooner, the window stops just
    before that turn starts. Each event goes to one turn only. The amendment
    adds the served model (for example the model behind "auto"), Cursor's
    charge, and the request cost. It also prices the dashboard's tokens again
    at the served model's list price (`apiEquivalentUsd`), because the turn
    priced its row from the requested model. It writes no Usage rows. The endpoint is
    private: a shape change fails closed (no amendment, a `bad_body`
    warning). Set `ADE_CURSOR_DASHBOARD_USAGE` to `0`, `false`, `off`, or
    `no` to turn the read off.
  - Droid: with a Factory key, ADE reads the session's Factory credits 15 s
    after the turn. The row gets the session total, and the turn's own
    `factory_credit` plan usage when the brain saw the session's previous
    total. The reads for one session run in order, so a slow read cannot
    replace a newer total.
- **Quota readings.** The ledger writes a quota reading when the percent moves
  by half a point or more, or when a new window instance starts. Reset times
  less than five minutes apart name the same window instance. Claude's reset
  time moves by microseconds on every poll, and this rule keeps one row for
  that window instead of one row per poll.
- **Burn rate.** `quotaBurnRate.ts` pairs the quota readings of the last 14
  days with ledger rows. For each window instance (one reset time, within the
  five-minute jitter), it divides the API-equivalent dollars of the matching
  ADE turns by the percent the window moved. These rules apply:
  - A span without an ADE turn does not count.
  - A span with a turn that used tokens but has no list price does not count,
    because its dollars are unknown.
  - A turn with no tokens costs $0. It does not make its span unpriced.
  - A turn billed to an API key or served by a local model does not count. A
    turn whose account has `routedAway` set (a keyed preset, a redirected
    endpoint, or a cloud route such as Bedrock) does not count either. These
    turns cannot move a subscription window. `upstream` names only the model
    vendor, so a turn with an `upstream` and no `routedAway` still counts.
  - A row with no account comes from an older host and still counts.
  - A turn counts for a window of its own account. When the provider has one
    account in the readings, every turn of that provider counts, also a turn
    keyed `<provider>:local`. A `<provider>:local` reading is not a second
    account when the provider also has a named account. The poller writes that
    reading when an identity call fails (after a restart or a token refresh),
    so it is the same login without its name.

  Other clients on the same login (a terminal Claude Code, the Cursor IDE)
  also move the percent, so the result is a lower bound on dollars per
  percent, and `headroomUsd` is a safe minimum.
- **Read it.** `ade usage turns --days 14 --text` (action
  `usage.getTurnUsageSummary`) returns totals by provider, account, and model,
  the cache hit ratio, the median context, served-model mismatches, and the
  burn rates. `--group-by provider|provider_model|provider_account_model` is
  optional; the default is `provider_account_model`. `--recent N` (up to 200
  rows) adds the newest rows. The totals and burn rates cover the whole
  machine. The recent rows come from the calling project only. The read is
  asynchronous: it streams each month file line by line, so a 90-day read
  does not block the brain. Only the per-turn append and the first quota
  snapshot's small seed read are synchronous.

## Daily usage research report

Each machine sends one compact report for each finished local day to ADE's
account directory Worker (`POST /usage-research/daily`). ADE uses the reports
to learn how to route turns between models: prices, models, times, and costs
for each provider, mainly Claude and Codex. The wire contract is in
`apps/desktop/src/shared/usageResearch.ts`. The Worker keeps its own copy.

- **What is sent.** One body for each day. It has the schema version, an
  install id, the local day, the app version, the platform, the CPU
  architecture, the UTC offset, and the report. The report has:
  - day totals (turns and dollars);
  - groups of turns with the same provider, requested model, served model,
    account kind, account ref, plan tier, `routedAway`, `upstream`, reasoning effort,
    surface, and subagent-chat flag. Each group has turn counts by status,
    token sums, requests, API-equivalent dollars, provider cost, list-price
    cost, plan units, context and duration percentiles, usage confidence
    counts, served-model mismatches, compactions, and a histogram of the local
    hour each turn started;
  - the day's quota readings for each window (lowest and highest percent,
    window instances, readings);
  - the burn rate of each window at the end of the day;
  - the list price of each group's model, with long-context tiers.
- **What is never sent.** Emails, account ids, provider instance ids, project
  roots and other paths, lane ids, session and turn ids, prompts, file names,
  hostnames, API keys, and tokens. A model, vendor, or effort name that looks
  like a path, an email, or a URL is sent as `_redacted`.
- **Ids.** `installId` is the first 32 hex characters of
  sha256("ade-usage-research-install:" + salt). `accountRef` is the first 12
  hex characters of sha256(salt + ":" + account key). The salt is random for
  each install and stays on the machine. Nothing else ADE sends derives from
  it, so `installId` is not linkable to analytics or the account, and the
  hash alone does not join `accountRef`s across installs. Quota readings are
  account-wide, though: two installs signed in to one account report the same
  window percentages, which can correlate their refs. An unnamed login
  (`<provider>:local`) has no ref. The upload is anonymous: it sends no
  account token.
- **Consent.** The report goes only while product analytics is on
  (`productAnalyticsService.getStatus().effective`). The analytics setting in
  Settings says so in plain words. Turns and quota readings from before the
  user last turned analytics on are not read. To stop the report on a
  machine, set `ADE_USAGE_RESEARCH` to `0`, `false`, `off`, or `no`. Both are
  checked again before every request, so turning analytics off mid-run stops
  the run, and stopping the uploader aborts the request in flight.
- **Schedule.** The brain starts one uploader for each ADE home
  (`usageResearchUploader.ts`, wired in `apps/ade-cli/src/bootstrap.ts`). It
  runs 2 minutes after start, then each hour. Each run looks at the 7 local
  days before today. It never sends today. It sends at most 7 requests, oldest
  day first.
- **Dedupe.** `<adeHome>/usage/research-uploads.json` holds the salt and the
  outcome of each day (`sent` or `rejected`). A recorded day does not go again.
  A day with no turns is not recorded and is not sent. A ledger read that
  fails is not a day with no turns: the run stops and the next hour reads
  again. Nothing is sent until the salt is on disk, because a new salt on
  every start would re-send every day under a new install id. The file keeps
  30 days and is written atomically. The Worker keeps one row for each
  install and day and replaces it on a repeat.
- **Answers.** 200 and 201 record `sent`. 400, 413, and 415 record
  `rejected`. A 429 stops the run; the uploader waits for the `retry-after`
  time (to the next UTC midnight for the identity, daily, and storage caps).
  A 503, another 5xx, or a network error stops the run until the next hour.
  The request times out after 15 s, the response body included. The uploader
  never throws and logs one warning for each kind of failure.
- **Size.** The whole body is 32 KB or less. A report has 150 groups or
  fewer; the smallest groups past that merge into one `_other` group. When a
  body is too large, the uploader first removes the hour histograms. Then it
  merges the smallest groups into `_other`, keeping as many groups whole as
  fit (a binary search on the count). When the body still does not fit, the
  day is recorded as `rejected` and is not sent. A group's served-model
  mismatches use the same rule as the chat's mismatch warning
  (`isServedModelMismatch`), so a harness prefix, a dated snapshot, or a build
  variant of the requested model is not a mismatch. The same
  day always gives the same bytes. A busy day of 200 turns in 9 groups is
  about 10 KB.
- **Worker.** `apps/account-directory` stores the reports in its D1 database
  (`migrations/0012_usage_research.sql`) and keys its per-caller quota on the
  caller's address only (an IPv6 address counts as its /64); it reads no
  account token. A stopped or spent fleet budget answers `429` from a read,
  before any quota is claimed. Each row counts its report plus 256 bytes
  against the storage ceiling, and each write is a compare-and-swap on the
  row's previous size, so a write that loses a race gives back its claims and
  answers `503`. The Worker's `usageResearchContract.test.ts` imports
  `shared/usageResearch.ts` and checks both copies of the contract agree.

## Desktop, CLI, remote, and mobile parity

- Desktop Settings > Usage is one scrolling page. The Live limits band reads
  cached live quota without starting a ledger scan; the rest of the page owns
  the expensive history refresh explicitly.
- `ade usage refresh` refreshes quota only; `ade usage refresh --history` runs
  the separate history path. `ade code` `/usage` reads the runtime snapshot for
  every tracked quota provider and displays source metadata.
- Remote desktop/runtime calls use the same runtime actions as a local project.
- Paired iOS devices request `usage.getQuotaSnapshot` for the host-cached
  snapshot. Pull-to-refresh and Settings refresh use `usage.refreshQuota` and
  therefore run a bounded provider flow on the paired host without interactive
  Keychain or bare-TUI prompts. The phone stores the last snapshot in a
  host-scoped local cache, clears it when the active host changes to an
  unsupported or unidentified machine, shows source/staleness, and never
  receives provider credentials. Older hosts that do not advertise the two
  quota actions remain connected in limited mode and show update guidance.
- Paired iOS also has a full Usage page in Settings (`SettingsUsagePage.swift`),
  composed in the same reading order as the desktop page: cost hero and
  per-provider split, daily chart, Live limits, metric strip, breakdown. It
  reads history through `usage.getAdeStats` and shows update guidance when the
  host does not advertise it. Type, colour, and the chart's top-N/Other rule
  come from `ADEUsageDesign.swift`, the iOS counterpart of `usageDesign.ts`, so
  the page and the new-chat activity module read as one surface.
- Every quota card names the account it describes, its plan, and links out to
  the provider's own limits page. The poller resolves the signed-in email locally
  (`providerAccountIdentity.ts`: Codex `~/.codex/auth.json` `id_token` payload and
  account id, Claude `.claude.json` `oauthAccount.emailAddress`; both via
  `os.homedir()`, no Keychain) and stamps it onto `UsageProviderStatus.accountEmail`, alongside
  `accountPlan` (Codex `chatgpt_plan_type`, Claude `subscriptionType`/
  `rateLimitTier`) and `accountUrl` from the single shared source
  `usageProviderAccountUrl`. The same reader fills
  `AiProviderConnectionStatus.accountEmail`/`accountPlan`, so Settings >
  Providers says "Authenticated as <email> · <plan>" from the same source the
  Limits cards use. Copilot reads `email`/`login` from GitHub `/user`, while Kimi
  reads `email`/`name` from `/me`, using only the bearer already resolved for
  quota. Pi reads only provider key names and `openai-codex.accountId`, then
  matches that id to ADE's own Codex identity; Claude is unmatched because Pi
  has no Claude account id. No token is read into the snapshot, logged, or persisted. Both fields are
  optional: an unknown account shows no line, and a host that predates them
  shows no external link.
- Live limits reads as headroom, not consumption, and **the account is the
  row**. Every signed-in Claude or Codex account is a row, including one that
  has not reported a window yet: that row names the account and says `No usage
  yet` instead of omitting it. Two local logins stay two rows even when they
  share an email, because the row is keyed by the provider account id. Each row
  names itself — provider mark, provider, `email · plan` — and
  carries that account's windows side by side underneath as meters: a short
  label (`5h` / `wk` / `mo`), a bar filled to the HEADROOM with the spent
  remainder hatched, that same headroom in words ("82% left"), and the reset
  countdown. One
  provider with two logins is two rows, both named. Hovering, focusing, or
  clicking a meter on desktop — tapping a row on iOS — opens that window's
  details: plan, the machines reporting it, headroom, absolute reset time,
  pace, the model split, what the reset restores to the pool, and the link out.
  The desktop details panel is portalled above the usage popover and stays open
  while the pointer crosses onto it, so the link can be clicked. The popover
  lists each provider as a logo, a hairline, and the accounts under it, with no
  rounded box around the provider.
  The arithmetic is `usageLimitModel.ts` on desktop (`buildAccountRows`
  transposes `buildLimitCards`, so one set of numbers feeds both shapes) and the
  `adeUsageLimitCards` family in `ADEUsageDesign.swift` on iOS; both are pure
  and clock-injected, and both are asserted against the same numbers. iOS, the
  TUI `/usage` pane, and `ade usage snapshot` name an account that has no
  window yet as `No usage yet` (the snapshot text says `no windows yet`). The row
  itself is `UsageAccountRow.tsx`, rendered by `UsageLimitsBand` in the header
  popup. It replaced a per-window card stack that cost roughly 360px per
  provider and hid the email; the popover ran about 720px tall for two
  providers. Bars are coloured by headroom (`usageHeadroomColor`: green from
  50% left, yellow from 25%, red below), the same rule as the top-bar rings —
  accounts get no colour of their own, because hashing an account id into a
  palette drew a Claude window in Gemini's blue. On iOS the same rows are the
  Limits tab of the Work usage module (`WorkUsageLimitsModule.swift`, split out
  of `WorkUsageActivityCarousel.swift`) as well as the Settings Usage page.
- A row offers **Use reset** only while its account carries a banked reset
  credit (`UsageAccount.resetCredits.availableCount > 0`). It calls
  `ade.usage.consumeResetCredit` and reports what the host did, on the row, for
  four seconds — "Reset applied. Your windows have cleared.", "Nothing to reset
  right now.", "No reset credit left.", "That credit was already redeemed.", or
  "Could not use the reset credit." A host whose usage service cannot spend
  credits answers "Reset credits are not available on this host yet." rather
  than reporting a reset it did not perform.
- Accounts pool by email: the same login reported by two machines is one
  account with two `Via` entries, freshest reading first. **Today the quota
  poller only reads the local machine**, but it reads EVERY provider account on
  it: `listQuotaInstances` enumerates the provider-instance registry and polls
  each account's own config home (default first, because its result decides the
  provider-level facts that stay singular — the status line's account email, the
  poll `source`, and the Codex spend-control / 7-day series). A machine with
  three Claude logins therefore contributes three accounts to the snapshot, not
  one. A machine with no registry entry falls back to the single ambient
  `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The
  account-wide fan-out in `accountUsageLiveRefresh.ts` carries history rollups
  (`usage.getUsageRollup`), not live quota. The pooled shape is the contract so
  a quota fan-out can fill it without moving any client. **Every row names its
  account, always** — on desktop, iOS, and the `ade code` usage pane
  (`usageWindowAccountLabel` in `tuiClient/components/UsagePane.tsx`). The
  earlier rule suppressed the email whenever a provider had one account, which
  is precisely the case where the row IS that account and a machine shared
  between two logins gives no other clue. A host with no account directory
  falls back to `status.accountEmail`, then to "This machine".
- The iOS quota rows are readings, not controls: the old tap-to-focus gesture
  on a pace bar is gone. Tapping a row opens the account detail sheet.
- Codex and Claude both report banked reset credits, and ADE parses them:
  `parseCodexResetCredits` counts only credits whose status is still
  `available` and reports the soonest expiry; `parseClaudeResetCredits` (Claude
  Code's `cedar_ember` program) counts the grants the server marks usable and
  unexpired and pins the one it names as next. Both land on
  `UsageAccount.resetCredits`, which is what gates the row's **Use reset**
  action, so an account with no banked credit shows no action at all.
  `parseCodexRateLimitSnapshot` remains windows-and-spend-control only; the
  Codex credits ride their own key in the same payload. Claude's read is the
  OAuth usage endpoint with `cedar_ember=1&skip_spend=1`, sent with the OAuth
  token the CLI keeps on disk. On macOS that token lives in the Keychain, so
  ADE does not offer the control there rather than turn a Keychain read into an
  unattended HTTP call; the read stays off and sends nothing. Spending a Claude
  credit is `POST /api/organizations/{org}/reset_rate_limits` with
  `{ program, grant_id, request_id }`, one claim at a time with the request id
  held until Claude answers — `cooldown`, `429`, and a signed-out answer count
  as answers, while an unanswered or unconfirmed claim reuses the same id.
  Claude's `extra_usage` is paid overage in dollars, which the extra usage card
  already shows.
- Every Codex app-server read (`runCodexAppServerJsonRpc`: the quota fallback,
  the reset-credit probe, and spending a credit) holds stdin open until every
  requested response id has arrived, then closes it; only the timeout kills the
  tree early. The app-server aborts an in-flight request the moment it sees
  stdin EOF, and `account/rateLimits/read` is a network round-trip, so closing
  stdin right after the write returned only the `initialize` reply and dropped
  the credit payload — which ADE then cached as `availableCount: 0` and never
  offered **Use reset**. Notifications interleaved between replies carry no
  numeric id and are ignored.

Claude's "Couldn't refresh Claude — showing last reading" is the generic
stale-state line `buildProviderWindows` emits when a *fresh* Claude poll returns
no windows while unexpired last-good windows exist: a transient usage-endpoint
5xx/timeout/429 or an unrecognized response. It is not the credential path — a
background poll that cannot read a login returns `preserve_previous` (silent,
windows carried, no such message), and a rejected token produces the
"reconnect" state instead. The next successful poll clears it and resets
`providerFailureCount`, and `Retry-After`/exponential backoff bounds the retry
storm, so it self-heals.
