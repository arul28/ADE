# Desktop auto-update disk-space behavior

## macOS update path

ADE uses `electron-updater` with the macOS ZIP target. The behavior below was
verified against the installed `electron-updater` 6.8.3 source and the official
[electron-builder auto-update documentation](https://www.electron.build/docs/features/auto-update/).

1. `checkForUpdates()` reads `latest-mac.yml` and emits `update-available`.
2. ADE keeps `autoDownload` disabled so it can inspect the artifact size and
   preflight the updater-cache volume before calling `downloadUpdate()`.
3. `electron-updater` writes the archive under the updater cache's `pending/`
   directory. On macOS it also retains `update.zip` for future differential
   downloads.
4. After the archive is ready, `MacUpdater` starts a loopback HTTP server and
   emits `update-downloaded`. Native Squirrel.Mac later fetches the cached ZIP
   through that server.
5. `quitAndInstall()` returns `void`. If Squirrel has not fetched the archive
   yet, `MacUpdater` asks the native updater to check again and waits for its
   `update-downloaded` event before quitting. Native failures arrive through the
   updater's `error` event; there is no install-completion promise.
6. Squirrel/ShipIt stages, expands, replaces, and relaunches the application on
   the installed application's volume.

A `ready` snapshot is not proof the ZIP still exists. ADE stores the archive
under `~/Library/Caches/ade-desktop-updater` (Windows: `%LOCALAPPDATA%\ade-desktop-updater`),
which the OS may purge while ADE stays running. `MacUpdater` also starts the
loopback HTTP server at download time, not at install time, so a days-old
`ready` state can hand Squirrel a dead pipe. Root `update.zip` is only the
differential cache copy — Squirrel pipes the pending ZIP recorded as
`downloadedFile`. ADE therefore:

- Re-downloads the staged archive **before** uninstalling the background
  service or calling native `quitAndInstall`, whenever the recorded
  `downloadedFile` or updater-cache ZIP/EXE is gone.
- Re-downloads on the periodic ready check so a vanished cache does not sit
  on the Install button until the user clicks it, and skips the feed check
  for that cycle.
- Treats install-phase `The network connection was lost` / `Cannot pipe` /
  `ENOENT` as a vanished local archive: restore the ZIP (which recreates the
  loopback server) and retry native handoff once. A second failure parks as
  `handoff_failed`. Leftover updater `error` / cancelled / not-available events
  during that restore do not wipe the archive or take the download-error path;
  `downloadUpdate()` resolving with a present ZIP is the source of truth.

The same `quitAndInstall()` path serves the desktop pill, the orange Restart
banner, Settings, `ade update install`, the TUI action, and idle auto-apply.
There is no per-surface installer.

The practical volume checks are therefore:

- Before download: ADE's resolved updater cache path.
- Before staging/install: `process.execPath`, which resolves to the installed
  application bundle's volume on macOS.

## Windows update path

Windows x64 uses electron-builder's per-user NSIS target and
`electron-updater`'s `latest.yml` + blockmap contract:

1. Electron-builder generates the installed `resources/app-update.yml` from
   the package's GitHub publish configuration. ADE does not copy the
   source-tree YAML into the package. `ADE_RELEASE_REPOSITORY=owner/repo`
   lets CI bind a fork package to the repository that produced it while the
   source default remains the upstream `arul28/ADE`.
2. `checkForUpdates()` reads `latest.yml`; ADE keeps `autoDownload` disabled
   until it has run the same cache-volume capacity preflight used on macOS.
3. `downloadUpdate()` writes the NSIS installer and blockmap into the updater
   cache. `quitAndInstall()` hands off to the external NSIS updater, so Windows
   uses the 60-second hard quit bound and has no in-process Squirrel staging
   signal. If that installer file is gone from `%LOCALAPPDATA%\ade-desktop-updater`
   when Install runs, ADE re-downloads it first — the same vanished-archive
   restore used on macOS — then hands off to NSIS.
4. The packaged-artifact smoke test requires the generated update authority
   to match `ADE_RELEASE_REPOSITORY`, preventing a fork build from silently
   checking a different repository.

### What the person sees, and what the installer does

The handoff is silent (`quitAndInstall(true, true)`; it has to be, or the
assisted installer never relaunches ADE), so ADE shows its own window for the
gap. Right before the handoff, `windowsInstallProgress.ts` copies
`resources/ade-cli/windows-update-progress.ps1` to
`%LOCALAPPDATA%\ADE\update-progress-<channel>\` and starts it through
`cmd /c start`. It runs from outside the install folder because the installer
renames that folder away and kills every process whose image lives in it, and
not from `%TEMP%` because some machines point TEMP at a folder other users can
write. It uses `cmd start` because, from Electron, a `detached`
powershell.exe exits without running and an attached one dies with ADE. The
small, topmost "Updating ADE to vX" window follows the old app quitting, the
installer running, and the steps in `install-steps.log`. It closes when the new
ADE has a window on screen. If the installer ends and no new ADE appears, it
says so and offers Open ADE. Its log is read into `ade-update.jsonl` as
`autoUpdate.install_progress_report` 30 s into the next launch.

The window also writes a heartbeat. A copy of the old ADE opened by hand during
the install (the person sees nothing happening and clicks the shortcut) reads
it, brings the window forward, and exits before starting anything, instead of
being force-killed by the installer seconds later. An `ade://` link opened in
that window of time is dropped with it.

An in-place update does only what an update needs. The old uninstaller runs with
`--updated`, so `customUnInstall` passes `-Updating`: it stops the background
service without starting ADE.exe, and leaves the terminal shim, the user PATH
entry, `ade://`, file associations and the firewall rule in place.
`customInstall` passes `-Updating` to `windows-install-setup.ps1`, which then
refreshes only the shim. If that refresh fails, the script puts the previous
shim back, logs `update_continues`, and still exits 0: the update flow has
already removed the service, and NSIS does not relaunch ADE after an abort, so
failing here used to leave no brain and no ADE window. The relaunched app
reinstalls, restarts and verifies the service itself (`runUpdateTransaction`). Every `--updated` install comes
from `quitAndInstall` (`autoInstallOnAppQuit` is off), which records the
pending install that makes that launch run the transaction. The trade: if the
new ADE does not open at all, the brain stays down, and the machine is
unreachable from the phone, until ADE is next opened. `install-path.cmd` broadcasts
`WM_SETTINGCHANGE` only when PATH actually changed, and detached. Its 5 s
per-window timeout stacked to 82 s inside the installer. `customCheckAppRunning`
replaces electron-builder's app-running check with one PowerShell pass instead
of three or four. Every step appends its duration to
`runtime/install-steps.log` in the channel's ADE home (`~/.ade` on Stable,
`~/.ade-beta` and `~/.ade-alpha` on the channels).

Measured in Windows Sandbox with real installers (2026-10-07): from
`quit_and_install` to the new ADE on screen took 77 s before these changes
(1.2.94 → next). The steady state, one fixed version to the next, took 43-50 s.
Over half of that was the sandbox copying files; the same copy takes 7 s on
recent hardware. The first update after this change still runs the previous
version's uninstaller, so it gets the install-side savings only.

`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1` is the single gate. It builds Windows
fresh on the release tag and adds the installer, blockmap, and `latest.yml` to
the draft release. The build is fail-closed on Authenticode: the installer and
packaged `ADE.exe` must share the pinned publisher identity and carry a trusted
RFC3161 timestamp, or the release fails. Keep the gate disabled until the signed
installer has passed the clean standard-user Windows checks, which the
`windows_proof` dispatch input on `prepare-release.yml` produces without
publishing anything. Validate version-to-version automatic updating after two
signed Windows releases exist.

## Artifact size limits

`MacUpdater` hands the downloaded ZIP to native Squirrel.Mac, which buffers the
whole archive into one contiguous `CFData` grown by doubling. Past 1 GiB that
asks for a 2 GiB reallocation, which Chromium's PartitionAlloc refuses: the app
dies with `EXC_BREAKPOINT` about a minute after launch, before the user can even
decline the update. v1.2.52 shipped a 1054 MB arm64 ZIP and did exactly that.

Two defenses, both below the cliff:

| Layer | Limit | Where |
| --- | --- | --- |
| CI, primary | 800 MiB per macOS ZIP; 900 MiB per Windows installer | `apps/desktop/scripts/artifact-size-budget.cjs`, enforced post-packaging by `npm run assert:artifact-size` in both release jobs |
| Runtime, backstop | 800 MiB reported artifact size on darwin | `exceedsMacUpdateArtifactLimit` in `autoUpdateErrors.ts`, checked before `downloadUpdate()` |

The runtime guard refuses the download with an `artifact_too_large` error rather
than letting Squirrel crash the app. It matches the CI budget, so an artifact
that passed CI can never trip it. If release metadata omits the size the update
is allowed through — the CI gate is the real defense, and a malformed manifest
must not block every update.

`artifact_too_large` is the one kind that is never recovered from message text.
The preflight raised the failure itself, so it passes `kind` to
`setErrorSnapshot` explicitly and `classifyUpdateError` is skipped entirely;
message-sniffing stays reserved for the opaque errors electron-updater emits.
Round-tripping ADE's own wording back through a regex would have made the
classification hostage to a copy edit.

The Windows cap is a bloat tripwire, not a crash guard: the NSIS installer is
streamed to disk and run as an external process, so nothing buffers it whole.

The root cause of the 1054 MB ZIP was foreign-platform runtime payloads. Each
packaging job now pins `ADE_RUNTIME_TARGET` to the single target it builds, and
the desktop bundle carries only that target's `ade-<target>` sidecar. Every
target is still published as a standalone release asset, so `ade brain update`
and the standalone installers are unaffected.

## Required-space estimate

Release metadata reports compressed archive size, not expanded application
size. ADE uses a conservative peak-space estimate:

- Download: `2 × compressed archive + 512 MiB`.
- Install/staging: `5 × compressed archive + 512 MiB`.
- If metadata omits size, assume a 512 MiB archive.

The download estimate accounts for the pending archive and macOS differential
cache copy. The install estimate accounts for another staged archive, up to 4×
expansion/replacement space, and fixed filesystem/rollback headroom. The UI
labels this value as an estimate rather than an exact installer requirement.

## Failure timing and cache policy

| Failure | Observation path | Snapshot classification | Cache policy |
| --- | --- | --- | --- |
| Artifact size preflight (macOS) | Synchronous ADE check before download | `artifact_too_large` at the download phase | Nothing downloaded; no cache to preserve |
| Capacity preflight | Synchronous ADE check before download/install | `insufficient_space` with measured free/required bytes and affected path | Preserve only after a verified download |
| `ENOSPC` | Synchronous throw, rejected download, or updater `error` event | `disk_full` at the active phase | Preserve a verified download; clear incomplete download data |
| `EDQUOT` | Rejected download or updater `error` event | `quota` at the active phase | Same as `ENOSPC` |
| Network | Rejected check/download or updater `error` event; `net::ERR_*` included | `network` (phase `check` when the feed request itself failed) | Retry; incomplete cache may be cleared |
| Wedged updater session | Feed check fails with `net::ERR_*` while Node's `fetch` reaches the feed; ADE retries with a fresh session, then switches the updater to Node HTTP/HTTPS if Chromium still fails | Recovered checks continue normally; if the Node transport also fails, the check reports `network` at phase `check` | Same as a check failure |
| Checksum/signature | Rejected verification or updater `error` event | `verification` / `signature` | Clear unsafe cached data |
| Permission | Synchronous throw or updater `error` event | `permission` | Preserve only a previously verified download |
| Installer handoff | Synchronous throw, async updater `error`, or watchdog expiry | `installer` | Preserve the verified download |
| Vanished staged archive | Missing ZIP/EXE at install or periodic ready check; Squirrel `network connection was lost` / `Cannot pipe` during install | Re-download, then continue the same consented install | Clear the empty cache and fetch again; leftover updater errors during restore do not wipe a restored ZIP; park as `refresh_failed` or `handoff_failed` only if restore or the retry still fails |

The service tests reproduce each feasible boundary deterministically by
injecting disk measurements and updater errors. Preparation has a 30-second
watchdog, while the native Squirrel handoff has a separate five-minute watchdog
so loopback transfer and staging are not mistaken for a stalled quit. Handoff
timeouts retain the pending-install marker because Squirrel may still complete;
an explicit updater error clears it.

## Wedged updater session

electron-updater fetches through Chromium's `net` on one session it caches for
the life of the process. That session can stop working while the machine is
online: checks then fail with `net::ERR_FAILED` a few milliseconds after they
start, before any request leaves the machine. ADE now recovers the updater
transport for the rest of that launch.

When a check fails with `net::ERR_*`, `checkFeedRecoveringNetSession` asks
Node's `fetch` for the channel file (`latest-mac.yml` / `latest.yml`) on the
configured feed (`updaterNetRecovery.ts`). If Node gets no success response
either (no answer, a 404, a 5xx, a captive portal's page), the feed itself is
unavailable: `network`, "ADE can't reach the update server". If Node gets a
success response, the updater gets a fresh in-memory session
(`electron-updater-recovered-<n>`) and the check runs once more. If Chromium
still fails on that session, ADE replaces the updater executor's request
creation with Node's `http` / `https` transports and retries again. The Node
executor follows `location` redirects for both feed checks and artifact
downloads, and remains active for the rest of that launch.

`autoUpdate.net_wedge_detected` records the Node probe and starts recovery
without waiting for Chromium diagnostics. `autoUpdate.chromium_net_diagnostics`
later records default-session reachability, network-service pid/age, and app
uptime. `autoUpdate.net_wedge_recovered` records whether a fresh Chromium
session or Node transport recovered the check. Only if the final Node request
also fails does the check report a normal `network` error; a feed reachable by
Node no longer requires restarting ADE just because Chromium's updater session
is stuck.

## Quit deadline during the native handoff

`quitAndInstall` arms a deadline before entering `electron-updater` so a quit
that never happens cannot strand the app in `installing` forever. The window has
to respect what Squirrel.Mac actually does after that call: pull the archive
from the loopback server, expand it, code-sign verify the expanded bundle, then
spawn ShipIt. On a ~750 MB archive that is roughly ten seconds, and it scales
with bundle size and disk contention.

So the deadline is staged rather than a single hard bound:

| Stage | Default | Behavior |
| --- | --- | --- |
| Soft mark | 10s | Logs `autoUpdate.quit_staging_slow`. Never fatal. |
| Native staging complete | — | Electron's own `autoUpdater` emits `update-downloaded`; logs `autoUpdate.native_staging_complete` and re-arms the short bound below. |
| Post-staging bound | 15s | ShipIt is already running, so a process still alive here is genuinely wedged: escalate. |
| Hard bound | 5min (macOS) / 60s elsewhere | Staging never signalled at all: escalate. |

The staging signal comes from Electron's own `autoUpdater` — the Squirrel.Mac
binding `electron-updater`'s `MacUpdater` drives underneath — resolved through
`require("electron")` at construction and only on darwin, degrading to "no
staging signal" if it is absent rather than throwing. Everywhere else the
installer is an external process (NSIS, AppImage) that never emits that event,
so nothing stages in-process, the long bound could only hang the app in
`installing` for five minutes, and the shorter 60-second bound applies from the
start.

Escalation logs `autoUpdate.quit_escalated` with its `hard_deadline` /
`post_staging` reason and whether staging had completed, captures the matching
`ade_update_quit_escalated` analytics event, and calls `logger.flushSync()`
before `forceQuit`, because `forceQuit` ends the process and ordinary log writes
are batched onto an async stream — without the sync drain the escalation record
dies with the process and the failure leaves no trace.

A single hard bound around ten seconds cannot work: it force-quits the process
mid-staging and loses that race most of the time, so the app quits, nothing
installs, and it relaunches on the old version.

## When an install does not land

Relaunching on the old version while a `pendingInstallUpdate` marker exists
means the handoff never completed. `reconcilePersistedUpdateState` records this
in the `failedInstallAttempts` global-state row (target version + consecutive
count + timestamp), logs `autoUpdate.install_did_not_land`, captures the
internal-only `ade_update_install_did_not_land` event with just the bounded
`attempt` counter, and exposes `lastInstallFailed` on the snapshot so the
top-bar pill reads "Retry install vX" instead of silently offering the same
update again. Requesting another install clears `lastInstallFailed` (the new
attempt supersedes the notice). A launch on the target version or newer clears
`failedInstallAttempts` entirely, even when no pending marker remains, as when
an earlier launch already consumed the marker; a landed retry does not log
`install_did_not_land`.

The first such failure **keeps** the cached archive. It was checksum-verified
before the update was ever offered, so a lost quit race says nothing about the
bytes, and re-downloading the whole release on every retry is pure cost. A
second consecutive failure on the same version stops trusting the archive and
clears the updater cache.

## Checking while an update is staged

A staged update does not pause update checks. The startup timer, the periodic
timer, the Settings **Check for updates** button, `ade update`, and the
`update.checkForUpdates` ADE action all reach the same code, and it behaves the
same way for all of them while the status is `ready`:

| Feed answer | Result |
| --- | --- |
| Same or older than the staged version | Ignored (`autoUpdate.update_available_ignored`). The status, the staged version, and the cached archive do not change; `latestKnownVersion` still records what the feed reported. |
| Strictly newer | Supersedes. The recorded `downloadedFile` is dropped, the updater cache is wiped with reason `superseded_ready_update`, any auto-apply countdown for the old version is cancelled, and the snapshot runs `checking` → `downloading` → `ready` on the new version. The countdown re-arms on the new `ready`. |
| The check fails | The staged version, ready status, and cached archive stay intact. ADE records the failure kind, message, and time in `checkFailure`, and logs `autoUpdate.ready_check_failed`. |

Every answered feed check records `lastCheckedAt` and clears any prior
`checkFailure`. Settings → About shows the last check time, or the failure kind
and time when the latest check did not get an answer. `ade update status` exposes
the same timestamps and failure kind to CLI users.

Every entry point first logs `autoUpdate.check_requested` with the current
status and a `userInitiated` label, so an operator can tell whether a check was
requested at all and what state it found. The flag does not change whether the
check runs.

This is what stops the top-right pill from offering a release the feed has
already replaced.

A failure *after* a supersede has started is an ordinary download failure: the
status is no longer `ready`, so it takes the normal error path. The old archive
is already gone at that point, which matches what a relaunch would have done.

When the staged archive has vanished, that cycle restores the archive and skips
the feed check, so one cycle never runs a restore and a check at the same time.

An install that is already running blocks the check entirely. The status stays
`ready` for the whole `quitAndInstall()` transaction, across the
`beforeQuitAndInstall` service uninstall, so a check started in that window
could supersede and delete the archive the install is about to hand to
Squirrel or NSIS. The pre-install refresh inside that transaction is the one
exception, and it keeps its own failure handling: a feed failure there aborts
the install with `parked.reason === "refresh_failed"` and returns the snapshot
to `ready` on the staged version.

## Truthful version surfaces

Every version surface reads from one shared snapshot so they can never disagree
about what is running versus what is staged. `AutoUpdateSnapshot` carries both
`currentVersion` (the running build) and `latestKnownVersion` (the newest
version `electron-updater` has observed from its configured feed), plus the
staged `version`, `parked`, and `autoApplyPending` fields below.
`useAutoUpdateSnapshot` (`renderer/components/app/useAutoUpdateSnapshot.ts`)
does the initial `updateGetState()` read and subscribes to `onUpdateEvent`; the
top-bar pill (`AutoUpdateControl`), the app-shell banner (`AutoUpdateBanner`),
and the Settings About panel (`AboutSection`) all consume it. About shows the
running version as "Installed" and `latestKnownVersion` as "Latest", but swaps
"Installed" to the staged version when a download is `ready` or `parked`, so the
user sees the version they will get after the next restart rather than a stale
"you're up to date".

## Transactional install and exceptional recovery banners

`quitAndInstall()` is transactional. Before flipping the snapshot to
`installing` it re-runs `updater.checkForUpdates()` to
confirm the staged installer is still the latest, verifies the staged ZIP or
NSIS installer is still on disk (and re-downloads it if macOS or Windows
removed it), and only then uninstalls the background service, persists
`pendingInstallUpdate`, and calls `updater.quitAndInstall(false, true)`. A
consent that aborts before the native updater can take over does not silently
vanish: the snapshot records `parked: { reason, at }` where `reason` is a typed
`AutoUpdateInstallAbortReason` — `refresh_failed`, `install_preflight_failed`,
`prepare_failed`, `prepare_timeout`, or `handoff_failed`. The app-shell
`AutoUpdateBanner` renders this exceptional state as "ADE update didn't finish
— Restart to retry". It also renders "ADE update did not install — Restart to
retry" when launch reconciliation proves that a requested install returned on
the old version. Both provide a **Restart now** action wired to
`updateQuitAndInstall()`. A normally downloaded `ready` update appears as a
floating app-shell prompt with its version and a **Restart and install** action,
alongside the flashing top-right `AutoUpdateControl`. Both actions use the same
impact confirmation and install handler. Dismissing the floating prompt hides
it for that version in the current app session; the top-right control remains
available, and a new version raises a fresh prompt. Recovery-banner dismissal
is keyed on a stable failure signature so a fresh abort or failed attempt
reappears while an unchanged state stays hidden.

## Applying an update is one transaction

Replacing the application bundle does not touch the background service, which
keeps running the old code until something reinstalls and restarts it. That
repair used to happen invisibly inside `localRuntimeConnectionPool`'s
build-hash mismatch path, so a failure produced a silently broken app.

The relaunch after an update now runs one explicit transaction with four steps —
`swap`, `service`, `restart`, `health` — modelled by the dependency-injected
`runUpdateTransaction` in `apps/desktop/src/main/services/updates/updateTransaction.ts`.
It is pure: no Electron, no timers. `main.ts` runs it once when the snapshot
carries `recentlyInstalled`, binding the steps to the paths that already exist —
`localRuntimePool.installServiceBestEffort()` for `service`,
`runVerifiedRuntimeRestart` (which drives the shared
`ProjectRecoveryService.restartBrain()`) for `restart`, and `checkRuntimeIdentity`
for `health`. There is no second restart path, and `main.ts` now owns the single
recovery service instance it shares with `registerIpc`, so repair and restart
stay mutually exclusive.

### The restart step has to be told the truth

Reinstalling the service does not necessarily replace the brain. The old
process can survive the reinstall and keep the socket, the machine-wide
sync-host lease, and everything that follows from holding it. The step used to
ask the endpoint whether it was `ok`, and a pre-update brain answers `ok`
perfectly well — so the transaction reported a green restart while the machine
went on running yesterday's code, invisibly, until something else broke.

`updates/runtimeRestartVerification.ts` replaces that question with an identity
check. `verifyRuntimeIdentity` is pure and returns a named verdict:

| Verdict | Meaning |
| --- | --- |
| `matches` | The brain answering is the one this update installed. |
| `unreachable` | Nothing answered the endpoint. |
| `incompatible` | Something answered but the handshake failed. |
| `version` | The answering brain reports the wrong version. |
| `build` | Right version, wrong build hash. |
| `stale_runtime` | A live pre-update brain is still running under a different pid. |

A skip is now something the step has to *earn*: version, build hash, and the
absence of a live mismatched pid must all agree. A newer compatible brain
deliberately passes — a user who is already ahead of this update does not need
their brain restarted backwards. Anything else restarts and re-verifies, up to
`maxRestarts` (2), and a run that still cannot prove the right brain is running
returns a **failed** step ("… Still wrong after N restart(s)") rather than a
green one. The `restart` and `health` steps call the same
`checkRuntimeIdentity`, so the two cannot disagree about what is running.

Recognising a stale brain requires having seen it: the transaction probes the
machine's identity *before* reinstalling, so the pid it may later find squatting
is one it can name. `processes/processStartTime.ts` guards that record — a pid
alone is not identity once the OS starts recycling them.

### Resuming the chats an update interrupts

Installing an update quits the app and restarts the brain, which stops every
chat with a live turn. The install confirmation names those chats and offers one
checkbox (default on) to resume them. When the user accepts with the box
checked, the list is persisted with the pending install; it is not turned into
work yet.

The launch that actually lands the install is the only one that arms the resume.
`reconcilePersistedUpdateState` moves the list onto `recentlyInstalledUpdate`,
and main arms one durable scheduled-work row per chat under the `update_restart`
source. A failed or declined install clears the pending record, so it can never
leave a resume behind: nothing is armed until the new version is running. Each
armed session is consumed from the persisted list, so a later launch does not
arm it twice; a chat whose project was not reachable stays on the list and gets
another attempt.

Each row delivers the "ADE restarted to install an update…" continue prompt
once. Only rows that actually landed `scheduled` (not paused) are reported in
the post-update "Scheduled N chats to resume" notice, and typing into a chat
cancels its pending resume. Remote-machine chats and terminals are never
included.

### Repair is suppressed while an update is applying

The connection pool repairs a machine endpoint that is missing or incompatible
by reinstalling and restarting the service. During an update those are exactly
the shapes the updater itself creates, and repairing them starts the old brain
alongside the new one — the pool racing the updater to fix a machine that is not
broken.

`main.ts` therefore brackets both update paths with
`localRuntimePool.beginUpdateWindow(reason)` / `endUpdateWindow(reason)`: around
`prepare_quit_and_install` (ended if the uninstall fails, and unconditionally at
the top of the abort path) and around the post-relaunch transaction (ended in
its `finally`). Inside the window the pool declines its opportunistic repair,
logs `local_runtime.service_repair_suppressed`, and answers refused connects
with "ADE is applying an update. The background service is restarting."

The window is capped at `LOCAL_RUNTIME_UPDATE_WINDOW_MAX_MS` (2 minutes) and
expires on its own, because suppression that depends on a transaction remembering
to end it would disable recovery for the rest of the session the first time one
does not settle. Outside the window, repair is still throttled — 0 / 5 s / 15 s /
30 s / 60 s, then once a minute — since a mismatched runtime previously spawned
one installer per connect attempt.

The typed result rides the existing `AutoUpdateSnapshot` over
`IPC.updateEvent` / `updateGetState` as `updateTransaction`; no new channel. A
failure names the step in plain words. A failed `swap` is a warning banner in
`AutoUpdateBanner` (it stands down while the staleness banner already offers
the retry). Every other failed step means the background service is down, and
`BrainDownNotice` owns it: one error banner with the cause, **Fix it** (the real
service reinstall and restart), then **Restart ADE**, then **Reset ADE**, and
**Report issue** under the text — see
[the brain-down notice](../storage-and-recovery/README.md#the-recovery-screen-and-the-brain-down-notice).
A project open the pool refused mid-update (`LOCAL_RUNTIME_UPDATE_IN_PROGRESS_MESSAGE`)
is part of the same notice ("Finishing the update"), never a second banner.

| Step | Line |
| --- | --- |
| `swap` | The update didn't finish installing. ADE is still on the old version. |
| `service` | ADE's background service didn't start after the update |
| `restart` | ADE's background service didn't restart after the update |
| `health` | ADE's background service isn't responding after the update |

When the live service status says macOS's "Allow in the Background" is off,
the notice says that instead of the step's line.

The first failure stops the sequence; later steps are recorded `skipped`. A
dependency that throws becomes a `failed` step, never an unhandled rejection.
Every step is platform-agnostic: install and restart both dispatch through the
ade-cli service manager, which picks launchd or the Windows per-user service,
and the health probe uses whatever endpoint `resolveMachineAdeLayout` reports
(unix socket on macOS/Linux, named pipe on Windows).

## Automatic installation policy

Packaged builds keep checking for and downloading updates, but restarting to
install them is manual by default. Settings > General exposes the machine-local
`AutoUpdatePreferences` contract:

- `automaticInstall: false` by default. A `ready` update waits for the user to
  install it from the top-right control.
- `onlyWhenIdle: true` by default. This nested setting is shown only after
  automatic installation is enabled.

With both options enabled, the service polls the runtime's
`RuntimeActivitySummary`. `idle` is true only when there are no active agent
turns and no active work sessions. After the runtime stays idle through the
grace period, the snapshot gets an `autoApplyPending: { deadlineAt }`
countdown. If `onlyWhenIdle` is disabled, a newly ready update starts the same
countdown immediately without querying runtime activity.

`AutoUpdateBanner` renders the countdown as an "ADE will update in Ns" toast
that ticks once per second. Reaching the deadline while the policy is still
enabled and any required idle condition still holds calls the transactional
`quitAndInstall()` path and emits `ade_update_auto_applied`. Renewed activity
clears an idle-only countdown. An explicit **Cancel**
(`updateCancelAutoApply`) sets `autoApplySuppressedUntil` so another countdown
does not start until that epoch passes. Disabling automatic installation also
clears a pending countdown. `ADE_DISABLE_AUTO_UPDATE_APPLY=1` is the
process-level kill switch for all automatic installation.

Changing either preference persists it to the Electron user-data
`ade-state.json` and records one privacy-bounded `ade_feature_used` event at the
update-service boundary. Only the coarse automatic/manual and
idle-only/immediate choices are included, with a 24-hour deduplication window
per combination; no paths, versions, session details, or activity counts leave
the machine.

`installing` remains a sticky status throughout: the service ignores
`update-not-available` / `checking-for-update` / `error` while a
`quitAndInstall` is in flight.
