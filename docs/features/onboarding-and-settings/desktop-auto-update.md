# Desktop auto-update

Packaged builds check for and download updates on their own; installing is
manual unless the person turns on automatic installs. One `quitAndInstall()`
path serves the top-bar control, the restart banner, Settings, `daex update
install`, remote "Update & restart", idle auto-apply and install-on-quit.

## Source file map

Paths are relative to `apps/desktop/src/` unless they start with `apps/`.

- `main/services/updates/autoUpdateService.ts`: the electron-updater wrapper and
  `AutoUpdateSnapshot` (status `idle` / `checking` / `downloading` / `ready` /
  `installing` / `error`, `currentVersion`, `latestKnownVersion`, `parked`,
  `lastInstallFailed`, `autoApplyPending`, `updateTransaction`, …).
- `autoUpdateErrors.ts`: error classification and the macOS artifact limit.
- `downloadStallWatchdog.ts`, `updaterNetRecovery.ts`: stalled downloads and a
  wedged Chromium session.
- `updateTrackFeed.ts`, `trackSwitchGuard.ts`, `shared/updateTrack.ts`,
  `apps/ade-cli/src/services/runtime/updateTrackStore.ts`: Stable and Beta.
- `updateTransaction.ts`, `runtimeRestartVerification.ts`: the post-update
  transaction.
- `installOnQuit.ts`, `windowsInstallProgress.ts`, `remoteUpdateInstall.ts`,
  `updateWorkspace.ts`, `nativeUpdateInstall.ts`.
- `clientUpdateGate.ts`, `shared/clientUpdateGate.ts`: the minimum-build gate.
- `appBundleOwnership.ts`, `registerAppBundleOwnershipIpc.ts`,
  `app/AppBundleOwnershipBanner.tsx`: a root-owned app bundle on macOS.
- `shared/updateVersions.ts`: the one version comparator
  (`compareUpdateVersions`) and `isWindowsSelfInstallBlocked`.
- `app/useAutoUpdateSnapshot.ts`, `app/AutoUpdateControl.tsx`,
  `app/AutoUpdateBanner.tsx`, `settings/AutoUpdatesSection.tsx`: the UI.
- `apps/ade-cli/src/commands/brainUpdate.ts`, `macDesktopUpdate.ts`,
  `windowsDesktopRescue.ts`: `daex brain update`, which also updates an
  installed desktop app.
- `apps/desktop/scripts/artifact-size-budget.cjs`: release size budgets.

## Gotchas

- **Compare versions with `compareUpdateVersions`**, never `===`.
- **Install refreshes before quitting.** `quitAndInstall()` re-runs the feed
  check before `installing`, or DAEX could install a stale download.
- **`installing` is sticky; `ready` is not.** While installing, the service
  ignores `update-not-available`, `checking-for-update` and `error`.
- **Parked is not failed.** An aborted install goes to `snapshot.parked`, not
  `error`; the download stays.
- **A `ready` snapshot is not proof the archive exists.** The OS may purge the
  updater cache (`~/Library/Caches/ade-desktop-updater`,
  `%LOCALAPPDATA%\ade-desktop-updater`), and on macOS the loopback server that
  feeds Squirrel starts at download time. DAEX re-downloads a vanished archive
  before handoff and on the periodic ready check, and treats install-time
  `Cannot pipe` / `ENOENT` / "network connection was lost" as a vanished archive
  (restore and retry once, then park as `handoff_failed`).
- **`artifact_too_large` is never classified from message text**; the
  preflight passes its `kind` explicitly.

## The minimum-build gate

The account server can require a minimum build (`GET /client/minimum`). Desktop
main reads it at launch, every 3 hours and on focus after 30 minutes without a
read (`main/services/updates/clientUpdateGate.ts`; rule
`desktopUpdateRequirement`; iOS `ClientUpdateGate.swift`). A stale or failed
read never blocks. A blocked build shows the update screen and drops its own
Sentry events. Setting and undoing it: [the update gate
playbook](../../playbooks/update-gate.md).

## Platform paths

**macOS**: `electron-updater` with the ZIP target. `autoDownload` is off so
DAEX can preflight size and free space first; differential downloads are off.
After download, Squirrel.Mac fetches the ZIP through a loopback server and
ShipIt replaces and relaunches the app. Volume checks: the updater cache before
download, `process.execPath` before install.

**Windows**: per-user NSIS with `latest.yml` + blockmap. `app-update.yml` comes
from the build's publish config and must match `ADE_RELEASE_REPOSITORY` (default
`arul28/ADE`; forks override). The handoff is silent
(`quitAndInstall(true, true)`).

- **Progress window.** `windowsInstallProgress.ts` starts
  `windows-update-progress.ps1` from `%LOCALAPPDATA%\ADE\update-progress-<channel>\`
  (outside the install folder, not `%TEMP%`) through `cmd /c start`. It shows
  "Updating DAEX to vX" until the new DAEX has a window. If no new DAEX appears,
  or the installer runs past 10 minutes, it stops the installer and opens DAEX
  itself, because a remote update has nobody at the PC. Its heartbeat makes a
  copy opened by hand mid-install step aside.
- **No installer dialog may wait during a silent update.** `installer.nsh`
  replaces electron-builder's "uninstall failed" box
  (`customUnInstallCheck*`): it reopens the old DAEX on a silent update and
  exits 2, leaving the old install for a retry. First it runs
  `build/ade-update-holders.ps1` (Restart Manager) and writes the processes
  holding the install folder to `<ade home>\runtime\update-blocked.json`. The
  brain reports it in its handshake (`runtimeInfo.lastUpdateBlock`,
  `apps/ade-cli/src/lib/hostUpdateFacts.ts`), and another computer's Machines
  card names the blocker
  (`renderer/components/remoteTargets/machineUpdateStatus.ts`; the phone has
  the same rules in `MachineUpdateStore.swift`).
- **In-place updates do only what an update needs** (`-Updating`): stop the
  service, refresh the terminal shim, leave PATH, link handlers, associations
  and the firewall rule. The relaunched app reinstalls and restarts the service
  (the transaction below). Every step logs to `runtime/install-steps.log` in the
  channel's DAEX home.
- **Service-removal preflight.** `readRecordedBrain`
  (`apps/ade-cli/src/serviceManager/installWindows.ts`) refuses to stop a brain
  whose recorded command differs from the one DAEX would launch.
  `checkWindowsServiceRemovable` runs it read-only, so `remoteUpdateInstall.ts`
  answers `failed` with the reason instead of dying. Builds that cannot
  self-install (`isWindowsSelfInstallBlocked`) are updated through a remote
  terminal ([Remote runtime](../remote-runtime/README.md#machineupdateandrestart)).
- `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1` gates publishing Windows release
  assets; the build fails closed on Authenticode.

**`daex brain update --apply-staged` updates the app too.** On Windows with an
app installed, `applyWindowsDesktopUpdate` verifies the installer's sha512 and
Authenticode signer, stops the service, runs the installer with `--updated /S`
and restarts the service from the app's CLI; failure restores the old service.
On macOS with `ADE.app` in `/Applications` or `~/Applications`,
`applyMacDesktopUpdate` asks an open app to install its own update, or swaps a
closed app's bundle after checking the zip's SHA-512, `codesign`, Team ID,
bundle id and version, and registers the service on the app's runtime. Anything
unsafe changes nothing and says why. An Alpha app has no feed and is reported as
behind. On Linux the app updates itself or through the package manager.

### App bundle ownership

A root-owned `/Applications/ADE.app` makes every update ask for a password.
`AppBundleOwnershipBanner.tsx` offers **Fix it** (an admin `chown -R` through
`osascript`). The IPC is local-only and takes no pin.

## Update tracks (Stable and Beta)

Beta is an update track of the normal install, not a separate app: same
`ADE.app`, `~/.ade`, service and CLI.

- **A build's track comes from its version**: `X.Y.Z-beta.N` is Beta
  (`shared/updateTrack.ts`).
- **The choice** is `~/.ade/update-track.json`, read by app, brain and CLI. A
  missing file means the running version's track.
- **The Beta feed** is the fixed GitHub prerelease `beta-feed`
  (`latest-mac.yml`, `latest.yml`, `beta.json`); a 404 means no Beta build and
  shows no error. electron-updater's GitHub provider is not used for Beta.
- **Checks never cross tracks.** A build is offered only when it is on the
  selected track and newer.
- **The guarded switch** (`trackSwitchGuard.ts`) reads the target's
  `release-manifest.json` and blocks when any local database's compat level
  (`dbCompatRecord.ts`, `DB_COMPAT_LEVEL` in `shared/releaseCompat.ts`) is
  higher, or unreadable.
- **Database copies**: before a new version first opens a database, DAEX copies
  it to `<db>.pre-<version>-from-<previous>.bak` (SQLite online backup; last 3
  kept). Settings › Advanced › Database copies lists them.
- **Other machines.** Remote "Update & restart"
  (`apps/ade-cli/src/services/runtime/machineUpdateAndRestart.ts`) never moves a
  machine across tracks. Each update check reads the newest Stable and Beta
  manifests (`latestByTrack.ts`), so another machine is offered the newest
  build on its own track. The phone and DAEX Web learn it from the account
  directory's `GET /releases/latest`. General's update rows offer a Stable/Beta
  choice per eligible computer; the web has no `switchUpdateTrack`.
- `daex brain update` with `latest` follows the machine's track.

Beta builds come from `.github/workflows/beta.yml`.

## Size and space

- **Artifact limits** (`artifact-size-budget.cjs`, `npm run
  assert:artifact-size`): 800 MiB per macOS ZIP, 900 MiB per Windows installer.
  Squirrel.Mac buffers the whole ZIP and crashes the app past 1 GiB, so the
  runtime refuses a darwin download over 800 MiB (`artifact_too_large`,
  `exceedsMacUpdateArtifactLimit`). Missing size metadata is allowed through.
  Each packaging job pins `ADE_RUNTIME_TARGET` so the bundle carries one
  runtime target.
- **Required space**: download `2 × archive + 512 MiB`; install `5 × archive +
  512 MiB`; 512 MiB assumed without metadata.

## Failures

| Failure | Classification | Cache |
|---|---|---|
| Size or capacity preflight | `artifact_too_large` / `insufficient_space` | nothing downloaded, or keep a verified download |
| `ENOSPC` / `EDQUOT` | `disk_full` / `quota` | keep a verified download, clear partial data |
| Network, stalled download | `network` | retry; partial data may be cleared |
| Checksum / signature | `verification` / `signature` | clear |
| Permission | `permission` | keep a verified download |
| Installer handoff | `installer` | keep |

- **Stalled downloads**: electron-updater's timeout does not fire in Electron.
  `downloadStallWatchdog.ts` cancels after 2 minutes with no progress and no
  growth of the partial file; sleep resets the window.
- **Wedged updater session**: when a check fails with `net::ERR_*` but Node's
  `fetch` reaches the feed, DAEX retries on a fresh session, then switches the
  updater to Node `http`/`https` for the rest of the launch
  (`updaterNetRecovery.ts`; logs `autoUpdate.net_wedge_detected` /
  `_recovered`).
- **Quit deadline** during handoff: a soft mark at 10 s, 15 s after Squirrel
  signals staging complete, and a hard bound of 5 min on macOS (60 s
  elsewhere). Escalation logs `autoUpdate.quit_escalated` and calls
  `logger.flushSync()` before force-quitting. A single short bound would kill
  Squirrel mid-staging.
- **An install that does not land**: relaunching on the old version with a
  pending marker records `failedInstallAttempts`, logs
  `autoUpdate.install_did_not_land` and sets `lastInstallFailed` ("Retry install
  vX"). The first failure keeps the archive; a second on the same version clears
  the cache.

## Checking while an update is staged

A staged update does not pause checks; every entry point behaves the same while
`ready`:

- Same or older feed answer: ignored; `latestKnownVersion` still updates.
- Strictly newer: supersedes (cache wiped, countdown cancelled, download
  restarts).
- A failed check keeps the staged version and records `checkFailure`.

Only a running `quitAndInstall()` blocks a check, because the status stays
`ready` until the handoff and a supersede then would delete the archive being
handed to Squirrel or NSIS. The pre-install refresh inside it parks as
`refresh_failed` on failure.

## Install and recovery UI

`useAutoUpdateSnapshot` is the one subscription for the top-bar control, the
banner and Settings, so they never disagree. Settings shows the staged version
as "Installed" once it is `ready` or `parked`.

- `quitAndInstall()` re-checks the feed, verifies the staged file, uninstalls
  the background service, saves `pendingInstallUpdate` and hands off. An abort
  before handoff sets `parked` with an `AutoUpdateInstallAbortReason`
  (`refresh_failed`, `install_preflight_failed`, `prepare_failed`,
  `prepare_timeout`, `handoff_failed`).
- A `ready` update shows a floating prompt (**Restart and update**, or **Restart
  and switch to Stable/Beta** when the build is on the other track;
  `updateRestartAction.ts` names it once for every surface). Dismissal hides it
  for that version this session.
- Recovery banners: "DAEX update didn't finish — Restart to retry" (parked) and
  "DAEX update did not install — Restart to retry" (did not land), dismissed by
  failure signature.
- The install prompt says what the restart stops, read from the brain's
  `runtime.updateImpact` (`main/services/runtime/updateImpactProbe.ts`).

## Applying an update is one transaction

Replacing the app bundle does not restart the background service, so the
relaunch after an update runs one transaction: `swap` → `service` → `restart`
→ `health` (`runUpdateTransaction`, `updateTransaction.ts`; pure, dependencies
injected). `main.ts` runs it once when the snapshot has `recentlyInstalled` and
shares one `ProjectRecoveryService` with `registerIpc`, so repair and this
restart exclude each other.

- **The restart step checks identity, not `ok`.** An old brain answers `ok`.
  `verifyRuntimeIdentity` returns `matches`, `unreachable`, `incompatible`,
  `version`, `build` or `stale_runtime`; anything but `matches` (or a newer
  compatible brain) restarts and re-verifies up to 2 times, then fails the step.
  The machine's identity is probed before the reinstall so a squatting old pid
  can be named (`processes/processStartTime.ts`).
- **Repair is suppressed while an update applies.** `main.ts` brackets both
  update paths with `localRuntimePool.beginUpdateWindow` / `endUpdateWindow`;
  inside, the pool skips its repair and refuses connects with "DAEX is applying
  an update…". The window expires after `LOCAL_RUNTIME_UPDATE_WINDOW_MAX_MS`
  (2 minutes).
- **That launch waits for the transaction** (up to 30 s) before opening
  projects, since the pool refuses them meanwhile.
- **Failures**: the first failed step stops the sequence (later ones
  `skipped`). A failed `swap` is a warning in `AutoUpdateBanner`; any other
  failed step means the service is down and `BrainDownNotice` owns it
  ([the brain-down notice](../storage-and-recovery/README.md#the-recovery-screen-and-the-brain-down-notice)).

### Resuming interrupted chats

Whether a chat continues after the update is the machine's **Continue chats
after restarts** setting (`~/.ade/continue-after-restart.json`), by the same
rule as a crash (`continueAfterRestartHold` in `agentChatService.ts`). The
accepted list is saved with the pending install, and only the launch that lands
the install arms the resumes (`armUpdateResume`, durable `update_restart` rows
with deterministic ids, so a chat continues once). Typing into a chat cancels
its pending resume. The brain side is independent: before the service stops it
writes the `accepted_update` stop intent and saves its work
([work in flight across a brain stop](../storage-and-recovery/README.md#work-in-flight-across-a-brain-stop)).

## Automatic installation

`AutoUpdatePreferences` (Settings › General, saved in `ade-state.json`):
`automaticInstall` (default false) and `onlyWhenIdle` (default true).

- With idle-only on, the service polls `RuntimeActivitySummary` and starts the
  `autoApplyPending` countdown after a continuous idle grace period; activity
  clears it. Without idle-only, a ready update starts the countdown at once.
- The toast "DAEX will update in Ns" offers **Cancel**, which sets
  `autoApplySuppressedUntil`.
- `ADE_DISABLE_AUTO_UPDATE_APPLY=1` is the kill switch; dev launches never
  auto-apply.

**Installing on quit**: with automatic install on, quitting installs a
downloaded update only when that stops nothing (`decideInstallOnQuit`,
`installOnQuit.ts`): the service brain runs no chat turn, CLI or terminal, or
the app runs the brain itself. Work is re-read right before the service stops.
The updater's own relaunch starts hidden, runs the transaction and closes
(windows of 10 minutes, 3 on macOS where Squirrel leaves no marker).
