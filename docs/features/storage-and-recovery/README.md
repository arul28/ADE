# Storage and recovery

An open project database checks its file's device and inode before each SQLite
operation. If `.ade/ade.db` disappears or is replaced, ADE pauses database
work with `db_path_changed`. Put the original `.ade` folder back to resume.
The open connection never adopts a replacement database. Desktop and headless
runtimes share this guard, sync and database maintenance included.

The desktop also checks each open project's `ade.db` every 5 seconds
(`services/runtime/openProjectDataWatch.ts`):

- Only "not found" (ENOENT, or ENOTDIR when a parent became a file) counts as
  missing. Other errors (a slow volume) skip the tick.
- A missing or swapped file shows the project recovery screen
  (`data_missing` or `data_replaced` in `shared/types/recovery.ts`), not
  failing panels. A failed reopen at launch shows it too. A window asks
  `recovery.projectDataStatus` on load and on each project change.
- A project folder that is itself gone (an unplugged drive) gets its own
  words and no Restore or Start fresh, since either would recreate the folder.
- The screen shows at most two buttons; Restart, Reset and Report are hidden.
  Repair refuses missing data, because an open would create an empty database.

The actions:

- **Restore from Trash** shows when `findTrashedProjectData`
  (`services/runtime/projectDataTrash.ts`) finds the project's `.ade` in the
  Trash. It matches the database's device and inode from the project-data
  identity file, else the database's `projects` row.
  - macOS hides the Trash listing without Full Disk Access, so it tries
    Finder's names (`.ade`, `.ade 2`, …). On Windows it reads the drive's
    Recycle Bin `$I…` records (`recycleBinRecord.ts`) and removes the record
    on restore.
  - It merges into any `.ade` that came back meanwhile: the original wins and
    the newer file stays as `<name>.created-while-missing`. The database goes
    back last, after its write-ahead log; a copy from another volume lands
    under a temporary name first. Nothing is deleted.
  - Then the window closes the project and the service drops it, so the reopen
    uses fresh handles. A failed restore keeps the project's record, so the
    next open still refuses to create empty data.
- The screen keeps checking, so a folder put back by hand reopens the project.
- **Start fresh** (or **Use this copy** for a swapped database) closes the
  project, has the service drop it and its cached record, forgets the database
  identity, leaves an empty `.ade` and reopens. The old data stays where it is.

A disposed, moved database defers its native close and extension
finalization, so no checkpoint writes the WAL into the moved file. The handles
stay until the original returns and another open reaps them, or the process
exits. Normal disposal releases them at once, on Windows too.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/state/kvDb.ts` | Opens the project database (enabling `journal_mode = WAL` + `synchronous = NORMAL` at open), runs the interrupted-rebuild recovery pass, classifies database-open errors (`classifySqliteOpenError(error, { path })`, whose `storage_read_failed` bucket is checked *before* the integrity bucket so an unreadable file is never reported as a corrupt one; the errno rules live in `storage/storageErrnoClassifier.ts`, and the `path` argument is required rather than optional because a SQLite error rarely carries one and the classifier will not call a bare errno a storage fault without it), creates the headroom-gated migration backup, and exports `rebuildTableInTransaction` / `recoverInterruptedTableRebuilds`. Attaches the optional `maintenance` (`DbMaintenanceApi`) handle — the prune / compact / vacuum hooks the storage doctor invokes. The machine-local `local_lane_storage_state` and `local_storage_lifecycle_runs` tables retain reclaim retry/estimate and scan timing state; both are excluded from CRR sync because paths and cleanup results belong only to this checkout. |
| `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` | The `DbMaintenanceApi` interface consumed by the storage doctor, plus the single source of truth for the DB retention/count bounds (`INGRESS_EVENT_RETENTION_MS` = 7 days, `INGRESS_EVENT_MAX_ROWS_PER_PROJECT` = 2,000, `PR_SNAPSHOT_RETENTION_DAYS` = 60, `EVENT_LOG_RETENTION_DAYS` = 30) imported by the ingress writer, the kvDb hooks, and the storage ledger so the policy can never drift across enforcement sites. Also exports `pruneRowsInBatches` — the paced `delete … where rowid in (select rowid … limit N)` loop (`MAINTENANCE_DELETE_BATCH_ROWS` = 2,000, `MAINTENANCE_DELETE_MAX_BATCHES` = 200) that every new prune uses. |
| `apps/desktop/src/main/services/state/durableFile.ts` | Atomic temp-write-and-rename persistence, one-generation `.lkg` JSON backup, validation, and primary/previous recovery reads. `AtomicWriteOptions.mode` creates the temp file with the caller's permission bits so a secret is never briefly world-readable, and a rename refused with `EXDEV` / `EPERM` / `EACCES` / `EBUSY` falls back to a copy — a deliberately closed list that leaves `ENOSPC` and `EIO` terminal. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Persists chat metadata and transcripts, records provider-pointer transitions to the bounded thread-pointer ledger, reconciles missing pointers from ledger/resume command/transcript, gates new turns on disk pressure (`canPerform("chat_turn")`), and implements explicit `recoverContinuity` modes. |
| `apps/desktop/src/main/services/chat/threadPointerLedger.ts` | Standalone append-only continuity ledger (`thread-pointers.jsonl`): typed `ThreadPointerLedgerEntry` records, tolerant parse that drops only a torn tail line, newest-per-session read, and 64 KiB self-compaction (newest records first) via an atomic rewrite. |
| `apps/desktop/src/main/services/chat/providerResumeClassifier.ts` | Classifies a provider resume failure as missing thread, provider environment, transient transport, or unknown without treating every provider error as lost continuity. |
| `apps/desktop/src/main/services/startupRecovery/startupRecovery.ts` | The "ADE could not start" controller: which failure signals open the window (once per launch), the Go back flow (target check, download through the updater, restore in the install hook) and the Copy details text. Every step is a `startupRecovery.*` info line in `desktop-main.jsonl`; `startupRecovery.went_back` is a release-health event. |
| `apps/desktop/src/main/services/startupRecovery/goBackPlan.ts` | Pure: reads a copy's name (`pre-<to>-from-<from>`, `_2` for a repeat; `unknown` and `before-…` carry no version) and picks the version to go back to and one copy per database. |
| `apps/desktop/src/main/services/startupRecovery/databaseCopies.ts` | Lists this computer's databases and their copies, deletes a copy (checked against a fresh listing), and restores a plan by moving files only: the current database and its journal files go aside as a copy, then the copy takes its place. |
| `apps/desktop/src/main/services/startupRecovery/startupRecoveryWindow.ts`, `desktopStartupRecovery.ts`, `registerDatabaseCopiesIpc.ts`, `preload/startupRecoveryPreload.ts` | The window (a static page with its own sandboxed preload, so it opens when the app's renderer broke), the Electron wiring, and the Settings IPC (local only, no pin). |
| `apps/desktop/src/renderer/components/settings/DatabaseCopiesSection.tsx` | Settings › Advanced › Database copies: which database, from which version to which, when, size, Reveal and Delete (confirmed). Renders only for This computer. |
| `apps/desktop/src/main/services/runtime/lastFailureStore.ts` | Stores typed project/machine failures, keeps one previous report, counts repeated signatures, and computes crash-loop startup backoff. A brain failure records its `socketPath`, and the backoff counts only failures on the starting brain's own socket (a record without one is read as the primary socket's), so a desktop's isolated brain does not sleep for the service brain's crash loop. |
| `apps/ade-cli/src/services/runtime/failureLogDeduper.ts` | Emits the first repeated brain failure immediately and only periodic occurrence summaries afterward. `note(signature, message, meta)` and the `log` callback carry a `FailureLogMeta` bag alongside the human sentence, so the structured event and the stderr line a reader correlates share one cadence instead of drifting apart. |
| `apps/ade-cli/src/services/runtime/startupTeardown.ts` | `createTeardownStack()` — the LIFO release stack a half-built runtime unwinds. Each acquisition in `createAdeRuntime` registers its own release at the point it acquires, `drain()` pops in reverse order, and a release that throws is caught so it neither stops the drain nor replaces the original startup failure. `runtime.dispose` is the same `drain()`, so the failure and shutdown paths cannot drift apart. |
| `apps/ade-cli/src/services/runtime/brainMemoryRestart.ts` | `createBrainMemoryRestartGuard` — the planned restart of an idle brain that is holding too much resident memory. See [Brain resilience](#brain-resilience-watchdog-freshness-memory-and-recovery-notice). |
| `apps/ade-cli/src/services/runtime/runtimeLogMaintenance.ts` | Bounds launchd stdout/stderr with tail-copy plus in-place truncation. |
| `apps/ade-cli/src/services/runtime/syncFsCallTracker.ts`, `apps/ade-cli/src/services/projects/projectRootAccessMonitor.ts`, `apps/desktop/src/main/services/state/unansweringRoots.ts` | A folder waiting on a permission prompt or a hung drive: the tracker names the synchronous file call the main thread is stuck in (shared memory the watchdog worker reads) and fails calls under a folder that is not answering; the monitor finds such folders off the main thread, one probe per drive, and tells devices. See [A folder waiting on a permission prompt](#a-folder-waiting-on-a-permission-prompt). |
| `apps/ade-cli/src/services/runtime/brainLoopWatchdog.ts`, `brainLoopWatchdogWorker.ts` | Worker-thread **event-loop watchdog** for the machine brain (the worker's source and its stall evaluation live in `brainLoopWatchdogWorker.ts`). On macOS the worker also takes a 2 s native `sample` of a wedged brain before the kill (12 s cap), so the report names the blocking call. Heartbeats every second with the current command name plus event-loop, memory, and resource diagnostics; a recovered delay over 2 s logs a near-miss, or a suspend gap when the worker thread was paused too. A stall past `ADE_LOOP_WATCHDOG_MS` (30 s default) that is not a sleep/suspend writes an `event-loop-wedge.json` breadcrumb, requests a best-effort Node report, and `SIGKILL`s the brain, unless the machine caused it (memory pressure, a stuck drive), which it waits out up to 5 min (see [Brain resilience](#brain-resilience-watchdog-freshness-memory-and-recovery-notice)). On next boot it promotes the evidence to `last-wedge.json` / `last-wedge-report.json`, logs `brain.recovered_from_wedge`, and emits a deduped recovery event. Disable with `ADE_DISABLE_LOOP_WATCHDOG=1`. It is also the brain's memory sampler: `brain.memory_sample` every 5 min, `trackBrainMemoryPressure` to decide when RSS has stayed high long enough to act, and `resolveBrainRssRestartBytes` to read the `ADE_BRAIN_RSS_RESTART_BYTES` override. `classifyBrainLoopLag` separates a stall from a suspension, and `currentBrainLoopWatchdogCommand()` is the idleness signal the memory guard shares with it so a restart decision and a wedge breadcrumb can never disagree about what the brain was doing. |
| `apps/ade-cli/src/services/runtime/brainStallProfiler.ts` | After a freeze, a one-minute in-process CPU profile (`node:inspector`, at most once an hour) that names the code behind it: warn `brain.stall_profile`, and one Sentry warning issue per cause (`Brain froze in …`). |
| `apps/ade-cli/src/services/runtime/brainFreshnessMonitor.ts` | The running brain stats its own CLI entrypoint every 5 min (`ADE_BRAIN_FRESHNESS_INTERVAL_MS`), hashes only after the stat changes, and — when the on-disk hash no longer matches the baked runtime hash — waits for the brain to go idle (bounded) before triggering the brain-update service restart so an in-place upgrade takes effect without interrupting active work. Disable with `ADE_DISABLE_BRAIN_FRESHNESS=1`. |
| `apps/ade-cli/src/services/runtime/runtimeBuildIdentity.ts` | `computeRuntimeBuildHash` / `computeRuntimeBuildHashAsync` — the SHA-256 of the CLI entrypoint used as the brain build identity by the freshness monitor and the desktop compatibility handshake. |
| `apps/ade-cli/src/services/runtime/brainLogger.ts` | The machine-brain logger: reuses the desktop `createFileLogger` to write `~/.ade/runtime/brain.jsonl` (10 MiB `.1` rotation) and additionally mirrors timestamped `warn`/`error` lines to stderr so launchd captures them. |
| `apps/desktop/src/main/services/logging/machineLogger.ts` | The desktop main process's **machine-scoped** logger: same `createFileLogger` and rotation, writing `~/.ade/runtime/desktop-main.jsonl`. Opened in `main.ts`'s first executable statement, so the events that happen before (or without) a project — the launch marker, the `ade://` claim, the single-instance outcome, the CLI auto-install result — are durable rather than `console.log` into a stdout a Finder-launched app does not have. `logMachineEvent` writes the structured line and mirrors it to `console`; `flushMachineMainLog` drains it on the branch that quits immediately. See [logging.md](../../logging.md). |
| `apps/ade-cli/src/commands/doctor.ts` | `ade doctor [--online]` — connects to the brain over the local socket and prints one `ok`/`warn`/`fail` row per subsystem (App version, Brain, Wedge history, Sync port, Publish health, Relay, Account, Diagnostics sharing); exits non-zero on any `fail`. The **Diagnostics sharing** row reads the shared auto-send ledger through `readAutoDiagnosticsState` — never a second parser — and is always `ok`: consent is a preference, not a fault, so it reports `on · N of 3 automatic reports sent today` or `off · no automatic reports are sent` and never colours a healthy machine. `evaluateDoctorRows` is pure and dependency-injected — every row's inputs are read at the edge (`runDoctorCommand`) and handed in — so the verdict is testable without a machine and a second surface can reuse it. Today the CLI is its only caller: the desktop's **Connection doctor** card (`remoteTargets/ConnectionDoctorPanel.tsx` → `remoteRuntime.runDoctor`) is a different check about reaching a *remote* machine, not this one. |
| `apps/desktop/src/shared/adeRuntimeProtocol.ts` | Shared runtime-protocol contract: `RUNTIME_COMPAT_LEVEL` + `isRuntimeProtocolCompatible` (the integer compatibility-window check), and the tolerant parsers `parseRuntimePublishHealth` / `parseRuntimeLastWedge` that decode `runtimeInfo.publishHealth` and `runtimeInfo.lastWedge` for the connection pool, the doctor, and the desktop status surfaces. |
| `apps/desktop/src/main/services/runtime/projectDataTrash.ts` | Finds a project's `.ade` in the Trash (by the recorded database identity, else the database's own `projects` row; cached 5 s) and puts it back, whole or merged, database last. |
| `apps/desktop/src/main/services/runtime/recycleBinRecord.ts` | Reads a Windows Recycle Bin `$I…` record (versions 1 and 2) for the original path of the `$R…` item it describes. |
| `apps/desktop/src/main/services/runtime/openProjectDataWatch.ts` | Checks each open project's `ade.db` every 5 seconds and reports `missing` or `replaced` once per change, so the window shows the recovery screen. |
| `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` | Brain-independent diagnosis and ordered repair: space, ownership, database validation, migration recovery, service restart, endpoint/project verification, and chat reconciliation. On macOS it also reads the launch agent's Background Items verdict (`isBackgroundItemBlocked`, `shared/types/core.ts`) and reports `background_blocked` ahead of every repairable state when "Allow in the Background" is off; an installed brain that is not running with no crash on record is `brain_not_running`, not a crash loop. Also owns `restartBrain()` — the machine-scoped restart behind the Connections **Repair** button and the brain-down notice's **Fix it** — which shares one `restartServiceAndWait()` sequence (install → wait ≤90 s for the endpoint → `ping`) with `repair()`'s restart_service/verify_endpoint steps. The two are mutually exclusive: `restartBrain()` rejects while a `repair()` is in flight, because repair stops the service and then does exclusive database work that a reinstall would put a second writer on top of. A forced restart also treats a *skipped* install as a failure ("A newer version of ADE is already running. Restart ADE to switch to it."), where `repair()` tolerates one, since a protocol-compatible brain that is already running satisfies its step. `main.ts` constructs exactly one of these and shares it with `registerIpc`, so the mutual exclusion actually holds — the post-update transaction's `restart` step (see [desktop auto-update](../onboarding-and-settings/desktop-auto-update.md#applying-an-update-is-one-transaction)) binds to the same instance rather than a second one that could run alongside a repair. |
| `apps/desktop/src/main/services/storage/diskPressure.ts` | Samples all ADE storage roots, classifies pressure with recovery hysteresis, and gates write-producing operation classes via `canPerform(kind)`. Exports the `DiskPressureMonitor` type and refusal-message copy. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | Uses the project's disk-pressure monitor when available; otherwise samples the machine ADE directory, so disk pressure remains visible with no project open or while a remote project is bound. |
| `apps/desktop/src/main/services/storage/volume.ts` | `readVolumeSpace(dir)` (statfs free/total bytes) and `isNoSpaceError(err)` (ENOSPC/EDQUOT and disk-full message detection), shared by the pressure monitor and the database-open error classifier. `readStorageVolumes(roots)` is the storage page's async read: one entry per drive (device number; drive root on Windows) for the project, ADE home and temp folder, and on macOS the free space Finder shows (`NSURLVolumeAvailableCapacityForImportantUsageKey`, one short `osascript` run, statfs on any failure) with its purgeable part. The page prints these and every storage size in the measured machine's own units (`formatStorageBytes`: 1000 on macOS and Linux, Explorer's 1024 on Windows). |
| `apps/desktop/src/main/services/storage/cloudPlaceholder.ts` | The cloud-eviction preflight. `detectCloudStorageProvider` matches a path against the provider roots (`Library/Mobile Documents`, `Library/CloudStorage`, and home-relative `OneDrive` / `Dropbox` / `Google Drive` folders) on text alone, so it costs nothing on any platform; `isDatalessFileStats` spots a file with a size but zero allocated blocks, which is what a dehydrated placeholder looks like through `fs.stat`. `detectCloudPlaceholderFile` reports a finding only when both agree, and `storageUnreadableMessage` writes the one sentence a person needs — with the "move it out of the cloud folder" remedy stated conditionally when no provider was matched, because a failing disk or a dropped network mount produces the same unreadable file. `storageUnreadableRemedy` is that remedy on its own, so a caller holding an errno but no path can still word the fix. |
| `apps/desktop/src/main/services/storage/storageErrnoClassifier.ts` | The one place that decides whether a platform error means "this computer cannot read its own bytes". `classifyStorageFault(error, { path })` returns a `StorageFault` (`{ code: "storage_read_failed", errno, path, provider, message }`) or `null`, and `STORAGE_FAULT_ERRNO_CODES` names the seven codes it acts on (`EDEADLK`, `EIO`, `ENXIO`, `ENODEV`, `ESTALE`, `EHOSTDOWN`, `EREMOTEIO`). An errno alone is not enough: the error must also carry filesystem evidence — a caller-supplied path, a path on the error, or a `syscall` — so a socket-layer `EHOSTDOWN` or `ESTALE` is never read as a disk fault. An errno libuv could not name (`UNKNOWN_SYSTEM_ERRNO_PATTERN`, on the code or the text) qualifies on its own, as does a Windows `UNKNOWN` inside a detected cloud-provider folder, which is where `ERROR_CLOUD_FILE_*` and `ERROR_FILE_OFFLINE` land. The database open and the sync host are its only production callers. |
| `apps/ade-cli/src/services/diagnostics/storageEnvironmentProbe.ts` | `collectStorageEnvironment(roots)` — the "where do ADE's directories actually live, and are their bytes on this disk" probe behind the report's **Storage environment** section. It uses `node:fs` alone and needs no brain, because the machine it explains is often the one where the brain will not start. `classifyStorageLocation` labels each root `icloud` / `dropbox` / `google-drive` / `onedrive` / `cloud-storage` / `external-volume` / `network-volume` / `local`; a bounded breadth-first walk (`STORAGE_SAMPLE_MAX_FILES` 200, `STORAGE_SAMPLE_MAX_DIRECTORIES` 40, `STORAGE_SAMPLE_TIME_BUDGET_MS` 750, symlinks never followed) counts dataless placeholders through `isDatalessFileStats`. `detectLaunchdManaged` and `readMaterializeDatalessFilesKey` report whether launchd started this process and whether the installed launch agent carries the materialization key. The privacy contract is structural: it emits enums and counts, never a path, directory, or file name. |
| `apps/desktop/src/main/services/processes/processStartTime.ts` | `readProcessStartTimeMs(pid, platform)` — one `/bin/ps -o lstart= -p <pid>` under `LC_ALL=C` (an unpinned locale prints dates `Date.parse` rejects), bounded at 2 s, `null` on Windows or any failure. It is the shared answer to "is this still the process that wrote the thing I am about to act on", used by the external watchdog's identity check, by the connection pool's stale-runtime record, and by the machine-wide sync host lease so a recycled pid cannot be killed or reported as the old brain. Because it answers `null` on Windows, `syncHostSingleton.ts` pairs it with a PowerShell `StartTime` read there rather than falling back to a Node-bootstrap timestamp the reader would then reject — see [sync and multi-device](../sync-and-multi-device/README.md#source-file-map). |
| `apps/desktop/src/main/services/storage/storageInsightsService.ts` | Builds categorized storage snapshots and preview-confirmed cleanup plans without following symlinks or deleting protected state. `proof_attachments` is a manual `review_first` cleanup target for `.ade/artifacts` and `.ade/attachments`; after bytes are removed it invokes the broker's `purgeArtifactRecordsUnder` hook so proof rows cannot outlive their files. It also runs the lane-lifecycle scan at the configured interval: safely archives excess or inactive lanes, marks old archived worktrees for review, and never removes a lane's own files in the background. The **storage doctor** compresses history, maintains the database and removes build output from idle lanes (`laneBuildOutput.ts`); other filesystem candidates such as staging, backups and DerivedData remain review-first. Folder sizes use `diskUsage.ts`. Every run is journaled and emits one deduped `ade_feature_used` analytics event. Populates the snapshot's optional `extras` plus lifecycle policy/status and per-item ownership, age, blocked reasons, and reclaim estimates. |
| `apps/desktop/src/main/services/lanes/laneService.ts` | Owns the lane-aware `getReclaimRisk`, `archiveAndReclaim`, and restore-aware `unarchive` operations. It proves exact path-and-branch ownership against this project's Git worktree registry, rejects symlinks, rechecks directory identity before removal, shares the database-backed lane worktree lease with PR workflows, and stores retryable reclaim failures locally. |
| `apps/desktop/src/main/services/storage/storageLedger.ts` | The **storage ledger** (`STORAGE_LEDGER`): the declared policy for every persistent table and directory ADE writes — its privacy class (`user_data` / `derived` / `operational`) and how it is bounded (`write_time` / `doctor` / `both` / `manual`). `LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS` directory to a ledger id (or `null` for intentionally-unmanaged config/credentials) so a coverage test fails CI if a new tracked directory ships without a declared policy. `deriveCategoryPolicyChips()` renders the Settings policy chips from the ledger. |
| `apps/desktop/src/main/services/storage/storageDbBreakdown.ts` | Pure helpers turning raw `dbstat` rows into the coarse project-database breakdown (`classifyDbTable` / `mapDbBreakdown`: webhooks, sync bookkeeping, PR cache, core) and `deriveSyncBookkeepingAction` — which reads the journal so the sync-bookkeeping row offers "Compact now" only after a run proves compaction ran without a `has_peers` skip, and stays "waiting to compact" otherwise. |
| `apps/desktop/src/main/services/storage/laneBuildOutput.ts` | Build output in idle lanes: the explicit folder list (`BUILD_OUTPUT_FOLDER_RULES`), the depth bound, the lane and folder checks, the removal (bounded whole-pass retries, read-only entries made writable), the `local_lane_build_output_cleanups` record and the summary Settings shows. See "Build output in idle lanes". |
| `apps/desktop/src/main/services/storage/laneLifecycleScan.ts` | The archive rules' scan (`createLaneLifecycleScan`): archive idle lanes whose work is merged (an open PR keeps a lane; a squash-merged PR whose head is the branch counts as merged), then free up or delete archived lanes under the "Archived lanes" rules, each lane checked by one `laneSafeToTouch` gate; the retry of folders kept because files were in use; and the "Last run" report. Runs about hourly while a rule is on. |
| `apps/desktop/src/main/services/shared/deletingTrash.ts`, `shared/sameFolder.ts`, `git/gitLongPaths.ts` | The `.ade-deleting-` trash name, in-use error check, background removal and sweep shared by lane delete, reclaim and build-output cleanup; one path comparison (case-insensitive on Windows, real paths when the spellings differ); `-c core.longpaths=true` for git on Windows. |
| `apps/desktop/src/main/services/storage/laneSizes.ts` | Each lane folder's full size (`measureTree`, no entry cap), measured in the background one lane at a time and stored in the local-only `local_lane_size_measurements` table: for lanes never measured a minute after boot, for lanes older than 12 h (or whose build output was removed) from the storage doctor, and from the page's Check again. The snapshot shows a measured lane's size with when it was measured and walks only the others; `laneSizing` carries the pass's progress. Stops on `dispose()`; a lane cut short is not stored. |
| `apps/desktop/src/main/services/storage/diskUsage.ts` | One definition of "how much disk a folder takes", shared by the storage snapshot walk, the lane reclaim estimate (`laneService.managedTreeBytes`) and the build-output cleanup: allocated blocks (`st_blocks * 512`, the file length on Windows), a hard-linked file counted once and only when all its links are inside the measured folder, pnpm's `node_modules/.pnpm` left out when `.modules.yaml`'s `storeDir` is on the same volume (clones and hard links share the store's blocks), links never followed, unpatched `fs` so a lane's `.asar` files are files. |
| `apps/desktop/src/main/services/storage/storageMaintenanceJournal.ts` | Read/write helpers for the storage-doctor journal — a plain rebuildable JSON file (`storage-doctor-journal.json` under `.ade/cache`, no DB/CRR) capping the last 30 runs, written via temp-file-then-rename so a crash never leaves a torn journal. It creates only `.ade/cache`, never its parents, so a project deleted while open is not brought back. |
| `apps/desktop/src/main/services/storage/historyCompression.ts` | Finds inactive old history, gzip-compresses it, verifies byte identity, and only then removes the original; also reinflates before append. Exposes `readHistoryFileSync` / `reinflateHistoryFileSync` so transcript, session, and search readers can read a `.gz` generation transparently. The `.gz` keeps the source's modification time. An optional `minAgeMsFor` hook gives finished chats a shorter idle age and lists them first. |
| `apps/desktop/src/main/services/storage/legacyChatTranscripts.ts` | `resolveChatTranscriptReadPath` maps a chat row's legacy `<id>.chat.jsonl` path to the dedicated `transcripts/chat/<id>.jsonl` (plain or `.gz`). `removeDuplicateLegacyChatTranscripts` is the doctor step that deletes legacy copies once every event line in them is proven to be in the dedicated file. |
| `apps/desktop/src/main/services/storage/deletedLaneChats.ts` | Lists chats whose session row and lane are both gone (lane delete removes rows, not files), idle for 7 days, with every file they left. Backs the review-first "Chats from deleted lanes" row and its `deleted_lane_chats` cleanup target. `providerSessionsOfDeletedLaneChats` reads each chat's record for the Claude/Codex session ADE started. Imported chats are skipped, and so are sessions a live chat also names. |
| `apps/desktop/src/main/services/chat/deletedChats.ts`, `apps/desktop/src/renderer/components/settings/RecentlyDeletedSection.tsx` | Settings › Storage & cleanup › Recently deleted: the `deleted_chats` rows a chat delete, an agent CLI delete (`kind = 'cli'`), or a lane delete writes, the agent-copy lookup that keeps a row only while the conversation still exists on this machine, and Reopen through the external-session import. Machine-local (excluded from CRR); rows are hidden rather than removed. See [Recently deleted chats](../chat/README.md#recently-deleted-chats). |
| `apps/desktop/src/main/services/storage/providerHistory.ts` | `measureProviderHistory` sizes each provider's own session folders on this machine: Claude and Codex across every config home, plus OpenCode, Droid, Cursor, Copilot, Pi and Grok. `listProviderCopiesOfChats` finds the Claude `projects/<cwd>/<id>.jsonl` (plus its `<id>/` side folder) and the Codex rollout for given session ids. |
| `apps/desktop/src/renderer/components/app/useDeletedChatsReminderBanner.tsx` | The docked reminder shown when chats from deleted lanes pile up: 25 or more chats, or at least 100 MB. It checks 45 s after open and every 6 h through `storage.deletedLaneChatsSummary`. Every answer snoozes it for two weeks per project, in localStorage. |
| `apps/desktop/src/renderer/components/app/StoragePressureIndicator.tsx` | Quiet top-right warning/critical/exhausted status and entry point to Storage settings. Mounted in `TopBar.tsx` (enabled only when a workspace project is open). |
| `apps/desktop/src/renderer/components/app/ProjectRecoveryScreen.tsx` | Full-project recovery surface for typed open failures: one `.kit-card` over the window's scene with the cause, live repair steps, the Fix it → Restart ADE → Reset ADE → Report ladder, and technical details. `ProjectTabHost` in `App.tsx` renders it full-viewport whenever `projectTransitionError` carries a `code` and `rootPath`. This is the **local disk/brain** repair surface; the similarly named `ProjectHostRecoveryScreen.tsx` is the remote one a browser or phone sees when a reachable machine's project sync host is blocked (see [web client](../web-client/README.md#source-file-map)). |
| `apps/desktop/src/renderer/components/app/ProjectTransitionErrorAlert.tsx` | Fallback dismissible banner for project open/switch failures that lack a code/rootPath (un-coded string errors); it renders nothing once a coded error hands the surface to `ProjectRecoveryScreen`, for an open refused mid-update, or while `BrainDownNotice` owns a down background service. |
| `apps/desktop/src/renderer/components/app/BrainDownNotice.tsx` | The one app banner for a background service that is down around an update (mounted by `AutoUpdateBanner`): "Finishing the update" while an update owns the service, then the cause and the Fix it → Restart ADE → Reset ADE ladder when it half-landed. Publishes `useBrainDownNoticeShowing` so the project banner stands down. |
| `apps/desktop/src/renderer/components/app/restartAde.ts` | The Restart ADE rung: relaunches through `updateRelaunchApp` and stamps `ade.recovery.restartRequestedAt` so the next failure after the relaunch knows that rung was tried. |
| `apps/desktop/src/main/services/ipc/knownProjectRoots.ts` | Validation for renderer-supplied project roots on the recovery and diagnostics channels. A renderer may only name the open project, a local recent-projects entry, or a root main itself recently attempted to open; `AttemptedProjectRoots` is that last, bounded and expiring, single-writer registry, recorded only after the repo path resolves. Comparison goes through `pathsEqual` (case folding) and falls back to `path.resolve` when a root has no realpath, so a project on an unmounted volume is not refused. |
| `apps/desktop/src/main/services/diagnostics/diagnosticReportService.ts` | Desktop half of the report dialog ("Report this error to ADE…"): shared machine sources plus what only Electron can reach — its `userData` jsonl logs, local runtime status, the recovery diagnosis for the open project, the typed last-failure store, and an Electron-aware volume reader. Builds the redacted text the dialog shows; the send saves it `0600` and uploads it. The typed last-failure store is keyed off the root the shared collector actually used, not the request's, so a report with no project open cannot attribute one project's failure to another's logs. |
| `apps/ade-cli/src/services/diagnostics/diagnosticReport.ts` | The pure report builder and the redactor (`redactDiagnosticText`). No I/O, so both the desktop and the CLI produce byte-identical documents from the same sources. |
| `apps/ade-cli/src/services/diagnostics/diagnosticSources.ts` | `collectMachineDiagnosticSources` — everything a headless box can read: both of the background service's output streams, the service definition (the plist via `readFileHead`, the loaded job via `launchctl print`, the job's line in launchd's disabled list via `launchctl print-disabled`, the macOS Background Items verdict, and launchd's own spawn log for the job via `log show --last 10m`), a Notes line when launchd has the job loaded but stopped and never started it (`runs = 0`, `pended nondemand spawn`) or its domain is in on-demand-only mode, naming the `launchctl kickstart` that starts it, the project logs of the open **or most recently opened** project (`resolveMostRecentProjectRoot`), layout, disk figures, the storage-environment probe (`storageEnvironment`), and the redaction context. Both surfaces read it, so a source added for one appears in both. Command-backed sources (journald, `schtasks /XML`) go through the injectable `DiagnosticCommandRunner`, bounded and non-interactive. |
| `apps/ade-cli/src/commands/reportIssue.ts` | `ade report-issue [--send] [--open]`, the headless equivalent. It prints the report and never tells anyone to post it on a public page; `--open` after a successful `--send` opens the public GitHub issue that holds only the reference (`shared/publicIssueLink.ts`). `--send` needs no project and no arguments: it posts the same redacted report to ADE (Clerk token when the machine is signed in, anonymous otherwise), saves a copy under `~/.ade/diagnostic-reports/` *before* attempting the upload, and prints the reference id or the plain-words failure alongside that path. Local files only: it never starts or contacts the brain, so it still works where ADE will not come up and on hosts with no error screen to press. |
| `apps/ade-cli/src/commands/triage.ts` | `ade triage [--agent] [--provider <name>]` — the step after diagnosis. `ade doctor` says which check failed and `ade report-issue` produces something to file; neither fixes anything, and the person staring at either is usually the person least able to act on it. This builds the two files an agent needs — a redacted machine context and a maintained playbook — and gets out of the way. This module only **sequences**: it runs the doctor probe, the diagnostic collection, and the playbook resolution concurrently (none needs the others, and the brain is exactly what may be hanging), then assembles, writes, detects, and launches. `--agent` launches nothing and prints the handoff for a session that is already running; a machine where ADE has downloaded no agent yet gets the same files and **exit 0**, because the files are the deliverable and the launch is a convenience. CLI-only by design — the desktop and iOS clients all need the brain this command exists to repair. Every collector is allowed to fail: a rejected doctor probe, diagnostic collection, or ADE-layout resolution becomes a section in `context.md` saying so, and even a rejected playbook resolver falls to the embedded copy rather than taking the bundle down. If the report could not be collected, the redaction context is derived locally instead, so a failed collection cannot turn `context.md` into the one unredacted copy of this machine's paths and names. |
| `apps/ade-cli/src/commands/triageContext.ts` | Assembles the two files and the prompt from already-collected material; nothing here probes the machine. `context.md` is Install → Health checks → Brain → Recent errors → Full diagnostic report, with `orderTriageDoctorRows` putting failures before warnings before passes and a header line naming how many rows failed. `extractRecentErrorLines` pulls up to 40 error-shaped lines (`ERROR_LINE_PATTERN` covers `EACCES`/`ENOSPC`/`EDEADLK` and friends) **out of the already-redacted report**, so it cannot become a second unredacted path for the same bytes. The whole document then goes through `redactDiagnosticText` on the way out — the pass is idempotent, so the embedded report is unchanged, and collection error messages ride it too, which is why they are written into the document rather than printed raw. The bundle dir is `mkdtemp`, not a bare `mkdir` of the timestamp: the temp directory is world-writable on POSIX and a predictable name there is something another user can pre-create as a symlink. A full or read-only temp directory raises `TriageCommandError` naming the path, because that is a plausible state on exactly the machine this command is for. |
| `apps/ade-cli/src/commands/triageLaunch.ts` | Provider detection and the launch plan. `TRIAGE_PROVIDERS` is the detection order — claude, codex, cursor-agent, opencode, droid, muse — each resolved to ADE's pinned copy (`resolvePinnedProviderCli`), never a CLI on the PATH; a provider with no copy is skipped with its pinned state (`pinnedProviderCliStateSentence`), and a resolver that throws drops that provider rather than the command. `--provider` accepts aliases (`cursor`, `factory`) and raises `TriageUsageError` on anything else. Prompt delivery is per provider: claude, codex, cursor-agent and droid document a trailing `[prompt]`, but OpenCode's positional argument is a *project directory*, so it launches bare and the prompt is printed to paste. The same paste path is taken whenever `resolveCliSpawnInvocation` has to **wrap** the executable — a `.cmd` through `cmd.exe`, a `.ps1` through PowerShell — because both rewrite the command line before argv and the multi-line, path-bearing triage prompt would arrive corrupted. The spawn inherits stdio (the user talks to their agent directly), hides the extra Windows console a `.cmd` shim would pop, and the command exits with the agent's code. |
| `apps/ade-cli/src/commands/triagePlaybook.ts` | Playbook resolution. The maintained copy on `main` is fetched **first** when the network answers inside 3 s; everything else is the fallback. The fetch is pinned to `raw.githubusercontent.com`, refuses redirects outright (a redirect means a captive portal, proxy, or hijacked DNS rewrote the request, and following it would fetch *instructions for a coding agent* from an origin nobody pinned), caps at 512 KiB checked against `content-length` before the body is read, and treats every failure — offline, DNS, TLS interception, timeout — as "use what is on this machine". The local candidates, in order: `ADE_TRIAGE_PLAYBOOK`, the packaged copy under `process.resourcesPath`, the ADE install this CLI was launched from, then the working directory. The install-anchored rung is an **anchored** walk (stop at the first `ade-cli` ancestor, take that install's playbook, containment-check the result via `realpath` on both ends) rather than "try every ancestor", which would climb out of an npm-global install into `$HOME` and let any `~/docs/triage/PLAYBOOK.md` out-rank the shipped copy. Both entry points are walked because neither covers both builds — `__dirname` is absent under an ESM loader, `argv[1]` is what a `tsx src/cli.ts` run has — and both outrank cwd so a checkout the shell happens to sit in cannot win. `embeddedTriagePlaybook()` is the floor: safety rules plus where to read the real thing, deliberately not a second full copy, since a stale duplicate is worse than a short one. `ADE_TRIAGE_NO_FETCH=1` disables the fetch. |
| `apps/ade-cli/src/commands/triageErrors.ts` | `TriageUsageError` and `TriageCommandError`, in their own module so every triage module can throw them without importing each other. `cli.ts` maps them onto `CliUsageError` / `CliToolError`, which print the message alone; a bare `Error` would reach the catch-all and print a stack trace over the wording, on the one machine whose owner is least able to read one. |
| `docs/triage/PLAYBOOK.md` | The playbook `ade triage` hands to the agent: safety rules first (read-only diagnosis before mutation, never delete under `.ade/` or `$ADE_HOME`, never kill by name or pattern, exact PIDs only, ask before destructive steps), then one section per failure class keyed to the doctor rows. Fetched from `main` at run time so it can be improved without an ADE release, falling back to the copy on this machine and then to the reduced built-in one; `playbookSource`/`playbookOrigin` record which won and appear in the file's own header and in `--json`. Packaged builds ship it beside the CLI through a single `extraResources` entry — one guessed layout only, because a second would mask a packaging change that should fail loudly — and both `validate-mac-artifacts.mjs` and `validate-win-artifacts.mjs` assert `<Resources>/docs/triage/PLAYBOOK.md` exists, since electron-builder only *warns* on a missing source and a dropped entry would silently degrade triage to its built-in minimum on every installed machine. |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsStore.ts` | The consent flag **and** the spend ledger for automatic uploads, in one file (`<adeHome>/secrets/diagnostics-autosend.json`) that both senders open — the desktop main process and the brain — because "three a day from this computer" is a property of the install, not of a process, and two private ledgers would quietly mean six. Deliberately dependency-free (`node:fs`, no Electron, no logger) for exactly that reason. Owns `AUTO_DIAGNOSTICS_WINDOW_MS` (24 h), `MAX_AUTO_DIAGNOSTICS_PER_CODE` (1), `MAX_AUTO_DIAGNOSTICS_PER_WINDOW` (3), `normalizeAutoDiagnosticsFailureCode` (coerced to the Worker's `FAILURE_CODE_PATTERN`, re-exported rather than rewritten), the mkdir lock — whose `isLockContention` names the Windows delete-pending `EPERM`/`EACCES`/`EBUSY` window as well as `EEXIST` — and the pending-notice queue the toast acknowledgement retires. On by default; `DO_NOT_TRACK=1` or a persisted explicit off turns it off. An unreadable or locked ledger fails closed. |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsSend.ts` | `runAutoDiagnosticsSend` — the policy every automatic send obeys, written once. The two senders differ in exactly three things (what they build, how they upload, which analytics surface they report as) and bring those as structural seams; consent, the pre-request reservation, the local copy, silence on failure, the pending flag, the log lines and the analytics dedupe key live here. Also owns the `AutoDiagnosticsOutcome` vocabulary (`completed`, `skipped_disabled`, `skipped_budget`, `skipped_ineligible`, `failed`) and `AUTO_DIAGNOSTICS_ANALYTICS_DEDUPE_MS` (1 h). |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsService.ts` | The desktop sender: what is specific to this process — how a report gets built (no `diagnoseProject`, since a diagnosis is itself a trigger), that it uploads anonymously, the `onSent` fast path for an open window, and the getter/setter the Settings toggle reads and writes. |
| `apps/ade-cli/src/services/diagnostics/autoDiagnosticsSender.ts` | The brain's sender, for the failures the desktop never sees — a headless machine whose pairing recovery gave up, a publisher failing for minutes with nobody at the console. It reads the machine credential store, so its reports land attributed rather than anonymous. It has no window, so successful sends stay pending in the shared ledger until a renderer subscribes and acknowledges the toast. |
| `apps/ade-cli/src/lib/externalLinks.ts` | `normalizeExternalUrl` / `openExternalUrl` for general URLs: allows only `http(s)` and `mailto:`. `normalizeEditorExternalUrl` / `openEditorExternalUrl` is a separate allowlist for SSH editor URLs (`vscode:` / `vscode-insiders:` / `vscodium:` with host `vscode-remote` and path `/ssh-remote+…`, plus `zed://ssh/…`). Opens through the platform helper (`open` / `rundll32` via the trusted-tool resolver / `xdg-open`), and falls back to Electron's `shell.openExternal` only when actually running inside Electron — a static `electron` import crashes headless startup. |
| `apps/desktop/src/shared/diagnosticsUpload.ts` | The one diagnostics upload client, shared by the desktop main process (`autoDiagnosticsService`) and the CLI: `uploadDiagnosticReport`, the `DiagnosticUploadFailure` vocabulary and its one-sentence copy, `resolveDiagnosticsUploadBaseUrl`, and `diagnosticReference` (the first 8 characters of the returned id — a full uuid is unreadable over a phone call). It lives in `shared/` because that is the only tree the renderer, the main process and the CLI can all import (Vite refuses to serve files outside `apps/desktop`), and it is deliberately free of Node built-ins and `import.meta` so the identical module loads in all three. It posts the report's exact bytes and transforms nothing: the thing that is sent has to be the thing that was shown. |
| `apps/desktop/src/shared/types/diagnostics.ts` | The `DiagnosticSurface` / request / payload contract shared by main, preload and renderer. |
| `apps/desktop/src/renderer/components/app/ReportIssueButton.tsx` | The **Report this error to ADE…** control and its result line, on every error surface. A press opens the report dialog and sends nothing; after a send the line shows the reference, a copy control and the optional public GitHub issue. |
| `apps/desktop/src/renderer/components/app/ReportIssueDialog.tsx`, `reportDraft.ts` | The report dialog (note, exact preview, Send) in its own React root, and the prepare → send → discard draft that it and Settings share. See *Diagnostic reports* below. |
| `apps/desktop/src/shared/publicIssueLink.ts` | The one public GitHub issue link after a send: only the reference, version and channel, and OS family. Used by main, the web client and the CLI. |
| `apps/desktop/src/renderer/components/app/ReportIssueFooter.tsx` | The last row of the recovery screen and the two crash boundaries: a rule, **Report this error to ADE…** with one hint line, and on a crash card "ADE got an error report automatically" once Sentry confirms it has the crash (`confirmSentryDelivery`). |
| `apps/desktop/src/renderer/webclient/adapter/diagnostics.ts` | The report dialog's prepare and send in the hosted web client: the report goes to the web client's Sentry as User Feedback. Without Sentry the dialog offers only **Copy report**. See *Diagnostic reports* below. |
| `apps/desktop/src/renderer/components/settings/DiagnosticsSharingSection.tsx` | The one report control in Settings → System → Advanced (`general.diagnostics-sharing`, anchored `#diagnostics-sharing`, `web: "hidden"` because the report is built on this machine). It is **Send a report to ADE**, with no toggle. It hides the button on a preload that predates it. |
| `apps/desktop/src/renderer/components/app/toast/useAutoDiagnosticsToast.ts` | The renderer half of the delivery contract: subscribes, asks for the outstanding notices (`IPC.diagnosticsFlushAutoSent`), raises the *"A diagnostic report was sent to ADE"* toast with **View**, and only then acknowledges it (`IPC.diagnosticsAckAutoSent`). Mounted from `AppShell.tsx`. |
| `apps/desktop/src/renderer/components/app/errorSurfaceKit.tsx` | Shared parts for the full-screen error surfaces, built on the surface kit (`.kit-card`, `.kit-tag`, `.kit-btn`) — `ErrorSurfaceCard`, `TechnicalDetailsFold`, `ERROR_PRIMARY_BUTTON` — so the recovery screen, the renderer/page boundaries and the CTO wake failure keep the raw text behind a fold and the plain-language account on top, and read on light themes and over a picture. |
| `apps/desktop/src/renderer/components/chat/ChatContinuityRecoveryCard.tsx` | The continuity notice as the chat draws it: a quiet "Reconnecting…" line while ADE recovers by itself, a quiet "Reconnected" line after, and only when that failed an inline `Banner` with one recommended action ("Try again") and "Start a new chat". `AgentChatMessageList` renders it in place of a plain notice chip when a `system_notice` event's `detail.kind` is `"continuity_recovery"`; `foldSelfHealedFailures` in `selfHealedFailureLines.ts` keeps only the newest notice per lost thread, hides the hand-off message, and drops the failed turns once the thread is back (a "not found" error is dropped only when the next continuity notice after it is a thread that came back). |
| `apps/desktop/src/renderer/components/settings/health/HealthSpace.tsx` | The storage part of Settings: category totals, the project-database breakdown, the cleanup preview, Archive & Reclaim with its typed confirmation, and manual history compression. One storage result shows at a time; a new one replaces the last. Storage accounting includes ADE temporary files. |
| `apps/desktop/src/renderer/components/settings/health/HealthService.tsx` | Computer → ADE service: how the background service on this computer is doing (its calls over the last day, slow and failed apart, with the p95 of the slow ones; its memory against the computer's; the computer's load; Repair). It reads only this computer over IPC, so another machine's page says so. |
| `apps/desktop/src/renderer/components/settings/health/HealthCleanups.tsx` | The recent cleanups from the maintenance journal, the lane check (one sentence per lane the lane rules looked at), and what the build output rule removed. |
| `apps/desktop/src/renderer/components/settings/storage/storageUiConstants.ts` | Shared presentational constants (`STORAGE_BRAND`, `PANEL_STYLE`) for the section shell and the split-out diagnostics/journal components, so they share styling without a circular import. |
| `apps/desktop/src/renderer/components/settings/storage/StorageCleanupDialog.tsx` | Preview-confirmed cleanup dialog: lists selected removable items with sizes, surfaces blocked paths and reasons, and only enables Remove once a fresh preview is in hand. Its failure state is phase-aware — failing to *look* and failing to *remove* leave the disk in different states and call for different next steps — and it carries a Try again that re-runs the preview. Overlapping previews are retired by request id, so a stale answer cannot paint over a fresh one or drag a settled dialog back to "error". Also hosts the itemized "Clean up safely" plan and its `runMaintenance` path. The cleanup is done once the files are removed: the dialog shows that result at once, and the maintenance sweep goes on in the background with a "You can close this" note. Its outcome reaches Health through `onMaintenanceDone` / `onMaintenanceFailed` as a toast whether or not the dialog is still open, and a slow or failed sweep is a note, never "the cleanup didn't finish". |
| `apps/desktop/src/renderer/components/settings/storage/storageView.ts` | Pure, DOM-free presentation + policy helpers. Category metadata/order/hues, safety labels, and `buildCleanupTarget` / `cleanableEntries` / `groupLaneItems` map a snapshot item to a typed `StorageCleanupTarget`. The overhaul adds the diagnostics/maintenance view-model: `dbBreakdownRows`, `buildSafeCleanupPlan`, journal/db-size-sparkline/trend helpers, `daemonMemoryBytes`, `healthChip`, `formatSlowActions`, and `categoryPolicyChip` — each degrading to a sensible "not available" value so the UI renders against an older daemon that never sends `extras`. |
| `apps/desktop/src/shared/types/storage.ts` | Shared storage contracts: disk-pressure types, `StorageCategoryId`, `StorageSafety`, `StorageItem`/`StorageCategorySnapshot`/`StorageSnapshot`, and the `StorageCleanupTarget`/`StorageCleanupPreview`/`StorageCleanupResult` DTOs. `StorageItem` carries ownership, age, blocked reasons, reclaim estimate/state, and lane ownership for the review screen; `StorageLifecycleSnapshot` carries the effective four-rule policy plus last/next scan and review counts. The ledger/maintenance surface includes `StorageLedgerEntry`/`StoragePolicyClass`, `MaintenanceAction`/`MaintenanceRunReport`/`MaintenanceTrigger`, `DbBreakdownEntry`, `StorageSnapshotExtras`, and `RuntimeHealthSnapshot`. |
| `apps/desktop/src/shared/types/recovery.ts` | Typed recovery contracts: the `AdeRecoveryErrorCode` union + `toAdeRecoveryErrorCode`, `AdeLastFailureReport`, `ProjectRecoveryDiagnosis`, the ordered `RepairStepId` list + `ProjectRepairReport`, `mapKvDbOpenErrorCode`, and the `RECOVERY_COPY` table the main process and the recovery screen both read, so a state can never be worded or offered differently by each half. `stateForCode` maps a stored code to its state from one place. |
| `apps/desktop/src/main/services/runtime/machineResetLauncher.ts` | Desktop launcher for the hard reset: builds the plan, then spawns the CLI engine (`ade reset --all`) and hands it the person's rescue choice, quitting the app so the engine can own the machine. Machine-scoped because a reset removes the very brain the desktop talks to. |
| `apps/ade-cli/src/services/reset/machineResetInventory.ts` | Read-only inventory behind the hard reset: every ADE process, background service, folder, Keychain item and config entry, plus each registered project and its lanes. Every external effect goes through `MachineResetDeps` (the process boundary), so the plan the person confirms is the list the engine removes. Also owns `isAdeProcessCommand` (the reset marker excludes the reset itself), `stripAdeShellLines`, `cursorHooksWithoutAde`, and `findAdeAncestor` (the ADE parent a terminal-launched reset must not kill). |
| `apps/ade-cli/src/services/reset/machineReset.ts` | The hard reset engine (`ade reset --all`): rescues lane work (commit on the lane's branch, or move the worktree out), then removes ADE's data inside each project and the machine-wide paths, and writes a receipt the relaunched app reads. Never removes a project's own files; a rescue that fails parks the lane rather than deleting it. `assertRemovable` is the last check before any removal. |
| `apps/desktop/src/shared/types/machineReset.ts` | Shared hard-reset contracts: `MachineResetLane`/`MachineResetProject`/`MachineResetItem`/`MachineResetPlan`, the `MachineResetRescueMode` (`none` / `commit` / `move`), and the `MachineResetReceipt` the CLI writes and the desktop reads on next launch. |
| `apps/desktop/src/renderer/components/app/ResetAdeDialog.tsx` | The reset confirm dialog: shows the plan, takes the rescue choice, requires typing `RESET`, and calls the launch IPC. `ResetAdeButton` is the entry point on the recovery screen and Settings → System → Advanced (the Reset ADE section, last on the page, local machine only). |
| `apps/desktop/src/renderer/browserMockRecovery.ts` | Vite-preview mock for the recovery screen (`?adeRecovery=<state>`) and the brain-down banner (`?adeBrainDown=service\|restart\|health\|background_blocked\|updating`), with `&adeRecoveryRepair=fail` to make Fix it fail and `&adePlatform=win32` for the Windows copy, so each state renders without Electron. |
| `apps/desktop/src/shared/codedError.ts` | `codedError(message, code)`, `encodeCodedErrorMessage`, and the `parseCodedErrorMessage`/`stripElectronErrorWrapper`/`extractCodeFromMessage` decoders that let the renderer recover a `code` through the Electron IPC error-wrapping — and through the runtime RPC client's own `Remote ADE service method <m> failed (code <n>):` wrapper, which the strip list has to name or no brain-side code survives the trip. It also draws the line between the two error vocabularies: `isErrnoLikeCode` recognises platform codes (`E…`, `ERR_…`, `MODULE_NOT_FOUND`) and `UNKNOWN_SYSTEM_ERRNO_PATTERN` recognises an errno libuv could not even name, neither of which can collide with ADE's lowercase snake_case codes. Re-exported to the renderer via `apps/desktop/src/renderer/lib/codedError.ts`. |
| `apps/ade-cli/src/jsonrpc.ts` | The brain's JSON-RPC server, and the boundary that decides which failures may be worded to a caller at all. A service verdict — a plain `Error` carrying a non-errno string `code` — is re-encoded as `code: message` (with the rootPath tail intact) in the shape `parseCodedErrorMessage` decodes, and the code is repeated in `error.data.code`. A platform or runtime fault (a `syscall`/`errno`, an errno-like code, an unnameable errno, a `TypeError`-class fault) is replaced on the wire by `Internal error in <method> (ref <id>)` and handed in full to `onInternalError`, which `cli.ts` writes to stderr — `launchd.err.log`, one of the logs `ade report-issue` tails — so the reference the user was shown is searchable. |

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

`writeJsonWithPrevious` copies the current valid file to `<file>.lkg`, writes a
temp file in the same folder, optionally syncs it, and renames it over the
primary. A failed write leaves the primary. `readJsonWithRecovery` accepts only
payloads that pass the caller's validator and falls back to the one `.lkg`.

`writeFileAtomic` never unlinks the target first; `rename` replaces it in one
step on every platform (Windows: `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`).

- A rename refused with `EXDEV`, `EPERM`, `EACCES` or `EBUSY` (a held file, a
  temp file on another device) falls back to `copyFileSync`. The list is
  closed: `ENOSPC` and `EIO` stay failures, so the old file stays intact.
- A caller's `mode` (for example `0o600` from
  `apps/ade-cli/src/services/sync/syncCloudRelayStore.ts`) goes on the temp
  file, so a secret is never readable by others; the copy path re-applies it
  with `chmod`.
- Directory fsync is skipped on Windows.

A chat's thread identity has three sources:

1. Version-2 metadata in `.ade/cache/chat-sessions/<sessionId>.json`.
2. The newest valid record per session in `thread-pointers.jsonl`.
3. The session `resume_command` and the provider pointer in the transcript
   tail.

When metadata cannot be read, reconciliation picks the durable pointer without
starting a provider thread and writes repaired metadata. A failed resume never
starts fresh: the service keeps the pointer, sets
`continuityRecovery.state: "required"` and emits a `system_notice` with
`detail.kind: "continuity_recovery"`.

When the provider says the thread is gone (`reason: "thread_missing"`:
Claude's "No conversation found", Codex's missing rollout), ADE recovers by
itself, at most once per chat in 10 minutes. The notice has
`autoRecovery: "pending"` and `startAutomaticContinuityRecovery` runs
`recover_from_history`: a new thread gets the conversation word for word with
tool steps condensed (`continuityConversation.ts`, about 240 KB; the first and
latest user messages always kept) and answers the unanswered message. If that
fails (`autoRecovery: "failed"`), or the chat already recovered in the last 10
minutes, the chat waits for one action:

- `retry_original` retries the kept pointer. Success writes
  `state: "reconstructed"` and `originalThreadResumed: true`, so the transcript
  shows "Reconnected". The failed message is not sent again; that turn keeps
  its Retry.
- `recover_from_history` starts a new thread in the same chat with the hidden
  hand-off and records the pointer lineage.
- `start_new_chat` creates a separate chat and records the link.

Other reasons (`unknown`, `provider_environment`, `transient`) wait for the
user, since the thread may come back.

### Work in flight across a brain stop

A brain told to stop (SIGTERM or SIGINT from launchd, systemd or the Windows
service, a logout or reboot, or the `shutdown` request behind restart, repair
and the memory restart) is a kept-alive service, so another start follows. It
records what was at work (`recordPlannedBrainStop`,
`apps/desktop/src/main/services/runtime/liveTurnProjects.ts`):

1. It runs first in `finish({ requested: true })` (`apps/ade-cli/src/cli.ts`),
   synchronously, before teardown, because the service manager may kill the
   brain 1.5 s after SIGTERM.
2. Each project with work gets `.ade/cache/reopen-cli-after-restart.<pid>.json`:
   the open agent CLIs (`registerPlannedStopCliSource`) and one
   `{ sessionId, midTurn: true, kind: "chat" }` per chat whose turn ran
   (`acceptedUpdate: true` for an accepted update). The terminals' own
   teardown adds to the same file only when this list failed.
3. A project whose folder refuses the list (read-only, full) still opens; its
   list rides in the brain's record (`lists`).
4. The record, `runtime/live-turns/<endpoint>.<pid>.stopped.json`, names at
   most 50 projects and the stop time. The live record and any pending file
   go. If the record cannot be written, the live record stays and the next
   brain treats the stop as a crash.

The next brain takes each `.stopped.json` once, by rename. A record older than
6 h (`RESTART_RESUME_MAX_AGE_MS`) opens nothing
(`brain.planned_stop_record_taken`, `stale: true`). Otherwise projects open
one at a time, as after a crash.

- Each chat service takes its list once (`reopenCliSessionsAfterRestart`) and
  continues each chat by id (`continueChatsAfterPlannedStop`), with the same
  row id (`updateResumeScheduleId`), prompt and cap as every restart continue.
- It skips a chat closed on purpose, owned by another brain, already
  continued, or driven by the user since the start
  (`agent_chat.update_resume_dropped`, `cause: "planned_stop"`).
- A brain that is not the machine brain leaves the machine brain's chats in
  the list (`agent_chat.planned_stop_chat_left`).
- Personal chats continue too: the brain warms the personal-chats runtime at
  start (`createPersonalChatScope` → `warmExisting`).

**The stop's reason decides what is kept.** The caller writes
`runtime/live-turns/stop-intent.<endpoint>.json` first (`noteBrainStopIntent`,
with the brain's pid when known) and clears it if the stop fails. The brain
reads it once; an intent for another pid, or older than 2 minutes, does not
count.

| Stop | Intent | Kept |
| --- | --- | --- |
| Restart, repair, memory restart, logout, reboot, Windows service shutdown | none | Chats and CLIs at work are continued |
| `ade serve` stopped with Ctrl+C | none | Kept: it cannot be told from a restart |
| Desktop update, `ade brain update` | `accepted_update` | Kept, and the continue cap starts again |
| Settings "Stop and quit ADE", `ade brain stop`, `ade runtime stop`, `ade runtime uninstall-service` | `stop_for_good` | No chat continues. Open CLIs reopen at their prompt. Projects an earlier stop left unopened lose their continues too. |
| Idle exit, socket lost, parent app gone, a failed start | none, not requested | Nothing kept |
| Crash, kill, power loss | — | The crash path: the live record stays |

- A stop for good changes only this endpoint's lists. Each list names its
  writer pid; each record carries the pids whose lists it took (`listPids`).
  Other brains' lists keep their continues.
- A list that cannot be claimed (read-only or locked folder) leaves the
  decision in `runtime/live-turns/<endpoint>.for-good.json`. This endpoint's
  next brain retries the rewrite; until it works, those lists reopen CLIs at
  their prompt and continue nothing (`stoppedForGoodListWriters`). An entry
  older than 6 h goes.
- A take that leaves entries for another runtime writes them back before it
  deletes the list. If that write fails, the whole list goes back under its
  own name and this runtime takes nothing.
- A brain an app started keeps no record; its terminals still write their CLI
  list at teardown.
- A Devin CLI never reopens: ADE never learns its resume id.
  `trackedCliReopensAfterRestart` leaves it out (`pty.cli_reopen_not_supported`)
  and its terminal gets `CLI_NOT_REOPENED_NOTICE` as the brain stops.

Size: the record holds at most 50 roots, the pid and the time; a list at most
200 entries of session id and flags; the intent about 100 bytes. No prompt or
transcript text is stored.

### What an ADE Cloud computer keeps off the computer

An ADE Cloud computer can be deleted, so its brain keeps the account server's
copy current (see [On an ADE Cloud computer](../remote-runtime/README.md#on-an-ade-cloud-computer)).
These small files record what the server already has, so a restart does not
send everything again and a crash does not send a message twice:

| File | What it records |
|---|---|
| `<project>/.ade/cloud/saved-chats.json` | Each chat's last uploaded part, the deletes the server has not confirmed, and each parent chat's subagent copies (a parent delete removes them too). |
| `<ADE home>/cloud/rest-save.json` | The marks of the shell and CLI copies, Git summaries, capsules, subagent copies and event-wake topics already saved. |
| `<ADE home>/cloud/chat-messages.json` | The queue drain's journal: each claimed message, and whether it was sent. |
| `<ADE home>/cloud/git-identity.json` | The commit identity the brain set. |
| `<ADE home>/account-lanes.json` | The account lane index set last sent. |

Each file is written to a temporary file and renamed, with mode 0600. A file
that is missing or unreadable makes the brain start over: the server answers a
part it already has without a second write, and a message the journal does not
know is claimed and sent once.

### Typed project-open recovery

Database and runtime failures use `AdeRecoveryErrorCode`, not string matching.
The brain records a bounded report in `lastFailureStore`; the local runtime
pool reads it and throws a coded refusal instead of starting a second brain on
the primary socket. IPC carries the code through the project transition state.
`ProjectRecoveryScreen` asks for a fresh diagnosis and shows plain repair
actions, with technical detail in a fold. `repair()` streams each step
(`IPC.recoveryRepairStep`), and the screen names the running step from
`REPAIR_STEPS` (`shared/types/recovery.ts`), the list the service runs.
`stateForCode` lives there too, so a fallback to the last failure gives the
same verdict as the service.

**A code must survive every wrapper.**

- The brain throws `codedError(message, code)`. `apps/ade-cli/src/jsonrpc.ts`
  re-encodes it as `code: message` (a rootPath rides after a NUL) and repeats
  it in `error.data.code`.
- The runtime RPC client prefixes `Remote ADE service method <m> failed (code
  <n>):`. Electron IPC drops custom `Error` fields, so `registerIpc`'s
  `surfaceCodedError` encodes once more. `stripElectronErrorWrapper` must name
  every prefix.
- `RECOVERY_MESSAGE_BY_CODE` (`renderer/state/appStore.ts`) replaces the
  brain's sentence only where the screen knows more. Other codes keep the
  brain's words as the headline (for `storage_read_failed`, the brain's
  message names the file and the fix).

**What may not be worded.** A platform fault (a `syscall`/`errno`, an
errno-like `code`, an errno libuv could not name, a `TypeError`-class fault)
goes on the wire as `Internal error in <method> (ref <id>)` and in full to
`onInternalError` (the brain's stderr), with the failing `path` when the error
has one. Service verdicts (`JsonRpcError`s, plain sentences such as "Project
root does not exist: …") pass. `isErrnoLikeCode` (`shared/codedError.ts`)
draws the line, which is why ADE codes are lowercase snake_case.
`isInternalRuntimeError` checks `UNKNOWN_SYSTEM_ERRNO_PATTERN` against `code`
**before** the coded-error branch, because "Unknown system error -11" in
`code` looks like a coded verdict.

**What the desktop retries.** `isLocalRuntimeConnectionDropped`
(`localRuntimeConnectionPool.ts`) resets the connection and runs the action
again only when the socket went away. It reads `Error.code` for `ECONNRESET`,
`ECONNABORTED`, `EPIPE` and `ENOTCONN`, and first rejects anything shaped like
`Remote ADE service method <m> failed …`: the daemon answered, so a retry
would run a non-idempotent action twice.

**Unreadable storage is not a damaged database.**

- A project or `~/.ade` in iCloud Drive, Dropbox or OneDrive whose files the
  provider evicted fails reads with an errno the platform does not name
  (macOS `EDEADLK`, "Unknown system error -11"). `createAdeRuntime`
  (`apps/ade-cli/src/bootstrap.ts`) runs `detectCloudPlaceholderFile` on the
  database before the open and throws `storage_read_failed` with
  `storageUnreadableMessage`.
- When the preflight does not fire, `classifySqliteOpenError` still buckets
  `EDEADLK`, `EIO`, `ENXIO`, `ENODEV`, `ESTALE`, `EHOSTDOWN`, `EREMOTEIO` and
  any unnamed errno as `storage_read_failed`, ahead of the integrity check.
  Both paths record the typed failure with the `dbPath` and the raw errno as
  `detail`.
- The errno list lives once, in `storage/storageErrnoClassifier.ts`
  (`classifyStorageFault`); the database open and the sync host call it.
- An errno alone is not evidence: the classifier also needs a path from the
  caller, a path on the error, or a `syscall`, because `EHOSTDOWN` and
  `ESTALE` are socket errnos too. So `classifySqliteOpenError` requires
  `{ path }` (explicit `null` allowed).
- On macOS, `read(2)` returns `EDEADLK` for a dataless file when the process's
  I/O policy forbids download, which launchd applies to background jobs. Both
  launch agents set `MaterializeDatalessFiles=true` (`installLaunchd.ts`,
  `installLaunchdWatchdog.ts`). With the key present, an `EDEADLK` is a
  provider problem; the report's storage environment says which.

Diagnoses with no repair:

- `storage_read_failed` → `storage_unreadable`. Rewriting unreadable files
  would risk the user's work, and a failing disk or dropped network mount
  looks the same. The screen states the cloud-folder remedy as a condition,
  lists moving the folder, and offers Try again only.
- `storage_io_failed` (SQLite "disk I/O error" at open: the drive is not
  answering, full or removed) → `drive_unreadable`: check that the drive is
  connected, awake and has space, then Try again. Corruption-type I/O
  sub-codes and out-of-memory do not count.
- `db_busy` (another ADE holds the lock past the retries; `openKvDb` reruns
  the open up to three times, a second apart) → `project_busy`: wait or close
  the other ADE, then Try again.
- `brain_starting` (the service is registered and alive but has not bound the
  socket; see [remote runtime](../remote-runtime/README.md)): the screen
  diagnoses again every 2 s and reopens the project when the endpoint answers.

`projectRecoveryService` does not need a healthy brain, so it can repair the
database that stopped the brain. `recovery.diagnose` and `recovery.repair`
accept only a known root (`apps/desktop/src/main/services/ipc/knownProjectRoots.ts`):
the open project, a recent project, or a root main recently tried to open (a
bounded, expiring registry, because a first open that failed is never a recent
project). Diagnostics drops a root it cannot place and says the report has
machine state only.

The repair stops at the first unsafe step: free space, exclusive ownership,
`quick_check`, an open so the pre-migration pass resolves staging, service
restart, endpoint and project RPC checks, then chat record and continuity
counts.

### The recovery screen and the brain-down notice

Two surfaces speak for "ADE's background service is down", never both.

**The recovery screen** (`ProjectRecoveryScreen.tsx`) is one `.kit-card` over
the window's scene. The head names the project and a status tag; the title
names the cause from `RECOVERY_COPY`, with one hint line and numbered steps
only for real chores. One ladder follows, one line per rung:

1. The state's own fix: **Fix it** (the repair, steps shown live), **Open
   System Settings** (macOS blocked; the screen watches and continues), **Try
   again** (a chore for the person), or "Waiting for ADE…" while the service
   starts.
2. **Restart ADE**: quits and reopens through `updateRelaunchApp`, after the
   usual quit warnings.
3. **Reset ADE…**: the hard reset below.
4. **Report this error to ADE…**: the report dialog.

The filled button is the first rung until a fix fails, then Restart ADE, then
Reset ADE after a fix fails again after a recent restart (a `localStorage`
stamp, cleared on success). Without a relaunch bridge, two failed fixes lead
to Reset. A failed fix's title names its step. Raw text (the installer's
`failureStep` and `serviceInstallMessage`, a thrown repair error) stays in the
details fold.

**The brain-down notice** (`BrainDownNotice.tsx`) is the app banner for a
service that is down around an update.

- While an update owns the service and an open was refused with
  `LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE`, it is a quiet "Finishing the
  update" that reopens the project when the service answers or the update
  settles.
- When the update half-landed, it is an error banner in the `app` band: the
  cause, then **Fix it** → **Restart ADE** → **Reset ADE…**, and the report
  control. Fix it is `app.restartBackgroundService` → `restartBrain()`; it
  resolves only when the new service answers, and a rejection moves the
  ladder on. `account.repairSession` stays on the account and sync surfaces.
- With "Allow in the Background" off it offers Open System Settings, reads the
  service every 3 s, and runs Fix it once the switch is on.
- It clears when the pool connects to the primary service again.

One problem, one notice: `ProjectTransitionErrorAlert` stands down for an open
refused mid-update and while the brain-down notice shows
(`useBrainDownNoticeShowing`). The brain-down notice stands down while the
recovery screen shows and while the desktop's fallback brain serves
(`AppFallbackBanner` offers the same Fix it). Windows never shows the blocked
cause, so its copy is the neutral "didn't start".

### "ADE could not start" after an update

When an update leaves ADE unable to start, a small window says what failed and
offers Try again, Go back to the previous version, Open logs folder and Copy
details. It opens once per launch, for a project database that does not open
or a brain that keeps crashing before any project opened (after an update
only), or for a main window whose renderer gave up. Go back asks first, then
installs the previous version and puts back this computer's database, the
personal chats' database and the failed project database as they were before
the update. The current databases are kept as moved copies; the restore is all
or nothing. Triggers, version choice and steps are in
[docs/plans/beta-track.md](../../plans/beta-track.md#startup-recovery). The
project recovery screen handles every other failure.

### Login Items ("Allow in the Background")

macOS keeps ADE's launch agent loaded but does not start it when **System
Settings → General → Login Items → Allow in the Background** is off for ADE.
No repair changes that. `readLaunchdBackgroundItemStatus` reads the switch
(`backgroundItemStatusCommand` calls `SMAppService.statusForLegacyURL` through
`osascript`: `0` notRegistered, `1` enabled, `2` requiresApproval, `3`
notFound, else `unknown`; cached a few seconds). The installer records
`failureStep: "background_item_blocked"` when launchd names no replacement pid
and the switch reads `requires_approval`.

`isBackgroundItemBlocked` (`shared/types/core.ts`) is the one predicate: a
live `requires_approval` blocks, a live `enabled` clears a stale
`background_item_blocked`, and `unknown` uses the recorded failure. When
blocked, the recovery screen offers **Open System Settings**, watches, and
reopens the project once the switch is on.

### Hard reset (`ade reset --all`)

`ade reset --all` removes everything ADE put on this computer, so the next
launch is a first install. `machineResetInventory.ts` builds the read-only
plan and `machineReset.ts` runs it; the plan the person confirms is the list
that is removed.

- Lane work is rescued first: `commit` commits uncommitted files on the
  lane's branch, `move` relocates the worktree (`git worktree move`), and a
  rescue that cannot run parks the lane under `~/ADE Rescued Lanes`.
- A project's own files are never removed: only its `.ade/`, the lane
  worktrees git lists under it, redundant lane branches, and ADE's line in
  `.git/info/exclude`. Files the project committed under `.ade/` are restored
  from git.
- `assertRemovable` rejects a path that is not absolute, contains the home
  folder, or is outside the home, temp, or a project's `.ade`.
- The CLI writes a receipt (`MachineResetReceipt`) the relaunched app reads.
  `ResetAdeDialog` takes the rescue choice after the person types `RESET`.
  `--dry-run` prints the plan and changes nothing.

### Brain resilience: watchdog, freshness, memory, and recovery notice

**The event-loop watchdog** (`brainLoopWatchdog.ts`) is an unref'd worker
thread. The main thread sends it a heartbeat every second with the running
command (`trackBrainLoopWatchdogCommand`; remote sync commands and local
`ade/actions/call` requests register, and a start or end is sent at once).

- A heartbeat stall past `ADE_LOOP_WATCHDOG_MS` (30 s) that is not a sleep
  (wall-clock against monotonic time) writes `event-loop-wedge.json` (command,
  blocked ms, threshold, loop, memory and resource snapshot), asks for a Node
  report, and `SIGKILL`s the brain after a one-second grace so launchd
  restarts it.
- **Only the brain's own freeze is killed.** A restart ends every terminal and
  agent session under the brain and cannot fix a machine freeze. Before the
  kill, `brainLoopFreezeCause` reads page faults and CPU since the last
  heartbeat (per 30 s) and the open synchronous file call: `memory` (50+ major
  faults, or 50,000+ minor faults while the process used at most half the
  CPU), `drive` (one file call open 10 s or more), or `self`. Windows never
  waits on memory (libuv counts every fault as major). It judges again each
  tick.
- For `memory` and `drive` it logs `brain.loop_watchdog_waiting_on_machine`
  once and waits up to `BRAIN_LOOP_MACHINE_WAIT_CEILING_MS` (5 min), then
  kills. Every 15 s it rewrites the breadcrumb (with `freezeCause`) and
  refreshes the machine heartbeat (`machineWait`), so the outside watchdog
  (`brainWatchdogCheck.ts`, which kills at 90 s) does not end the wait. When
  the freeze ends it logs `brain.loop_watchdog_machine_wait_ended` and removes
  its own breadcrumb. A brain starting on the same home leaves a breadcrumb
  alone while its writer `pid` is alive and the file is under 2 minutes old.
- On macOS the worker runs `/usr/bin/sample` (2 s, detached) and waits for
  "Sampling completed" (20 s at most) before the kill;
  `event-loop-wedge-sample.txt` names the blocking call.
- A recovered delay of 2 s or more is info `brain.suspend_gap` when it used
  little CPU (at most 2 s, or a tenth of the delay), faulted at most 10 major
  pages (not checked on Windows or for gaps of 60 s or more), and the worker
  was late for nearly all of it (a sleep, App Nap or a stopped process).
  Other delays are warn `brain.event_loop_near_miss`. Both carry `pid`,
  `socketPath`, `workerPauseCoverage`, `workerPausedMs`, `cpuDeltaMs` and
  `majorPageFaultsDelta`. A near miss also carries `blockedFsMethod`,
  `blockedFsPath`, `blockedFsCaller` and `blockedFsMs` when the worker saw the
  main thread inside a sync file call during the freeze; the line is written
  one loop turn after the freeze (`setImmediate`), so the worker's report
  arrives first. A near miss also starts the stall profile
  (`brainStallProfiler.ts`; see "What becomes an issue" in `docs/logging.md`).
  A `ping` answered just after a freeze carries `hostFrozenMs`
  (`brainPingReply`), and the desktop drops that round trip as a link sample. Warn `brain.slow_sync_spawn` names a synchronous
  child process of 1 s or more (see `docs/ARCHITECTURE.md`).
- On the next boot the breadcrumb, report and sample become
  `last-wedge.json` / `last-wedge-report.json` / `last-wedge-sample.txt`, with
  `brain.recovered_from_wedge` and a deduped `ade_brain_recovered` event.
  `runtimeInfo.lastWedge` (`parseRuntimeLastWedge`,
  `LocalRuntimeStatus.lastWedge`) feeds `BrainRecoveryNotice`, once per `ts`;
  `ade doctor` shows it as Wedge history.

#### A project whose folder is too slow to open

A project on a slow drive (a network mount) can freeze the loop while it
opens; the guard kills the brain, a client asks for the project again, and the
loop repeats with every project down. The database stays where it is; this
breaks the loop:

- **Which project.** The scope registry reports opens and their step
  (`trackBrainLoopWatchdogProjectOpen`) from before the first folder read, so
  the breadcrumb names them (`openingProjects`).
- **Strikes.** The next start strikes each open that ran at the kill in
  `$ADE_HOME/runtime/project-open-strikes.json` (`projectOpenStrikes.ts`;
  atomic writes; a torn file is no strikes; a future stamp is ignored), except
  a `queued` open and one started over 10 minutes before the kill. A struck
  project opens alone: other cold opens wait for it, and it waits for running
  ones, each up to the guard's threshold plus 15 s.
- **Refusal.** Two strikes in 15 minutes and `ProjectScopeRegistry.get`
  refuses the project with `project_folder_too_slow` (the message names the
  wait). It lasts 15 minutes, doubling on each repeat up to 24 hours. Every
  caller hits it, and folder readers skip the project (sync host choice, phone
  roster, catalog lane count and icon, chat owner lookup, search). The
  desktop asks `projects.checkOpen` before it opens a project database itself,
  and on a switch to an open project (connected brain only, 1.5 s; a failed
  check lets the switch go). A refused open project shows one banner when its
  lane read is refused; Try again clears the refusal (message only for another
  machine's project).
- **Way back.** A successful open resets everything, as do
  `ade projects retry <id|path>` (`projects.retryOpen`, `--machine`) and the
  banner's Try again.
- Phones, the web app and a desktop showing another machine's project have no
  retry: they show the brain's message, and the refusal lifts on time. Their
  roster lists the project with no lanes or chats.

#### A folder waiting on a permission prompt

macOS gates external drives and Desktop, Documents and Downloads per program;
a program without the grant waits in `open()` until someone answers on that
Mac. A hung network drive does the same everywhere. Three parts keep the brain
running:

- **The sync-fs tracker** (`syncFsCallTracker.ts`) wraps the path-taking sync
  `fs` calls at brain start. Each call writes its path and method to memory
  the worker reads (about 50 ns); on a path that can stall
  (`isStallCapablePath`: `/Volumes`, the gated folders, UNC and non-system
  drives, `/mnt`, `/media`) it also records callers under a per-second
  budget. After 5 s blocked the worker writes `brain.sync_fs_call_blocked`
  (method, path, caller); a breadcrumb carries `blockedFsCall`. A call of 1 s
  or more logs `brain.sync_fs_call_slow`.
- **The project-root monitor** (`projectRootAccessMonitor.ts`) lists one
  project folder per such drive every 5 s with an async call (a pool thread,
  never the loop). A listing over 3 s marks the drive's project folders as not
  answering (`main/services/state/unansweringRoots.ts`). Sync `fs` calls under
  a marked folder then fail with `storage_read_failed` (`existsSync` answers
  "exists", so cleanup never acts on a waiting folder), as do the native
  SQLite openers. The brain contains that error from an unguarded timer. A
  refused listing is `denied` and engages nothing. A finished listing clears
  it all.
- **After a wedge** in such a call, the restarted brain reads `blockedFsCall`,
  marks the drive's folders first, and probes the file, then the folder.
  `assertProjectRootReadable` timing out marks the folder too.

Every connected device is told where to look (see
[Remote runtime](../remote-runtime/README.md), "A frozen host says so"). Logs:
`project_root.not_answering`, `project_root.permission_wait_started`,
`project_root.permission_wait_ended`, `project_root.access_denied`,
`project_root.recovered`.

**The freshness monitor** (`brainFreshnessMonitor.ts`) stats the CLI
entrypoint every 5 min, hashes only on a stat change
(`computeRuntimeBuildHashAsync`), and when the hash differs from the baked one
waits (bounded) for the brain to be idle, then asks for the brain-update
restart. A failed restart keeps the old stat baseline, so the next probe
checks again.

#### The planned memory restart

A long-lived brain leaks native memory. `brainMemoryRestart.ts` restarts it
while nothing is happening, before the OS decides.

- The watchdog samples RSS every 5 minutes (`BRAIN_MEMORY_SAMPLE_INTERVAL_MS`,
  `brain.memory_sample`). `trackBrainMemoryPressure` fires after
  `BRAIN_RSS_PRESSURE_SAMPLES` (3) samples over
  `DEFAULT_BRAIN_RSS_RESTART_BYTES` (1.5 GiB), then every
  `BRAIN_RSS_PRESSURE_REPEAT_SAMPLES` (12). One sample below resets the run.
- **A working brain never restarts.** The guard needs no running command, no
  active turns or work sessions (`readMachineRuntimeActivitySummary`) and no
  headless client. It checks every 30 s for up to 30 minutes, then logs
  `brain.memory_restart_deferred` and waits for the next trigger. An attached
  desktop is logged (`attached: true`), not a veto.
- The restart goes through the service manager, never `process.exit` (a
  hand-started brain has no supervisor). It happens once per process; a failed
  restart (`brain.memory_restart_failed`) re-arms. The log line says it is a
  leak mitigation, not a crash.
- `ADE_BRAIN_RSS_RESTART_BYTES` takes bytes or a `b`/`kb`/`mb`/`gb` suffix;
  `off`, `false` or 0 disables it. An unparsable value uses the default, and
  any value is floored at 256 MB.

#### Unwinding a runtime that never finished starting

`createAdeRuntime` acquires timers, sockets, watchers, subscriptions and the
database. `startupTeardown.ts` is a LIFO stack: each acquisition registers its
release, and a failure drains the stack in reverse before it rethrows. A
release that throws logs `runtime.teardown_step_failed` and neither stops the
drain nor replaces the startup error. The drain is synchronous and closes the
database last; a release's promise is not awaited, but its rejection is
reported the same way. Services whose async work can outlive the drain (the
sync status snapshot, the PR poller and watch) check their disposed flag after
each await. `runtime.dispose` is the same `drain()`.

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

Rising pressure kills no session; the gates apply at the next start.
`agentChatService` gates a turn (`chat_turn`), `ptyService.create` a tracked
CLI (`cli_launch`), and the compressor its sweeps (`compression`). A refusal
throws `disk_full` with the copy in `DISK_PRESSURE_REFUSAL_MESSAGES`. Both
`apps/desktop/src/main/main.ts` and `apps/ade-cli/src/bootstrap.ts` build the
monitor and `storageInsightsService`. Reads fall back to a `.gz` generation
(`readHistoryFileSync`), and `ptyService.create` reinflates a transcript
before append.

### Developer tools outside the project

Storage & cleanup › Space ends with **Outside this project**
(`settings/devices/OutsideProjectStorage.tsx`): one bar and one row each for
Xcode build data, iOS simulators and simulator runtimes (on a Mac) and Android
emulators, on the machine the page's project copy is on. Each row's Clean up
opens Apple devices or Android devices on that machine, where the lists and
their deletes live (`useDevToolsStorage`). Opening Space reads the lists only (cheap);
sizes walk tens of GB, so they are measured when the person presses Measure
sizes, with the same calls the Apple and Android panes use
(`iosSimulator.deviceList` with `disk`, `runtimeList`, `derivedDataList` with
`measure`, `androidEmulator.listDevices` with `measureSizes`), never on a timer.
A part that could not be read says so, with Try again. Nothing here deletes in the background: each delete is the
person's, confirmed with its size, and the brain refuses an unconfirmed one
or one an agent asks for.

### Storage categories and cleanup safety

| Category | Contents | Default safety |
|---|---|---|
| Chats and history | Chat/terminal JSONL, logs, terminal snapshots | `compressible` |
| Lanes and worktrees | Active, archived, reclaimed, and orphaned managed worktrees | Active `protected`, including a plain folder that holds a worktree further down; archived lanes use Archive & Reclaim; orphans `review_first` |
| Build and release | ADE temp staging, build output, and iOS DerivedData | `review_first` |
| Caches | Rebuildable cache and update staging | `safe_to_remove`; chat session records `protected` |
| Proof and attachments | Artifacts, recordings, attachments | `review_first` |
| Recovery backups | Database migration/recovery backups | `review_first`, or `safe_to_remove` only when old, healthy, and unrelated to a fresh database-open failure |
| Database | Database, WAL, and shared-memory files | `protected` |

Safety values are contracts: `safe_to_remove` can be rebuilt, `compressible`
is kept losslessly, `review_first` needs the user's confirmation, and
`protected` is never a target. Cleanup is preview-confirmed and checks path,
inode and metadata, size, lane ownership, age and safety again before it
deletes. The scanner and the validator use `lstat` and reject links and link
ancestors. Archived lane worktrees never enter the generic pipeline: they use
Archive & Reclaim, which also requires the saved path and branch to be this
project's registered worktree, checks links and identity again just before
removal, and holds the worktree lease PR workflows use.

Node compile caches prune themselves, outside the ledger. The desktop prunes
its root (`~/Library/Caches/ADE/compile-cache`, `%LOCALAPPDATA%\ADE\compile-cache`
or the XDG cache path) after the first window opens; the brain prunes
`<ADE home>/cache/node-compile` after it listens.

- A sibling build folder goes only when it is named like a Node build tag
  (`v<semver>-…`), nothing in it was written for 14 days, and it is not one of
  the two most recently written other builds. The active build's folder is
  never touched; links are never followed.
- An explicit `NODE_COMPILE_CACHE` or `ADE_COMPILE_CACHE_DIR` is not pruned.
- A folder Windows keeps locked is retried on the next launch. A process whose
  cache is removed compiles without one, silently. The `ade` CLI does not
  prune.

### Lane lifecycle rules

A lane is active, archived (hidden, nothing deleted, one click to restore) or
deleted. Project → Storage & cleanup → Rules sets the cleanup, every duration
in days (`laneCleanup` in `local.yaml`, read by `resolveLaneCleanupPolicy` in
`shared/laneCleanup.ts`):

- **Archive lanes automatically** (anchor `lane-storage-rules`):
  `archiveIdleAfterDays`, "Archive idle lanes after" (absent or 0 = off).
- **Archived lanes** (anchor `archived-lanes`), counted from `archived_at`:
  - `freeUpSpaceAfterDays` (absent = 14, 0 = off) with `freeUpSpaceMode`,
    "Free up space after N days" [Ask me / Automatically]. Free up space is
    Archive & Reclaim: the folder goes, the branch and chats stay, Restore
    rebuilds the folder. **Ask me** (default) removes nothing: the archive
    reminder and Settings → Archive ("due to free up space") point at the
    lane. **Automatically** removes it in the hourly check.
  - `deleteArchivedAfterDays` (absent or 0 = off), "Delete after", with
    `deleteLocalBranchOnAutoDelete` (off). The remote branch is never deleted.
- **Clean build output from idle lanes** (`cleanBuildOutputAfterDays`; see
  "Build output in idle lanes").

Settings → Archive and the weekly reminder split at `freeUpSpaceAfterDays`
(`archiveStaleDays`, 14 when off); project health calls an active lane stale
after `archiveIdleAfterDays` (`staleLaneDays`, 14 when off).

**Older keys.** `coerceLaneCleanupConfig` reads the old hour keys when the day
keys are absent and returns day keys only, so the next save writes only these:
`autoArchiveAfterHours` → `archiveIdleAfterDays` rounded up (0 when
`cleanupIntervalHours` was 0, left out with no interval);
`reclaimArchivedAfterHours` (or `autoDeleteArchivedAfterHours`) above 0 →
`freeUpSpaceAfterDays` with "Ask me"; `maxActiveLanes` and
`deleteRemoteBranchOnCleanup` drop. New names keep an older ADE from reading
days as hours (it drops unknown keys and its rules read as off).

The backend enforces the rules. The daemon ticks each minute (first a minute
after boot, once chats load) and scans about hourly while a rule needs it
(`laneCleanupChecksOn`: archive idle, delete after, or free up Automatically).
The scan records its start (`local_storage_lifecycle_runs.last_attempt_at`)
first, so a scan that throws waits an hour, and checks each lane on its own.

**Archive.** A scan archives only a clean, finished, managed worktree lane
with nothing running: no open chat, PTY or watcher, no chat or terminal the
database marks running, no lease held by another operation, not
edit-protected. Until the chat and terminal services are added, nothing is
archived.

- "Finished" (`getAutoArchiveFacts`, local git only): no commit missing from a
  remote, and either ADE's PR record says merged (a squash merge never makes
  the branch an ancestor) or the branch has its own commits (its reflog moved)
  and is an ancestor of its base. A new lane with no commits and no PR is not
  finished.
- Activity is the newest chat, terminal or operation row, or the branch's
  newest commit (outside commits count). Git runs only for lanes a rule would
  archive. Blocked lanes stay active.
- The notice says why ("Archived automatically: idle 3 days", "PR merged, idle
  3 days") and offers Undo on the machine it came from.

**Delete and free up.** An archived lane that is due gets the same checks, and
`getAutoArchiveFacts` must show no uncommitted file and no commit only this
machine has (a folder that is not a checkout is kept).

- The delete waits for an open PR; with one open and the free up due, the
  folder is freed instead. It is `laneService.delete`
  (`deleteRemoteBranch: false`, not forced), then the port lease and route are
  released, and the chats go to Recently deleted
  (`recordChatsDeletedWithLane`).
- The free up is `archiveAndReclaim` without the dirty override. A folder in
  use is kept and finished by the retry below; a `failed` removal waits for a
  person in Settings → Archive.
- The primary lane is never deleted or freed.

Each scan's result is kept per lane (`last_run_json`: archived, freed,
deleted, kept and why, or failed) and shown as "Last run" under Rules. Failures
show there, never as repeated toasts. "Due to free up" is never stored:
`local_lane_storage_state.reclaim_state` is `kept` (files in use),
`reclaimed` or `failed`; an older `ready_for_review` reads as `kept`.

### Archive & Reclaim removal

- Lane folders are compared with `shared/sameFolder` (resolved, case-blind on
  Windows, real paths when spellings differ), so a OneDrive junction, a
  drive-letter case or `/private/tmp` matches.
- On Windows ADE never runs `git worktree remove`. It makes git's refusals
  itself (a locked worktree, submodules without the dirty confirmation),
  renames the folder to a `.ade-deleting-` name (this works only once the
  lane's chats, terminals and CLIs exited and nothing holds a file; it retries
  for 20 s), runs `git worktree prune` (or puts the folder back if git keeps
  it), then deletes with Node's `rm`, which removes junctions without
  following them. Git runs with `-c core.longpaths=true`.
- A folder still held after the wait is kept (`reclaim_state = 'kept'`,
  `pending_removal_at`), and the storage doctor finishes it every 10 minutes,
  up to 12 tries.
- A folder an interrupted removal left (inside `.ade/worktrees`, this lane's,
  no worktree listed, git metadata gone) is reported as `finishRemoval`, and
  reclaim finishes it instead of refusing.

### Build output in idle lanes

`laneCleanup.cleanBuildOutputAfterDays` (Rules → "Clean build output from
idle lanes"; absent = 7, 0 = off) removes rebuildable build output from lane
folders unused for that long. The lane, branch, files and chats stay. It is a
storage-doctor step (`fs.lane_build_output`): 10 minutes after the brain
starts, then daily, whether or not the archive rules are on, at most once per
20 hours across restarts (`local_storage_lifecycle_runs.build_output_checked_at`).
A manual "Clean up safely" runs it now.

Folders (`BUILD_OUTPUT_FOLDER_RULES`): `node_modules`, `dist`, `build`,
`.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.angular`,
`.dart_tool`, `.gradle`, `DerivedData`, `target` beside a `Cargo.toml` or
`pom.xml`, and any folder with a valid `CACHEDIR.TAG`. Not `out`, `.cache`,
`vendor`, `Pods` or virtualenvs. At most 4 segments deep, never under `.git`
or `.ade`; an outer build folder covers inner ones.

A folder goes only when all of these hold, at scan and again before removal,
under the lane's worktree lease:

- The lane is a `worktree` lane, not edit-protected, a direct child of
  `.ade/worktrees` with no link on its path and a `.git` pointer file, and the
  folder `git rev-parse --show-toplevel` names (same device and inode). Never
  the primary checkout or an attached folder.
- Nothing runs in it: no open chat, live terminal or watcher
  (`laneService.getLiveWorkCounts`, read before each folder), no lease held by
  another operation, and no process working inside it (`lsof -d cwd` on
  macOS, `/proc/*/cwd` on Linux). On Windows the folder is first renamed aside
  in `.ade/worktrees` and deleted in the background; the rename fails while a
  program holds a file. A failed folder is recorded with its inode and mtime
  (`fingerprint`) and skipped until it changes.
- It is idle: no chat, terminal or operation row, archive, `HEAD` or reflog
  write, or uncommitted change (first 200 paths of `git status`) in the
  window; the folder and its direct entries have mtime and ctime older than
  the window.
- Git ignores it and tracks nothing in it; it is a real folder on the lane's
  device, with the scanned inode. A link is skipped, never followed or
  unlinked.
- No disk is mounted inside it (`/sbin/mount`, `/proc/self/mountinfo`).
  Windows volume mounts are reparse points, which Node removes as links.

Right before each removal the sweep reads working folders and mounts again
(a failed read skips the lane), checks links and the inode, then the lane's
live work with nothing awaited before the removal. With the chat or terminal
service missing, the lane is kept.

Removal is unpatched `fs.rm` (no link following, no `maxRetries`), up to
three passes a second apart that make read-only entries writable. A folder that
cannot go keeps a plain reason. A run starts nothing new after 15 minutes.

Each folder is recorded in local-only `local_lane_build_output_cleanups`
(folder, bytes, error, time; 90 days or 1,000 rows). `lifecycle.buildOutput`
feeds the Rules card, and the lane row says "Build output removed 3d ago" while
the folders are missing (up to 30 days). The lane overview banner
(`LaneBuildOutputNotice.tsx`, storage action `laneBuildOutputRemoved`, read on
the lane's machine through its pin) names the size and the folders. It reads
only the latest run and still-missing folders, so a reinstall clears it; it
reads again on focus, on visibility and each minute while shown. Dismiss hides
it for the app session.

Proof and attachment cleanup accepts only `.ade/artifacts` or
`.ade/attachments` (or below) after the same link and path checks. Removing
artifact bytes then calls
`computerUseArtifactBrokerService.purgeArtifactRecordsUnder()` to delete the
matching proof rows and links. It is an explicit `review_first` action.

### Chat transcripts: one copy

ADE writes each chat event once, to `transcripts/chat/<id>.jsonl`. Older builds
also wrote `transcripts/<id>.chat.jsonl` (8 MB cap). The session row still
names the legacy path, because `terminal_sessions.transcript_path` syncs to
peers and older builds. Readers that start from the row
(`sessionService.readTranscriptTail`, `ctoStateService`, `archiveService`)
resolve through `resolveChatTranscriptReadPath`.

The doctor removes a legacy copy only when every complete event line in it is
in the dedicated file at least as often (order is not compared; only the cap
notice and the one cut event may be missing), and the copy is idle for 10
minutes, not active, and unchanged during the check. Anything unproven is
kept (`storage.legacy_chat_transcript_kept`).

### History compression

A candidate is an inactive regular `.jsonl`/`.log` file older than 14 days,
not compressed or partial, at most 256 MiB. Finished chats qualify sooner and
go first: an archived chat after 1 hour idle, a chat settled 3 days after 1
hour idle, a transcript whose session row is gone after 1 day. The doctor
takes up to 200 files a run, the button 25, only when disk pressure allows.
Compression streams through SHA-256 and gzip, syncs the partial, gunzips it
through a second hash and count, and checks the source size and mtime did not
change. Only a byte-identical result is renamed to `.gz` and replaces the
original. An append first reinflates the gzip atomically.

### Storage doctor maintenance sweep

`storageInsightsService` runs one **storage doctor** sweep that bounds ADE's
footprint without touching user data. It is single-flighted (a second call
joins the run) and has three triggers: `post_boot` (10 minutes after the real
daemon starts), `daily` (every 24 h after), and `manual`
(`runMaintenanceNow()`: the `storage.runMaintenanceNow` action and "Clean up
safely"). Only the real daemon instance (built with `isPathActive` and
`diskPressure`) arms the timers; the desktop in-process fallback runs only on a
direct `runMaintenanceNow`.

Each step is caught on its own, so one failure does not stop the run. Except
for build output in idle lanes, files stay preview-confirmed, and archived
worktrees use the typed-confirmation path.

1. Run the lane lifecycle safety scan.
2. Remove legacy chat transcript copies proven redundant (`fs.transcript_duplicates`).
3. Compress inactive chat and terminal history (`fs.transcripts`).
4. Remove build output from idle lanes (`fs.lane_build_output`).
5. Record filesystem review candidates without deleting them.
6. Run the kvDb hooks: prune `automation_ingress_events`,
   `pull_request_snapshots` and the retained event logs; compact cr-sqlite
   sync bookkeeping; vacuum a fragmented freelist.
7. Compact the search index (`cache.search_index`) through the search
   service, which holds the file. An index with over 25% free pages and at
   least 16 MB free is rebuilt once with `VACUUM` (which turns on incremental
   auto-vacuum); later runs free pages in bounded chunks. New indexes start
   incremental. The one-time `VACUUM` blocks the brain for that moment.

The step 6 hooks run one by one, each through method-level optional chaining
(`maintenance?.pruneEventLogs?.bind(…)`), so an older database handle skips a
missing step. The run goes to the maintenance journal and
`storage.maintenance_completed` (`completed` / `partial` / `failed`), plus one
`ade_feature_used` (`feature: storage_doctor`) at most every 20 h.

**Provider history.** Settings › Storage › Details › *Provider history on this
machine* shows each agent CLI's own session folders and who manages them
(Claude prunes after 30 days by default; Codex never does). ADE touches only
*Copies of chats from deleted lanes* (`deleted_lane_provider_sessions`): the
Claude and Codex files ADE started for chats from deleted lanes, never one
imported from the person's CLI or named by a live chat. The "Chats from
deleted lanes" removal includes them, because the chats' records hold the only
copy of their session ids. The measurement runs with the project scan (cached
10 minutes, at most 2 s).

**Reminder.** At 25 or more chats from deleted lanes, or 100 MB, a docked
banner says so; *Review in Storage* opens the page, and every answer snoozes it
two weeks per project.

**Chats from deleted lanes.** Older builds deleted a lane's chat rows and left
the transcripts. Settings › Storage › Details lists them as one review-first
row with count and size. Remove… previews, confirms, then deletes exactly the
previewed files one by one (the transcript, the legacy copy, the
`cache/chat-sessions` records, the Claude/Codex copies), never the folder. A
file that cannot go (Windows locks) is reported and the rest still go. A chat
is listed only when its row is gone, the lane in its `session_init` header no
longer exists, and all its files have been idle 7 days. An empty lane table
lists nothing.

**Recently deleted chats.** Deleting one chat (not a lane) first writes a
`deleted_chats` row naming the agent's own copy of the conversation.

- Settings › Storage & cleanup › Recently deleted lists rows whose copy is
  still on this machine, with a preview, Reopen and Remove from list;
  `ade chat deleted list` and `ade chat deleted reopen <id>` use the same
  service.
- Reopen continues the conversation in its lane, or copies it into a lane the
  person picks when that lane is gone, and refuses one a live or archived chat
  holds. A row is never deleted, only hidden, so the Claude backfill cannot
  bring it back. The table is machine-local and excluded from CRR. Neither
  action deletes the agent's files.
- A deleted agent CLI gets a row too (`kind = 'cli'`, the terminal row in
  `cli_json`). Reopen relaunches it, resumed when the agent still has the
  conversation, else fresh with the reason. A CLI deleted with its lane is not
  recorded. A CLI moved to another machine leaves its files here.
- See [Recently deleted chats](../chat/README.md#recently-deleted-chats) and
  [Agent CLI sessions](../chat/README.md#agent-cli-sessions).

**Recently deleted lanes.** The same tab lists deleted lanes whose unsaved
work the delete kept as git refs under `refs/ade/deleted-lanes/`, for 30 days.
Restore brings one back as a new lane; Drop (the person only) deletes the ref.
Free up space with discard saves the same way ("Space freed"), and Put back
returns the files. The phone lists them under Lanes › Archived
([Saved work](../lanes/worktree-isolation.md)).

### Storage ledger and policy

`STORAGE_LEDGER` (`storageLedger.ts`) declares, for every persistent table and
folder, its privacy class (`user_data`, never auto-deleted; `derived`, can be
fetched again; `operational`) and its bound (`write_time`, `doctor`, `both`
or `manual`). Settings policy chips read it (`deriveCategoryPolicyChips`), and
the DB retention numbers come from the `dbMaintenanceApi` constants.
`LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS` folder to a
ledger id or `null` (git-tracked scaffold, agent scratch, credentials); a test
in `storageInsightsService.test.ts` fails CI for a folder with no entry.

### Database maintenance hooks

`kvDb.ts` attaches a `maintenance` (`DbMaintenanceApi`) handle to the open
database. Each hook first checks that its table exists, and any failure logs
`db.maintenance_failed` and returns an `unsupported` skip.

- `pruneIngressEvents` — age (7 d) and per-project count (2,000) prune of
  `automation_ingress_events`.
- `prunePrSnapshots` — deletes `pull_request_snapshots` not updated in 60
  days (machine-local data behind Stats, and the largest source of cr-sqlite
  metadata in a measured project database).
- `pruneEventLogs` (async) — deletes rows older than 30 days from the four
  retained event logs (below).
- `compactCrsqlTombstones` — rebuilds the `operations` CRR table to drop
  clock and pks shadow rows, then vacuums. **Only with zero sync peers**
  (`options.hasSyncPeers`, which assumes peers by default); otherwise it
  returns `has_peers` and changes nothing. Tombstones are a small part of CRR
  metadata; the growth is live clock rows behind unbounded logs, which the
  prunes target. Keep the guard.
- `vacuumIfFragmented(threshold)` — over the freelist threshold, one full
  `VACUUM` rebuilds the file and turns on `auto_vacuum = INCREMENTAL`; later
  sweeps reclaim in bounded `incremental_vacuum` chunks (at most 25 × 2,000
  pages). Each call ends with `wal_checkpoint(TRUNCATE)` and reports bytes
  freed (`.db` + `-wal` + `-shm`).

The database opens in WAL mode with `synchronous = NORMAL` (`openRawDatabase`).

#### Why `ai_usage_log` is not local-only

`ai_usage_log` has the most CRR metadata in a measured project database, and
it looks like `usage_events`, which is in `LOCAL_ONLY_CRR_EXCLUDED_TABLES`. It
stays a CRR, with no retention, on purpose:

- `ai.budgets.<feature>.dailyLimit` counts today's rows. Because the table
  replicates, the cap is account-wide; local-only would make it per machine.
- `ActivityModule` defaults to **All** and shows lifetime tokens from these
  rows, so a prune would make a lifetime figure a trailing window.
- A synced aggregate could replace it, but it must be keyed
  `(day, feature, site)` and summed on read (cr-sqlite is last-writer-wins per
  column), it needs two releases (the aggregate while `ai_usage_log` still
  syncs, then local-only), and a new CRR table must exist in every peer's
  schema (see [CRDT model](../sync-and-multi-device/crdt-model.md)).
- The phone never receives the table (`MOBILE_CHANGESET_EXCLUDED_TABLES`).

#### Paced deletes

`node:sqlite`'s `DatabaseSync` is synchronous: a `DELETE` blocks the UI, IPC
and the sync pump until it ends. `pruneRowsInBatches` is the shape for new
prunes: 2,000 rows per batch (`delete … where rowid in (select rowid … limit
N)`), `setImmediate` between batches, an early stop on a short batch, and at
most 200 batches. It returns a promise, so its hooks are `async` and
`runDbStep` awaits them.

The prunes compare timestamps with `column like '____-__-__%' and column < ?`.
These are text columns: an epoch stored as digits, or the `default ''` CRR
repair adds, sorts before every ISO cutoff and would be born expired.

#### Event-log retention, and the tables deliberately exempt

`RETAINED_EVENT_LOG_TABLES` in `kvDb.ts` pairs each retained table with the
column it is pruned on:

| Table | Column | Why this column |
|---|---|---|
| `linear_sync_events` | `created_at` | Insert time. |
| `linear_workflow_run_events` | `created_at` | Insert time. |
| `worker_agent_cost_events` | `created_at` | **Not `occurred_at`**, which is event time and can be backdated, so a row would expire as it is written. |
| `pack_events` | `created_at` | Insert time. |

Tables that look like event logs but are **not pruned** (also listed in the
`RETAINED_EVENT_LOG_TABLES` doc comment):

- **`linear_ingress_events`** is the webhook replay guard.
  `linearIngressService.persistRecord` refuses a `delivery_id` it has stored,
  and the cursor resets on `cursorExpired`. A prune lets a backlog drain run
  automations again (agent work, Linear comments).
- **`cursor_cloud_ingress_events`** is the same guard for Cursor Cloud
  `statusChange` deliveries.
- **`cto_session_logs`** is dormant: nothing reads or writes it since the v2
  migration moved `.ade/cto/sessions.jsonl` into `.ade/cto/legacy-v1/`. It is
  a CRR table, so a prune would only write tombstones.
- **`worker_agent_runs`** is a lifecycle table. A `created_at` prune would
  delete pending runs and orphan `worker_agent_cost_events.run_id` and
  `automation_runs.worker_run_id`. It needs a terminal-status and
  `finished_at` policy.

### Maintenance journal, diagnostics, and runtime health

Each doctor run appends a `MaintenanceRunReport` (trigger, per-action
results, bytes freed, DB size after) to `.ade/cache/storage-doctor-journal.json`
(last 30 runs, atomic writes, no DB or CRR; a bad file reads as empty).

The Space snapshot's optional `extras` comes from the journal and a `dbstat`
scan (optional; no breakdown without it): the database breakdown (webhooks,
sync bookkeeping, PR cache, core), recent runs, the policy chips and a safe
reclaimable estimate. The "Health & diagnostics" strip shows the DB-size
trend, the service's memory, the last cleanup, and **slow responses (24 h)**
from `LocalRuntimeConnectionPool.getRuntimeHealth()`
(`ade.app.getRuntimeHealth`): a bounded window of daemon calls over 500 ms or
failed, the calls that log `local_runtime.action_slow`. The top-bar load pill
links to `#/settings?tab=storage#diagnostics`.

### Backup and retention bounds

| State | Bound | Retention rule |
|---|---:|---|
| Durable JSON metadata | Primary + 1 `.lkg` | The previous valid generation is replaced on the next write. |
| Thread-pointer ledger | 64 KiB | Compacts to the newest valid record per session; a malformed tail is ignored. |
| Last-failure reports | Current + 1 previous | Repeated same-signature failures increment the current report; a changed signature rotates current to previous. |
| Database migration backup | 1 | `<db>.pre-crsqlite-w1.bak` is created once and only with sufficient headroom. |
| Update copies | 1 per database | `<db>.pre-<to>-from-<from>.bak`, taken before a new version first opens the database. A new copy deletes the older ones; the copy itself goes at a clean open 24 hours after that version first opened the file cleanly. What "Go back" set aside (`…_kept.bak`, with its `-wal`/`-shm`/`-journal`) goes 7 days after. Only names that parse as copies are deleted; a locked file is retried on a later open. Settings › Advanced › Database copies deletes one by hand. |
| Automation ingress events | 7 days / 2,000 rows per project | Age-pruned at write time and by the doctor; the newest 2,000 non-`dispatched` rows per project are kept regardless of age (dispatched rows are age-pruned only). Raw webhook payloads are not persisted. |
| PR snapshots | 60 days | `pull_request_snapshots` not updated within the window are deleted (re-fetchable from GitHub). |
| AI usage log | None | `ai_usage_log` is kept: it backs the account-wide daily budget and the lifetime totals; see [Why `ai_usage_log` is not local-only](#why-ai_usage_log-is-not-local-only). |
| Retained event logs | 30 days | `linear_sync_events`, `linear_workflow_run_events`, `worker_agent_cost_events`, and `pack_events`, each on `created_at`, in paced batches. `linear_ingress_events`, `cursor_cloud_ingress_events`, `cto_session_logs`, and `worker_agent_runs` are exempt — see [the exemptions](#event-log-retention-and-the-tables-deliberately-exempt). |
| Storage-doctor journal | 30 runs | `storage-doctor-journal.json` keeps the newest 30 `MaintenanceRunReport`s; older runs drop off on the next append. |
| launchd logs | 10 MiB threshold × 2 streams | `launchd.err.log` and `launchd.out.log` each keep a 1 MiB `.1` tail, then copytruncate the live file to zero. |
| Desktop JSONL logs | 10 MiB × 2 generations | Current log plus one `.1` rotation; the older rotation is replaced. |
| Transparent compressed history read | 256 MiB decompressed | Larger inputs are rejected rather than expanded in memory. |
| Automatic compression sweep | 25 files | Oldest eligible files first, with a delay between files. |

### Diagnostic reports (the report dialog)

Every error surface (error toasts and banners, the project recovery screen,
the renderer and page error boundaries, the update-transaction notice, the
brain Repair control, the Connections publish-failure line) has a **Report
this error to ADE…** control (`renderer/components/app/ReportIssueButton.tsx`,
`ui/notice/NoticeReport.tsx`). A press opens one dialog
(`renderer/components/app/ReportIssueDialog.tsx`) and sends nothing. The
dialog says the report goes to the ADE team privately, takes an optional
"What were you doing?" note, and shows exactly what is sent (the note, then
the redacted report, with its size). Send uploads; Cancel and Esc send and
spend nothing. It draws above the toasts (`Z_LAYERS.dialogOverToasts`).

The send has two steps (`renderer/components/app/reportDraft.ts`):

1. `diagnostics.prepareReport(context?)` → `IPC.diagnosticsPrepareReport` →
   `autoDiagnosticsService.prepareManual()`. Main builds and redacts the
   report, uploads nothing, claims no budget, and returns the text, its size
   and a one-use id. Main keeps at most 4 prepared reports for 10 minutes each
   (`PREPARED_REPORT_TTL_MS`).
2. `diagnostics.sendReport(id, { userMessage })` → `IPC.diagnosticsSendReport`
   → `autoDiagnosticsService.sendPrepared()`. Main uploads that exact text and
   claims the manual budget only then. An unknown or expired id answers
   `expired`; the dialog builds and shows a new report and asks again. A
   failed upload keeps the id, so Try again sends the same text.

Cancel, Esc and leaving Settings drop the id (`diagnostics.discardReport`).
After a send the dialog shows "Sent. Reference …" with a copy control and one
optional action, **Open a public GitHub issue**: a prefilled `arul28/ADE`
issue whose body holds only the reference, version and channel, OS family and
a line that the private report is with the ADE team
(`shared/publicIssueLink.ts`, also used by the web client and
`ade report-issue`). Report text, logs, raw errors, headlines and ids never go
to GitHub. Where sending is impossible (the web client with its Sentry off)
the dialog offers **Copy report** instead.

The report describes this computer and window, whatever machine a chat on
screen lives on, so none of these calls takes a pin.

**Settings → General → Privacy → Send a report to ADE**
(`renderer/components/settings/DiagnosticsSharingSection.tsx`) is for an app
that only feels wrong. It runs the same two steps under `settings_manual` and
`auto: false`, keeps its own note field, shows the same preview, and offers
**View report** after a send. It differs from the automatic sender in two
ways:

- **Its own budget**: `MAX_MANUAL_DIAGNOSTICS_PER_WINDOW` (5 per 24 h per
  install), apart from the automatic 3 and equal to the server's per-identity
  quota. Neither budget can use up the other.
- **No opt-out**: `DO_NOT_TRACK=1` governs what ADE sends by itself; a click
  is allowed.

Refusals are three sentences: the local cap ("you've already sent 5 from this
computer today"), the server's per-caller 429 ("you've already sent several
today"), and its fleet-wide 429 or 503 ("ADE isn't accepting reports right
now"). The route gives the two 429s different bodies; `uploadDiagnosticReport`
maps the fleet one to `unavailable`. No status code reaches the screen.

| Piece | Where |
| --- | --- |
| Pure builder + redactor | `apps/ade-cli/src/services/diagnostics/diagnosticReport.ts` |
| Shared collection (logs, disk, notes, redaction context) | `apps/ade-cli/src/services/diagnostics/diagnosticSources.ts` (`collectMachineDiagnosticSources`) |
| Desktop-only extras (its own jsonl logs, runtime status, recovery diagnosis, typed last-failure store) | `apps/desktop/src/main/services/diagnostics/diagnosticReportService.ts` |
| IPC | `IPC.diagnosticsPrepareReport`, `IPC.diagnosticsSendReport`, `IPC.diagnosticsDiscardReport` (the dialog and Settings) |
| Saved report | `<userData>/diagnostic-reports/<timestamp>-<surface>.md`, mode `0600` |
| Headless equivalent | `ade report-issue [--send] [--open]` |
| Headless state check | `ade doctor` → the **Diagnostics sharing** row (consent + today's spend) |
| Settings entry | `general.diagnostics-sharing` (General → Privacy, `#diagnostics-sharing`, **Send a report to ADE**, hidden on hosted web). No toggle. |
| Automatic opt-out | `DO_NOT_TRACK=1`, or an explicit `enabled: false` persisted by an earlier build. Honored silently; no UI. |
| Automatic sending (desktop) | `apps/desktop/src/main/services/diagnostics/autoDiagnosticsService.ts` |
| Automatic sending (brain) | `apps/ade-cli/src/services/diagnostics/autoDiagnosticsSender.ts` |
| Consent flag + the two daily budgets (automatic and manual) | `apps/desktop/src/main/services/diagnostics/autoDiagnosticsStore.ts` → `~/.ade/secrets/diagnostics-autosend.json` |
| Upload (opt-in) | `POST /diagnostics/upload` on the account directory Worker (`apps/account-directory/src/diagnostics.ts`); one client for both senders — the desktop main process and the CLI — in `apps/desktop/src/shared/diagnosticsUpload.ts` |

The desktop adds only what lives under Electron's `userData` (its
`local-runtime.jsonl` and `ade-update.jsonl`, the typed last-failure store, an
Electron-aware volume reader) to the shared machine sources.

`ade report-issue --send` takes no arguments and needs no project. It saves the
exact bytes to `~/.ade/diagnostic-reports/` and prints the path with the
reference id, or with the failure reason (`--json`: `reportPath`, `sent`).

**Contents.** App version, channel and packaging; platform, arch, OS release
(`sw_vers -productVersion` on macOS); model, CPU, RAM; `machine_id` and the
machine key fingerprint; Electron/Node/Chrome versions; timezone offset; a
**Machine health** section (memory, swap, pressure, load, ADE processes by
group, emulators, the brain's last WAL read, the last five pressure episodes;
see `docs/logging.md`, "Diagnostic reports: machine facts"); the surface,
code and detail the user saw; the runtime status; machine and project
`last-failure.json`; `last-wedge.json` (with its age, dropped after seven
days); the recovery diagnosis; free disk; the service definition; the storage
environment; and bounded log tails. `ade doctor` checks do not run, so a
machine whose brain will not start still gets a report.

**Storage environment** (`storageEnvironmentProbe.ts`) answers whether ADE's
files are on this disk and readable, for the ADE home and the project root:

- the location class: `icloud`, `dropbox`, `google-drive`, `onedrive`,
  `cloud-storage`, `external-volume`, `network-volume` or `local`;
- `N of M sampled files not downloaded`, and whether the sample hit its bound;
- the collector (`cli` or `desktop`), the platform, and whether launchd
  started the process;
- the materialization policy from the installed launch agent: allowed, or
  "NOT allowed (launch agent predates MaterializeDatalessFiles)". Without the
  key, reinstalling the service fixes it; with it, the provider is the
  problem.

It reads the plist as text and says so (Node cannot reach `getiopolicy_np`);
on Windows it says dataless detection uses allocated blocks. It uses `node:fs`
only, never the brain, and emits enums and counts only, never a path or name.
The walk takes at most 200 files, 40 folders and 750 ms per root, never
follows links, and skips `node_modules`, `.git`, `DerivedData`, `Pods`,
`dist`, `build`, `.venv`. An unreadable root reads `(could not be read)`.

**Collected sources.** `collectMachineDiagnosticSources` collects everything a
headless machine can read, so the desktop button and `ade report-issue --send`
make the same document.

| Source | Cap | Why |
| --- | --- | --- |
| Background service, **both** streams — `launchd.err.log` **and** `launchd.out.log` on macOS, the supervisor log on Windows (one merged stream by construction), `systemd.err.log` and `systemd.out.log` on Linux (a unit installed before these files, or systemd older than 240, keeps the output in the journal, so `journalctl --user-unit` is read too when the unit exists) | 120 lines / 32 KB | Main's early events go to `console`, so when a plist boots the desktop app as the service they land in **stdout**. |
| `desktop-main.jsonl` — "Desktop main (machine)" | 120 lines / 32 KB | The machine-scoped desktop log from process start: the only main-process log where no project was ever opened (launch marker, `ade://` claim, single-instance outcome, `ade_cli.auto_install`). |
| `brain.jsonl` | 120 lines / 32 KB | The brain's own structured log. |
| `local-runtime.jsonl`, `ade-update.jsonl` (desktop only) | 120 lines / 32 KB | Under Electron's `userData`; the CLI does not guess that path. |
| The project's `main.jsonl` and `ade-cli.jsonl` — "Desktop main (project)" | 80 lines / 16 KB | The open project, or the most recently opened one in `~/.ade/projects.json`, with a note saying which. |
| **Service definition**: the launchd plist, the systemd user unit, or the Windows launcher script plus its scheduled task XML | first 8 KB | Read from the front, where `Label`, `ProgramArguments` and `EnvironmentVariables` are. A plist without `ELECTRON_RUN_AS_NODE=1` boots the whole desktop app as the service, which then fights the GUI for `ade://` and the single-instance lock, with no log signature. It also shows whether `MaterializeDatalessFiles` is set. |

A missing or unreadable source is `(not present)` / `(could not be read)`,
never a thrown collector or a failed upload. The total stays inside
`MAX_DIAGNOSTIC_UPLOAD_BYTES` (512 KB). `resolveMostRecentProjectRoot` reads
`~/.ade/projects.json` directly, not through `ProjectRegistry` (which writes
back migrations and throws on unknown versions), so a bad registry means "no
project".

**Redaction.** `redactDiagnosticText` runs over the whole document last, so a
new section cannot skip it. In order it removes: project roots
(`<project:<name>#<6 hex>>`, stable per path), the home folder in every
spelling (native, JSON-escaped, percent-encoded, `file://`), other
`/Users/…`, `/home/…` or `X:\Users\…` paths, the OS account name, emails,
credentials (JWTs, `Bearer`/`Basic`/`Token` headers, `sk-`/`gh?_`/`ph[cx]_`/
`xox?-` prefixes, `?token=`-style params, hex or base64 runs of 32+ next to a
key, secret, authorization or cookie word), URL userinfo, non-loopback IPv4
and IPv6 (`127.0.0.0/8` and `::1` stay), this machine's hostname (full and
short, case-blind, on word boundaries), `*.ts.net` and `*.local` names. The
GitHub issue title and stub go through it too, before the URL is built.
Environment variables, the credential store, `~/.ade/secrets/*`, keychain
output and pairing PINs are never collected. It is idempotent.

**PostHog correlation.** `Install id (PostHog distinct_id)` is the value
`productAnalyticsService.getDistinctId()` sends (the account hash when signed
in, else `ade_<32 hex>`). `Account hash` is a 12-hex truncated SHA-256 of the
account user id; email and name are never included. `Machine id` is the
`machine_id` Sentry and PostHog carry; the upload stores it as the R2 object's
`machineId` metadata. Analytics: `ade_feature_used` with
`feature: "issue_report"` and coarse actions only (`issue_report` success or
failed, `report_dialog` opened/completed/cancelled, `github_issue`,
`report_copied`); see `docs/logging.md`.

**Private upload.** The repository is public and redaction is pattern-based,
so the report never goes to GitHub. Send and `ade report-issue --send` post to
`POST /diagnostics/upload` on the account directory Worker and show a short
reference. `apps/desktop/src/shared/diagnosticsUpload.ts` is the only client:
it sends the redacted string unchanged, checks the 512 KB ceiling first, and
returns a closed set (`too_large`, `rate_limited`, `unavailable`, `rejected`,
`network`), never a server string. `describeManualSendFailure` (desktop) and
`describeDiagnosticUpload` (CLI) word each one.

- The desktop sends from main (`sendPrepared`); the renderer cannot, because
  its CSP `connect-src` allows no remote origin. Main has no account token, so
  a desktop upload is anonymous, identified by the install id in the report.
  A failure shows its sentence with Try again where it helps, and the note
  stays.
- `ade report-issue --send` reads the machine credential store and directory
  origin from local files, so it sends a Clerk token when signed in, works
  with no brain, and a self-hosted machine reports to its own directory.
- The Worker never parses, indexes or echoes a report, and allows five uploads
  per identity (Clerk user, else a hash of the caller address) per UTC day.

**The hosted web client** has no main process or logs, and the account
directory refuses uploads from a page on another site. Its dialog
(`renderer/webclient/adapter/diagnostics.ts`, the same prepare → send →
discard contract) sends a smaller report as Sentry User Feedback to `ade-web`:
the surface, headline and detail (free-text scrub), code, web version,
browser, path and time, at most 2,000 characters, after the person's note. It
links the captured crash (`sentryEventId`) and tags a random 8-character
`report.reference`, shown only after Sentry answers 2xx
(`confirmSentryDelivery` in `shared/sentry/capture.ts`); otherwise "ADE
couldn't send the report." with **Try again**. A browser sends at most 5 a day
(`MAX_DIAGNOSTIC_REPORTS_PER_DAY`, `localStorage`). Where its Sentry does not
run (Do Not Track, an analytics opt-out, a non-production build) the dialog
offers **Copy report** and no GitHub link. Its crash boundaries' Sentry
capture is the web client's automatic report.

#### Auto-send

When ADE hits a failure it has already classified, it sends the same report by
itself, with `auto: true` and the failure code, so the two kinds stay apart on
the server.

| Trigger | Where | `failureCode` |
| --- | --- | --- |
| Recovery diagnosis reached a terminal state | `main/services/runtime/projectRecoveryService.ts` (`diagnose`, via `onTerminalDiagnosis`) | the `AdeRecoveryErrorCode` — `disk_full`, `brain_crash_looping`, … |
| Renderer or page crash | `renderer/components/app/RendererErrorBoundary.tsx` and `PageErrorBoundary.tsx` (`componentDidCatch`, via `IPC.diagnosticsAutoReport`, once per boundary) | `renderer_crash`, `page_crash` |
| Post-update transaction failed | `main/main.ts`, beside `autoUpdate.transaction_failed` | `update_<step>` |
| Desktop started its own brain because the service manager refused it | `main/main.ts` `onRuntimeStatusChange`, once per `appFallback.since` | `app_fallback_<reason>` |
| Pairing auto-recovery gave up | `ade-cli/.../machinePairingAutoRecovery.ts` (`onGaveUp`, wired in `cli.ts`; the same hook records `recoveryGaveUpAt` in publisher health, so the desktop also shows a lasting banner and does not depend on this report) | the refusal code, or `snapshot_failed` |
| Account publisher failing > 5 min | `ade-cli/.../accountMachinePublisherService.ts` (`onSustainedFailure`) | the health state, e.g. `snapshot_failed` |
| Sync host refused by unreadable storage, 3 attempts running | `ade-cli/.../sync/syncHostStartupLoop.ts` (`onSustainedStorageFault`) | `storage_read_failed` |

- The sync-host trigger does not hang off the account publisher, because the
  publisher exists only after the sync host starts. A trigger must sit
  upstream of what it reports. It reports under `sync_host_storage` ("This
  computer could not read its own data"); the per-code cap makes one report a
  day out of a fault that repeats every 30 s.
- `healthy` and `brain_starting` are not terminal. The auto builder passes no
  `diagnoseProject`, because a diagnosis is itself a trigger.
- **Budgets.** One report per failure code per 24 h and three in total per
  24 h per install, in one ledger (`~/.ade/secrets/diagnostics-autosend.json`)
  shared by the desktop and the brain. The reservation comes before the
  request, so failing uploads cannot loop. An unreadable or locked ledger
  fails closed. The server's per-identity limit and fleet-wide cap
  (`DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT`, see
  `apps/account-directory/README.md` § *Diagnostic report uploads*) bound it
  again.
- **Failure is silence.** A 429, 503 or network error is logged locally only:
  no toast, error or retry.
- **Toast.** Each successful send raises *"A diagnostic report was sent to
  ADE"* with **View**, which reveals the saved `.md` through a handler limited
  to the desktop's `userData/diagnostic-reports` and the brain's
  `<adeHome>/diagnostic-reports`. There is no Settings switch for automatic
  sending.
- **Delivery.** `webContents.send` does not fail when a renderer crashed or
  has no toast host, so every send is recorded pending. A subscribing renderer
  asks for outstanding notices (`IPC.diagnosticsFlushAutoSent`, nothing polls)
  and acknowledges each one after its toast exists
  (`IPC.diagnosticsAckAutoSent`). A window that gets both paths keys the toast
  on `diagnostics-auto-sent-<reference>`. The brain waits for the same
  acknowledgement. The desktop and the brain can both report one incident
  with different codes; the shared daily cap bounds it.
- Nothing leaves the computer on the manual path until the user presses Send;
  the automatic path announces each send.

### Handing the repair to an agent (`ade triage`)

`ade doctor` names the failing check and `ade report-issue` makes something
to file; neither fixes anything. `ade triage` runs the same doctor checks and
redacted collection, writes them with a repair playbook into a fresh temp
folder, and hands the machine to the first agent whose ADE-pinned copy is on
disk (`claude`, `codex`, `cursor-agent`, `opencode`, `droid`, `muse`). It
never uses a CLI on the PATH and never starts a download; a provider with no
copy prints its pinned state.

```bash
ade triage                       # launch the first agent ADE has downloaded
ade triage --provider codex      # pick one
ade triage --agent --text        # print the handoff for an agent already running
```

- `context.md` is Install → Health checks → Brain → Recent errors → Full
  diagnostic report, failing rows first and error lines lifted to the top.
  `PLAYBOOK.md` is [docs/triage/PLAYBOOK.md](../../triage/PLAYBOOK.md), fetched
  from `main` at run time.
- **Degrade, never die.** Each collector may fail (a hung brain, a full disk,
  an unset `ADE_HOME`); each failure becomes a section in `context.md`.
- **Redacted by construction.** The whole document, error messages included,
  goes through `redactDiagnosticText`. Error lines come from the redacted
  report, and a failed collection derives the redaction context locally.
- **The launch is optional.** `--agent` prints the paths and prompt for a
  running session. With no downloaded agent, the output is the same and the
  exit is 0. A launched agent owns the terminal (paths to stderr first,
  inherited stdio) and triage exits with its code.
- **CLI only, no brain.** The desktop and iOS need the brain this repairs.

## Gotchas

- The interrupted-rebuild recovery pass **must run before `migrate()`**. An
  idempotent create in a migration can turn a finished rename into an
  ambiguous original-plus-staging state.
- Excluded tables get no CRR index rewrite; their rebuild plan must keep every
  unique and secondary index.
- Change `PRAGMA foreign_keys` outside a transaction; inside one it does
  nothing.
- **A rename failure is not always retryable.** Only `EXDEV` / `EPERM` /
  `EACCES` / `EBUSY` fall back to a copy in `writeFileAtomic`. Adding `ENOSPC`
  or `EIO` can leave a half-written target where the old file was intact.
- **A new ADE error code must be lowercase snake_case.** `isErrnoLikeCode`
  tells ADE codes from platform codes by shape, and the JSON-RPC boundary
  redacts platform-shaped ones to `Internal error in <method> (ref …)`.
- **`storage_read_failed` stays ahead of the integrity bucket** in
  `classifySqliteOpenError`; an unreadable file read as corrupt would offer a
  repair that rewrites data ADE cannot read.
- **Give `classifyStorageFault` a path when you have one.** Without a path, a
  `syscall` or a path on the error, a bare `EDEADLK` or `ESTALE` is not a
  storage fault, and the user sees the raw libuv sentence.
- **Do not copy the storage errno list.** Import `storageErrnoClassifier.ts`.
- **An auto-diagnostics trigger must sit upstream of what it reports.** Check
  that the subsystem that carries it still runs when the failure happens.
- launchd holds its stdout/stderr files open. Use copytruncate, not rename.
- A worktree can hold its own nested `.ade`. Count it only in the worktree
  category.
- Writers append to plain history. If a `.gz` exists, reinflate it atomically
  first; never append a second plain stream beside it.
- `compactCrsqlTombstones` is safe only with **zero sync peers**. Keep
  `hasSyncPeers` conservative; a paired project's sync-bookkeeping row stays
  "waiting to compact".
- DB retention numbers live once in `state/dbMaintenanceApi.ts`. Never
  hard-code a cutoff at one enforcement site.
- **The SQLite driver is synchronous.** New prunes use `pruneRowsInBatches`.
- **Not every append-only table is prunable.** `linear_ingress_events` and
  `cursor_cloud_ingress_events` (replay guards), `cto_session_logs` (dormant
  CRR) and `worker_agent_runs` (live references) stay out of
  `RETAINED_EVENT_LOG_TABLES`.
- **A new doctor step needs a `STORAGE_LEDGER` entry and a `LEDGER_LABELS`
  entry** (`storageView.ts`), or Settings shows no policy or the raw id.
- `dbstat` is compile-time optional. The breakdown and vacuum paths work
  without it.
