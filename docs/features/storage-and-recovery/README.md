# Storage and recovery

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/state/kvDb.ts` | Opens the project database (enabling `journal_mode = WAL` + `synchronous = NORMAL` at open), runs the interrupted-rebuild recovery pass, classifies database-open errors, creates the headroom-gated migration backup, and exports `rebuildTableInTransaction` / `recoverInterruptedTableRebuilds`. Attaches the optional `maintenance` (`DbMaintenanceApi`) handle — the prune / compact / vacuum hooks the storage doctor invokes. The machine-local `local_lane_storage_state` and `local_storage_lifecycle_runs` tables retain reclaim retry/estimate and scan timing state; both are excluded from CRR sync because paths and cleanup results belong only to this checkout. |
| `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` | The `DbMaintenanceApi` interface consumed by the storage doctor, plus the single source of truth for the DB retention/count bounds (`INGRESS_EVENT_RETENTION_MS` = 7 days, `INGRESS_EVENT_MAX_ROWS_PER_PROJECT` = 2,000, `REVIEW_ARTIFACT_RETENTION_DAYS` = 30, `PR_SNAPSHOT_RETENTION_DAYS` = 60) imported by the ingress writer, the kvDb hooks, and the storage ledger so the policy can never drift across enforcement sites. |
| `apps/desktop/src/main/services/state/durableFile.ts` | Atomic temp-write-and-rename persistence, one-generation `.lkg` JSON backup, validation, and primary/previous recovery reads. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Persists chat metadata and transcripts, records provider-pointer transitions to the bounded thread-pointer ledger, reconciles missing pointers from ledger/resume command/transcript, gates new turns on disk pressure (`canPerform("chat_turn")`), and implements explicit `recoverContinuity` modes. |
| `apps/desktop/src/main/services/chat/threadPointerLedger.ts` | Standalone append-only continuity ledger (`thread-pointers.jsonl`): typed `ThreadPointerLedgerEntry` records, tolerant parse that drops only a torn tail line, newest-per-session read, and 64 KiB self-compaction (newest records first) via an atomic rewrite. |
| `apps/desktop/src/main/services/chat/providerResumeClassifier.ts` | Classifies a provider resume failure as missing thread, provider environment, transient transport, or unknown without treating every provider error as lost continuity. |
| `apps/desktop/src/main/services/runtime/lastFailureStore.ts` | Stores typed project/machine failures, keeps one previous report, counts repeated signatures, and computes crash-loop startup backoff. |
| `apps/ade-cli/src/services/runtime/failureLogDeduper.ts` | Emits the first repeated brain failure immediately and only periodic occurrence summaries afterward. |
| `apps/ade-cli/src/services/runtime/runtimeLogMaintenance.ts` | Bounds launchd stdout/stderr with tail-copy plus in-place truncation. |
| `apps/ade-cli/src/services/runtime/brainLoopWatchdog.ts` | Worker-thread **event-loop watchdog** for the machine brain. Heartbeats every second with the current command name plus event-loop, memory, and resource diagnostics; a recovered delay over 2 s logs a near-miss. A stall past `ADE_LOOP_WATCHDOG_MS` (30 s default) that is not a sleep/suspend writes an `event-loop-wedge.json` breadcrumb, requests a best-effort Node report, and `SIGKILL`s the brain. On next boot it promotes the evidence to `last-wedge.json` / `last-wedge-report.json`, logs `brain.recovered_from_wedge`, and emits a deduped recovery event. Disable with `ADE_DISABLE_LOOP_WATCHDOG=1`. |
| `apps/ade-cli/src/services/runtime/brainFreshnessMonitor.ts` | The running brain stats its own CLI entrypoint every 5 min (`ADE_BRAIN_FRESHNESS_INTERVAL_MS`), hashes only after the stat changes, and — when the on-disk hash no longer matches the baked runtime hash — waits for the brain to go idle (bounded) before triggering the brain-update service restart so an in-place upgrade takes effect without interrupting active work. Disable with `ADE_DISABLE_BRAIN_FRESHNESS=1`. |
| `apps/ade-cli/src/services/runtime/runtimeBuildIdentity.ts` | `computeRuntimeBuildHash` / `computeRuntimeBuildHashAsync` — the SHA-256 of the CLI entrypoint used as the brain build identity by the freshness monitor and the desktop compatibility handshake. |
| `apps/ade-cli/src/services/runtime/brainLogger.ts` | The machine-brain logger: reuses the desktop `createFileLogger` to write `~/.ade/runtime/brain.jsonl` (10 MiB `.1` rotation) and additionally mirrors timestamped `warn`/`error` lines to stderr so launchd captures them. |
| `apps/ade-cli/src/commands/doctor.ts` | `ade doctor [--online]` — connects to the brain over the local socket and prints one `ok`/`warn`/`fail` row per subsystem (App version, Brain, Wedge history, Sync port, Publish health, Relay, Account); exits non-zero on any `fail`. `evaluateDoctorRows` is pure and dependency-injected so the desktop connection-doctor card and the CLI share one verdict. |
| `apps/desktop/src/shared/adeRuntimeProtocol.ts` | Shared runtime-protocol contract: `RUNTIME_COMPAT_LEVEL` + `isRuntimeProtocolCompatible` (the integer compatibility-window check), and the tolerant parsers `parseRuntimePublishHealth` / `parseRuntimeLastWedge` that decode `runtimeInfo.publishHealth` and `runtimeInfo.lastWedge` for the connection pool, the doctor, and the desktop status surfaces. |
| `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` | Brain-independent diagnosis and ordered repair: space, ownership, database validation, migration recovery, service restart, endpoint/project verification, and chat reconciliation. |
| `apps/desktop/src/main/services/storage/diskPressure.ts` | Samples all ADE storage roots, classifies pressure with recovery hysteresis, and gates write-producing operation classes via `canPerform(kind)`. Exports the `DiskPressureMonitor` type and refusal-message copy. |
| `apps/desktop/src/main/services/storage/volume.ts` | `readVolumeSpace(dir)` (statfs free/total bytes) and `isNoSpaceError(err)` (ENOSPC/EDQUOT and disk-full message detection), shared by the pressure monitor and the database-open error classifier. |
| `apps/desktop/src/main/services/storage/storageInsightsService.ts` | Builds categorized storage snapshots and preview-confirmed cleanup plans without following symlinks or deleting protected state. `proof_attachments` is a manual `review_first` cleanup target for `.ade/artifacts` and `.ade/attachments`; after bytes are removed it invokes the broker's `purgeArtifactRecordsUnder` hook so proof rows cannot outlive their files. It also runs the lane-lifecycle scan at the configured interval: safely archives excess or inactive lanes, marks old archived worktrees for review, and never removes lane files in the background. The **storage doctor** compresses history and maintains the database; filesystem candidates such as staging, backups, DerivedData, and build output remain review-first. Every run is journaled and emits one deduped `ade_feature_used` analytics event. Populates the snapshot's optional `extras` plus lifecycle policy/status and per-item ownership, age, blocked reasons, and reclaim estimates. |
| `apps/desktop/src/main/services/lanes/laneService.ts` | Owns the lane-aware `getReclaimRisk`, `archiveAndReclaim`, and restore-aware `unarchive` operations. It proves exact path-and-branch ownership against this project's Git worktree registry, rejects symlinks, rechecks directory identity before removal, shares the database-backed lane worktree lease with PR workflows, and stores retryable reclaim failures locally. |
| `apps/desktop/src/main/services/storage/storageLedger.ts` | The **storage ledger** (`STORAGE_LEDGER`): the declared policy for every persistent table and directory ADE writes — its privacy class (`user_data` / `derived` / `operational`) and how it is bounded (`write_time` / `doctor` / `both` / `manual`). `LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS` directory to a ledger id (or `null` for intentionally-unmanaged config/credentials) so a coverage test fails CI if a new tracked directory ships without a declared policy. `deriveCategoryPolicyChips()` renders the Settings policy chips from the ledger. |
| `apps/desktop/src/main/services/storage/storageDbBreakdown.ts` | Pure helpers turning raw `dbstat` rows into the coarse project-database breakdown (`classifyDbTable` / `mapDbBreakdown`: webhooks, sync bookkeeping, review artifacts, PR cache, core) and `deriveSyncBookkeepingAction` — which reads the journal so the sync-bookkeeping row offers "Compact now" only after a run proves compaction ran without a `has_peers` skip, and stays "waiting to compact" otherwise. |
| `apps/desktop/src/main/services/storage/storageMaintenanceJournal.ts` | Read/write helpers for the storage-doctor journal — a plain rebuildable JSON file (`storage-doctor-journal.json` under `.ade/cache`, no DB/CRR) capping the last 30 runs, written via temp-file-then-rename so a crash never leaves a torn journal. |
| `apps/desktop/src/main/services/storage/historyCompression.ts` | Finds inactive old history, gzip-compresses it, verifies byte identity, and only then removes the original; also reinflates before append. Exposes `readHistoryFileSync` / `reinflateHistoryFileSync` so transcript, session, and search readers can read a `.gz` generation transparently. |
| `apps/desktop/src/renderer/components/app/StoragePressureIndicator.tsx` | Quiet top-right warning/critical/exhausted status and entry point to Storage settings. Mounted in `TopBar.tsx` (enabled only when a workspace project is open). |
| `apps/desktop/src/renderer/components/app/ProjectRecoveryScreen.tsx` | Full-project recovery surface for typed open failures, diagnosis, repair progress, next action, and technical details. `ProjectTabHost` in `App.tsx` renders it full-viewport whenever `projectTransitionError` carries a `code` and `rootPath`. |
| `apps/desktop/src/renderer/components/app/ProjectTransitionErrorAlert.tsx` | Fallback dismissible banner for project open/switch failures that lack a code/rootPath (un-coded string errors); it renders nothing once a coded error hands the surface to `ProjectRecoveryScreen`. |
| `apps/desktop/src/renderer/components/chat/ChatContinuityRecoveryCard.tsx` | In-transcript choices to retry the original thread, rebuild from ADE history, or start a separate chat. `AgentChatMessageList` renders it in place of a plain notice chip when a `system_notice` event's `detail.kind` is `"continuity_recovery"`. |
| `apps/desktop/src/renderer/components/settings/StorageSection.tsx` | Storage dashboard: plain-language lane cleanup rules, last/next safety-scan status, and a review table for archived lanes, orphaned worktrees, DerivedData, and build output with ownership, age, blocked reasons, and reclaim estimates. Archive & Reclaim has a typed confirmation and explains exactly what stays and what restore recreates. The page also keeps the category totals, Health & diagnostics strip, project-database breakdown, cleanup preview, recent-cleanups journal, and manual history compression. |
| `apps/desktop/src/renderer/components/settings/storage/StorageDiagnostics.tsx` | The "Health & diagnostics" strip: four tiles — database size (with a journal-fed sparkline + trend arrow), background-service resident memory, slow responses in 24 h (from `getRuntimeHealth`), and last cleanup — plus the overall health chip. Deep-linked as `#diagnostics` from the top-bar load pill. |
| `apps/desktop/src/renderer/components/settings/storage/StorageMaintenanceJournal.tsx` | Collapsible "Recent cleanups" panel rendering the last runs from the maintenance journal, one humanized line per action. |
| `apps/desktop/src/renderer/components/settings/storage/storageUiConstants.ts` | Shared presentational constants (`STORAGE_BRAND`, `PANEL_STYLE`) for the section shell and the split-out diagnostics/journal components, so they share styling without a circular import. |
| `apps/desktop/src/renderer/components/settings/storage/StorageCleanupDialog.tsx` | Preview-confirmed cleanup dialog: lists selected removable items with sizes, surfaces blocked paths and reasons, and only enables Remove once a fresh preview is in hand. Also hosts the itemized "Clean up safely" plan and its `runMaintenance` path. |
| `apps/desktop/src/renderer/components/settings/storage/storageView.ts` | Pure, DOM-free presentation + policy helpers. Category metadata/order/hues, safety labels, and `buildCleanupTarget` / `cleanableEntries` / `groupLaneItems` map a snapshot item to a typed `StorageCleanupTarget`. The overhaul adds the diagnostics/maintenance view-model: `dbBreakdownRows`, `buildSafeCleanupPlan`, journal/db-size-sparkline/trend helpers, `daemonMemoryBytes`, `healthChip`, `formatSlowActions`, and `categoryPolicyChip` — each degrading to a sensible "not available" value so the UI renders against an older daemon that never sends `extras`. |
| `apps/desktop/src/shared/types/storage.ts` | Shared storage contracts: disk-pressure types, `StorageCategoryId`, `StorageSafety`, `StorageItem`/`StorageCategorySnapshot`/`StorageSnapshot`, and the `StorageCleanupTarget`/`StorageCleanupPreview`/`StorageCleanupResult` DTOs. `StorageItem` carries ownership, age, blocked reasons, reclaim estimate/state, and lane ownership for the review screen; `StorageLifecycleSnapshot` carries the effective four-rule policy plus last/next scan and review counts. The ledger/maintenance surface includes `StorageLedgerEntry`/`StoragePolicyClass`, `MaintenanceAction`/`MaintenanceRunReport`/`MaintenanceTrigger`, `DbBreakdownEntry`, `StorageSnapshotExtras`, and `RuntimeHealthSnapshot`. |
| `apps/desktop/src/shared/types/recovery.ts` | Typed recovery contracts: the `AdeRecoveryErrorCode` union + `toAdeRecoveryErrorCode`, `AdeLastFailureReport`, `ProjectRecoveryDiagnosis`, the ordered `RepairStepId` list + `ProjectRepairReport`, and `mapKvDbOpenErrorCode`. |
| `apps/desktop/src/shared/codedError.ts` | `codedError(message, code)`, `encodeCodedErrorMessage`, and the `parseCodedErrorMessage`/`stripElectronErrorWrapper`/`extractCodeFromMessage` decoders that let the renderer recover a `code` through the Electron IPC error-wrapping. Re-exported to the renderer via `apps/desktop/src/renderer/lib/codedError.ts`. |

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

### Brain resilience: watchdog, freshness, and recovery notice

The machine brain guards its own liveness. The **event-loop watchdog**
(`brainLoopWatchdog.ts`) runs an unref'd worker thread that the main thread
heartbeats every second with the name of the command currently running
(`trackBrainLoopWatchdogCommand`). If the heartbeat stalls past
`ADE_LOOP_WATCHDOG_MS` (30 s default) — and the gap is a genuine wedge, not a
laptop sleep/suspend, which the worker distinguishes by comparing wall-clock and
monotonic deltas — the worker atomically writes an `event-loop-wedge.json`
breadcrumb (wedged command, blocked ms, threshold, and the latest event-loop,
memory, and resource snapshot) under the runtime dir, requests a best-effort
Node diagnostic report, and `SIGKILL`s the brain after a one-second report
grace so launchd restarts it. A recovered heartbeat delay over 2 s logs
`brain.event_loop_near_miss` with the same diagnostic shape.

On the next boot the watchdog promotes any breadcrumb and generated report to
`last-wedge.json` / `last-wedge-report.json`,
logs `brain.recovered_from_wedge`, and emits a deduped `ade_brain_recovered`
analytics event. The recovered wedge is exposed to clients through
`runtimeInfo.lastWedge` (parsed by `adeRuntimeProtocol.parseRuntimeLastWedge`,
surfaced on `LocalRuntimeStatus.lastWedge`), and the desktop app shell shows it
once per distinct `ts` in `BrainRecoveryNotice` ("ADE recovered from a
background issue … a stuck task was restarted"). `ade doctor` reports the same
`last-wedge.json` as its Wedge-history row.

Separately, the **freshness monitor** (`brainFreshnessMonitor.ts`) keeps a
long-lived login-service brain from drifting behind an in-place binary upgrade:
it stats its own CLI entrypoint every 5 min, hashes only on a stat change
(`runtimeBuildIdentity.computeRuntimeBuildHashAsync`), and when the disk hash no
longer matches the baked runtime hash it waits for the brain to be idle (bounded
by a max wait) before requesting the brain-update service restart. A transient
restart failure keeps the previous stat baseline so the unchanged replacement is
re-checked on the next probe rather than the check disabling itself.

### Disk pressure and enforcement

The monitor samples every configured project/machine root and uses the most
constrained volume. Severity rises immediately; falling to a lower severity
requires two consecutive lower samples. If all measurements fail, the monitor
fails open and logs each root once.

| State | Definition | User effect |
|---|---|---|
| `normal` | More than 12 GiB and more than 5% free | All operations allowed. |
| `warning` | At most 12 GiB or 5% free | Indicator shown; all operations allowed. |
| `critical` | At most 4 GiB or 2% free | New chats and CLI sessions remain allowed; compression and high-write jobs stop. |
| `exhausted` | At most 1 GiB free | New write-producing work is refused with plain-language `disk_full` guidance. |

| Operation/session type | Normal | Warning | Critical | Exhausted |
|---|---:|---:|---:|---:|
| Chat turn | Allow | Allow | Allow | Refuse |
| CLI session launch | Allow | Allow | Allow | Refuse |
| High-write background job | Allow | Allow | Refuse | Refuse |
| History compression | Allow | Allow | Refuse | Refuse |

Existing sessions are not killed when pressure rises. The gates
apply at the next write-producing start boundary. Enforcement lives at each
start boundary rather than in one place: `agentChatService` gates a new turn
(`chat_turn`), `ptyService.create` gates a new tracked CLI PTY (`cli_launch`), and the
history compressor gates its own sweeps (`compression`). Every refusal throws a
`disk_full`-coded error whose message is the user-facing copy in
`DISK_PRESSURE_REFUSAL_MESSAGES`. The monitor and `storageInsightsService` are
constructed in both `apps/desktop/src/main/main.ts` (desktop) and
`apps/ade-cli/src/bootstrap.ts` (runtime), so the gate applies on the local
brain and the desktop in-process path alike.

Reads never break because history was compacted: `ptyService`,
`sessionService`, and `searchService` transparently fall back to a `.gz`
generation through `readHistoryFileSync`, and `ptyService.create` reinflates a
compressed transcript before reopening it for append.

### Storage categories and cleanup safety

| Category | Contents | Default safety |
|---|---|---|
| Chats and history | Chat/terminal JSONL, logs, terminal snapshots | `compressible` |
| Lanes and worktrees | Active, archived, reclaimed, and orphaned managed worktrees | Active `protected`; archived lanes use Archive & Reclaim; orphans `review_first` |
| Build and release | ADE temp staging, build output, and iOS DerivedData | `review_first` |
| Caches | Rebuildable cache and update staging | `safe_to_remove`; chat session records `protected` |
| Proof and attachments | Artifacts, recordings, attachments | `review_first` |
| Recovery backups | Database migration/recovery backups | `review_first`, or `safe_to_remove` only when old, healthy, and unrelated to a fresh database-open failure |
| Database | Database, WAL, and shared-memory files | `protected` |

Safety values are contracts: `safe_to_remove` is reconstructible,
`compressible` is retained losslessly in a smaller form, `review_first`
requires explicit user confirmation, and `protected` is never a cleanup
target. Cleanup is preview-confirmed and revalidates path, inode/metadata,
size, lane ownership, age, and safety before deletion. The scanner and cleanup
validator use `lstat` and reject links or link ancestors. Archived lane
worktrees cannot enter the generic cleanup pipeline: they must use the
lane-aware Archive & Reclaim path so ADE can preserve metadata and recreate the
worktree during restore. That lane-aware path additionally requires the exact
saved path and expected branch to be registered as this project's Git
worktree, rechecks symlink and directory identity immediately before removal,
and holds the same database-backed worktree lease used by PR workflows.

### Lane lifecycle rules

Settings > Storage owns the four project cleanup rules:

- maximum active lanes;
- archive inactive lanes after a configured age;
- run the safety scan at a configured interval;
- flag archived worktrees for reclaim review after a configured age.

The backend, not the renderer, enforces these settings. The daemon checks once
per minute whether the configured interval has elapsed; `0` disables scheduled
scans. A scheduled scan can archive only a clean, merged/pushed, unattached
managed lane with no running chat, PTY, watcher, protected edit operation, or
linked pull-request group. Blocked lanes remain active. The retention rule
never deletes files: it marks the archived lane `ready_for_review` so a person
can inspect the estimate and explicitly confirm Archive & Reclaim.

Proof/attachment cleanup accepts only the `.ade/artifacts` or
`.ade/attachments` roots (or descendants) after the same symlink/path
validation. Removing artifact bytes calls
`computerUseArtifactBrokerService.purgeArtifactRecordsUnder()` immediately
afterward, deleting matching canonical proof rows and links. This is an
explicit `review_first` action; it is not part of automatic safe cleanup.

### History compression

A compression candidate is an inactive regular `.jsonl`/`.log` file older than
30 days, not already compressed/partial, and no larger than 256 MiB. Automatic
sweeps consider at most 25 oldest files and only run under normal pressure.
Compression streams the source through SHA-256 and gzip, syncs the partial,
gunzips it through a second SHA-256/byte count, and checks that the source size
and modification time did not change. Only a byte-identical verified result is
renamed to `.gz` and allowed to replace the original. Any append path first
re-inflates the gzip atomically and removes the compressed copy.

### Storage doctor maintenance sweep

`storageInsightsService` runs a single **storage doctor** sweep that keeps ADE's
footprint bounded without ever touching user data. It is single-flighted (a
concurrent call joins the in-flight run) and fires on three triggers:
`post_boot` (10 minutes after the real daemon instance starts), `daily` (every
24 h thereafter), and `manual` (`runMaintenanceNow()`, wired to the
`storage.runMaintenanceNow` action / IPC and the section's "Clean up safely"
button). Only the real daemon instance — the one constructed with both
`isPathActive` and `diskPressure` — arms the timers; the desktop in-process
fallback instance never schedules maintenance and only acts if
`runMaintenanceNow` is called directly.

Each run is a fixed sequence of independently try/caught steps, so one failing
step never aborts the run. Filesystem removal stays outside the automatic
sweep: generic files remain preview-confirmed, and archived lane worktrees must
go through the lane-aware typed-confirmation path.

1. Run the lane lifecycle safety scan.
2. Compress inactive chat/terminal history (`fs.transcripts`).
3. Record filesystem review candidates without deleting them.
4. Invoke the kvDb DB-maintenance hooks: prune `automation_ingress_events`,
   `review_run_artifacts`, and `pull_request_snapshots`; compact cr-sqlite
   sync bookkeeping; and vacuum when the freelist is fragmented.

The run is appended to the maintenance journal and summarized in a
`storage.maintenance_completed` log with a `completed` / `partial` / `failed`
outcome. Exactly one deduped `ade_feature_used` (`feature: storage_doctor`)
analytics event is captured at the daemon boundary per completed run, collapsed
to one per 20 h so a daily sweep plus a manual "Clean up now" reads as a single
product event.

### Storage ledger and policy

`storageLedger.ts` declares `STORAGE_LEDGER`, the single source of truth for what
every persistent table and directory holds, its privacy class, and how it is
bounded. Privacy classes are `user_data` (never auto-deleted), `derived`
(re-derivable/re-fetchable), and `operational` (bookkeeping). Enforcement is one
of `write_time` (bounded as it is written), `doctor` (swept by the maintenance
run), `both`, or `manual` (only removed on explicit user request). The ledger
is the source the Settings policy chips read (`deriveCategoryPolicyChips`) and
the DB retention numbers derive from the shared `dbMaintenanceApi` constants, so
a policy change updates every enforcement site and the Settings copy in lockstep.

`LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS` directory to a
ledger id, or to `null` when the directory is intentionally not storage-managed
(git-tracked scaffold, agent-runtime scratch, or credentials the doctor must
never sweep). A coverage test in `storageInsightsService.test.ts` asserts that
every layout directory appears in the map, so adding a new tracked directory
without declaring its storage policy fails CI.

### Database maintenance hooks

`kvDb.ts` attaches a `maintenance` (`DbMaintenanceApi`) handle to the open
database. Every hook is wrapped so any failure logs `db.maintenance_failed` and
returns an `unsupported` skip rather than throwing, and each first checks that
its target table exists:

- `pruneIngressEvents` — age (7 d) + per-project count (2,000) prune of
  `automation_ingress_events`.
- `pruneReviewArtifacts` — delete `review_run_artifacts` older than 30 days.
- `prunePrSnapshots` — delete `pull_request_snapshots` not updated in 60 days.
- `compactCrsqlTombstones` — rebuild the `operations` CRR table to shed
  cr-sqlite clock/pks shadow rows, then vacuum. **Only runs when the project has
  zero sync peers** (`options.hasSyncPeers`, defaulting conservatively to
  "assume peers"); otherwise it returns a `has_peers` skip and touches nothing,
  because compacting shared change-tracking state mid-sync is unsafe.
- `vacuumIfFragmented(threshold)` — when the freelist fraction exceeds the
  threshold, a one-time full `VACUUM` rebuilds the file and activates
  `auto_vacuum = INCREMENTAL`; every later sweep then reclaims the freelist in
  bounded `incremental_vacuum` chunks (≤ 25 × 2,000 pages per call) so a blocking
  full VACUUM never runs again. Each call finishes with a `wal_checkpoint(TRUNCATE)`
  and reports bytes reclaimed from the on-disk footprint (`.db` + `-wal` + `-shm`).

The database is opened in WAL mode with `synchronous = NORMAL`
(`journal_mode = WAL` set explicitly at open in `openRawDatabase`).

### Maintenance journal, diagnostics, and runtime health

Every doctor run appends a `MaintenanceRunReport` (trigger, per-action results,
bytes reclaimed, and the post-run DB size) to `storage-doctor-journal.json`
under `.ade/cache`, capped at the last 30 runs and written atomically. The
journal is a plain rebuildable file — no DB, no CRR — so a corrupt or missing
journal degrades to empty.

The Settings > Storage snapshot carries an optional `extras` block built from the
journal and a `dbstat` scan: the project-database breakdown (webhooks, sync
bookkeeping, review artifacts, PR cache, core — `dbstat` is treated as optional
and degrades to no breakdown when the SQLite build lacks it), the recent-runs
journal, the derived per-category policy chips, and a safe-reclaimable byte
estimate. The renderer's "Health & diagnostics" strip renders a DB-size
sparkline/trend from the journal, the background service's resident memory, the
last-cleanup headline, and a **slow-responses (24 h)** tile. That last figure
comes from `LocalRuntimeConnectionPool.getRuntimeHealth()` (surfaced by the
`ade.app.getRuntimeHealth` IPC), a rolling, age- and count-bounded window of
daemon action calls that took over 500 ms or errored — the same calls that emit
`local_runtime.action_slow`. The top-bar resource-pressure "load pill" deep-links
into this strip via `#/settings?tab=storage#diagnostics`.

### Backup and retention bounds

| State | Bound | Retention rule |
|---|---:|---|
| Durable JSON metadata | Primary + 1 `.lkg` | The previous valid generation is replaced on the next write. |
| Thread-pointer ledger | 64 KiB | Compacts to the newest valid record per session; a malformed tail is ignored. |
| Last-failure reports | Current + 1 previous | Repeated same-signature failures increment the current report; a changed signature rotates current to previous. |
| Database migration backup | 1 | `<db>.pre-crsqlite-w1.bak` is created once and only with sufficient headroom. |
| Automation ingress events | 7 days / 2,000 rows per project | Age-pruned at write time and by the doctor; the newest 2,000 non-`dispatched` rows per project are kept regardless of age (dispatched rows are age-pruned only). Raw webhook payloads are no longer persisted. |
| Review artifacts | 30 days | `review_run_artifacts` older than the cutoff are deleted (re-derivable from a fresh review). |
| PR snapshots | 60 days | `pull_request_snapshots` not updated within the window are deleted (re-fetchable from GitHub). |
| Storage-doctor journal | 30 runs | `storage-doctor-journal.json` keeps the newest 30 `MaintenanceRunReport`s; older runs drop off on the next append. |
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
- cr-sqlite compaction (`compactCrsqlTombstones`) is only safe with **zero sync
  peers**. Leave `hasSyncPeers` conservative — the default assumes peers, and a
  paired project's sync-bookkeeping row stays "waiting to compact" rather than
  offering an action that would be peer-blocked.
- The DB retention numbers live once in `state/dbMaintenanceApi.ts`. The ingress
  writer, the kvDb hooks, and the storage ledger all import them; never re-hard-code
  a cutoff in one enforcement site.
- `dbstat` is a compile-time-optional virtual table. The breakdown scan and the
  vacuum path degrade gracefully when the SQLite build lacks it — do not assume
  it is present.
