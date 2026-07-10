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
injecting disk measurements and updater errors. The install watchdog covers the
macOS case where `quitAndInstall()` returns but no quit, relaunch, or error event
follows.
