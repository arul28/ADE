# Storage and recovery

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/state/kvDb.ts` | Opens the project database, runs the interrupted-rebuild recovery pass, classifies database-open errors, creates the headroom-gated migration backup, and exports `rebuildTableInTransaction` / `recoverInterruptedTableRebuilds`. |
| `apps/desktop/src/main/services/state/durableFile.ts` | Atomic temp-write-and-rename persistence, one-generation `.lkg` JSON backup, validation, and primary/previous recovery reads. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Persists chat metadata and transcripts, appends the bounded thread-pointer ledger, reconciles missing pointers from ledger/resume command/transcript, and implements explicit `recoverContinuity` modes. |
| `apps/desktop/src/main/services/chat/providerResumeClassifier.ts` | Classifies a provider resume failure as missing thread, provider environment, transient transport, or unknown without treating every provider error as lost continuity. |
| `apps/desktop/src/main/services/runtime/lastFailureStore.ts` | Stores typed project/machine failures, keeps one previous report, counts repeated signatures, and computes crash-loop startup backoff. |
| `apps/ade-cli/src/services/runtime/failureLogDeduper.ts` | Emits the first repeated brain failure immediately and only periodic occurrence summaries afterward. |
| `apps/ade-cli/src/services/runtime/runtimeLogMaintenance.ts` | Bounds launchd stdout/stderr with tail-copy plus in-place truncation. |
| `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` | Brain-independent diagnosis and ordered repair: space, ownership, database validation, migration recovery, service restart, endpoint/project verification, and chat reconciliation. |
| `apps/desktop/src/main/services/storage/diskPressure.ts` | Samples all ADE storage roots, classifies pressure with recovery hysteresis, and gates write-producing operation classes. |
| `apps/desktop/src/main/services/storage/storageInsightsService.ts` | Builds categorized storage snapshots and preview-confirmed cleanup plans without following symlinks or deleting protected state. |
| `apps/desktop/src/main/services/storage/historyCompression.ts` | Finds inactive old history, gzip-compresses it, verifies byte identity, and only then removes the original; also reinflates before append. |
| `apps/desktop/src/renderer/components/app/StoragePressureIndicator.tsx` | Quiet top-right warning/critical/exhausted status and entry point to Storage settings. |
| `apps/desktop/src/renderer/components/app/ProjectRecoveryScreen.tsx` | Full-project recovery surface for typed open failures, diagnosis, repair progress, next action, and technical details. |
| `apps/desktop/src/renderer/components/chat/ChatContinuityRecoveryCard.tsx` | In-transcript choices to retry the original thread, rebuild from ADE history, or start a separate chat. |
| `apps/desktop/src/renderer/components/settings/StorageSection.tsx` | Storage dashboard with volume pressure, category totals, cleanup preview/confirmation, and manual history compression. |

## Behavior

### Restart-safe database rebuilds

`rebuildTableInTransaction` performs create-staging, copy, count verification,
drop, rename, and index recreation inside one `BEGIN IMMEDIATE` transaction.
Any error rolls the transaction back, including a real `SQLITE_FULL`, so the
original table remains authoritative and no staging table survives.

At database open, `recoverInterruptedTableRebuilds` runs before `migrate()` and
classifies older, non-transactional staging shapes:

| Original | Staging | Classification | Action |
|---|---|---|---|
| Present | Empty | Safe abandoned start | Drop staging. |
| Present | Non-empty, same ordered columns, row count no greater than original | Safe partial copy | Drop staging; original remains authoritative. |
| Missing | Present with columns | Drop/rename was interrupted | Rename staging to the original name. |
| Present/missing | Shape or counts do not meet a safe rule | Ambiguous | Keep both, report `migration_unknown_state`, and require guided recovery. |

The migration backup is written only once and only when free space can hold the
database plus required headroom. Rebuild plans recreate secondary indexes
explicitly; excluded non-CRR tables such as `automation_ingress_events` must
retain their unique indexes.

### Durable metadata and chat continuity

`writeJsonWithPrevious` copies the current valid generation to `<file>.lkg`,
writes a same-directory temporary file, optionally syncs it, and atomically
renames it over the primary. A failed write does not replace the primary.
`readJsonWithRecovery` accepts only payloads that pass the caller's validator
and falls back from primary to the one `.lkg` generation.

Chat thread identity has three redundant sources:

1. Version-2 chat metadata in `.ade/cache/chat-sessions/<sessionId>.json`.
2. The latest valid record per session in the bounded
   `thread-pointers.jsonl` continuity ledger.
3. The session `resume_command` and provider pointer found in the durable
   transcript tail.

If metadata cannot be read, reconciliation chooses the durable pointer without
starting a provider thread and writes repaired metadata. A failed provider
resume never silently starts fresh. The service preserves the original pointer,
sets `continuityRecovery.state: "required"`, emits a `system_notice` whose
`detail.kind` is `"continuity_recovery"`, and waits for one explicit action:

- `retry_original` retries the preserved pointer.
- `recover_from_history` creates a new provider thread in the same chat with a
  bounded hidden history capsule and records old/new pointer lineage.
- `start_new_chat` creates a distinct chat and records the relationship.

### Typed project-open recovery

Database/runtime failures use `AdeRecoveryErrorCode` rather than renderer
string matching. The brain records a bounded report in `lastFailureStore`; the
local runtime pool reads that report and throws a coded refusal instead of
starting a second app-owned brain on the primary socket. IPC carries the code
through project transition state. `ProjectRecoveryScreen` requests a fresh
diagnosis and renders plain-language repair actions, while technical detail
stays behind disclosure. `projectRecoveryService` does not depend on a healthy
brain, so it can validate and repair the database that prevented the brain from
starting.

The repair sequence stops at the first unsafe step. It checks free space,
establishes exclusive ownership, runs `quick_check`, opens the database so the
pre-migration recovery pass can resolve staging, restarts the service, verifies
the endpoint and project RPC, then counts chat records and continuity warnings.

### Disk pressure and enforcement

The monitor samples every configured project/machine root and uses the most
constrained volume. Severity rises immediately; falling to a lower severity
requires two consecutive lower samples. If all measurements fail, the monitor
fails open and logs each root once.

| State | Definition | User effect |
|---|---|---|
| `normal` | More than 12 GiB and more than 5% free | All operations allowed. |
| `warning` | At most 12 GiB or 5% free | Indicator shown; all operations allowed. |
| `critical` | At most 4 GiB or 2% free | New chats/CLI/processes remain allowed; compression and high-write jobs stop. |
| `exhausted` | At most 1 GiB free | New write-producing work is refused with plain-language `disk_full` guidance. |

| Operation/session type | Normal | Warning | Critical | Exhausted |
|---|---:|---:|---:|---:|
| Chat turn | Allow | Allow | Allow | Refuse |
| CLI session launch | Allow | Allow | Allow | Refuse |
| Managed process start | Allow | Allow | Allow | Refuse |
| High-write background job | Allow | Allow | Refuse | Refuse |
| History compression | Allow | Allow | Refuse | Refuse |

Existing sessions and processes are not killed when pressure rises. The gates
apply at the next write-producing start boundary.

### Storage categories and cleanup safety

| Category | Contents | Default safety |
|---|---|---|
| Chats and history | Chat/terminal JSONL, logs, terminal snapshots | `compressible` |
| Lanes and worktrees | Active, archived, and orphaned managed worktrees | Active `protected`; archived/orphaned `review_first` |
| Build and release | ADE temp staging and iOS DerivedData | Old/rebuildable `safe_to_remove`; current staging `review_first` |
| Caches | Rebuildable cache and update staging | `safe_to_remove`; chat session records `protected` |
| Proof and attachments | Artifacts, recordings, attachments | `review_first` |
| Recovery backups | Database migration/recovery backups | `review_first`, or `safe_to_remove` only when old, healthy, and unrelated to a fresh database-open failure |
| Database | Database, WAL, and shared-memory files | `protected` |

Safety values are contracts: `safe_to_remove` is reconstructible,
`compressible` is retained losslessly in a smaller form, `review_first`
requires explicit user confirmation, and `protected` is never a cleanup
target. Cleanup is preview-confirmed and revalidates path, inode/metadata,
size, lane ownership, age, and safety before deletion. The scanner and cleanup
validator use `lstat` and reject links or link ancestors.

### History compression

A compression candidate is an inactive regular `.jsonl`/`.log` file older than
30 days, not already compressed/partial, and no larger than 256 MiB. Automatic
sweeps consider at most 25 oldest files and only run under normal pressure.
Compression streams the source through SHA-256 and gzip, syncs the partial,
gunzips it through a second SHA-256/byte count, and checks that the source size
and modification time did not change. Only a byte-identical verified result is
renamed to `.gz` and allowed to replace the original. Any append path first
re-inflates the gzip atomically and removes the compressed copy.

### Backup and retention bounds

| State | Bound | Retention rule |
|---|---:|---|
| Durable JSON metadata | Primary + 1 `.lkg` | The previous valid generation is replaced on the next write. |
| Thread-pointer ledger | 64 KiB | Compacts to the newest valid record per session; a malformed tail is ignored. |
| Last-failure reports | Current + 1 previous | Repeated same-signature failures increment the current report; a changed signature rotates current to previous. |
| Database migration backup | 1 | `<db>.pre-crsqlite-w1.bak` is created once and only with sufficient headroom. |
| launchd logs | 10 MiB threshold × 2 streams | `launchd.err.log` and `launchd.out.log` each keep a 1 MiB `.1` tail, then copytruncate the live file to zero. |
| Desktop JSONL logs | 10 MiB × 2 generations | Current log plus one `.1` rotation; the older rotation is replaced. |
| Transparent compressed history read | 256 MiB decompressed | Larger inputs are rejected rather than expanded in memory. |
| Automatic compression sweep | 25 files | Oldest eligible files first, with a delay between files. |

## Gotchas

- The interrupted-rebuild recovery pass **must run before `migrate()`**. An
  idempotent create in migration can turn a safe completed rename into an
  ambiguous original-plus-staging state.
- Excluded tables do not get CRR index rewriting. Their rebuild plan must keep
  every required unique and secondary index.
- `PRAGMA foreign_keys` changes must happen outside a transaction; changing it
  inside an active transaction is ineffective.
- launchd holds open descriptors for its stdout/stderr paths. Use
  copytruncate, not rename, or the service keeps writing to the unbounded old
  inode.
- A worktree may contain its own nested `.ade`. Count that data only through
  the worktree category; scanning it again as top-level project state double
  counts bytes.
- Writers append to plain history. If a `.gz` exists, reinflate atomically
  before append; never append a second plain stream beside the compressed
  generation.
