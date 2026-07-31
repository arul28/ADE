# CRDT Model (cr-sqlite)

ADE's replicated state is a CRDT: every row of every eligible table
carries per-column Lamport timestamps, and merges use last-writer-wins
per column. This document describes how cr-sqlite is wired up on desktop,
how iOS emulates the same contract without the loadable extension, and
the schema implications that fall out of the CRR retrofit.

## Where it plugs in

The entire CRDT layer lives inside the shared DB adapter:
`apps/desktop/src/main/services/state/kvDb.ts` exposes an `AdeDb` with
an `AdeDb.sync` object. The same module is consumed both by the
Electron main process and by the **ADE runtime** (`ade serve`);
both open the same `.ade/ade.db` and use the same `AdeDb.sync`
surface, so a change in either place is wire-compatible with the other.

Every other service talks to plain SQLite (`run`, `get`, `all`,
`prepare`); `AdeDb.sync` exposes:

- `getSiteId(): string` — the local cr-sqlite site identifier.
- `getDbVersion(): number` — the monotonic replication version.
- `exportChangesSince(version, { maxRows?, throughDbVersion?, excludeTables?,
  rejectOversizedVersionGroup? }):
  CrsqlChangeRow[]` — the changes generated since the given version.
  Exports are **windowed and bounded**: callers constrain the scan to
  a `db_version` range (the sync pump and peer relay walk 250k-version
  windows per poll, ~4 batches of rows at a time) and the scan runs
  inside a read transaction that pins the WAL snapshot. Both are
  load-bearing: the `crsql_changes` vtab aborts any scan
  (`SQLITE_ABORT`) when another connection commits mid-read, a bare
  `LIMIT` cannot bound a vtab scan (it applies after the full backlog
  is materialized and sorted), and version-range constraints are the
  only thing that pushes down to the indexed clock tables. Truncation
  only happens at complete `db_version` groups so ack watermarks stay
  correct. `excludeTables` applies inside the SQL query before limiting.
  With `rejectOversizedVersionGroup`, a group larger than `maxRows` throws
  `crsql_export_version_group_too_large` instead of materializing the whole
  transaction in memory.
- `applyChanges(rows: CrsqlChangeRow[]): ApplyRemoteChangesResult` —
  apply remote changes locally.
- `discardUnpublishedChangesForTables(tableNames: string[]): void` —
  records a per-table, per-site high-water mark in the local-only
  `local_crr_change_suppressions` table so subsequent
  `exportChangesSince` calls filter local-site rows for those tables at
  or below the current `db_version`. Used when local viewer state
  (e.g. the device registry on a viewer join) must be cleared without
  relaying those clears to sync peers.

The canonical `syncHostService` and `syncPeerService`
(`apps/ade-cli/src/services/sync/`) use those four primitives plus
`syncProtocol.ts` envelope encoding to do the actual wire exchange.
The desktop tree's matching files are one-line re-exports of the
ade-cli modules — there is no second implementation to keep in sync.

## Desktop / daemon: native loadable extension

Both the Electron main process and the `ade serve` daemon open SQLite
through `node:sqlite` and load a vendored `crsqlite.dylib` (macOS) /
`.so` (linux) as a loadable extension. A fresh connection runs
`SELECT load_extension(...)` once, then `AdeDb` marks every eligible
non-virtual table as a CRR at startup:

```sql
SELECT crsql_as_crr('table_name');
```

**Exclusions:**

- `sqlite_%`, `crsql_%` — virtual / internal tables

The migration is dynamic: any new table that appears in
`sqlite_master` and is not in the excluded set is marked as a CRR
automatically at next startup. There is no hand-curated CRR list to
maintain when a feature adds a table.

Startup also self-heals **orphaned CRR shadow tables**
(`removeOrphanedCrrMetadata` in `kvDb.ts`): if a base table was
dropped but its `__crsql_clock` / `__crsql_pks` shadow tables were
left behind, every `crsql_changes` scan fails instantly with
`SQLITE_ABORT` — the vtab unions all clock tables it finds — silently
killing changeset export (mobile sync, peer relay) while writes keep
working. The repair drops shadow tables whose base table no longer
exists before any other CRR work, so existing DBs heal on the next
brain start.

Startup also self-heals **orphaned rebuild staging tables**. Copy-table
migrations (`rebuildTableInTransaction`, used for the column drop/rename that
CRR forbids in place — see Rule 2) issue a bare
`CREATE TABLE __ade_crr_repair_<name>`. A rebuild whose process was killed, or
whose row-copy failed on a bloated source table, can leave that staging table
behind — and then every retrofit throws `table already exists`, wedging the sync
host in an infinite repair loop that silently starves changeset export. Two
guards prevent this: `rebuildTableInTransaction` now drops any leftover staging
table (and its `__crsql_clock` / `__crsql_pks` siblings) inside the same
transaction before the `CREATE`, and `sweepOrphanedRepairStagingTables()` runs at
`openKvDb` — after `recoverInterruptedTableRebuilds()` has salvaged interrupted
renames — to clear any orphan recovery could not reconcile (staging bases it
deliberately marked ambiguous are skipped, since retrofit already skips them).
Every drop uses `if exists` and the whole sweep is wrapped so it never throws out
of open, and original tables are untouched, so no user data is lost. The
root-cause bloat is bounded separately: `automation_ingress_events` now has a
hard 10,000-rows-per-project cap (any status) on top of the 2,000 active-row cap,
so an always-on brain dispatching high webhook volume can't grow the table inside
the 7-day retention window to the point where its rebuild fails mid-copy (see
[ARCHITECTURE §3.1](../../ARCHITECTURE.md)).

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

Legacy secondary unique indexes also need to be removed on upgrade
before CRR conversion. `lane_linear_issue_links` is the current model:
startup drops the old `(project_id, lane_id, issue_id, role)` unique
index, deduplicates to the newest row per tuple, and keeps non-unique
lookup indexes only. The iOS bootstrap SQL mirrors that cleanup so a
fresh phone database can enable CRR for the table without hitting a
unique-index constraint.

### Rule 2: `ALTER TABLE ADD COLUMN` is safe; `DROP COLUMN` is not

The adapter wraps `ADD COLUMN` with `crsql_begin_alter` /
`crsql_commit_alter`, which re-registers the trigger set for the new
column. Dropping or renaming a column on a replicated table is not
supported by the current adapter and must be migrated through a copy
table.

### Rule 3: Machine-bound state is not a CRR

Do not add tables to the replicated set that only matter on one
device. Worktrees, PTY handles, transcripts, and caches are
explicitly excluded. If a table is useful as "the host knows X", it
should live outside `.ade/ade.db` or be designed so the host owns
all writes and controllers only read. The local-only excluded set
is enumerated in `kvDb.ts`'s `LOCAL_ONLY_CRR_EXCLUDED_TABLES` and
includes `lane_detail_snapshots`, `lane_list_snapshots`,
`local_crr_change_suppressions`, `local_worktree_residual_cleanups`,
`pr_auto_link_ignores`, `pull_request_ai_summaries`, and
`runtime_processes`.

### Local clears that must not propagate

Some bookkeeping tables are CRRs on every device but occasionally
need to be wiped on one device without that wipe being relayed to
peers — the canonical case is the device registry on a viewer join,
where the daemon clears its local `devices` and `sync_cluster_state`
rows before adopting the host's snapshot. The naive approach
(running `DELETE FROM devices`) generates CRR tombstones that the
peer would then ship back to the host, erasing the host's authoritative
registry.

`AdeDb.sync.discardUnpublishedChangesForTables(tableNames)` is the
escape hatch:

1. Capture the current `getDbVersion()` as the suppression
   high-water mark.
2. Upsert one row per `(table_name, site_id)` into
   `local_crr_change_suppressions` with `through_db_version` set to
   that mark (or `max(existing, new)` on conflict).
3. `exportChangesSince(version)` consults the suppression map for the
   local site id and drops any local-site rows whose `db_version <=
   through_db_version` for a suppressed table. Foreign-site rows for
   the same table are still exported normally.

After the clear, the caller is expected to advance the peer client's
outbound cursor (`syncPeerService.acknowledgeLocalDbVersion()`) so
nothing in the suppressed range can ever be queued for transmission.
`local_crr_change_suppressions` is itself in
`LOCAL_ONLY_CRR_EXCLUDED_TABLES`, so the suppression bookkeeping never
syncs.

## Changeset extraction and application

### Extract

```sql
SELECT * FROM crsql_changes
 WHERE db_version > ? AND db_version <= ?   -- bounded version window
 ORDER BY db_version, cl, seq;
```

Wrapped in `AdeDb.sync.exportChangesSince(version, options)`, run
inside a read transaction that pins the WAL snapshot (concurrent
commits otherwise abort the vtab scan). The sync pump and peer relay
scan a 250,000-version window per poll and advance the cursor across
empty windows; suppression-filtered fetches keep scanning forward
until surviving rows appear or the range is exhausted, so a truncated
fetch can never silently skip rows. Returned `CrsqlChangeRow`s are
batched into `changeset_batch` envelopes. Because the replication
watermark is the integer `db_version`, the transport must not split
rows that share one `db_version` across separate host batches.

Normal host/desktop-peer batches target 250 rows / 256 KB. A peer with
active chat subscriptions gets a 64 KB byte target, and the host may defer
background changesets while its socket buffer is above 512 KB — but for at
most 2 seconds, so a busy chat cannot starve CRR convergence. The byte/row
limits are split targets rather than hard transaction caps: one complete
`db_version` group is admitted even when that group alone exceeds a target.

Hosted browsers negotiate `invalidationOnlyV1` because they have no local CRR
replica and `compactInvalidationV1` when they understand bounded refresh hints.
A supporting host confirms both capabilities in `hello_ok`, starts a new
browser at the current database watermark, and sends post-connect
`invalidation_batch` envelopes containing only database-version bounds and
changed table names after the browser's initial full-domain refresh. These
envelopes have a hard 16 KB serialized limit; an invalid or oversized table set
collapses to a compact full-refresh hint, so a single large CRR value cannot
overflow the Relay bridge. Same-DB socket handoff restores the deposited live
cursor so writes committed during the handoff window are not skipped.
Foreground requests defer invalidation scans only for their own peer and for at
most 2 seconds; the forced fairness scan uses the active-chat 64 KB/64-row
limits. Browsers close with desktop update guidance when an older host does not
confirm both contracts, preventing a historical replay or oversized live row
from overflowing Relay. Older browsers that advertise only
`invalidationOnlyV1` remain on their existing `changeset_batch` hint path.

Replica iOS peers advertising both `changesetAck` and `chunkedEnvelopes` use a
compact reseed when their host cursor is strictly more than 5,000 versions
behind. The host fixes a target version and scans current CRR state from version
0 in 250,000-version windows, at most 1,000 relevant rows per poll. Mobile-only
exclusions and host-authoritative tables are removed in SQL. The shared build
and logical payload are capped at 10,000 rows / 4 MiB; a larger state or version
group falls back to normal incremental replay. A successful build is sent as
one logical `reason: "catchup"` batch (using `envelope_chunk` frames as needed),
and writes after its fixed target resume incrementally.

### Apply

```sql
INSERT INTO crsql_changes(...);
```

Wrapped in `AdeDb.sync.applyChanges(rows)`. cr-sqlite and the iOS
emulation both handle conflict resolution inside the insert trigger
(accept newer `col_version`, tombstone semantics for deletes, last
writer wins on ties by `site_id`).

Before apply, `kvDb.ts` filters inbound rows for explicitly retired
tables (`unified_memories` and related FTS tables) and for tables that
no longer exist locally. iOS also ignores its hydration-owned snapshot
tables, which are intentionally not part of the desktop CRDT schema,
and **skips rows for any table its bundled schema does not know**
instead of failing the batch. A thrown error there would nack the
whole changeset, the host's cursor would never advance past the poison
batch, and every retry would replay it — freezing all sync for the
device until an app update ships (this happened live when desktop
added `session_linear_issues` before the phone schema had it). Skipped
tables' data arrives after the phone updates. These filters run before
the SQL transaction starts; a batch containing only ignored rows
returns `appliedCount: 0`, preserves the local database version, and
emits no touched tables. Mixed batches remain transactional for the
actionable rows.

After apply, ADE runs post-hooks:

- Emit relevant IPC events (`laneChanged`, `prsChanged`, etc.) so the
  renderer re-queries the affected projections.
- On iOS, post `Notification.Name.adeDatabaseDidChange` so SwiftUI
  views re-read.

## Transactional boundaries

- The host applies each `changeset_batch` envelope as a single SQL
  transaction. Partial application is impossible; the entire batch
  either lands or rolls back.
- Senders keep exactly one batch pending and advance their durable outbound
  cursor only after a successful `changeset_ack`. A NACK or 10-second ack
  timeout retries the identical batch; cursor state never moves speculatively.
  The compact mobile reseed follows the same rule: its target becomes the
  peer's watermark only after the reseed ACK commits.
- After six failed send attempts, host and desktop-peer senders discard the
  encoded pending envelope but retain its `fromDbVersion`. They back off
  (250 ms up to 4 s), re-export from that same cursor, and halve the batch
  targets by recovery level down to 16 rows / 16 KB. A successful ack advances
  the cursor and restores normal limits. This re-windowing lets a poisonously
  large or transiently failing batch make bounded progress without skipping
  CRR rows.
- iOS persists both its last-acked per-project/site cursor and pending outbound
  batch. It retries at 10-second acknowledgement intervals; after its retry
  budget it rebuilds from the same cursor with progressively smaller windows
  (64 rows / 64 KB down to one row / 4 KB) and 1–30 second backoff. Reconnect or
  project switching reloads the persisted batch/cursor rather than claiming
  unacknowledged phone writes were delivered.

## Implementation status

| Piece | Status |
|---|---|
| Desktop / daemon extension loading + CRR marking | Implemented |
| iOS pure-SQL emulation | Implemented, wire-compatible |
| Dynamic CRR discovery | Implemented |
| `ALTER TABLE ADD COLUMN` support | Implemented (wrapped) |
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
- **A leftover `__ade_crr_repair_<name>` staging table wedges the sync
  host.** The copy-table rebuild's `CREATE TABLE __ade_crr_repair_<name>` is bare,
  so a surviving orphan makes every retrofit throw `table already exists` and
  loops forever, silently killing changeset export. `rebuildTableInTransaction`
  drops the staging table before its `CREATE`, and
  `sweepOrphanedRepairStagingTables()` clears orphans at open — do not remove
  either guard, and keep both `__ade_crr_repair_%` and `__ade_fk_repair_%`
  prefixes covered.
- **`ade_next_db_version()` is synchronous and unlocked.** Under
  heavy concurrent write load on iOS (which is unlikely because the
  phone is a controller-only device with limited write surface), the
  version sequence could in theory race across connections. In
  practice the iOS app uses a single serialized writer queue so this
  is safe.
