# Storage and recovery

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/state/kvDb.ts` | Opens the project database (enabling `journal_mode = WAL` + `synchronous = NORMAL` at open), runs the interrupted-rebuild recovery pass, classifies database-open errors (`classifySqliteOpenError`, whose `storage_read_failed` bucket is checked *before* the integrity bucket so an unreadable file is never reported as a corrupt one), creates the headroom-gated migration backup, and exports `rebuildTableInTransaction` / `recoverInterruptedTableRebuilds`. Attaches the optional `maintenance` (`DbMaintenanceApi`) handle — the prune / compact / vacuum hooks the storage doctor invokes. The machine-local `local_lane_storage_state` and `local_storage_lifecycle_runs` tables retain reclaim retry/estimate and scan timing state; both are excluded from CRR sync because paths and cleanup results belong only to this checkout. |
| `apps/desktop/src/main/services/state/dbMaintenanceApi.ts` | The `DbMaintenanceApi` interface consumed by the storage doctor, plus the single source of truth for the DB retention/count bounds (`INGRESS_EVENT_RETENTION_MS` = 7 days, `INGRESS_EVENT_MAX_ROWS_PER_PROJECT` = 2,000, `REVIEW_ARTIFACT_RETENTION_DAYS` = 30, `PR_SNAPSHOT_RETENTION_DAYS` = 60, `EVENT_LOG_RETENTION_DAYS` = 30) imported by the ingress writer, the kvDb hooks, and the storage ledger so the policy can never drift across enforcement sites. Also exports `pruneRowsInBatches` — the paced `delete … where rowid in (select rowid … limit N)` loop (`MAINTENANCE_DELETE_BATCH_ROWS` = 2,000, `MAINTENANCE_DELETE_MAX_BATCHES` = 200) that every new prune uses. |
| `apps/desktop/src/main/services/state/durableFile.ts` | Atomic temp-write-and-rename persistence, one-generation `.lkg` JSON backup, validation, and primary/previous recovery reads. `AtomicWriteOptions.mode` creates the temp file with the caller's permission bits so a secret is never briefly world-readable, and a rename refused with `EXDEV` / `EPERM` / `EACCES` / `EBUSY` falls back to a copy — a deliberately closed list that leaves `ENOSPC` and `EIO` terminal. |
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
| `apps/ade-cli/src/commands/doctor.ts` | `ade doctor [--online]` — connects to the brain over the local socket and prints one `ok`/`warn`/`fail` row per subsystem (App version, Brain, Wedge history, Sync port, Publish health, Relay, Account, Diagnostics sharing); exits non-zero on any `fail`. The **Diagnostics sharing** row reads the shared auto-send ledger through `readAutoDiagnosticsState` — never a second parser — and is always `ok`: consent is a preference, not a fault, so it reports `on · N of 3 automatic reports sent today` or `off · no automatic reports are sent` and never colours a healthy machine. `evaluateDoctorRows` is pure and dependency-injected — every row's inputs are read at the edge (`runDoctorCommand`) and handed in — so the verdict is testable without a machine and a second surface can reuse it. Today the CLI is its only caller: the desktop's **Connection doctor** card (`remoteTargets/ConnectionDoctorPanel.tsx` → `remoteRuntime.runDoctor`) is a different check about reaching a *remote* machine, not this one. |
| `apps/desktop/src/shared/adeRuntimeProtocol.ts` | Shared runtime-protocol contract: `RUNTIME_COMPAT_LEVEL` + `isRuntimeProtocolCompatible` (the integer compatibility-window check), and the tolerant parsers `parseRuntimePublishHealth` / `parseRuntimeLastWedge` that decode `runtimeInfo.publishHealth` and `runtimeInfo.lastWedge` for the connection pool, the doctor, and the desktop status surfaces. |
| `apps/desktop/src/main/services/runtime/projectRecoveryService.ts` | Brain-independent diagnosis and ordered repair: space, ownership, database validation, migration recovery, service restart, endpoint/project verification, and chat reconciliation. Also owns `restartBrain()` — the machine-scoped restart behind the Connections **Repair** button — which shares one `restartServiceAndWait()` sequence (install → wait ≤90 s for the endpoint → `ping`) with `repair()`'s restart_service/verify_endpoint steps. The two are mutually exclusive: `restartBrain()` rejects while a `repair()` is in flight, because repair stops the service and then does exclusive database work that a reinstall would put a second writer on top of. A forced restart also treats a *skipped* install as a failure ("A newer ADE runtime is already running — quit and reopen ADE instead."), where `repair()` tolerates one, since a protocol-compatible brain that is already running satisfies its step. `main.ts` constructs exactly one of these and shares it with `registerIpc`, so the mutual exclusion actually holds — the post-update transaction's `restart` step (see [desktop auto-update](../onboarding-and-settings/desktop-auto-update.md#applying-an-update-is-one-transaction)) binds to the same instance rather than a second one that could run alongside a repair. |
| `apps/desktop/src/main/services/storage/diskPressure.ts` | Samples all ADE storage roots, classifies pressure with recovery hysteresis, and gates write-producing operation classes via `canPerform(kind)`. Exports the `DiskPressureMonitor` type and refusal-message copy. |
| `apps/desktop/src/main/services/storage/volume.ts` | `readVolumeSpace(dir)` (statfs free/total bytes) and `isNoSpaceError(err)` (ENOSPC/EDQUOT and disk-full message detection), shared by the pressure monitor and the database-open error classifier. |
| `apps/desktop/src/main/services/storage/cloudPlaceholder.ts` | The cloud-eviction preflight. `detectCloudStorageProvider` matches a path against the provider roots (`Library/Mobile Documents`, `Library/CloudStorage`, and home-relative `OneDrive` / `Dropbox` / `Google Drive` folders) on text alone, so it costs nothing on any platform; `isDatalessFileStats` spots a file with a size but zero allocated blocks, which is what a dehydrated placeholder looks like through `fs.stat`. `detectCloudPlaceholderFile` reports a finding only when both agree, and `storageUnreadableMessage` writes the one sentence a person needs — with the "move it out of the cloud folder" remedy stated conditionally when no provider was matched, because a failing disk or a dropped network mount produces the same unreadable file. |
| `apps/desktop/src/main/services/storage/storageInsightsService.ts` | Builds categorized storage snapshots and preview-confirmed cleanup plans without following symlinks or deleting protected state. `proof_attachments` is a manual `review_first` cleanup target for `.ade/artifacts` and `.ade/attachments`; after bytes are removed it invokes the broker's `purgeArtifactRecordsUnder` hook so proof rows cannot outlive their files. It also runs the lane-lifecycle scan at the configured interval: safely archives excess or inactive lanes, marks old archived worktrees for review, and never removes lane files in the background. The **storage doctor** compresses history and maintains the database; filesystem candidates such as staging, backups, DerivedData, and build output remain review-first. Every run is journaled and emits one deduped `ade_feature_used` analytics event. Populates the snapshot's optional `extras` plus lifecycle policy/status and per-item ownership, age, blocked reasons, and reclaim estimates. |
| `apps/desktop/src/main/services/lanes/laneService.ts` | Owns the lane-aware `getReclaimRisk`, `archiveAndReclaim`, and restore-aware `unarchive` operations. It proves exact path-and-branch ownership against this project's Git worktree registry, rejects symlinks, rechecks directory identity before removal, shares the database-backed lane worktree lease with PR workflows, and stores retryable reclaim failures locally. |
| `apps/desktop/src/main/services/storage/storageLedger.ts` | The **storage ledger** (`STORAGE_LEDGER`): the declared policy for every persistent table and directory ADE writes — its privacy class (`user_data` / `derived` / `operational`) and how it is bounded (`write_time` / `doctor` / `both` / `manual`). `LEDGER_LAYOUT_COVERAGE` maps every `ADE_LAYOUT_DEFINITIONS` directory to a ledger id (or `null` for intentionally-unmanaged config/credentials) so a coverage test fails CI if a new tracked directory ships without a declared policy. `deriveCategoryPolicyChips()` renders the Settings policy chips from the ledger. |
| `apps/desktop/src/main/services/storage/storageDbBreakdown.ts` | Pure helpers turning raw `dbstat` rows into the coarse project-database breakdown (`classifyDbTable` / `mapDbBreakdown`: webhooks, sync bookkeeping, review artifacts, PR cache, core) and `deriveSyncBookkeepingAction` — which reads the journal so the sync-bookkeeping row offers "Compact now" only after a run proves compaction ran without a `has_peers` skip, and stays "waiting to compact" otherwise. |
| `apps/desktop/src/main/services/storage/storageMaintenanceJournal.ts` | Read/write helpers for the storage-doctor journal — a plain rebuildable JSON file (`storage-doctor-journal.json` under `.ade/cache`, no DB/CRR) capping the last 30 runs, written via temp-file-then-rename so a crash never leaves a torn journal. |
| `apps/desktop/src/main/services/storage/historyCompression.ts` | Finds inactive old history, gzip-compresses it, verifies byte identity, and only then removes the original; also reinflates before append. Exposes `readHistoryFileSync` / `reinflateHistoryFileSync` so transcript, session, and search readers can read a `.gz` generation transparently. |
| `apps/desktop/src/renderer/components/app/StoragePressureIndicator.tsx` | Quiet top-right warning/critical/exhausted status and entry point to Storage settings. Mounted in `TopBar.tsx` (enabled only when a workspace project is open). |
| `apps/desktop/src/renderer/components/app/ProjectRecoveryScreen.tsx` | Full-project recovery surface for typed open failures, diagnosis, repair progress, next action, and technical details. `ProjectTabHost` in `App.tsx` renders it full-viewport whenever `projectTransitionError` carries a `code` and `rootPath`. |
| `apps/desktop/src/renderer/components/app/ProjectTransitionErrorAlert.tsx` | Fallback dismissible banner for project open/switch failures that lack a code/rootPath (un-coded string errors); it renders nothing once a coded error hands the surface to `ProjectRecoveryScreen`. |
| `apps/desktop/src/main/services/ipc/knownProjectRoots.ts` | Validation for renderer-supplied project roots on the recovery and diagnostics channels. A renderer may only name the open project, a local recent-projects entry, or a root main itself recently attempted to open; `AttemptedProjectRoots` is that last, bounded and expiring, single-writer registry, recorded only after the repo path resolves. Comparison goes through `pathsEqual` (case folding) and falls back to `path.resolve` when a root has no realpath, so a project on an unmounted volume is not refused. |
| `apps/desktop/src/main/services/diagnostics/diagnosticReportService.ts` | Desktop half of **Report issue**: shared machine sources plus what only Electron can reach — its `userData` jsonl logs, local runtime status, the recovery diagnosis for the open project, the typed last-failure store, and an Electron-aware volume reader. Saves the report `0600`, copies it, and opens a prefilled GitHub issue. The typed last-failure store is keyed off the root the shared collector actually used, not the request's, so a report with no project open cannot attribute one project's failure to another's logs. |
| `apps/ade-cli/src/services/diagnostics/diagnosticReport.ts` | The pure report builder, the redactor (`redactDiagnosticText`), and `buildDiagnosticIssueUrl`. No I/O, so both the desktop and the CLI produce byte-identical documents from the same sources. |
| `apps/ade-cli/src/services/diagnostics/diagnosticSources.ts` | `collectMachineDiagnosticSources` — everything a headless box can read: both of the background service's output streams, the service definition (`readFileHead`), the project logs of the open **or most recently opened** project (`resolveMostRecentProjectRoot`), layout, disk figures and the redaction context. Both surfaces read it, so a source added for one appears in both. Command-backed sources (journald, `schtasks /XML`) go through the injectable `DiagnosticCommandRunner`, bounded and non-interactive. |
| `apps/ade-cli/src/commands/reportIssue.ts` | `ade report-issue [--open] [--send]`, the headless equivalent. `--send` needs no project and no arguments: it posts the same redacted report to ADE (Clerk token when the machine is signed in, anonymous otherwise), saves a copy under `~/.ade/diagnostic-reports/` *before* attempting the upload, and prints the reference id or the plain-words failure alongside that path. Local files only: it never starts or contacts the brain, so it still works where ADE will not come up and on hosts with no error screen to press. |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsStore.ts` | The consent flag **and** the spend ledger for automatic uploads, in one file (`<adeHome>/secrets/diagnostics-autosend.json`) that both senders open — the desktop main process and the brain — because "three a day from this computer" is a property of the install, not of a process, and two private ledgers would quietly mean six. Deliberately dependency-free (`node:fs`, no Electron, no logger) for exactly that reason. Owns `AUTO_DIAGNOSTICS_WINDOW_MS` (24 h), `MAX_AUTO_DIAGNOSTICS_PER_CODE` (1), `MAX_AUTO_DIAGNOSTICS_PER_WINDOW` (3), `normalizeAutoDiagnosticsFailureCode` (coerced to the Worker's `FAILURE_CODE_PATTERN`, re-exported rather than rewritten), the mkdir lock — whose `isLockContention` names the Windows delete-pending `EPERM`/`EACCES`/`EBUSY` window as well as `EEXIST` — and the pending-notice queue the toast acknowledgement retires. Consent defaults **on**; an unreadable or locked ledger fails closed. |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsSend.ts` | `runAutoDiagnosticsSend` — the policy every automatic send obeys, written once. The two senders differ in exactly three things (what they build, how they upload, which analytics surface they report as) and bring those as structural seams; consent, the pre-request reservation, the local copy, silence on failure, the pending flag, the log lines and the analytics dedupe key live here. Also owns the `AutoDiagnosticsOutcome` vocabulary (`completed`, `skipped_disabled`, `skipped_budget`, `skipped_ineligible`, `failed`) and `AUTO_DIAGNOSTICS_ANALYTICS_DEDUPE_MS` (1 h). |
| `apps/desktop/src/main/services/diagnostics/autoDiagnosticsService.ts` | The desktop sender: what is specific to this process — how a report gets built (no `diagnoseProject`, since a diagnosis is itself a trigger), that it uploads anonymously, the `onSent` fast path for an open window, and the getter/setter the Settings toggle reads and writes. |
| `apps/ade-cli/src/services/diagnostics/autoDiagnosticsSender.ts` | The brain's sender, for the failures the desktop never sees — a headless machine whose pairing recovery gave up, a publisher failing for minutes with nobody at the console. It reads the machine credential store, so its reports land attributed rather than anonymous. It has no window, so successful sends stay pending in the shared ledger until a renderer subscribes and acknowledges the toast. |
| `apps/ade-cli/src/lib/externalLinks.ts` | `normalizeExternalUrl` / `openExternalUrl` for the CLI: allows only `http(s)` and `mailto:`, opens through the platform helper (`open` / `rundll32` via the trusted-tool resolver / `xdg-open`), and falls back to Electron's `shell.openExternal` only when actually running inside Electron — a static `electron` import crashes headless startup. |
| `apps/desktop/src/shared/diagnosticsUpload.ts` | The one **Send to ADE** client, shared by the renderer button and the CLI: `uploadDiagnosticReport`, the `DiagnosticUploadFailure` vocabulary and its one-sentence copy, `resolveDiagnosticsUploadBaseUrl`, and `diagnosticReference` (the first 8 characters of the returned id — a full uuid is unreadable over a phone call). It lives in `shared/` because that is the only tree the renderer, the main process and the CLI can all import (Vite refuses to serve files outside `apps/desktop`), and it is deliberately free of Node built-ins and `import.meta` so the identical module loads in all three. It posts the report's exact bytes and transforms nothing: the thing that is sent has to be the thing that was shown. |
| `apps/desktop/src/shared/types/diagnostics.ts` | The `DiagnosticSurface` / request / payload contract shared by main, preload and renderer. |
| `apps/desktop/src/renderer/components/app/ReportIssueButton.tsx` | The button itself, on every error surface. One press assembles, saves, copies, and opens the issue; it reports what actually happened rather than claiming success. |
| `apps/desktop/src/renderer/components/settings/DiagnosticsSharingSection.tsx` | The off switch, in Settings → General → Privacy (`general.diagnostics-sharing`, anchored `#diagnostics-sharing`, `web: "hidden"` because the consent lives in a file a browser does not have). It renders `ConsentToggleSection` from `settings/settingsSectionUi.tsx` — the shared consent control it and `ProductAnalyticsSection` both use, which reads the real persisted value instead of rendering optimism and renders disabled when the preload bridge predates the setting. |
| `apps/desktop/src/renderer/components/app/toast/useAutoDiagnosticsToast.ts` | The renderer half of the delivery contract: subscribes, asks for the outstanding notices (`IPC.diagnosticsFlushAutoSent`), raises the *"A diagnostic report was sent to ADE"* toast with **View** / **Turn off**, and only then acknowledges it (`IPC.diagnosticsAckAutoSent`). Mounted from `AppShell.tsx`. |
| `apps/desktop/src/renderer/components/app/errorSurfaceKit.tsx` | Shared parts for the full-screen error surfaces — `ErrorSurfaceCard`, `WhatToDo`, `TechnicalDetailsFold`, `ERROR_PRIMARY_BUTTON` — so the recovery screen, the renderer/page boundaries and the CTO wake failure keep the raw text behind a fold and the plain-language account on top. |
| `apps/desktop/src/renderer/components/chat/ChatContinuityRecoveryCard.tsx` | In-transcript choices to retry the original thread, rebuild from ADE history, or start a separate chat. `AgentChatMessageList` renders it in place of a plain notice chip when a `system_notice` event's `detail.kind` is `"continuity_recovery"`. |
| `apps/desktop/src/renderer/components/settings/StorageSection.tsx` | Storage dashboard: plain-language lane cleanup rules, last/next safety-scan status, and a review table for archived lanes, orphaned worktrees, DerivedData, and build output with ownership, age, blocked reasons, and reclaim estimates. Archive & Reclaim has a typed confirmation and explains exactly what stays and what restore recreates. The page also keeps the category totals, Health & diagnostics strip, project-database breakdown, cleanup preview, recent-cleanups journal, and manual history compression. |
| `apps/desktop/src/renderer/components/settings/storage/StorageDiagnostics.tsx` | The "Health & diagnostics" strip: four tiles — database size (with a journal-fed sparkline + trend arrow), background-service resident memory, slow responses in 24 h (from `getRuntimeHealth`), and last cleanup — plus the overall health chip. Deep-linked as `#diagnostics` from the top-bar load pill. |
| `apps/desktop/src/renderer/components/settings/storage/StorageMaintenanceJournal.tsx` | Collapsible "Recent cleanups" panel rendering the last runs from the maintenance journal, one humanized line per action. |
| `apps/desktop/src/renderer/components/settings/storage/storageUiConstants.ts` | Shared presentational constants (`STORAGE_BRAND`, `PANEL_STYLE`) for the section shell and the split-out diagnostics/journal components, so they share styling without a circular import. |
| `apps/desktop/src/renderer/components/settings/storage/StorageCleanupDialog.tsx` | Preview-confirmed cleanup dialog: lists selected removable items with sizes, surfaces blocked paths and reasons, and only enables Remove once a fresh preview is in hand. Its failure state is phase-aware — failing to *look* and failing to *remove* leave the disk in different states and call for different next steps — and it carries a Try again that re-runs the preview. Overlapping previews are retired by request id, so a stale answer cannot paint over a fresh one or drag a settled dialog back to "error". Also hosts the itemized "Clean up safely" plan and its `runMaintenance` path. |
| `apps/desktop/src/renderer/components/settings/storage/storageView.ts` | Pure, DOM-free presentation + policy helpers. Category metadata/order/hues, safety labels, and `buildCleanupTarget` / `cleanableEntries` / `groupLaneItems` map a snapshot item to a typed `StorageCleanupTarget`. The overhaul adds the diagnostics/maintenance view-model: `dbBreakdownRows`, `buildSafeCleanupPlan`, journal/db-size-sparkline/trend helpers, `daemonMemoryBytes`, `healthChip`, `formatSlowActions`, and `categoryPolicyChip` — each degrading to a sensible "not available" value so the UI renders against an older daemon that never sends `extras`. |
| `apps/desktop/src/shared/types/storage.ts` | Shared storage contracts: disk-pressure types, `StorageCategoryId`, `StorageSafety`, `StorageItem`/`StorageCategorySnapshot`/`StorageSnapshot`, and the `StorageCleanupTarget`/`StorageCleanupPreview`/`StorageCleanupResult` DTOs. `StorageItem` carries ownership, age, blocked reasons, reclaim estimate/state, and lane ownership for the review screen; `StorageLifecycleSnapshot` carries the effective four-rule policy plus last/next scan and review counts. The ledger/maintenance surface includes `StorageLedgerEntry`/`StoragePolicyClass`, `MaintenanceAction`/`MaintenanceRunReport`/`MaintenanceTrigger`, `DbBreakdownEntry`, `StorageSnapshotExtras`, and `RuntimeHealthSnapshot`. |
| `apps/desktop/src/shared/types/recovery.ts` | Typed recovery contracts: the `AdeRecoveryErrorCode` union + `toAdeRecoveryErrorCode`, `AdeLastFailureReport`, `ProjectRecoveryDiagnosis`, the ordered `RepairStepId` list + `ProjectRepairReport`, and `mapKvDbOpenErrorCode`. |
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

`writeJsonWithPrevious` copies the current valid generation to `<file>.lkg`,
writes a same-directory temporary file, optionally syncs it, and atomically
renames it over the primary. A failed write does not replace the primary.
`readJsonWithRecovery` accepts only payloads that pass the caller's validator
and falls back from primary to the one `.lkg` generation.

`writeFileAtomic` never unlinks the destination first. `rename` replaces an
existing target in one step on every platform ADE ships to — libuv implements
`fs.rename` on Windows with `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` — so the
delete-then-rename shape some writers reach for as "the Windows fix" would only
open a window in which the file does not exist at all, and a concurrent reader
looking during it sees neither generation. What Windows genuinely needs is the
other end: a rename refused because something else holds the target open (an
indexer, an antivirus scanner, a second ADE process), plus `EXDEV` for a temp
file that landed on another device. Those four codes — `EXDEV`, `EPERM`,
`EACCES`, `EBUSY` — fall back to a non-atomic `copyFileSync`, and the list is
closed on purpose: retrying `ENOSPC` or `EIO` as a copy would write the payload
a second time to a filesystem that just proved it cannot take it, turning a
clean "the write failed, the old file is intact" into a half-written target. A
caller that passes `mode` — today `0o600` from the machine sync-relay identity
store (`apps/ade-cli/src/services/sync/syncCloudRelayStore.ts`) — gets it on the
temp file, so the rename carries the bits onto the target and the secret is
never world-readable for even an instant; on the copy path the mode is reapplied
with a best-effort `chmod`. Directory fsync is
skipped on Windows rather than attempted and caught, because opening a directory
handle there fails outright.

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
stays behind disclosure. `repair()` streams each step to the window as it
finishes (`IPC.recoveryRepairStep`), so a long service restart reads as
progress rather than a hang, and the screen names the step currently running
from `REPAIR_STEPS` in `shared/types/recovery.ts` — the same ordered list the
service runs. `stateForCode` lives there too, so a screen falling back to the
last recorded failure can never offer a different verdict, or a different
repair offer, than the service would have given.

**A code is only worth attaching if it survives every wrapper on the way out.** The brain throws
`codedError(message, code)`; `apps/ade-cli/src/jsonrpc.ts` re-encodes it as
`code: message` (the rootPath, when there is one, rides after a NUL delimiter
that never appears in human-readable text) and repeats the code in
`error.data.code`; the desktop's runtime RPC client prefixes `Remote ADE service
method <m> failed (code <n>):`; and Electron IPC strips custom `Error`
properties, so `registerIpc`'s `surfaceCodedError` re-encodes once more on the
way to the renderer. `stripElectronErrorWrapper` names all of those prefixes —
missing the runtime-RPC one is how a project whose data files were unreadable
reached the user as a raw libuv errno. The renderer's
`RECOVERY_MESSAGE_BY_CODE` (`renderer/state/appStore.ts`) then overrides the
brain's sentence only for codes where the screen genuinely knows more; a code
that is not listed keeps the brain's own wording as the headline, because for
`storage_read_failed` the brain's message is the one that names the file and the
fix, and a generic paraphrase would push it into the collapsed details fold.

The same boundary decides what may *not* be worded to a caller. A failure that
came from the platform rather than from a service — one carrying `syscall` /
`errno`, an errno-like `code`, an errno libuv could not name, or a
`TypeError`-class runtime fault — is replaced on the wire with `Internal error
in <method> (ref <id>)` and reported in full through `onInternalError` to the
brain's stderr. Service verdicts are exempt: `JsonRpcError`s and plain sentences
like "Project root does not exist: …" are authored for the person who asked, and
blanking those would turn every actionable refusal into a reference number. The
split is `isErrnoLikeCode` in `shared/codedError.ts`, which is also why ADE's
codes are lowercase snake_case — the two vocabularies cannot collide.

That same `Remote ADE service method …` prefix also decides what the desktop
retries. `isLocalRuntimeConnectionDropped` in `localRuntimeConnectionPool.ts` is the
predicate behind resetting the connection and re-running an action, so it has to
mean "the socket went away", not "the message mentioned a socket". It reads
`Error.code` for the transport errnos (`ECONNRESET`, `ECONNABORTED`, `EPIPE`,
`ENOTCONN`) rather than matching them in text, and it rejects anything shaped
like `Remote ADE service method <m> failed …` first and unconditionally: that
prefix means the daemon answered, so the failure is the brain's and may quote a
transport sentence verbatim — retrying it would re-run a non-idempotent action
against a healthy daemon.

**Unreadable storage is not a damaged database.** A project (or `~/.ade`) parked
in iCloud Drive, Dropbox or OneDrive whose contents the provider has evicted
answers a read with an errno the platform never names; on macOS it is `EDEADLK`,
which reaches the app as "Unknown system error -11: … read". `createAdeRuntime`
(`apps/ade-cli/src/bootstrap.ts`) runs `detectCloudPlaceholderFile` on the
database path *before* opening it and throws `storage_read_failed` with
`storageUnreadableMessage`, so the common case fails with the sentence that
names the fix rather than the errno. When the preflight declines to fire — the
file is materialized, or outside any known provider root — the open still fails
safe, because `classifySqliteOpenError` buckets `EDEADLK` / `EIO` / `ENXIO` /
`ENODEV` / `ESTALE` / `EHOSTDOWN` / `EREMOTEIO` and any unnameable errno into
the same code, ahead of the integrity check. Both paths record the same typed
failure and rethrow a coded error carrying the offending `dbPath` and the raw
errno as `detail`, rather than the bare libuv message.

`storage_read_failed` maps to the `storage_unreadable` diagnosis, which offers
no repair on purpose: rewriting files ADE cannot read would risk the user's
work, and the same failure also arrives from a failing disk or a dropped network
mount. The recovery screen states the remedy as a condition ("if the folder is
in iCloud Drive, Dropbox or OneDrive, move it…"), lists moving the folder as a
prerequisite, and leaves Try again as the only action.

One further diagnosis offers no repair: `brain_starting`, when the service
is registered and its brain is alive but has not bound the socket yet (see
[remote runtime](../remote-runtime/README.md)). There is nothing to fix and a
repair would only kill a booting brain and restart its clock, so the screen
re-diagnoses every 2 s and reopens the project itself the moment the endpoint
answers. `projectRecoveryService` does not depend on a healthy
brain, so it can validate and repair the database that prevented the brain from
starting.

Both `recovery.diagnose` and `recovery.repair` validate the root the renderer
names before acting on it (`apps/desktop/src/main/services/ipc/knownProjectRoots.ts`):
a renderer may only name the open project, a local recent-projects entry, or a
root main itself recently attempted to open. That last source is what keeps the
recovery screen working — a folder whose *first* open failed never reaches the
recent-projects list, so main records every open attempt in a bounded, expiring
registry and treats those roots as known. Diagnostics applies the same rule; a
root it cannot place is dropped rather than swapped for the open project, and
the report says it carries machine-level state only.

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
   `review_run_artifacts`, `pull_request_snapshots`, `ai_usage_log`, and the
   retained event logs; compact cr-sqlite sync bookkeeping; and vacuum when the
   freelist is fragmented.

Step 4's hooks are awaited individually, so a hook may be `async` — the two
newest ones are, because they delete in paced batches. Each is invoked through
method-level optional chaining (`maintenance?.pruneEventLogs?.bind(…)`), not
just object-level: the handle is consumed optionally so the doctor can degrade
against a database handle that predates a step, and `handle?.method.bind()`
still throws when only the method is missing.

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
  Machine-local telemetry behind Stats and the per-feature daily budget check,
  and the largest single source of cr-sqlite metadata in a measured project
  database.
- `pruneEventLogs` (async) — delete rows older than 30 days from the four
  retained append-only event logs (see below).
- `compactCrsqlTombstones` — rebuild the `operations` CRR table to shed
  cr-sqlite clock/pks shadow rows, then vacuum. **Only runs when the project has
  zero sync peers** (`options.hasSyncPeers`, defaulting conservatively to
  "assume peers"); otherwise it returns a `has_peers` skip and touches nothing,
  because compacting shared change-tracking state mid-sync is unsafe. The guard
  is also cheap to keep: on a measured 28.7 MB project database, tombstones were
  under 4% of CRR metadata (~220 KB of 5.7 MB). Do not re-litigate removing a
  correctness guard for that prize — the metadata that actually grows is the
  live clock rows behind unbounded logs, which is what the two prunes above
  target.

#### Why `ai_usage_log` is not local-only

It is the largest single block of CRR metadata in a measured project database
— 0.93 MB of clock/pks for 0.27 MB of data, about 2.8 MB off the file after a
vacuum — and it looks like an obvious sibling of `usage_events`, which *is* in
`LOCAL_ONLY_CRR_EXCLUDED_TABLES`. It stays a CRR anyway, deliberately.

`ai.budgets.<feature>.dailyLimit` is enforced by counting rows in this table
for today. Because the table replicates, that cap is **account-wide across a
user's machines**. Making it local-only silently turns it into a per-machine
cap — an N-times looser cost control.

Serving the cap from a slim synced aggregate was scoped and deferred, not
dismissed. Three things make it larger than it looks:

1. The aggregate must be keyed `(day, feature, site)` and summed at read.
   A shared `(day, feature)` counter cannot work — cr-sqlite is
   last-writer-wins per column, so one machine's upsert discards another's
   count, reintroducing the same under-count by a different route.
2. It cannot ship in one release. Once raw rows stop replicating, a machine on
   the new build sees nothing from a peer still on the old one, so it
   under-counts and overruns the cap during precisely the window a rollout
   guarantees. Safe sequencing is two releases: ship the aggregate while
   `ai_usage_log` still replicates, then flip to local-only.
3. A new CRR table must exist in every peer's schema or `unknown_sync_table`
   wedges apply — the hazard described under [CRDT model](../sync-and-multi-device/crdt-model.md).

Retention is not a consolation prize here either. `ActivityModule` defaults to
the **All** range and renders a "lifetime tokens" total computed from these
rows, so ageing them out would quietly turn a lifetime figure into a
trailing-window one — the same class of silent loss as the budget. Both wait on
the aggregate. The phone already never receives the table
(`MOBILE_CHANGESET_EXCLUDED_TABLES`).
- `vacuumIfFragmented(threshold)` — when the freelist fraction exceeds the
  threshold, a one-time full `VACUUM` rebuilds the file and activates
  `auto_vacuum = INCREMENTAL`; every later sweep then reclaims the freelist in
  bounded `incremental_vacuum` chunks (≤ 25 × 2,000 pages per call) so a blocking
  full VACUUM never runs again. Each call finishes with a `wal_checkpoint(TRUNCATE)`
  and reports bytes reclaimed from the on-disk footprint (`.db` + `-wal` + `-shm`).

The database is opened in WAL mode with `synchronous = NORMAL`
(`journal_mode = WAL` set explicitly at open in `openRawDatabase`).

#### Paced deletes

ADE's SQLite driver (`node:sqlite`'s `DatabaseSync`) is **fully synchronous**: a
`DELETE` runs to completion on the event loop with nothing else able to proceed,
so an unbounded delete stalls the UI, IPC, and the sync pump for its whole
duration. The older prunes are each a single unbounded `DELETE`, which is fine
at today's row counts and is a latency cliff waiting for the first project with
a real backlog.

`pruneRowsInBatches` is the shared fix and the shape new prunes should use:
delete 2,000 rows per batch (`delete … where rowid in (select rowid … limit N)`,
so each batch's work is proportional to the batch and not to the table), yield
with `setImmediate` between batches, stop early when a short batch proves the
predicate is exhausted, and cap at 200 batches so one call can never run
unbounded. It returns a promise, which is why the two hooks that use it are
`async` and why `runDbStep` awaits its callback.

Both prunes compare timestamps with `column like '____-__-__%' and column < ?`
rather than `column < ?` alone. These are `text`-affinity columns: an epoch
number stored as digits sorts before every ISO cutoff (`'1767225600000' <
'2026-…'` is true as strings), and CRR repair appends `default ''` to NOT NULL
text columns, where `''` also sorts before every cutoff. Without the shape guard
a numeric or defaulted timestamp would be born expired.

#### Event-log retention, and the three tables deliberately exempt

`RETAINED_EVENT_LOG_TABLES` in `kvDb.ts` pairs each retained table with the
column it actually timestamps on:

| Table | Column | Why this column |
|---|---|---|
| `linear_sync_events` | `created_at` | Insert time. |
| `linear_workflow_run_events` | `created_at` | Insert time. |
| `worker_agent_cost_events` | `created_at` | **Not `occurred_at`** — that is event time and can be backdated, which would age a row out the moment it is written. |
| `pack_events` | `created_at` | Insert time. |

Three tables that look like event logs are **deliberately not pruned**. Each
exemption is a correctness constraint, not an oversight — the reasoning is
recorded here and in the `RETAINED_EVENT_LOG_TABLES` doc comment so nobody
"completes" the set later:

- **`linear_ingress_events` is the webhook replay guard, not a log.**
  `linearIngressService.persistRecord` refuses to dispatch a delivery whose
  `delivery_id` it has already stored, and the cursor is explicitly reset on
  `cursorExpired`. Pruning it lets a backlog drain **re-dispatch automations** —
  re-running agent work and re-posting Linear comments.
- **`cto_session_logs` is two-way reconciled** against an append-only
  `.ade/cto/sessions.jsonl` that has no retention of its own, so every prune is
  undone by the next CTO read. On a CRR table each such cycle writes a tombstone
  plus a fresh set of clock rows, so pruning would make the metric this work
  exists to improve permanently *worse*.
- **`worker_agent_runs` is a lifecycle table.** Keying it on `created_at` would
  delete a still-pending run and orphan the `worker_agent_cost_events.run_id`
  and `automation_runs.worker_run_id` references. It needs a terminal-status +
  `finished_at` policy instead, which is a different change.

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
| AI usage log | 90 days | `ai_usage_log` rows older than the cutoff are deleted in paced batches. Stats and the daily budget check read a shorter window than this. |
| Retained event logs | 30 days | `linear_sync_events`, `linear_workflow_run_events`, `worker_agent_cost_events`, and `pack_events`, each on `created_at`, in paced batches. `linear_ingress_events`, `cto_session_logs`, and `worker_agent_runs` are deliberately exempt — see [the exemptions](#event-log-retention-and-the-three-tables-deliberately-exempt). |
| Storage-doctor journal | 30 runs | `storage-doctor-journal.json` keeps the newest 30 `MaintenanceRunReport`s; older runs drop off on the next append. |
| launchd logs | 10 MiB threshold × 2 streams | `launchd.err.log` and `launchd.out.log` each keep a 1 MiB `.1` tail, then copytruncate the live file to zero. |
| Desktop JSONL logs | 10 MiB × 2 generations | Current log plus one `.1` rotation; the older rotation is replaced. |
| Transparent compressed history read | 256 MiB decompressed | Larger inputs are rejected rather than expanded in memory. |
| Automatic compression sweep | 25 files | Oldest eligible files first, with a delay between files. |

### Diagnostic reports ("Report issue")

Every error surface — the project recovery screen, the renderer and page error
boundaries, the update-transaction notice, the brain Repair control, and the
Connections pane's publish-failure line — carries a **Report issue** button
(`renderer/components/app/ReportIssueButton.tsx`). One press assembles a
redacted Markdown report, saves it, copies it to the clipboard, and opens a
prefilled GitHub new-issue page for `arul28/ADE` in the default browser. The URL
carries only a short stub: GitHub rejects issue URLs somewhere north of 8 KB, so
`buildDiagnosticIssueUrl` caps the whole URL at `ISSUE_URL_MAX_LENGTH` (6,000
characters) and falls back to a title-and-stub URL past it. The full report
rides the clipboard.

Those surfaces all share one property: something has already visibly broken. A
user whose app merely *feels* wrong has nothing to press, so **General → Privacy
→ Diagnostics sharing** also carries a **Send a report to ADE** button
(`renderer/components/settings/DiagnosticsSharingSection.tsx` →
`IPC.diagnosticsSendManual` → `autoDiagnosticsService.sendManual()`). It builds
and uploads the same redacted report the error screens do, under surface
`settings_manual` and `auto: false`, so a report somebody asked for stays
separable server-side from one nobody chose to file. It does not open GitHub:
the point is the send, and the result line offers **View report** for the saved
copy.

Two things it deliberately does not share with the automatic sender:

- **Its own budget.** Manual sends are capped at
  `MAX_MANUAL_DIAGNOSTICS_PER_WINDOW` (5 per 24h per install), counted apart
  from the automatic 3 — matching the account directory's per-identity daily
  quota so the client never refuses a report the server would still have
  accepted. Neither budget can spend the other: pressing the button cannot
  silence the automatic reports that explain a crash, and a crash loop that has
  burned its three automatic sends cannot lock a user out of asking for help.
- **Consent.** The toggle governs what ADE sends *by itself*; a deliberate click
  is not that, so a manual send is allowed with the toggle off — and when it is
  off, the pane says so next to the button, and the click never flips it back on.

Refusals are three separate sentences, because they are three separate
situations: the local cap ("you've already sent 5 from this computer today"),
the account directory's per-caller 429 ("you've already sent several today"),
and its fleet-wide 429 or 503 ("ADE isn't accepting reports right now"). The
route answers the two 429s with distinct bodies precisely so a client can tell
them apart; `uploadDiagnosticReport` reads the body and maps the fleet one to
`unavailable`. No status code ever reaches the screen.

| Piece | Where |
| --- | --- |
| Pure builder + redactor | `apps/ade-cli/src/services/diagnostics/diagnosticReport.ts` |
| Shared collection (logs, disk, notes, redaction context) | `apps/ade-cli/src/services/diagnostics/diagnosticSources.ts` (`collectMachineDiagnosticSources`) |
| Desktop-only extras (its own jsonl logs, runtime status, recovery diagnosis, typed last-failure store) | `apps/desktop/src/main/services/diagnostics/diagnosticReportService.ts` |
| IPC | `IPC.diagnosticsOpenIssue`; manual send from Settings: `IPC.diagnosticsSendManual` |
| Saved report | `<userData>/diagnostic-reports/<timestamp>-<surface>.md`, mode `0600` |
| Headless equivalent | `ade report-issue [--open] [--send]` |
| Headless state check | `ade doctor` → the **Diagnostics sharing** row (consent + today's spend) |
| Settings toggle | `general.diagnostics-sharing` (General → Privacy, `#diagnostics-sharing`, default **on**, hidden on hosted web) |
| Automatic sending (desktop) | `apps/desktop/src/main/services/diagnostics/autoDiagnosticsService.ts` |
| Automatic sending (brain) | `apps/ade-cli/src/services/diagnostics/autoDiagnosticsSender.ts` |
| Consent flag + the two daily budgets (automatic and manual) | `apps/desktop/src/main/services/diagnostics/autoDiagnosticsStore.ts` → `~/.ade/secrets/diagnostics-autosend.json` |
| Upload (opt-in) | `POST /diagnostics/upload` on the account directory Worker (`apps/account-directory/src/diagnostics.ts`); one client for both senders — the renderer button and the CLI — in `apps/desktop/src/shared/diagnosticsUpload.ts` |

`ade report-issue` and the desktop button read the same machine sources through
`collectMachineDiagnosticSources`, so a source added for one appears in both.
The desktop adds only what lives under Electron's `userData` — its own
`local-runtime.jsonl` and `ade-update.jsonl`, the typed last-failure store, and
an Electron-aware volume reader.

`ade report-issue --send` takes **no arguments and needs no project**: with
nothing open and a cwd outside every project it still produces a complete report
and uploads it. It also saves the exact bytes it sent to
`~/.ade/diagnostic-reports/`, and prints where. A successful send prints the
reference id plus that path ("exactly what was sent"); a failed one prints the
reason in plain words plus that path, so the user is left holding a file to
attach rather than a sentence about a service they cannot reach. Both appear in
`--json` as `reportPath` and `sent`.

The report contains: app version/channel/packaging, platform, arch, OS release
(plus `sw_vers -productVersion` on macOS), Electron/Node/Chrome versions,
timezone offset, the surface and recovery code the user hit, the technical
detail that screen already showed, the local runtime status snapshot, the
machine and project `last-failure.json`, `last-wedge.json`, the recovery
diagnosis for the open project, free disk for the ADE home and the project, the
background-service definition, and bounded tails of the logs below. The
`ade doctor` checks are **not** run: the report must be collectable on a machine
whose brain will not start.

**What is collected, and why each one.** Everything a headless box can read is
collected by `collectMachineDiagnosticSources`, so the desktop button and
`ade report-issue --send` produce the same document.

| Source | Cap | Why |
| --- | --- | --- |
| Background service, **both** streams — `launchd.err.log` **and** `launchd.out.log` on macOS, the supervisor log on Windows (one merged stream by construction), `journalctl --user-unit` on Linux when the unit exists | 120 lines / 32 KB | Early-startup lines are written with `console.log` before the structured logger exists, so `deeplink.scheme_claimed` and `deeplink.single_instance.lock_lost` land in **stdout and nowhere else**. Collecting only stderr is how a user once had to read the decisive two lines off his own disk by hand. |
| `brain.jsonl` | 120 lines / 32 KB | The brain's own structured log. |
| `local-runtime.jsonl`, `ade-update.jsonl` (desktop only) | 120 lines / 32 KB | Under Electron's `userData`; the CLI does not write them. |
| The project's `main.jsonl` and `ade-cli.jsonl` | 80 lines / 16 KB | Machine-level events (the `ade_cli.auto_install` outcome among them) live here. Collected for the open project, or — when no project is open — for the most recently opened project in `~/.ade/projects.json`, with a note in the report saying which. |
| **Service definition**: the launchd plist, the systemd user unit, or the Windows launcher script plus its scheduled task XML | first 8 KB | Configuration, not logs, and read from the front because a plist states its `Label`, `ProgramArguments` and `EnvironmentVariables` first. A plist written without `ELECTRON_RUN_AS_NODE=1` boots the whole desktop app as the background service, which then claims the `ade://` scheme and fights the GUI for the single-instance lock — a failure with no signature in any log. |

Two properties hold for every one of them. **Absence is a fact, not an error**:
a missing or unreadable source becomes `(not present)` / `(could not be read)`
under its own heading, never a thrown collector and never a failed upload — the
machine this runs on is by definition damaged. And the total stays inside
`MAX_DIAGNOSTIC_UPLOAD_BYTES` (512 KB for the serialized upload): at the caps
above a desktop report's tails are ~208 KB at their theoretical worst and a real
one is well under 100 KB, which is why the two project logs take the smaller cap
and the service definition is capped at all.

`resolveMostRecentProjectRoot` reads `~/.ade/projects.json` directly rather than
through `ProjectRegistry`, which migrates a legacy v1 file by writing it back and
throws on a version it does not know. A diagnostic collector may do neither: it
runs on a machine whose state is already suspect, and a registry it cannot parse
has to degrade to "no project" rather than take the report down with it.

**Redaction guarantees.** `redactDiagnosticText` runs over the whole assembled
document as the last step — not per field — so a section added later cannot leak
by forgetting to opt in. It removes, in order: project roots (collapsed to
`<project:<name>#<6 hex>>`, stable per path so two reports about one project
correlate without naming its location), the home directory in every spelling
(native, JSON-escaped backslashes, percent-encoded, `file://`), any other
`/Users/…`, `/home/…` or `X:\Users\…` shape, the OS account name, email
addresses, credentials (JWTs, `Bearer`/`Basic`/`Token` headers, `sk-`/`gh?_`/
`ph[cx]_`/`xox?-` prefixes, `?token=`-style query params, and hex/base64 blobs
of 32+ characters adjacent to a key/secret/authorization/cookie word), URL
userinfo, non-loopback IPv4 and IPv6 addresses (`127.0.0.0/8` and `::1` are
kept — "the brain answered on 127.0.0.1" is signal and identifies nobody), this
machine's hostname (the fully-qualified name and its short form, case
insensitive, on word boundaries), `*.ts.net` tailnet names, and `*.local`
names. The GitHub issue **title and stub body** go through the same redaction
before the URL is built — the headline they are made from is caller-supplied
and routinely carries OS paths (an update failure message, for instance). What
is redacted is the plain text, never the encoded URL. Environment
variables, the credential store, `~/.ade/secrets/*`, keychain output and
pairing PINs are never collected at all. The function is idempotent, so
re-redacting a stored report is a no-op.

**Correlating a report with PostHog.** The report's `Install id (PostHog
distinct_id)` line is exactly the value the desktop sends as PostHog's
`distinct_id` (`productAnalyticsService.getDistinctId()` — the identified
account hash when signed in, otherwise the anonymous `ade_<32 hex>` install
token). Search PostHog for that `distinct_id` to get the same installation's
event history. When an account is signed in, `Account hash` carries a 12-hex
truncated SHA-256 of the account user id — enough to tell two reports apart,
never enough to recover the account. The account email and name are never
included.

One coarse analytics event is emitted per press:
`ade_feature_used { feature: "connections", action: "issue_report", outcome:
"opened" | "failed" }`, deduped to one per hour per outcome.

**Send to ADE.** Filing on GitHub asks a user who is already looking at an error
screen to paste a document into a form; the second action on the result line —
and `ade report-issue --send` — posts the same finished report straight to
`POST /diagnostics/upload` on the account directory Worker and shows a short
reference id back. `apps/desktop/src/shared/diagnosticsUpload.ts` is the only
client: it takes an already-redacted string and a base URL its caller resolved,
and changes nothing about the bytes, because redaction happened once in the
builder and any transformation here would mean the thing that was sent is not
the thing that was shown. It also re-checks the 512 KB ceiling locally, so an
oversized report fails without spending one of the user's few daily uploads on a
doomed request. Failures come back as a small closed vocabulary — `too_large`,
`rate_limited`, `unavailable`, `rejected`, `network` — never a server string,
because the person reading it already hit one failure and a status line is not
an improvement on "couldn't send". Each maps to one plain sentence that points
back at GitHub where posting by hand is still the answer, or at tomorrow where
it is not; the CLI words the same reasons for a terminal line in
`describeDiagnosticUpload`.

The two surfaces differ in exactly one way, and deliberately. The renderer runs
the upload itself (the diagnostics preload bridge exposes only `openIssue`, and
the renderer already holds the report that call returned), and it has no access
to an account token — those live in the brain's credential store — so a desktop
upload is anonymous, identified only by the install id the report already
carries. `ade report-issue --send` reads the machine's own credential store and
directory origin off local files, so it sends a Clerk token when the machine is
signed in and still works on a machine whose brain will not start; resolving the
origin the way the brain does also means a self-hosted machine's report and its
token are not silently redirected to ADE's directory. The Worker treats the body
as opaque: it never parses, indexes or echoes a report, which is what lets it
accept anonymous uploads at all, and it bounds one identity (Clerk user, else a
hash of the caller address) to five uploads a UTC day.

#### Auto-send

Nobody presses the button. A person looking at an error screen has to notice the
control, decide the failure is worth reporting, and follow through — so the
reports that would explain the worst failures are exactly the ones that never
arrive. When ADE hits a failure it has **already classified**, it sends the same
finished report by itself, with `auto: true` and the failure code alongside it so
the two populations stay separable on the server.

**Triggers.** One call each, at the point the failure is already known:

| Trigger | Where | `failureCode` |
| --- | --- | --- |
| Recovery diagnosis reached a terminal state | `main/services/runtime/projectRecoveryService.ts` (`diagnose`, via `onTerminalDiagnosis`) | the `AdeRecoveryErrorCode` — `disk_full`, `brain_crash_looping`, … |
| Renderer crash | `renderer/components/app/RendererErrorBoundary.tsx` (`componentDidCatch`, via `IPC.diagnosticsAutoReport`) | `renderer_crash` |
| Post-update transaction failed | `main/main.ts`, beside `autoUpdate.transaction_failed` | `update_<step>` |
| Pairing auto-recovery gave up | `ade-cli/.../machinePairingAutoRecovery.ts` (`onGaveUp`) | the refusal code, or `snapshot_failed` |
| Account publisher failing > 5 min | `ade-cli/.../accountMachinePublisherService.ts` (`onSustainedFailure`) | the health state, e.g. `snapshot_failed` |

`healthy` and `brain_starting` are deliberately not terminal: a booting brain
fixes itself in seconds, and reporting it would spend the day's budget on a
non-event. The auto builder also passes **no** `diagnoseProject`, because the
diagnosis is itself a trigger and asking for a fresh one while building the
report about it would re-enter the path that asked.

**Budgets.** At most **one report per failure code per 24 hours** and **three in
total per 24 hours, per install** — one rolling ledger in
`~/.ade/secrets/diagnostics-autosend.json`, shared by the desktop and the brain,
so it is three a day for the computer rather than three per process. The
reservation is taken **before** the request: a budget that only counted
successes would let a machine whose uploads all fail retry the same failure
every time it recurs, which is precisely the loop this is not allowed to become.
An unreadable or locked ledger fails closed. The client ceiling sits well inside
the server's five-per-day-per-identity limit and its fleet-wide daily cap
(`DEFAULT_DIAGNOSTICS_DAILY_GLOBAL_LIMIT`, see
`apps/account-directory/README.md` § *Diagnostic report uploads*), so the cost
ceiling is enforced twice and neither side depends on the other.

**Failure is silence.** Any upload failure — `429` from the per-user or the
fleet budget, `503`, a network error — is logged locally and nothing else. No
toast, no error, no retry. The person is already looking at something broken;
telling them the thing they did not ask for also did not work is not help.

**Toast and toggle.** Every successful send raises one toast — *"A diagnostic
report was sent to ADE"* — with **View** and **Turn off**. Settings → General →
Privacy carries the same switch, *"Share diagnostics with ADE when something
breaks"*, default **on**.

**View** reveals the saved `.md` through a handler scoped to the two
directories reports are written to — the desktop's
`userData/diagnostic-reports` and the brain's `<adeHome>/diagnostic-reports` —
rather than by widening `appRevealPath`'s allowlist. Both, because a headless
send is exactly the one the user was not present for, so a brain report is the
one they are most likely to open.

Delivery is the ledger's job, not the window's, and only the window can close
it. `webContents.send` does not throw when the receiving renderer has crashed or
has not mounted its toast host, so a successful send is ALWAYS recorded pending,
and *pending* means "no renderer has said it showed this". A renderer asks for
the outstanding ones as it subscribes (`IPC.diagnosticsFlushAutoSent` —
event-driven, nothing polls); that read retires nothing, because the window can
still vanish between being handed a notice and rendering it. What retires one is
the renderer acknowledging it after the toast exists
(`IPC.diagnosticsAckAutoSent`). So a toast is never shown twice across restarts,
and a window that dies mid-render repeats one toast rather than swallowing it.
The immediate send to open windows is a fast path on top of that; a window that
gets both keys the toast on `diagnostics-auto-sent-<reference>` and sees one, and
acknowledges it either way. The brain has no window at all and waits for the
same acknowledgement. The desktop and the brain can both report one
incident; they carry different codes and surfaces, so both are individually
useful, and the shared three-a-day ceiling bounds the duplication. Nothing else
coordinates them, deliberately.

The button's disclosure text still holds for the manual path — nothing leaves
the computer unless the user posts the issue or chooses **Send to ADE** — and
the automatic path adds one more way, which is announced every time it happens
and switched off in one click.

## Gotchas

- The interrupted-rebuild recovery pass **must run before `migrate()`**. An
  idempotent create in migration can turn a safe completed rename into an
  ambiguous original-plus-staging state.
- Excluded tables do not get CRR index rewriting. Their rebuild plan must keep
  every required unique and secondary index.
- `PRAGMA foreign_keys` changes must happen outside a transaction; changing it
  inside an active transaction is ineffective.
- **A rename failure is not automatically retryable.** Only `EXDEV` / `EPERM` /
  `EACCES` / `EBUSY` fall back to a copy in `writeFileAtomic`; widening that set
  to `ENOSPC` or `EIO` writes the payload a second time to a filesystem that
  just refused it and can leave a half-written target where a clean failure
  would have left the previous file intact.
- **A new ADE error code must be lowercase snake_case.** `isErrnoLikeCode`
  separates ADE's vocabulary from the platform's by shape alone, and the brain's
  JSON-RPC boundary redacts anything it reads as platform-shaped. A code spelled
  like an errno reaches the user as `Internal error in <method> (ref …)` instead
  of its own message.
- **`storage_read_failed` must stay ahead of the integrity bucket in
  `classifySqliteOpenError`.** An unreadable file classified as a corrupt one
  offers a repair that would rewrite data ADE could not even read.
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
- **The SQLite driver is synchronous.** A single unbounded `DELETE` blocks the
  whole event loop. New prunes go through `pruneRowsInBatches`; an existing
  unbounded one is a latency cliff to migrate, not a pattern to copy.
- **Not every append-only table is prunable.** `linear_ingress_events` (replay
  guard), `cto_session_logs` (reconciled from a jsonl that has no retention),
  and `worker_agent_runs` (lifecycle rows with live foreign references) are
  exempt on purpose. Adding one to `RETAINED_EVENT_LOG_TABLES` re-dispatches
  automations, churns CRR metadata forever, or orphans references respectively.
- **A new doctor step must be added to `STORAGE_LEDGER` and to `LEDGER_LABELS`.**
  The ledger is what the Settings policy chips read; a step whose `ledgerId` has
  no ledger entry runs but has no declared policy, and one missing from
  `storageView.ts`'s `LEDGER_LABELS` shows the raw id in Settings.
- `dbstat` is a compile-time-optional virtual table. The breakdown scan and the
  vacuum path degrade gracefully when the SQLite build lacks it — do not assume
  it is present.
