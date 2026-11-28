# Universal Search

One deterministic full-text index over a project's chat transcripts,
terminal/CLI scrollback, PRs, commits and branches, unioned at query time with
sources delegated to their owning service (lanes, workspace files, proof
artifacts, Linear issues). Every hit carries a `daex://` deep link to the exact
surface (a chat message sequence, a scrollback byte offset, a PR, commit, lane,
file line or artifact), with the portable envelope where the lane can resolve it.

The index is a **machine-local, disposable cache** at
`.ade/cache/search-index.db` (SQLite + FTS5): never inside `ade.db`, never
synced, rebuilt by deleting the file. Text is ingested on a debounced background
queue. The same `searchService` backs the ⌘K palette and `daex search` (`ade
search` still works) through the `search` action domain.

## Source file map

- `apps/desktop/src/main/services/search/searchService.ts` — the core: the
  debounced queue (one serialized `workChain`), per-source processors (chat,
  terminal, PR, PR sweep, lane git), cursors in the `sources` table,
  `startBackfill`, and `query` (FTS candidates + delegation + ranking + cursor
  paging). Hooks: `notifyChatEvent`, `notifyTerminalData`, `notifySessionChanged`,
  `notifyPrChanged`, `notifyLaneActivity`.
- `searchIndexDb.ts` — DDL (`docs`, `docs_fts`, `sources`, `meta`),
  `SEARCH_INDEX_SCHEMA_VERSION`, drop-and-recreate on mismatch or corruption,
  `openSearchIndexDbReadOnly`.
- `searchIndexQuery.ts` — the one FTS candidate query, shared by the live service
  and `querySearchIndexReadOnly`.
- `searchQueryParser.ts`, `searchRanking.ts`, `terminalChunking.ts`
  (newline-aligned, ANSI-stripped chunks keyed by byte offset;
  `sanitizeIndexedText`).
- `searchServiceWiring.ts` — `createProjectSearchService`, shared by desktop
  main and the brain (`apps/ade-cli/src/bootstrap.ts`).
- `apps/desktop/src/shared/types/search.ts` — the contract.
- `apps/desktop/src/main/services/adeActions/registry.ts` — the `search` domain
  (`query`, `indexStatus`, `rebuildIndex`; `rebuildIndex` is CTO-only).
- `apps/ade-cli/src/adeRpcServer.ts` — `scopeSearchAdeActionArgs` strips any
  caller `callerScope`.
- `apps/ade-cli/src/multiProjectRpcServer.ts` — the machine search policy (below).
- `apps/desktop/src/preload/preload.ts` — `window.ade.search`, runtime-only (no
  in-process fallback).
- Palette: `renderer/components/app/commandPaletteSearch.tsx`
  (`useUniversalSearch`, result rows, `withIndexedLaneName`), `CommandPalette.tsx`
  (`activateResult`); web adapter `renderer/webclient/adapter/search.ts`.
- CLI: `apps/ade-cli/src/cli.ts` (`buildSearchPlan`; exit 1 on no results, 2 on a
  usage error); skill `apps/desktop/resources/agent-skills/daex-search/SKILL.md`.

## Gotchas / fragile areas

- **Search runs on each machine, by pin.** The palette asks every online copy of
  the repository (`useOnlineCopyPins`, `callEachMachine`); there is no account
  index. An offline computer or a resting DAEX Cloud computer is not searched and
  never woken.
- **Hot-path enqueue stays cheap.** `notify*` hooks touch only the in-memory
  queue and timer; all IO is in the drain.
- **Schema changes mean drop-and-rebuild**: bump `SEARCH_INDEX_SCHEMA_VERSION`;
  never hand-migrate the cache.
- **Torn-tail rule.** Processors never consume an unterminated final line. A
  shrunk file reindexes the session. A `.gz` compaction is not a shrink
  (`readHistoryFileSync` returns the same bytes, so cursors survive).
- **Branches come from the primary lane only**; commits are per lane (100
  recent).
- **PR documents use local rows only** (title, number, URL from `listAll()`);
  never call `getDetail` / `getComments` from indexing (GitHub quota).
- **Delegated sources are best effort** and skipped for filter-only queries.
- **Snippet markers** (`\u0001` / `\u0002`) work only because indexed text is
  sanitized; never index raw bytes.

## Key concepts

### Ingestion queue and cursors

`notify*` hooks enqueue a source with a per-kind debounce (chat 300 ms, terminal
1,200 ms, PR 500 ms, lane git 1,000 ms). Chat and terminal transcripts are read
incrementally from a byte cursor (4 MiB per pass); PR and lane-git docs are
rebuilt wholesale. `startBackfill` runs once after boot (10 s on desktop),
enqueues everything and drops docs of deleted sessions.

- A steer indexes once (`chat:<session>:steer:<steerId>`, first row wins);
  `queued` rows are not indexed.
- A chat's meta document carries the identifiers of its linked PRs (`#1237`,
  `owner/repo#1237`, URL, title). `prTermsByChatSession` is rebuilt on every PR
  index and sweep, and only chats whose terms changed reindex.

### Deterministic ranking

Exact title > title prefix > title substring > BM25 body; ties by `updatedAt`
desc, then `docId` asc. Message and chunk docs have an empty `rankTitle`. When
the BM25 window fills, title matches are unioned in so they are never buried.

### Query syntax

Bare terms AND as prefix tokens; `"quoted phrases"` match exactly; filters
`kind:` (`kind:issue` = Linear), `lane:<id-or-name>`, `session:<id>`,
`since:<7d|2026-06-01>`. Linear is opt-in (`kind:linear`) because it hits the
network. An exact `session:<id>` reads the live session first and replaces stale
index metadata, so a just-sent message appears once.

### Query-time delegation

Only chat, terminal, PR, commit and branch text is indexed. Lanes, files,
artifacts and Linear are asked live, ranked with the same comparator, and paged
with an opaque cursor.

### Machine search policy

`search.query` is not narrowed by the caller's chat. The router answers the
active project fully and every other registered project for chat hits only
(results carry `projectId`, `projectName`, `projectRoot`; ≤200 hits per project,
`resultsTruncated` says so). Personal chats are not searched. **A search never
loads a project's runtime**: projects not loaded are read from their index file
read-only (`querySearchIndexReadOnly`); a missing file means no hits; a wrong
schema or unreadable file lists the project in `projectsUnavailable` ("open it
once"). `chat.readTranscript` follows the same rule
(`resolveProjectBackedChatOwner`, `readSessionToolTypeFromDisk`).

### With no computer awake

With no computer online the palette makes no search call and matches only the
rows Work already holds (saved chats and copies, cloud lanes). On open it reads
the account lane index once (`useLaneMentions`) to name results that came with no
lane name.

### The ⌘K palette

`CommandPalette.tsx` interleaves commands, threads and search results;
`activateResult` routes each kind to its tab through the deep-link listener.
Threads keep their owner machine's name; an amber marker shows only for another
machine. With a chat on screen, **Find "…" in this chat** (`chat/chatFindPalette.ts`,
section `chatFind` in `commandPaletteSections.ts`) hands the words to that chat's
find bar. A selected lane adds **Open PR #N** (or a create-PR command) from the
same selector as the Lanes badge (`commandPaletteLanePr.ts`). Queries of three or
more words (or two with no direct match) ask Jev (`usePaletteSuggestions.ts`,
`commandPaletteSuggestions.ts`) after 500 ms to rank up to 20 commands; a
**Suggested** group shows when the top probability is ≥0.35 (each shown ≥0.15),
and still needs an explicit click or Enter. Icons and captions are in
`commandPaletteMarks.tsx`.

### Dual-host limitation

When the desktop and the brain both run a project, each ingests into the shared
index. Writes converge (deterministic ids, idempotent upserts, shared cursors,
WAL + `busy_timeout`) at the cost of duplicate IO and some `SQLITE_BUSY` noise.

## Cross-links

- [Chat](../chat/README.md), [Terminals and Sessions](../terminals-and-sessions/README.md),
  [Pull requests](../pull-requests/README.md) — the indexed sources.
- [Deeplinks](../deeplinks/README.md) — result links and anchors.
- [Files and Editor](../files-and-editor/README.md) — the delegated `file` kind.
- [Storage and recovery](../storage-and-recovery/README.md) — `.gz` history.
