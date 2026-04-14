# CRDT Model (cr-sqlite)

ADE's replicated state is a CRDT: every row of every eligible table
carries per-column Lamport timestamps, and merges use last-writer-wins
per column. This document describes how cr-sqlite is wired up on desktop,
how iOS emulates the same contract without the loadable extension, and
the schema implications that fall out of the CRR retrofit.

## Where it plugs in

The entire CRDT layer lives inside the shared DB adapter:
`apps/desktop/src/main/services/state/kvDb.ts` exposes an `AdeDb` with
an `AdeDb.sync` object. Every other desktop service talks to plain
SQLite (`run`, `get`, `all`, `prepare`); `AdeDb.sync` exposes:

- `getSiteId(): string` — the local cr-sqlite site identifier.
- `getDbVersion(): number` — the monotonic replication version.
- `exportChangesSince(version: number): CrsqlChangeRow[]` — the list
  of changes this device has generated since the given version.
- `applyChanges(rows: CrsqlChangeRow[]): ApplyRemoteChangesResult` —
  apply remote changes locally.

`syncHostService` and `syncPeerService` use those four primitives
plus `syncProtocol.ts` envelope encoding to do the actual wire
exchange.

## Desktop: native loadable extension

Desktop opens SQLite through `node:sqlite` and loads a vendored
`crsqlite.dylib` (macOS) / `.so` (linux) as a loadable extension. A
fresh connection runs `SELECT load_extension(...)` once, then `AdeDb`
marks every eligible non-virtual table as a CRR at startup:

```sql
SELECT crsql_as_crr('table_name');
```

**Exclusions:**

- `sqlite_%`, `crsql_%`, `unified_memories_fts%` — virtual / internal /
  FTS tables
- `unified_memories_fts` in particular stays local-only and is rebuilt
  from synced `unified_memories` content

The migration is dynamic: any new table that appears in
`sqlite_master` and is not in the excluded set is marked as a CRR
automatically at next startup. There is no hand-curated CRR list to
maintain when a feature adds a table.

Sync-managed tables support later `ALTER TABLE ... ADD COLUMN` through
automatic `crsql_begin_alter` / `crsql_commit_alter` wrapping in the
adapter.

### Site identity

Each device has a unique local site id stored at
`.ade/secrets/sync-site-id`. It is generated once on first launch and
persisted. Clearing the file forces a fresh site id and re-initializes
replication state (use only as a last resort; it looks like a new
device to every connected peer).

## iOS: pure-SQL CRR emulation

Source file: `apps/ios/ADE/Services/Database.swift` (~2,200 lines).

iOS system SQLite does not support `sqlite3_load_extension()`, rejects
`sqlite3_auto_extension()` on Apple platforms, and crashes when
`sqlite3_crsqlite_init()` is called directly because the SQLite API
thunk pointer is nil in a loadable-extension binary. Rather than
fighting those restrictions with a static-link wrapper (which was the
original path before the pivot), iOS implements the **CRR contract in
SQL** against stock system SQLite.

What this means concretely:

### Metadata tables

The iOS app creates the same metadata tables cr-sqlite would:

- `crsql_master` (tracked tables)
- `crsql_site_id` (this device's stable site id)
- `crsql_changes` (change log — `[table]`, `pk`, `cid`, `val`,
  `col_version`, `db_version`, `site_id`, `cl`, `seq`)
- `<table>__crsql_clock` (per-table clock table), matching the
  cr-sqlite schema

Indexes match cr-sqlite's expected shape:

```sql
CREATE UNIQUE INDEX idx_crsql_changes_unique
  ON crsql_changes([table], pk, cid, db_version, site_id, cl, seq);

CREATE INDEX idx_crsql_changes_version
  ON crsql_changes(db_version, cl, seq);

CREATE INDEX idx_crsql_changes_table_pk
  ON crsql_changes([table], pk);
```

### Custom SQLite functions

Registered at connection open via `sqlite3_create_function_v2`:

- `ade_next_db_version()` — returns `max(db_version) + 1` from
  `crsql_changes`. Used by trigger bodies to stamp each generated
  row.
- `ade_local_site_id()` — returns the local hex site id.
- `ade_capture_local_changes()` — batched change-capture helper.

These are the trigger context cr-sqlite normally provides in C code.

### Per-table change-capture triggers

For each CRR-marked table, the iOS code installs three triggers:
`AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`. Each writes a row into
`crsql_changes` for every affected column (or a tombstone row with
`cid = "-1"` for deletes). Example (elided) INSERT body:

```sql
INSERT INTO crsql_changes([table], pk, cid, val, col_version,
                          db_version, site_id, cl, seq)
SELECT 'table_name',
       NEW.primary_key_column,
       'column_name',
       NEW.column_name,
       1,
       ade_next_db_version(),
       ade_local_site_id(),
       0, 0;
```

This matches the semantics the desktop cr-sqlite extension produces.

### `enableCrr(for:)`

Dynamically discovers tables from `sqlite_master` (excluding
`sqlite_%`, `crsql_%`, `%__crsql_clock`, `%__crsql_pks`) and installs
the triggers. Symmetric to desktop's dynamic startup behavior.

### Wire compatibility

`exportChangesSince(version:)` and `applyChanges(_:)` read/write the
same `crsql_changes` row format that desktop cr-sqlite uses, so
changesets are byte-for-byte wire compatible. A row originating on an
iPhone is indistinguishable from a row originating on a Mac (beyond
the `site_id`), and round-trips through the host without translation.

### Legacy iOS cache DB

On first launch the iOS app detects and replaces the legacy
disposable iOS cache DB with the new replicated DB path
(`Application Support/ADE/ade.db`).

### What iOS does **not** support

The pure-SQL emulation covers the CRR contract that ADE actually uses.
It does not implement:

- cr-sqlite's higher-level schema helpers beyond `crsql_as_crr`
  behavior (which on iOS is `enableCrr(for:)`).
- Any cr-sqlite feature that relies on extension-exclusive C hooks
  not mirrored by the custom functions above.

In practice ADE has been careful to use only CRR-marked tables plus
standard SQL on the host side, so iOS stays in parity.

## Merge semantics

- **Last-writer-wins per column.** A write on device A and a write on
  device B to the same row but different columns both apply; writes
  to the same column resolve by Lamport timestamp, with site id as
  tiebreaker.
- **Deletes are tombstones.** `cid = "-1"` (see `localDeleteColumnId`
  in `Database.swift`) marks the row dead. A resurrection from
  another device with a newer `col_version` wins over the tombstone.

## Schema implications

The CRR retrofit is not free. Key rules the engineering handbook
enforces:

### Rule 1: Upserts target the primary key only

```sql
-- OK: on conflict targets PK
INSERT INTO lanes(id, name, ...)
VALUES (?, ?, ...)
ON CONFLICT(id) DO UPDATE SET ...;

-- BROKEN after CRR retrofit: secondary UNIQUE is not replicated
INSERT INTO lanes(id, slug, ...)
VALUES (?, ?, ...)
ON CONFLICT(slug) DO UPDATE SET ...;
```

The CRR retrofit strips non-PK UNIQUE constraints from replicated
tables because two devices can legitimately write conflicting values
to a unique column before syncing. Upserts that relied on a secondary
UNIQUE must fall back to explicit select-then-update.

### Rule 2: `ALTER TABLE ADD COLUMN` is safe; `DROP COLUMN` is not

The adapter wraps `ADD COLUMN` with `crsql_begin_alter` /
`crsql_commit_alter`, which re-registers the trigger set for the new
column. Dropping or renaming a column on a replicated table is not
supported by the current adapter and must be migrated through a copy
table.

### Rule 3: FTS indexes stay local

Full-text search indexes (`unified_memories_fts` today) are not
synced. After a remote changeset touches `unified_memories`, ADE
rebuilds the FTS index locally. Adding a new FTS5 index follows the
same pattern.

### Rule 4: Machine-bound state is not a CRR

Do not add tables to the replicated set that only matter on one
device. Worktrees, PTY handles, transcripts, and caches are
explicitly excluded. If a table is useful as "the host knows X", it
should live outside `.ade/ade.db` or be designed so the host owns
all writes and controllers only read.

## Changeset extraction and application

### Extract

```sql
SELECT * FROM crsql_changes WHERE db_version > ?;
```

Wrapped in `AdeDb.sync.exportChangesSince(version)`. Returns an array
of `CrsqlChangeRow` objects; the transport layer batches them into
`changeset_batch` envelopes.

### Apply

```sql
INSERT INTO crsql_changes(...);
```

Wrapped in `AdeDb.sync.applyChanges(rows)`. cr-sqlite and the iOS
emulation both handle conflict resolution inside the insert trigger
(accept newer `col_version`, tombstone semantics for deletes, last
writer wins on ties by `site_id`).

After apply, ADE runs post-hooks:

- Rebuild FTS if `unified_memories` rows changed.
- Emit relevant IPC events (`laneChanged`, `prsChanged`, etc.) so the
  renderer re-queries the affected projections.
- On iOS, post `Notification.Name.adeDatabaseDidChange` so SwiftUI
  views re-read.

## Transactional boundaries

- The host applies each `changeset_batch` envelope as a single SQL
  transaction. Partial application is impossible; the entire batch
  either lands or rolls back.
- On failure (usually schema mismatch during a rolling upgrade), the
  batch is dropped with a logged error; the next version-based
  catch-up after both sides are on the same schema re-applies the
  missed changes.

## Implementation status

| Piece | Status |
|---|---|
| Desktop extension loading + CRR marking | Implemented |
| iOS pure-SQL emulation | Implemented, wire-compatible |
| Dynamic CRR discovery | Implemented |
| `ALTER TABLE ADD COLUMN` support | Implemented (wrapped) |
| FTS rebuild after remote apply | Implemented |
| Column drop/rename on replicated tables | **Not supported** — use copy-table migration |
| Statement caching in `node:sqlite` adapter | Deferred; prepares per call today, revisit before heavier loads |

## Gotchas

- **The vendored `crsqlite.xcframework` has been removed.** It was a
  dynamic framework binary whose entrypoint could not be loaded on
  iOS due to platform restrictions. The pure-SQL emulation replaces
  it completely.
- **Static-link cr-sqlite on iOS is a dead end.** The wrapper
  approach was evaluated and abandoned; do not revive it without a
  plan for the SQLite thunk pointer issue.
- **Tables added by tests still register as CRRs at startup.** Test
  suites that create scratch tables in the main DB will see them
  replicated on the next connection. Use an in-memory DB or a
  dedicated test DB path for scratch tables.
- **`unified_memories_fts` rebuild is not incremental.** Large
  `unified_memories` batches cause a full FTS rebuild on apply.
  If this becomes a hotspot the rebuild can be narrowed to rows
  touched by the batch, but that is not implemented today.
- **`ade_next_db_version()` is synchronous and unlocked.** Under
  heavy concurrent write load on iOS (which is unlikely because the
  phone is a controller-only device with limited write surface), the
  version sequence could in theory race across connections. In
  practice the iOS app uses a single serialized writer queue so this
  is safe.
