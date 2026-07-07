# Universal Search

One deterministic full-text index over everything ADE knows about a project —
chat transcripts, terminal/CLI-session scrollback, PRs, commits, and branches —
unioned at query time with cheap or fast-changing sources (lanes, workspace
files, proof artifacts, Linear issues) that are delegated to their owning
service instead of being indexed. Every hit carries a canonical `ade://` deep
link back to the exact surface (a chat message sequence, a scrollback byte
offset, a PR, a commit, a lane, a file line, or a proof artifact). Session,
lane, and commit links include the portable deeplink envelope when the owning
lane can resolve repo / branch / PR / Linear context.

The index is a **machine-local, disposable cache** at
`.ade/cache/search-index.db` (SQLite + FTS5). It never lives inside `ade.db`,
never syncs, and a rebuild is as cheap as deleting the file. Heavy text is
ingested on a **debounced background queue** off the PTY/chat hot paths; the
same `searchService` backs the desktop ⌘K command palette, the `ade code` TUI
palette, and the `ade search` CLI through one `search` ADE action domain.

## Source file map

Main-process service (`apps/desktop/src/main/services/search/`):

- `searchService.ts` — the service core. Owns the debounced ingestion queue
  (`enqueue` / `armTimer` / `processQueue` / `drainDueEntries`, serialized
  through a single `workChain` promise), the per-source processors
  (`processChatSession`, `processTerminalSession`, `processPr`,
  `processPrSweep`, `processLaneGit`), cursor-based incremental reads with the
  `sources` table, the deferred `startBackfill` reconcile pass, and `query`
  (FTS candidate fetch + query-time delegation + deterministic ranking +
  cursor pagination). Public surface: `query`, `indexStatus`, `rebuildIndex`,
  `startBackfill`, the `notify*` hooks (`notifyChatEvent`,
  `notifyTerminalData`, `notifySessionChanged`, `notifyPrChanged`,
  `notifyLaneActivity`), `processPendingNow` (tests/rebuild), `dispose`.
- `searchIndexDb.ts` — opens/creates the disposable index DB. Owns the DDL
  (`docs`, `docs_fts` FTS5 virtual table, `sources`, `meta`), the
  `SEARCH_INDEX_SCHEMA_VERSION = 4` constant and the drop-and-recreate on schema
  mismatch or corruption, WAL + `busy_timeout` pragmas, `clearSearchIndex`
  (wipe rows, keep schema), and the `createRequire`-anchored `node:sqlite`
  resolver (same pattern as `kvDb.ts`).
- `searchQueryParser.ts` — deterministic query parser. Tokenizes bare terms
  (AND-ed, matched as FTS5 prefix tokens), quoted phrases (exact), and
  `kind:` / `lane:` / `session:` / `since:` filters (`since:` durations like
  `7d` resolve against a caller-provided `now`). `buildFtsMatchExpression`
  builds the FTS5 `MATCH` string (optionally column-scoped to `rank_title`);
  `isMatchAllQuery` flags filter-only queries so callers never run FTS on them.
- `searchRanking.ts` — the deterministic ranking tiers (exact title > title
  prefix > title substring > FTS5 BM25 body), the `compareRanked` comparator
  (tie-break by `updatedAt` desc, then `docId` asc), and the snippet marker
  extraction (`extractSnippetRanges` turns SQLite `snippet()` markers into
  typed `matchRanges`).
- `terminalChunking.ts` — splits raw terminal transcript bytes into
  newline-aligned, ANSI-stripped, control-sanitized chunks keyed by raw byte
  offset (so a hit deep-links to the scrollback position). Leaves an
  unterminated tail unconsumed unless `force` (session ended) is set.
  `sanitizeIndexedText` strips control chars while keeping `\n` / `\t`.
- `searchServiceWiring.ts` — `createProjectSearchService`, the host-level
  assembly shared by the desktop main process and the `ade` runtime so their
  wiring cannot drift. Binds the delegated sources, subscribes the
  session/chat hooks, resolves the primary lane for file delegation, and owns
  the deferred backfill kickoff.

Shared contract:

- `apps/desktop/src/shared/types/search.ts` — `SearchDocKind`,
  `SearchResultItem`, `SearchQueryArgs` (including the `callerScope` gate),
  `SearchQueryResult`, `SearchIndexStatus`, `SearchRebuildResult`. Re-exported
  from `shared/types/index.ts`.

ADE action domain + RPC scoping:

- `apps/desktop/src/main/services/adeActions/registry.ts` — registers the
  `search` domain (`ADE_ACTION_DOMAIN_NAMES`), its allowlist
  (`query`, `indexStatus`, `rebuildIndex`), the CTO-only gate on
  `rebuildIndex` (`ADE_ACTION_CTO_ONLY`), and `buildSearchDomainService`
  (returns `null` when the runtime has no `searchService`).
- `apps/ade-cli/src/adeRpcServer.ts` — `scopeSearchAdeActionArgs` injects the
  `callerScope` for non-CTO callers of `search.query`: a session-bound caller
  gets chat/terminal results limited to its own session; an unbound
  agent/orchestrator/evaluator gets session content excluded entirely;
  unbound external callers (user CLI/desktop) keep whole-project search.
- `apps/ade-cli/src/bootstrap.ts` — constructs the runtime's search service
  via `createProjectSearchService`, wires `notifyTerminalData` into
  `broadcastData`, `notifyLaneActivity` into `onLifecycleEvent`, and
  `notifyPrChanged` into the PR event emitter; exposes `runtime.searchService`.

Desktop main-process wiring + preload bridge:

- `apps/desktop/src/main/main.ts` — constructs the search service after the
  chat/pr/git/file services, wires the same PTY/lane/PR notify hooks, threads
  it into `AppContext`, and disposes it on shutdown (`backfillDelayMs: 10_000`).
- `apps/desktop/src/main/services/ipc/registerIpc.ts` — adds the optional
  `searchService` field to `AppContext`.
- `apps/desktop/src/preload/preload.ts` + `global.d.ts` — `window.ade.search`
  (`query` / `indexStatus` / `rebuildIndex`). **Daemon-only by design:** every
  call routes through the runtime action bridge
  (`callProjectRuntimeActionIfBound`) with no in-process IPC fallback, so
  packaged and remote-bound windows behave identically.

Desktop ⌘K command palette:

- `apps/desktop/src/renderer/components/app/commandPaletteSearch.tsx` — the
  universal-search seam: `useUniversalSearch` (debounced `window.ade.search`
  query), the `KindIcon` / highlight helpers, and the `SearchResultRow` entity
  rows grouped by kind (`ENTITY_KIND_ORDER` / `ENTITY_KIND_LABEL`).
- `apps/desktop/src/renderer/components/app/CommandPalette.tsx` — hosts the
  flat-index interleaving of command matches and entity results, and
  `activateResult`'s `kind → navigate` switch (chat/terminal/pr/lane/commit/
  branch/file/linear/artifact → the matching tab, relying on the deep-link
  navigate listener to focus the target).

`ade search` CLI + agent skill:

- `apps/ade-cli/src/cli.ts` — `buildSearchPlan` (flags `--kind`/`--kinds`,
  `--lane`/`--lane-id`, `--limit`, `--cursor`, `--status`, `--rebuild`,
  `--text`/`--json`), the `search-results` / `search-status` text formatters,
  the `search` help block, and `exitCodeFromResult` (exit `1` on no results,
  `2` on a usage error such as an unknown `--kind`).
- `apps/desktop/resources/agent-skills/ade-search/SKILL.md` — the bundled
  `ade-search` agent skill (registered in
  `apps/desktop/src/shared/adeCliGuidance.ts` and referenced in `AGENTS.md`).

TUI palette:

- `apps/ade-cli/src/tuiClient/app.tsx` — the `ade code` command palette merges
  universal-search chat/terminal hits **below** the local command/lane/chat
  matches (debounced ~200 ms, generation-guarded against stale responses,
  deduped by owning session). Selecting a search hit resolves the session
  against the local list first, then a fresh listing, so a jump to an archived
  or not-yet-listed session still lands.

## Key concepts

### Disposable cache DB — never inside `ade.db`

The index is a machine-local cache, so it lives in its own SQLite file
(`.ade/cache/search-index.db`), never inside `ade.db`. Three reasons force
this: FTS5 virtual tables cannot be cr-sqlite CRRs, the index must never sync
to other devices, and a rebuild must be as cheap as deleting the file. On
schema-version mismatch or corruption, `openSearchIndexDb` drops and recreates
the file rather than migrating — the ingestion cursors it loses are rebuilt by
the backfill pass.

### Ingestion queue + cursors

Writes never run on hot paths. The `notify*` hooks (chat event, PTY data, PR
refresh, lane lifecycle, session change) only `enqueue` a source key with a
per-kind debounce (chat 300 ms, terminal 1200 ms, PR 500 ms, lane-git 1000 ms);
the timer drains due entries on a single serialized `workChain` promise,
yielding to the event loop between sources. Each source's progress is a cursor
in the `sources` table: chat and terminal transcripts are read incrementally
from a byte cursor (capped at 4 MiB per pass, re-enqueuing when more remains),
so a growing transcript is indexed in bounded slices. PR/lane-git sources
re-derive their docs wholesale each run. `startBackfill` runs once, well past
the host boot window, enqueues every session/PR/lane, and reconciles docs whose
sessions were deleted while the service was down.

### Deterministic ranking tiers

Ranking is exactly specifiable and stable — the same query over the same corpus
always produces the same order. Candidates tier by title match against the
normalized query: exact title > title prefix > title substring > FTS5 BM25 body
match. Only the body tier uses BM25; ties across all tiers break by `updatedAt`
descending, then `docId` ascending. Message/chunk docs carry an empty
`rankTitle` so they rank body-only and don't inherit their session's title
rank. Because the BM25 candidate window is capped, a title-scoped candidate set
is unioned in when the window fills, so a strong title match is never buried by
body-match volume.

### Query syntax

Bare terms AND together (matched as FTS5 prefix tokens); `"quoted phrases"`
match exactly. Inline filters narrow the set: `kind:<kind>` (with `kind:issue`
as an alias for Linear), `lane:<id-or-name>` (names resolved against the lane
list), `session:<id>`, and `since:<7d|2026-06-01>` (durations resolve against
the service's `now`). The `--kind` / `--lane` CLI flags are the scriptable,
validated form and can be mixed with inline filters. Linear is opt-in: it can
hit the network, so it is excluded from the default kind set and only consulted
when a caller explicitly asks for `kind:linear`.

### Query-time delegation vs. FTS

Only chat, terminal, PR, commit, and branch text is FTS-indexed. Lanes, files,
artifacts, and Linear issues are **delegated at query time** to their owning
service so results are always fresh and nothing duplicates an authoritative
store. FTS candidates and delegated candidates are ranked together through the
one comparator, then paginated with an opaque base64 cursor.

### Caller scoping policy

`search.query` mirrors the read-scoping of the direct chat/terminal read paths
(`scopeChatAdeActionArgs` / `scopeTerminalAdeActionArgs`). The RPC gate injects
a `callerScope` that can only narrow results, never widen them: a session-bound
non-CTO caller sees chat/terminal hits only for its own session; an unbound
agent/orchestrator/evaluator (which `chat.readTranscript` would deny) gets
session content excluded entirely; unbound external callers (user CLI, desktop)
and CTO callers keep whole-project search. PR/commit/branch/lane/file kinds are
unaffected — those surfaces are already readable unscoped through their own
actions. `rebuildIndex` is CTO-only.

### Dual-host known limitation

When the desktop app and the brain daemon are both up for one project, each
runs its own ingestion over the shared index file. Writes still converge — doc
ids are deterministic, upserts idempotent, cursors shared via the `sources`
table, and WAL + `busy_timeout` serialize writers — at the cost of some
duplicate IO and occasional `SQLITE_BUSY` retry noise in logs.

## Gotchas / fragile areas

- **Hot-path enqueue must stay cheap.** `notifyTerminalData` /
  `notifyChatEvent` run inside `broadcastData` and the chat event emitter.
  They only touch the in-memory queue and re-arm the timer (and only when the
  new work is due before the armed wakeup). Never do DB work in a `notify*`
  hook — all IO belongs in the debounced drain.
- **Schema changes mean drop-and-rebuild.** Any DDL change must bump
  `SEARCH_INDEX_SCHEMA_VERSION`. There is no migration path — a mismatch drops
  and recreates the DB, and backfill rebuilds it. Do not hand-migrate the
  cache.
- **Torn-tail rule for incremental reads.** Transcript writers append whole
  lines. The chat/terminal processors never consume an unterminated final line
  (chat: no trailing newline; terminal chunker: unforced partial tail) —
  consuming it would advance the cursor past a half-written record and
  permanently drop it. A shrunk file (compaction/rewrite) is detected via
  `stat.size < cursor` and triggers a from-scratch reindex of that session.
- **Branches are indexed from the primary lane only.** `listBranches` returns
  every branch visible from the repo, so indexing per lane would duplicate the
  whole branch list N times. `processLaneGit` only indexes branches when the
  lane is `primary`; commits are per lane (capped at 100 recent).
- **Delegated sources are best-effort.** Every delegation (lanes, files,
  artifacts, Linear) is wrapped so an unavailable source (missing worktree,
  no file index, Linear not connected) yields no candidates rather than
  failing the whole query. File and Linear delegation also require positive
  query text — they are skipped for match-all/filter-only queries.
- **Snippet markers rely on sanitized text.** The `\u0001` / `\u0002` (`SNIPPET_MARK_START` / `SNIPPET_MARK_END`) SQLite `snippet()` markers survive
  into typed `matchRanges` only because `sanitizeIndexedText` strips control
  chars from every indexed body, so those bytes can never appear in real
  indexed text. Don't index raw bytes past the sanitizer.

## Cross-links

- [Chat](../chat/README.md) — chat transcripts are the FTS `chat` source.
- [Terminals and Sessions](../terminals-and-sessions/README.md) — terminal /
  CLI-session scrollback is the FTS `terminal` source.
- [Pull requests](../pull-requests/README.md) — PR title/body/comments are the
  `pr` source.
- [Deeplinks](../deeplinks/README.md) — every result carries an `ade://` deep
  link built through the shared deeplink contract; session results carry
  `event` / `offset` anchors, and file / commit / artifact results use the
  canonical shared URL builders.
- [Files and Editor](../files-and-editor/README.md) — the file quick-open /
  content-search index backs the delegated `file` kind.
- [System overview](../../ARCHITECTURE.md) — the `search` ADE action domain and
  services catalog entry.
</content>
</invoke>
