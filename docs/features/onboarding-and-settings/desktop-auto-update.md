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

The practical volume checks are therefore:

- Before download: ADE's resolved updater cache path.
- Before staging/install: `process.execPath`, which resolves to the installed
  application bundle's volume on macOS.

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
| Capacity preflight | Synchronous ADE check before download/install | `insufficient_space` with measured free/required bytes and affected path | Preserve only after a verified download |
| `ENOSPC` | Synchronous throw, rejected download, or updater `error` event | `disk_full` at the active phase | Preserve a verified download; clear incomplete download data |
| `EDQUOT` | Rejected download or updater `error` event | `quota` at the active phase | Same as `ENOSPC` |
| Network | Rejected check/download or updater `error` event | `network` | Retry; incomplete cache may be cleared |
| Checksum/signature | Rejected verification or updater `error` event | `verification` / `signature` | Clear unsafe cached data |
| Permission | Synchronous throw or updater `error` event | `permission` | Preserve only a previously verified download |
| Installer handoff | Synchronous throw, async updater `error`, or watchdog expiry | `installer` | Preserve the verified download |

The service tests reproduce each feasible boundary deterministically by
injecting disk measurements and updater errors. Preparation has a 30-second
watchdog, while the native Squirrel handoff has a separate five-minute watchdog
so loopback transfer and staging are not mistaken for a stalled quit. Handoff
timeouts retain the pending-install marker because Squirrel may still complete;
an explicit updater error clears it.

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

## Transactional install and the parked banner

`quitAndInstall()` is transactional. Before flipping the snapshot to
`installing` it re-runs `updater.checkForUpdates({ allowReady: true })` to
confirm the staged installer is still the latest, then persists
`pendingInstallUpdate` and calls `updater.quitAndInstall(false, true)`. A
consent that aborts before the native updater can take over does not silently
vanish: the snapshot records `parked: { reason, at }` where `reason` is a typed
`AutoUpdateInstallAbortReason` — `refresh_failed`, `install_preflight_failed`,
`prepare_failed`, `prepare_timeout`, or `handoff_failed`. The app-shell
`AutoUpdateBanner` renders a parked state as "Update to vX didn't finish —
Restart to retry" (a parked state wins over a plain `ready` state), and a plain
`ready` state as "Running vCurrent · vNext is ready", each with a **Restart
now** action wired to `updateQuitAndInstall()`. Banner dismissal is keyed on a
stable signature so it reappears when a newer version stages or a fresh abort
occurs, but stays hidden for an unchanged state.

## Idle auto-apply

When auto-apply is enabled (packaged builds with auto-check on, unless
`ADE_DISABLE_AUTO_UPDATE_APPLY=1`), a `ready` update is applied on its own once
the machine is quiet. The service polls the runtime's
`RuntimeActivitySummary` — `idle` is true only when there are no active agent
turns and no active work sessions. After the runtime has been continuously idle
for the idle grace period, the snapshot gets an `autoApplyPending: { deadlineAt }`
countdown; the `AutoUpdateBanner` renders a "Updating to vX in Ns" toast that
ticks down each second. Reaching the deadline while still `ready` and idle calls
the same `quitAndInstall()` path and emits `ade_update_auto_applied`. Any
renewed activity clears the pending countdown, and an explicit user **Cancel**
(`updateCancelAutoApply`) sets `autoApplySuppressedUntil` so another countdown
is not started until that epoch passes. `installing` remains a sticky status
throughout: the service ignores `update-not-available` / `checking-for-update` /
`error` while a quitAndInstall is in flight.
