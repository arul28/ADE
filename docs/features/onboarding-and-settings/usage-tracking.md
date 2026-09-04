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
the brain has already booted, and receives the brain's snapshots as they land.
It falls back to its own in-process tracker only when no brain scope is
running, which is also the only time that tracker polls.

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

The maintained public rate list — BerriAI/litellm's
`model_prices_and_context_window.json` — wins whenever it prices the model.
ADE's static table is the fallback: what answers when the list cannot be fetched
and has never been cached, and what answers for models the list has never heard
of (a bare `qwen3.5-9b`, ADE's own coarse `claude-opus` / `codex` buckets at the
end of `resolveTokenPrice`). `tokenPriceSource(model)` reports which of the two
answered, as `list` or `fallback`, so a headline cost figure can say where its
rates came from.

Mechanics:

- the list is fetched with a 10 s timeout, cached to `~/.ade/litellm-pricing.json`,
  and refreshed once a day; a failed refresh keeps whatever is loaded. A
  codeburn-written cache at `~/.cache/codeburn/litellm-pricing.json` is read too,
  and the newer of the two wins.
- a cached copy stops outranking the static table after 30 days. Without that
  bound a machine that went offline in March would still be pricing this year's
  usage at March's rates, beating a table that had been corrected since.
- entries fill field by field. A list entry gives `input_cost_per_token` and
  `output_cost_per_token`; when it omits cache-write or cache-read rates,
  `fillMissingPriceFields` takes them from the static entry for that model and
  only then falls back to the `input × 1.25` / `input × 0.1` ratios. An entry
  with no usable input or output rate is skipped entirely rather than stored as
  a partial price.
- lookup tries the provider-prefixed name, then the canonical name, then an
  alias, then the longest key the canonical name extends — so a dated model id
  resolves to its family without a per-release table edit.
- the static table is a hand-maintained snapshot and is expected to drift. It
  was last reconciled against the list on 2026-08-10, taking the list's number
  wherever the two disagreed, so a machine with the cache and a machine without
  it report the same cost.

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
in the macOS Keychain (the Claude CLI's default store). Because background
polls must not touch the Keychain, three rules prevent a dead file token from
turning into an OAuth storm that gets the whole client rate-limited (429) by
Anthropic:

- Any successful Keychain read (explicit refresh, provider-status checks)
  populates the shared in-memory credential cache, so background polls reuse
  the live login instead of the file.
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

## Additional provider ranking

| Rank | Provider | What is actually available | ADE position |
|---|---|---|---|
| 1 | GitHub Copilot | GitHub's supported billing APIs expose personal AI-credit/premium-request usage for self-billed accounts with `Plan: read`; organization-managed plans require organization administration access. | Best official next candidate, but label it billing usage rather than live remaining quota and gate it on the correct GitHub permission/account ownership. |
| 2 | Gemini | Official Gemini documentation exposes project rate-limit dimensions and directs users to AI Studio for active limits. CodexBar additionally uses Gemini CLI OAuth and its quota RPC, but that is not a documented personal subscription quota contract. | Keep existing local history. Prototype only behind an experimental strategy until Google documents a stable usage/remaining endpoint and auth scope. |
| 3 | Cursor | Cursor's supported Admin API provides team member usage/spend; it is not a general personal-plan API. | Offer only for explicitly configured team admins; do not silently reuse personal credentials or call token estimates quota. |
| 4 | Factory Droid, OpenCode, local/open providers | ADE can scan local histories, but no supported personal remaining-quota API was verified for the normal user credentials ADE already holds. | Activity/history only. Reassess when a provider publishes a stable authenticated quota API. |

Primary provider references: [GitHub billing usage](https://docs.github.com/en/rest/billing/usage),
[Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), and
[Cursor Admin API](https://docs.cursor.com/en/account/teams/admin-api).

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
