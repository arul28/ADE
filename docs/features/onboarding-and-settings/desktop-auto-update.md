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
   signal.
4. The packaged-artifact smoke test requires the generated update authority
   to match `ADE_RELEASE_REPOSITORY`, preventing a fork build from silently
   checking a different repository.

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
attempt supersedes the notice); a launch that does land on the target version
clears `failedInstallAttempts` entirely.

The first such failure **keeps** the cached archive. It was checksum-verified
before the update was ever offered, so a lost quit race says nothing about the
bytes, and re-downloading the whole release on every retry is pure cost. A
second consecutive failure on the same version stops trusting the archive and
clears the updater cache.

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
`installing` it re-runs `updater.checkForUpdates({ allowReady: true })` to
confirm the staged installer is still the latest, then persists
`pendingInstallUpdate` and calls `updater.quitAndInstall(false, true)`. A
consent that aborts before the native updater can take over does not silently
vanish: the snapshot records `parked: { reason, at }` where `reason` is a typed
`AutoUpdateInstallAbortReason` — `refresh_failed`, `install_preflight_failed`,
`prepare_failed`, `prepare_timeout`, or `handoff_failed`. The app-shell
`AutoUpdateBanner` renders this exceptional state as "ADE update didn't finish
— Restart to retry". It also renders "ADE update did not install — Restart to
retry" when launch reconciliation proves that a requested install returned on
the old version. Both provide a **Restart now** action wired to
`updateQuitAndInstall()`. A normal downloaded `ready` update stays in the
top-right `AutoUpdateControl` and does not duplicate that control with a wide
banner. Banner dismissal is keyed on a stable failure signature so a fresh
abort or failed attempt reappears while an unchanged state stays hidden.

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
