# Storage and recovery

How DAEX keeps project data safe on disk, recovers when it cannot open it,
bounds its own footprint, and reports failures. An open project database checks
its file's device and inode before each SQLite operation: if `.ade/ade.db`
disappears or is replaced, database work pauses with `db_path_changed` and the
connection never adopts the replacement. The CLI is `daex` (`ade` still works);
folders and env vars keep their `ade` names (`.ade/`, `~/.ade`, `ADE_HOME`).

## Source file map

Database and files:

- `apps/desktop/src/main/services/state/kvDb.ts` — opens the project DB (WAL,
  `synchronous = NORMAL`), runs `recoverInterruptedTableRebuilds` before
  `migrate()`, `classifySqliteOpenError`, the migration backup,
  `rebuildTableInTransaction`, and the `maintenance` handle.
- `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` — the
  `DbMaintenanceApi` interface, every retention bound (one source), and
  `pruneRowsInBatches`.
- `apps/desktop/src/main/services/state/durableFile.ts` — atomic writes, one
  `.lkg` backup, validated recovery reads.
- `apps/desktop/src/main/services/chat/threadPointerLedger.ts`,
  `providerResumeClassifier.ts`, `agentChatService.ts` — chat continuity.

Recovery:

- `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` —
  brain-independent diagnosis and ordered repair; `restartBrain()`.
- `apps/desktop/src/main/services/runtime/lastFailureStore.ts` — typed failure
  reports and crash-loop backoff (per socket).
- `apps/desktop/src/main/services/runtime/openProjectDataWatch.ts`,
  `projectDataTrash.ts`, `recycleBinRecord.ts` — missing or replaced data,
  restore from Trash or Recycle Bin.
- `apps/desktop/src/main/services/startupRecovery/` — the "DAEX could not
  start" window, Go back, database copies.
- `apps/desktop/src/main/services/ipc/knownProjectRoots.ts` — which roots a
  renderer may name on recovery channels.
- `apps/desktop/src/shared/types/recovery.ts` — `AdeRecoveryErrorCode`,
  `REPAIR_STEPS`, `RECOVERY_COPY`, `stateForCode`.
- `apps/desktop/src/shared/codedError.ts`, `apps/ade-cli/src/jsonrpc.ts` — codes
  across IPC and RPC wrappers; which faults may be worded.
- UI: `renderer/components/app/ProjectRecoveryScreen.tsx`,
  `ProjectTransitionErrorAlert.tsx`, `BrainDownNotice.tsx`, `restartAde.ts`,
  `ResetAdeDialog.tsx`, `errorSurfaceKit.tsx`;
  `renderer/components/chat/ChatContinuityRecoveryCard.tsx`;
  `renderer/browserMockRecovery.ts` (`?adeRecovery=<state>` previews).
- Hard reset: `apps/ade-cli/src/services/reset/machineResetInventory.ts`,
  `machineReset.ts`; `apps/desktop/src/main/services/runtime/machineResetLauncher.ts`.

Brain resilience (`apps/ade-cli/src/services/runtime/`):

- `brainLoopWatchdog.ts`, `brainLoopWatchdogWorker.ts` — event-loop watchdog
  and memory sampler.
- `brainStallProfiler.ts`, `brainFreshnessMonitor.ts`,
  `runtimeBuildIdentity.ts`, `brainMemoryRestart.ts`, `startupTeardown.ts`,
  `failureLogDeduper.ts`, `runtimeLogMaintenance.ts`, `brainLogger.ts`.
- `syncFsCallTracker.ts`, `apps/ade-cli/src/services/projects/projectRootAccessMonitor.ts`,
  `projectOpenStrikes.ts`, `apps/desktop/src/main/services/state/unansweringRoots.ts`
  — folders that stall.
- `apps/desktop/src/main/services/runtime/liveTurnProjects.ts` — work in flight
  across a stop.

Storage (`apps/desktop/src/main/services/storage/`):

- `diskPressure.ts`, `volume.ts` — pressure monitor and volume reads.
- `storageErrnoClassifier.ts`, `cloudPlaceholder.ts` — "this computer cannot
  read its own bytes".
- `storageInsightsService.ts` — snapshots, cleanup plans, the storage doctor.
- `storageLedger.ts`, `storageDbBreakdown.ts`, `storageMaintenanceJournal.ts`.
- `laneLifecycleScan.ts`, `laneBuildOutput.ts`, `laneSizes.ts`, `diskUsage.ts`.
- `historyCompression.ts`, `legacyChatTranscripts.ts`, `deletedLaneChats.ts`,
  `providerHistory.ts`.
- `apps/desktop/src/main/services/lanes/laneService.ts` — Archive & Reclaim.
- UI: `renderer/components/settings/health/` (`HealthSpace.tsx`,
  `HealthService.tsx`, `HealthCleanups.tsx`), `settings/storage/`
  (`StorageCleanupDialog.tsx`, `storageView.ts`),
  `app/StoragePressureIndicator.tsx`, `settings/RecentlyDeletedSection.tsx`.
- `apps/desktop/src/shared/types/storage.ts` — storage contracts.

Diagnostics:

- `apps/ade-cli/src/services/diagnostics/diagnosticReport.ts` (pure builder and
  `redactDiagnosticText`), `diagnosticSources.ts`
  (`collectMachineDiagnosticSources`), `storageEnvironmentProbe.ts`,
  `autoDiagnosticsSender.ts` (brain).
- `apps/desktop/src/main/services/diagnostics/diagnosticReportService.ts`,
  `autoDiagnosticsStore.ts` (consent and budgets ledger),
  `autoDiagnosticsSend.ts` (the one policy), `autoDiagnosticsService.ts`.
- `apps/desktop/src/shared/diagnosticsUpload.ts` (the one upload client),
  `publicIssueLink.ts`, `types/diagnostics.ts`.
- UI: `ReportIssueButton.tsx`, `ReportIssueDialog.tsx`, `reportDraft.ts`,
  `ReportIssueFooter.tsx`, `settings/DiagnosticsSharingSection.tsx`,
  `toast/useAutoDiagnosticsToast.ts`; web `webclient/adapter/diagnostics.ts`.
- CLI: `apps/ade-cli/src/commands/doctor.ts`, `reportIssue.ts`, `triage*.ts`;
  playbook `docs/triage/PLAYBOOK.md`.

## Gotchas

- **Storage is per machine.** Settings › Storage acts on the Settings page's
  machine (`useSettingsMachineScope().pin`); start and status of a cleanup go to
  the same machine.
- The interrupted-rebuild recovery **must run before `migrate()`**.
- Excluded (non-CRR) tables get no index rewrite; their rebuild plan must keep
  every unique and secondary index.
- Change `PRAGMA foreign_keys` outside a transaction.
- **A rename failure is not always retryable.** Only `EXDEV`, `EPERM`, `EACCES`,
  `EBUSY` fall back to a copy in `writeFileAtomic`; `ENOSPC` and `EIO` stay
  failures.
- **New DAEX error codes are lowercase snake_case.** `isErrnoLikeCode` tells
  them from platform codes by shape; the RPC boundary redacts platform-shaped
  ones.
- **`storage_read_failed` stays ahead of the integrity bucket** in
  `classifySqliteOpenError`, or an unreadable file is offered a destructive
  repair.
- **Give `classifyStorageFault` a path**; never copy its errno list.
- **An auto-diagnostics trigger must sit upstream of what it reports.**
- launchd holds its log files open: copytruncate, never rename.
- A worktree's nested `.ade` counts only in the worktree category.
- Before appending to history with a `.gz` present, reinflate it atomically.
- `compactCrsqlTombstones` is safe only with **zero sync peers**.
- Retention numbers live once in `dbMaintenanceApi.ts`; new prunes use
  `pruneRowsInBatches` (the driver is synchronous).
- Not every append-only table is prunable (see the exemptions below).
- A new doctor step needs a `STORAGE_LEDGER` entry and a `LEDGER_LABELS` entry
  (`storageView.ts`).
- `dbstat` is optional; breakdown and vacuum work without it.

## Missing or replaced project data

`openProjectDataWatch.ts` checks each open project's `ade.db` every 5 s; only
ENOENT/ENOTDIR counts as missing. A missing or swapped file shows the recovery
screen (`data_missing`, `data_replaced`); a missing project folder gets its own
words and no restore. Repair refuses missing data (an open would create an
empty database).

- **Restore from Trash** (`findTrashedProjectData`): matches the DB's device and
  inode, else its `projects` row; on Windows reads Recycle Bin `$I…` records. It
  merges into any `.ade` that came back (originals win; newer files kept as
  `<name>.created-while-missing`), database last. Nothing is deleted.
- **Start fresh** / **Use this copy** leaves an empty `.ade`; the old data stays.
- A moved database's native close is deferred so no checkpoint writes into the
  moved file.

## Behavior

### Restart-safe database rebuilds

`rebuildTableInTransaction` does create-staging, copy, count check, drop, rename
and indexes in one `BEGIN IMMEDIATE`; any error rolls back. At open,
`recoverInterruptedTableRebuilds` classifies older staging leftovers: empty
staging → drop; a safe partial copy → drop; original missing → rename staging;
anything else → keep both and report `migration_unknown_state`. The migration
backup is written once, only with headroom.

### Durable metadata and chat continuity

`writeJsonWithPrevious` keeps the current valid file as `<file>.lkg` and writes
via temp + rename; `readJsonWithRecovery` validates and falls back to the
`.lkg`. `writeFileAtomic` never unlinks the target first; a caller's `mode`
goes on the temp file.

A chat's thread identity comes from version-2 metadata
(`.ade/cache/chat-sessions/<id>.json`), the `thread-pointers.jsonl` ledger, then
`resume_command` and the transcript tail. A failed resume never starts fresh:
the pointer is kept, `continuityRecovery.state: "required"`, and a
`continuity_recovery` notice appears.

When the provider says the thread is gone (`thread_missing`), DAEX recovers by
itself at most once per chat in 10 minutes (`recover_from_history`: a new thread
gets the conversation with tool steps condensed, `continuityConversation.ts`).
Otherwise the chat offers `retry_original`, `recover_from_history` or
`start_new_chat`. Other reasons wait for the user.

### Work in flight across a brain stop

A brain told to stop records what was working (`recordPlannedBrainStop`,
synchronously first in `finish({ requested: true })` because the service
manager may kill it 1.5 s after SIGTERM): per project
`.ade/cache/reopen-cli-after-restart.<pid>.json` (open agent CLIs and chats
mid-turn), and `runtime/live-turns/<endpoint>.<pid>.stopped.json` (≤50
projects). The next brain takes each record once by rename (ignored after 6 h,
`RESTART_RESUME_MAX_AGE_MS`), reopens CLIs and continues chats by id
(`continueChatsAfterPlannedStop`), skipping chats closed on purpose or touched by
the user since.

The stop's reason, written first as `runtime/live-turns/stop-intent.<endpoint>.json`
(`noteBrainStopIntent`), decides what is kept:

| Stop | Intent | Kept |
| --- | --- | --- |
| Restart, repair, memory restart, logout, reboot | none | Chats and CLIs continue |
| Desktop update, `daex brain update` | `accepted_update` | Kept; the continue cap restarts |
| "Stop and quit DAEX", `daex brain stop`, `daex runtime stop` | `stop_for_good` | No chat continues; CLIs reopen at their prompt |
| Idle exit, socket lost, failed start | none, not requested | Nothing |
| Crash or kill | — | The crash path (the live record stays) |

No prompt or transcript text is stored. A Devin CLI never reopens (no resume
id).

### What a DAEX Cloud computer keeps off the computer

Small marks of what the account server already has (all atomic, mode 0600; a
missing file means start over, safely):
`<project>/.ade/cloud/saved-chats.json`, `<ade home>/cloud/rest-save.json`,
`<ade home>/cloud/chat-messages.json` (queue journal),
`<ade home>/cloud/git-identity.json`, `<ade home>/account-lanes.json`. See
[remote runtime › On a DAEX Cloud computer](../remote-runtime/README.md#on-a-daex-cloud-computer).

### Typed project-open recovery

Failures use `AdeRecoveryErrorCode`, not string matching. The brain records a
report in `lastFailureStore`; the local pool throws a coded refusal instead of
starting a second brain on the primary socket; `ProjectRecoveryScreen` asks for
a fresh diagnosis and streams repair steps (`IPC.recoveryRepairStep`,
`REPAIR_STEPS`).

- **A code survives every wrapper**: `codedError` → `jsonrpc.ts` re-encodes
  `code: message` and `error.data.code` → the RPC client prefix → Electron IPC
  (`surfaceCodedError`). `stripElectronErrorWrapper` must name every prefix.
- **Platform faults are not worded**: a `syscall`/errno, an errno-like code, an
  unnamed errno or a `TypeError`-class fault goes on the wire as `Internal error
  in <method> (ref <id>)` and in full to the brain's stderr (`onInternalError`).
- **Retries**: `isLocalRuntimeConnectionDropped` retries only when the socket
  went away (`ECONNRESET`, `ECONNABORTED`, `EPIPE`, `ENOTCONN`), never when the
  daemon answered.
- **Unreadable storage is not a damaged database.** A project or `~/.ade` in a
  cloud-synced folder whose files were evicted fails with an unnamed errno (macOS
  `EDEADLK`). `createAdeRuntime` runs `detectCloudPlaceholderFile` first;
  `classifySqliteOpenError` buckets `EDEADLK`, `EIO`, `ENXIO`, `ENODEV`,
  `ESTALE`, `EHOSTDOWN`, `EREMOTEIO` and unnamed errnos as `storage_read_failed`
  (with a path). Both launch agents set `MaterializeDatalessFiles=true`.
- **No-repair diagnoses**: `storage_unreadable`, `drive_unreadable` (SQLite disk
  I/O error), `project_busy` (`db_busy` after three opens a second apart),
  `brain_starting` (re-diagnosed every 2 s).

`recovery.diagnose` / `recovery.repair` accept only a known root. Repair stops
at the first unsafe step: free space, exclusive ownership, `quick_check`, an
open that resolves staging, service restart, endpoint and project checks, chat
counts.

### The recovery screen and the brain-down notice

Two surfaces speak for "the background service is down", never both.

- **The recovery screen** (`ProjectRecoveryScreen.tsx`): cause from
  `RECOVERY_COPY`, then one ladder: the state's own fix (**Fix it**, **Open
  System Settings**, **Try again**, or "Waiting for DAEX…") → **Restart DAEX**
  → **Reset DAEX…** → **Report this error to DAEX…**. The filled button moves
  down the ladder after failures (a `localStorage` stamp). Raw text stays in the
  details fold.
- **The brain-down notice** (`BrainDownNotice.tsx`): "Finishing the update"
  while an update owns the service, else an error banner with Fix it
  (`restartBrain()`) → Restart → Reset. With "Allow in the Background" off it
  offers Open System Settings.
- `ProjectTransitionErrorAlert` stands down for both; the notice stands down
  while the recovery screen or the app-fallback brain shows.

### "DAEX could not start" after an update

A small window offers Try again, Go back to the previous version (reinstall and
restore this computer's databases from their pre-update copies, all or
nothing), Open logs folder and Copy details. Details:
[beta track › startup recovery](../../plans/beta-track.md#startup-recovery).

### Login Items ("Allow in the Background")

macOS keeps the launch agent loaded but never starts it while this switch is off;
no repair changes that. `readLaunchdBackgroundItemStatus` reads it
(`SMAppService.statusForLegacyURL` via `osascript`); `isBackgroundItemBlocked`
(`shared/types/core.ts`) is the one predicate. The screen offers Open System
Settings and reopens once the switch is on.

### Hard reset (`daex reset --all`)

Removes everything DAEX put on this computer. `machineResetInventory.ts` builds
the plan; `machineReset.ts` runs exactly that list. Lane work is rescued first
(`commit` or `move`, else parked under `~/ADE Rescued Lanes`). A project's own
files are never removed (only its `.ade/`, DAEX lane worktrees and branches, the
exclude line). `assertRemovable` is the last check. `ResetAdeDialog` requires
typing `RESET`; `--dry-run` prints the plan.

### Brain resilience: watchdog, freshness, memory, and recovery notice

**Event-loop watchdog** (`brainLoopWatchdog.ts`, a worker thread with 1 s
heartbeats naming the running command):

- A stall past `ADE_LOOP_WATCHDOG_MS` (30 s) that is not a sleep writes
  `event-loop-wedge.json`, asks for a Node report and `SIGKILL`s the brain.
- **Only the brain's own freeze is killed.** `brainLoopFreezeCause` reads page
  faults, CPU and any open sync file call: for `memory` or `drive` it waits up to
  5 minutes (`BRAIN_LOOP_MACHINE_WAIT_CEILING_MS`), refreshing the heartbeat so
  the outside watchdog does not kill it.
- On macOS a 2 s `/usr/bin/sample` names the blocking call.
- Recovered delays log `brain.suspend_gap` (a sleep) or
  `brain.event_loop_near_miss` (with the blocked file call); a near miss starts a
  one-minute CPU profile (`brainStallProfiler.ts`).
- Next boot promotes the evidence to `last-wedge.json` and friends, logs
  `brain.recovered_from_wedge`; `runtimeInfo.lastWedge` feeds the desktop notice
  and `daex doctor`.
- `ADE_DISABLE_LOOP_WATCHDOG=1` disables it.

#### A project whose folder is too slow to open

Opens report their step to the watchdog (`openingProjects` in the breadcrumb).
After a kill the next start strikes those projects
(`$ADE_HOME/runtime/project-open-strikes.json`); a struck project opens alone.
Two strikes in 15 minutes refuse it with `project_folder_too_slow` (15 minutes,
doubling to 24 h), and folder readers skip it. A successful open,
`daex projects retry <id|path>` or the banner's Try again resets it.

#### A folder waiting on a permission prompt

macOS gates external drives and Desktop/Documents/Downloads per program; a hung
network drive behaves the same.

- `syncFsCallTracker.ts` wraps path-taking sync `fs` calls so the worker knows
  the stuck call (`brain.sync_fs_call_blocked` after 5 s).
- `projectRootAccessMonitor.ts` lists one folder per such drive every 5 s
  asynchronously; over 3 s marks the drive's folders (and the drive, unless it
  holds home or `ADE_HOME`) as not answering (`unansweringRoots.ts`). Sync calls
  under a marked folder then fail fast with `storage_read_failed`.
- After a wedge in such a call, the next brain marks the whole drive first.
- Connected devices are told (`hostHealth.storageWait`; see
  [remote runtime](../remote-runtime/README.md#which-part-failed-the-connection-doctor)).

**Freshness** (`brainFreshnessMonitor.ts`): every 5 minutes, a changed
entrypoint hash triggers an idle-bounded brain-update restart
(`ADE_DISABLE_BRAIN_FRESHNESS=1` disables it).

#### The planned memory restart

`brainMemoryRestart.ts`: after 3 samples over 1.5 GiB RSS
(`DEFAULT_BRAIN_RSS_RESTART_BYTES`), the brain restarts through the service
manager only while nothing runs (checked every 30 s for up to 30 minutes).
`ADE_BRAIN_RSS_RESTART_BYTES` overrides (`off` disables; floor 256 MB).

#### Unwinding a runtime that never finished starting

`startupTeardown.ts` is a LIFO stack: each acquisition in `createAdeRuntime`
registers its release; a failure drains it in reverse (a throwing release logs
`runtime.teardown_step_failed` and does not stop the drain). `runtime.dispose` is
the same drain.

### Disk pressure and enforcement

The monitor uses the most constrained volume among DAEX's roots; severity rises
at once and falls after two lower samples; total measurement failure fails open.

| State | Free space | Effect |
|---|---|---|
| `normal` | >12 GiB and >5% | everything allowed |
| `warning` | ≤12 GiB or ≤5% | indicator only |
| `critical` | ≤4 GiB or ≤2% | compression and high-write jobs stop |
| `exhausted` | ≤1 GiB | new chat turns and CLI launches refused with `disk_full` |

Rising pressure kills no session; gates apply at the next start
(`canPerform("chat_turn" | "cli_launch" | "compression")`, copy in
`DISK_PRESSURE_REFUSAL_MESSAGES`).

### Developer tools outside the project

Disk space › **Outside this project** (`OutsideProjectStorage.tsx`): Xcode build
data, simulators and runtimes, Android emulators on the page's machine. Lists
are read on open; sizes only on **Measure sizes**. Deletes are the person's,
confirmed; the brain refuses an unconfirmed or agent-requested one.

### Storage categories and cleanup safety

| Category | Default safety |
|---|---|
| Chats and history | `compressible` |
| Lanes and worktrees | active `protected`; archived via Archive & Reclaim; orphans `review_first` |
| Build and release | `review_first` |
| Caches | `safe_to_remove` (chat session records `protected`) |
| Proof and attachments | `review_first` |
| Recovery backups | `review_first` (or `safe_to_remove` when old and unrelated to a fresh failure) |
| Database | `protected` |

Cleanup is preview-confirmed and re-checks path, inode, size, ownership, age and
safety before deleting; links are never followed. Node compile caches prune
themselves outside the ledger.

### Lane lifecycle rules

Project → Disk space → Rules (`laneCleanup` in `local.yaml`,
`resolveLaneCleanupPolicy` in `shared/laneCleanup.ts`, all in days):
`archiveIdleAfterDays` (off by default), `freeUpSpaceAfterDays` (14) with
`freeUpSpaceMode` (Ask me / Automatically), `deleteArchivedAfterDays` (off;
remote branches never deleted), `cleanBuildOutputAfterDays` (7).
`coerceLaneCleanupConfig` maps old hour keys.

The daemon scans about hourly while a rule needs it (`laneCleanupChecksOn`). It
archives only a clean, finished, idle managed worktree lane with nothing running
(`getAutoArchiveFacts`: nothing unpushed, and merged per PR record or an
ancestor of its base with its own commits). Delete and free-up get the same
checks; an open PR keeps a lane; the primary lane is never touched. Each lane's
last result shows as "Last run".

### Archive & Reclaim removal

Lane folders compare with `shared/sameFolder`. On Windows DAEX never runs `git
worktree remove`: it renames the folder to a `.ade-deleting-` name (only possible
once nothing holds a file; 20 s of retries), prunes the worktree and deletes in
the background. A folder still held is `kept` and finished by the storage doctor
(every 10 minutes, 12 tries).

### Build output in idle lanes

A storage-doctor step (`fs.lane_build_output`, `laneBuildOutput.ts`): 10 minutes
after start, then daily (≥20 h apart). It removes `BUILD_OUTPUT_FOLDER_RULES`
folders (`node_modules`, `dist`, `build`, `.next`, `.turbo`, `DerivedData`,
`target` with `Cargo.toml`/`pom.xml`, `CACHEDIR.TAG` folders, …; ≤4 deep, never
under `.git` or `.ade`) from managed worktree lanes idle for the window, only
when nothing runs in them (no chat, terminal, lease or process cwd), git ignores
and tracks nothing in them, they are real folders with the scanned inode and no
mount inside. Every check repeats right before removal. Results go to the
local-only `local_lane_build_output_cleanups`; the lane shows "Build output
removed 3d ago" (`LaneBuildOutputNotice.tsx`, read on the lane's machine).

### Chat transcripts: one copy

Each chat event is written once to `transcripts/chat/<id>.jsonl`. Older builds
also wrote `transcripts/<id>.chat.jsonl`; the synced session row still names
that path, so readers resolve through `resolveChatTranscriptReadPath`. The
doctor removes a legacy copy only when every line is proven in the dedicated
file and the copy is idle and unchanged.

### History compression

Inactive `.jsonl`/`.log` files older than 14 days (finished chats sooner), ≤256
MiB, up to 200 per doctor run (25 per button press), only when pressure allows.
gzip with a verified byte-identical round trip before the original is replaced;
an append reinflates first.

### Storage doctor maintenance sweep

`storageInsightsService` runs one single-flighted sweep (`post_boot` 10 minutes
after start, `daily`, `manual` via `storage.runMaintenanceNow` and "Clean up
safely"); each step is isolated:

1. lane lifecycle scan;
2. legacy transcript duplicates;
3. history compression;
4. build output in idle lanes;
5. filesystem review candidates (recorded, not deleted);
6. kvDb hooks (prune ingress events, PR snapshots, event logs; compact CRR
   bookkeeping; vacuum a fragmented freelist);
7. search index compaction.

Runs go to the journal and `storage.maintenance_completed`. Settings also shows
provider history on this machine (DAEX deletes only its own copies of chats from
deleted lanes), a reminder at 25 chats / 100 MB from deleted lanes, and
**Recently deleted** chats and lanes (`deleted_chats` rows,
`refs/ade/deleted-lanes/` for 30 days; reads every online copy of the project,
never waking a resting cloud computer). See
[Recently deleted chats](../chat/README.md#recently-deleted-chats).

### Storage ledger and policy

`STORAGE_LEDGER` declares every persistent table and folder's privacy class
(`user_data`, `derived`, `operational`) and bound (`write_time`, `doctor`,
`both`, `manual`). `LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS`
folder; a test fails CI for an unmapped one.

### Database maintenance hooks

`kvDb.ts` attaches `maintenance` (`DbMaintenanceApi`); each hook checks its table
exists and logs `db.maintenance_failed` on error:

- `pruneIngressEvents` — `automation_ingress_events`, 7 days / 2,000 per project.
- `prunePrSnapshots` — `pull_request_snapshots` older than 60 days.
- `pruneEventLogs` — 30 days on the retained event logs.
- `compactCrsqlTombstones` — only with zero sync peers (`has_peers` otherwise).
- `vacuumIfFragmented` — one full `VACUUM` (turns on incremental auto-vacuum),
  then bounded incremental chunks, then `wal_checkpoint(TRUNCATE)`.

#### Why `ai_usage_log` is not local-only

It backs the account-wide daily AI budget (`ai.budgets.<feature>.dailyLimit`) and
lifetime totals, so it stays a CRR with no retention. Replacing it needs a
`(day, feature, site)` aggregate over two releases. Phones never receive it.

#### Paced deletes

`pruneRowsInBatches`: 2,000 rows per batch, `setImmediate` between batches, at
most 200 batches. Prunes compare text timestamps with `like '____-__-__%' and
column < ?`, so digit epochs and `''` defaults are not "born expired".

#### Event-log retention, and the tables deliberately exempt

`RETAINED_EVENT_LOG_TABLES`: `linear_sync_events`, `linear_workflow_run_events`,
`worker_agent_cost_events` (on `created_at`, **not** the backdatable
`occurred_at`), `pack_events`. Exempt: `linear_ingress_events` and
`cursor_cloud_ingress_events` (webhook replay guards), `cto_session_logs`
(dormant CRR), `worker_agent_runs` (live references).

### Maintenance journal, diagnostics, and runtime health

Each run appends a `MaintenanceRunReport` to
`.ade/cache/storage-doctor-journal.json` (last 30, atomic). The Space page's
`extras` adds the DB breakdown (from `dbstat`), recent runs, policy chips and
**slow responses (24 h)** from `LocalRuntimeConnectionPool.getRuntimeHealth()`.

### Backup and retention bounds

| State | Bound |
|---|---|
| Durable JSON | primary + one `.lkg` |
| Thread-pointer ledger | 64 KiB, newest per session |
| Last-failure reports | current + previous |
| Migration backup | one, with headroom |
| Update copies | one per database (`<db>.pre-<to>-from-<from>.bak`), removed 24 h after a clean open of the new version; Go back's set-aside copies after 7 days |
| Automation ingress events | 7 days / 2,000 per project |
| PR snapshots | 60 days |
| AI usage log | none |
| Retained event logs | 30 days |
| Storage-doctor journal | 30 runs |
| launchd logs | 10 MiB, 1 MiB `.1` tail, copytruncate |
| Desktop JSONL logs | 10 MiB × 2 |
| Compressed history read | 256 MiB decompressed |

### Diagnostic reports (the report dialog)

Every error surface has **Report this error to DAEX…**
(`ReportIssueButton.tsx`). A press opens `ReportIssueDialog.tsx` and sends
nothing; it shows the exact redacted report and an optional note. Two steps
(`reportDraft.ts`):

1. `diagnostics.prepareReport` → main builds and redacts, uploads nothing,
   returns text and a one-use id (≤4 kept, 10 minutes each).
2. `diagnostics.sendReport(id, { userMessage })` uploads that exact text and
   spends the manual budget only then; an expired id rebuilds.

After a send: a reference with copy, and an optional public GitHub issue holding
only the reference, version, channel and OS family (`shared/publicIssueLink.ts`).
The report describes this computer, so no call takes a pin.

- **Settings** (`general.diagnostics-sharing`, **Send a report to DAEX**) runs
  the same steps with its own budget (`MAX_MANUAL_DIAGNOSTICS_PER_WINDOW`, 5 per
  24 h); a click is allowed even with `DO_NOT_TRACK=1`.
- **Contents**: app, OS and hardware facts, machine health, the surface and
  code, runtime status, last failures and wedge, the recovery diagnosis, disk,
  the service definition, the storage environment
  (`storageEnvironmentProbe.ts`: location class and dataless-file counts, never
  a path), and bounded log tails (service streams, `desktop-main.jsonl`,
  `brain.jsonl`, the most recent project's logs). Total ≤512 KB.
- **Redaction** (`redactDiagnosticText`, run last over the whole document,
  idempotent): project roots, home in every spelling, user paths, account name,
  emails, credentials, URL userinfo, non-loopback IPs, hostnames, `*.ts.net` and
  `*.local`. Env vars, credential stores, `~/.ade/secrets/*` and PINs are never
  collected.
- **Private upload**: `POST /diagnostics/upload` on the account directory
  (`apps/account-directory/src/diagnostics.ts`), one client
  (`diagnosticsUpload.ts`) returning a closed failure set. The desktop uploads
  from main, anonymously; `daex report-issue --send` sends a Clerk token when
  signed in, needs no brain and saves a copy under
  `~/.ade/diagnostic-reports/` first. Five uploads per identity per UTC day.
- **Web client**: a smaller report as Sentry User Feedback; **Copy report** when
  Sentry is off.

#### Auto-send

Classified failures send the same report by themselves (`auto: true` plus the
failure code):

| Trigger | Where | `failureCode` |
| --- | --- | --- |
| Terminal recovery diagnosis | `projectRecoveryService.ts` (`onTerminalDiagnosis`) | the `AdeRecoveryErrorCode` |
| Renderer or page crash | `RendererErrorBoundary.tsx`, `PageErrorBoundary.tsx` | `renderer_crash`, `page_crash` |
| Post-update transaction failed | `main.ts` | `update_<step>` |
| App-fallback brain started | `main.ts` | `app_fallback_<reason>` |
| Pairing auto-recovery gave up | `machinePairingAutoRecovery.ts` (`onGaveUp`) | the refusal code |
| Account publisher failing > 5 min | `accountMachinePublisherService.ts` | the health state |
| Sync host refused by unreadable storage (3 in a row) | `syncHostStartupLoop.ts` (`onSustainedStorageFault`) | `storage_read_failed` |

- **Budgets**: one per code and three in total per 24 h per install, in one
  ledger (`~/.ade/secrets/diagnostics-autosend.json`) shared by desktop and
  brain; reserved before the request; an unreadable ledger fails closed.
- **Failure is silence** (logged locally only).
- **Toast**: "A diagnostic report was sent to DAEX" with **View**. Sends stay
  pending until a renderer acknowledges the toast (`IPC.diagnosticsFlushAutoSent`,
  `IPC.diagnosticsAckAutoSent`).
- Opt-out: `DO_NOT_TRACK=1` (or an old persisted off); no Settings switch.

### Handing the repair to an agent (`daex triage`)

`daex triage [--provider <name>] [--agent]` runs the doctor checks and the
redacted collection, writes `context.md` and `PLAYBOOK.md`
([docs/triage/PLAYBOOK.md](../../triage/PLAYBOOK.md), fetched from `main` with
the local copy as fallback) into a fresh temp folder, and launches the first
DAEX-pinned agent on disk (`claude`, `codex`, `cursor-agent`, `opencode`,
`droid`, `muse`; never a PATH CLI, never a download). Every collector may fail
into a section; the whole document is redacted; with no agent the files are the
deliverable (exit 0). CLI only: the other clients need the brain it repairs.
