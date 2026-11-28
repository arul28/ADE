# CRDT Model (cr-sqlite)

DAEX's replicated state is a CRDT: each row of each eligible table carries
per-column Lamport clocks, and merges are last-writer-wins per column. Desktop
and the brain load the cr-sqlite extension; iOS emulates the same contract in
SQL.

## Where it plugs in

`apps/desktop/src/main/services/state/kvDb.ts` exposes `AdeDb` with
`AdeDb.sync`, used by Electron main and by the brain (`daex serve`) over the
same `.ade/ade.db`:

- `getSiteId()`, `getDbVersion()`.
- `exportChangesSince(version, { maxRows?, throughDbVersion?, excludeTables?,
  rejectOversizedVersionGroup? })` — **windowed and bounded**: callers scan a
  `db_version` range (250,000-version windows) inside a read transaction that
  pins the WAL snapshot, because the `crsql_changes` vtab aborts when another
  connection commits mid-read and a bare `LIMIT` cannot bound a vtab scan.
  Truncation happens only at whole `db_version` groups.
  `rejectOversizedVersionGroup` throws
  `crsql_export_version_group_too_large` instead of loading a huge group.
- `applyChanges(rows)` — see [Apply](#apply).
- `discardUnpublishedChangesForTables(tableNames)` — see *Local clears*.

`syncHostService` and `syncPeerService` (`apps/ade-cli/src/services/sync/`) use
these with `syncProtocol.ts`.

## Desktop and brain: native loadable extension

`node:sqlite` loads `crsqlite.dylib`, `crsqlite.dll` (Windows x64) or
`crsqlite.so` (Linux x64/arm64), then `crsql_as_crr` marks every table except
`sqlite_%`, `crsql_%` and `LOCAL_ONLY_CRR_EXCLUDED_TABLES`. Discovery is dynamic:
a new table becomes a CRR at next startup. `ADD COLUMN` is wrapped in
`crsql_begin_alter` / `crsql_commit_alter`.

Startup self-heals in `kvDb.ts`:

- `removeOrphanedCrrMetadata` drops clock/pks tables whose base table is gone
  (otherwise every `crsql_changes` scan aborts and export silently dies).
- Two processes can open a new DB at once, so `rebuildTableInTransaction`
  re-plans under `BEGIN IMMEDIATE` from the live schema. `convertToCrr` logs
  `db.crr_conversion_failed` for a schema cr-sqlite refuses
  (`hasCrrRefusedSchema`) instead of failing the open; phone-critical tables
  still throw.
- Copy-table rebuilds drop a leftover `__ade_crr_repair_<name>` staging table
  before their `CREATE`, and `sweepOrphanedRepairStagingTables()` clears orphans
  at open; otherwise every retrofit throws `table already exists` and loops.

`validate-win-artifacts.mjs` loads the packaged DLL and proves a real
`crsql_changes` row, so a broken Windows package fails CI.
`SyncRoleSnapshot.crdtSyncAvailable` disables pairing and shows reinstall
guidance when the extension cannot load.

Each device's site id is `.ade/secrets/sync-site-id`; clearing it makes the
device look new to every peer.

## iOS: pure-SQL CRR emulation

iOS system SQLite cannot load extensions (`sqlite3_load_extension`,
`sqlite3_auto_extension` are refused), so `apps/ios/ADE/Services/Database.swift`
implements the CRR contract in SQL:

- The same metadata tables (`crsql_master`, `crsql_site_id`, `crsql_changes`,
  `<table>__crsql_clock`) and indexes.
- Functions registered at open: `ade_next_db_version()`,
  `ade_local_site_id()`, `ade_capture_local_changes()`.
- `AFTER INSERT/UPDATE/DELETE` triggers per table write `crsql_changes` rows
  (deletes as `cid = "-1"` tombstones); `enableCrr(for:)` installs them for
  every discovered table.
- Changesets are wire-compatible with the extension. iOS sends primary keys
  unpacked; desktop's `normalizeIncomingCrsqlChange` repacks them.
- Only the CRR contract DAEX uses is implemented; a desktop-only cr-sqlite
  feature would break parity.
- `ade_next_db_version()` is unlocked; iOS relies on one serialized writer.

## Merge semantics

- **Last-writer-wins per column**, Lamport clock first, site id as tiebreaker.
- **Deletes are tombstones** (`cid = "-1"`); a newer `col_version` resurrects.
- **A merge is not a caller**, so a host-side check cannot guard a replicated
  column. Host-decided columns are filtered from offending peers' inbound
  changesets (`terminal_sessions` settle and activity columns); see
  [Host-authoritative columns](README.md#host-authoritative-columns-are-peer-scoped)
  and [settle-teardown-design.md](../terminals-and-sessions/settle-teardown-design.md).

## Schema implications

1. **Upserts target the primary key only.** The retrofit strips non-PK UNIQUE
   constraints (two devices can write conflicting values before syncing); use
   select-then-update. Legacy unique indexes are dropped before conversion (for
   example `lane_linear_issue_links`, mirrored in the iOS bootstrap SQL).
2. **`ADD COLUMN` is safe; `DROP`/rename is not** — migrate through a copy table.
   A table with broken metadata gets `stripCrrMetadata`, the plain ALTER, and a
   fresh CRR (`db.crr_alter_metadata_reset`, reported to Sentry); every row then
   restarts at column version 1.
3. **Machine-bound state is not a CRR.** `LOCAL_ONLY_CRR_EXCLUDED_TABLES` in
   `kvDb.ts` lists them with reasons (projections, automation and runtime
   bookkeeping, `usage_events`, local storage state, and tables needing a non-PK
   UNIQUE index). "The host owns all writes" is intent, not enforcement; back it
   with the host-authoritative filter when a decision rests on it.

### Local clears that must not propagate

A viewer join clears local `devices` and `sync_cluster_state` without shipping
tombstones that would erase the authority's registry.
`discardUnpublishedChangesForTables` records a per-table, per-site high-water
mark in the local-only `local_crr_change_suppressions`; export drops local-site
rows at or below it. The caller then advances the peer cursor
(`syncPeerService.acknowledgeLocalDbVersion()`).

## Changeset extraction and application

### Extract

`SELECT * FROM crsql_changes WHERE db_version > ? AND db_version <= ? ORDER BY
db_version, cl, seq` inside `exportChangesSince`. Batches target 250 rows /
256 KB (64 KB for a peer with active chat subscriptions); a single `db_version`
group is never split, even past a target. Background changesets defer at most
2 s behind foreground work.

- **Browsers** negotiate `invalidationOnlyV1` and `compactInvalidationV1`: no
  replica; the host sends `invalidation_batch` envelopes (version bounds and
  table names, hard 16 KB) after the browser's first full refresh.
- **Far-behind phones** (ack and chunk capable, more than 5,000 versions behind)
  get one compact `catchup` batch of current state (≤10,000 rows / 4 MiB,
  built off the event loop), else normal replay.

### Apply

`applyChanges` inserts into `crsql_changes` in one transaction; cr-sqlite (or the
iOS triggers) resolves conflicts. Before the transaction `kvDb.ts` filters rows
for retired tables (`unified_memories` and its FTS tables), tables missing
locally, and `LOCAL_ONLY_CRR_EXCLUDED_TABLES`.

- **Invariant: moving a table to local-only is safe only because of that
  skip.** A local-only table still exists, but cr-sqlite has no schema for it,
  so one inbound row would throw, roll back the whole batch and wedge the peer's
  cursor forever. Do not reintroduce a throw.
- **Unknown columns are deferred.** A change whose `cid` is not a local column is
  kept in the local-only `sync_deferred_column_changes` (log
  `sync.unknown_column_deferred`) and the rest applies;
  `replayDeferredColumnChanges` applies it once a build has the column. New
  synced columns must tolerate a missing value on older peers. The first release
  that carries the skip must not also add a synced column.
- **An unknown table still throws** `unknown_sync_table` on desktop (skipping
  would lose its rows for good), so a new replicated table needs peers updated
  first. iOS skips unknown tables and its hydration-owned snapshot tables.
- A batch of only ignored rows is a no-op that keeps the local version.

After apply, sync change events tell renderers to re-query; iOS posts
`adeDatabaseDidChange`.

## Transactional boundaries

- Each `changeset_batch` applies as one transaction.
- Senders advance their outbound cursor only after an `ok` `changeset_ack`; a
  NACK or 10 s timeout resends the same batch. `changesetAckWindowV1` allows up
  to eight batches in flight; an ack covers its batch and all before it.
- After six failed sends, host and desktop peers re-export from the same cursor
  with halved targets down to 16 rows / 16 KB (250 ms–4 s backoff). iOS persists
  its cursor and pending batch and shrinks to one row / 4 KB (1–30 s backoff).

## Gotchas

- **iOS does not load cr-sqlite**; keep the SQL emulation wire-compatible.
- **A local-only table is not an unknown table** (see *Apply*).
- **Tables created by tests in the main DB become CRRs** at next open; use an
  in-memory or dedicated DB.
- **Keep both staging-table guards** and the `__ade_crr_repair_%` /
  `__ade_fk_repair_%` prefixes covered.
- Column drop/rename on replicated tables is not supported.
