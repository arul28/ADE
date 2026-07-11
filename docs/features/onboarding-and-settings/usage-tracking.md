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

## Claude credential hygiene (refresh storms)

`~/.claude/.credentials.json` can be a stale leftover while the live login sits
in the macOS Keychain (the Claude CLI's default store). Because background
polls must not touch the Keychain, three rules prevent a dead file token from
turning into an OAuth storm that gets the whole client rate-limited (429) by
Anthropic:

- Any successful Keychain read (explicit refresh, provider-status checks)
  populates the shared in-memory credential cache, so background polls reuse
  the live login instead of the file.
- A refresh token the token endpoint rejects (4xx) is negative-cached for 24 h
  (10 min for network/5xx failures) and never re-tried per poll.
- When a token is expired and cannot be refreshed, the reader reports "no
  usable credentials" (→ reconnect state) instead of returning the dead token,
  which would guarantee a 401 plus another doomed refresh on every cycle.

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
must remain covered.

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

- Desktop Settings shows Limits and Activity tabs. Limits reads cached live
  quota; Activity explicitly owns expensive history refresh.
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
