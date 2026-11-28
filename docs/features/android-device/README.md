# Android device

DAEX drives a per-lane Android emulator from the Work tab's **Android
Development** tool and from `daex android` (`ade android` still works). It makes
a new AVD for the lane or attaches one the user names, boots it headless,
streams the screen through a bundled scrcpy server, and sends touch, keys and
text.

Scope: emulators only (no physical phones), stock system images only, on macOS,
Windows and Linux. The whole backend is Node code in the brain, one path for all
three; there is no native helper. The original plan is
[docs/plans/android-emulator.md](../../plans/android-emulator.md).

## Source file map

All paths under `apps/desktop/src/main/services/android/` unless noted.

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/androidEmulator.ts` (+ siblings `androidEmulator*.ts`) | The contract: types, error codes, service API, action lists (`ANDROID_AGENT_ACTIONS`, `ANDROID_USER_ONLY_ACTIONS`, `ANDROID_PERSON_ONLY_ACTIONS`, …), extras, images, posture, previews, tests, recording, drawer. |
| `androidEmulatorService.ts`, `androidEmulatorServiceDeps.ts` | The service: lane queue, start, stop, input, screenshot, work-copy lanes, start-up cleanup, hand-off. |
| `androidEmulatorLifecycle.ts` | Boot and stop on the lane queue (`startLocked`, `stopLocked`): cloud disk grow, memory reservation, owner record, boot timeout. Serves lane device and extras. |
| `androidEmulatorProcess.ts`, `adb.ts`, `androidDeviceShell.ts` | Emulator boot, discovery files, boot-completed, stop; adb runner; shell and console helpers. |
| `androidEmulatorOwners.ts`, `androidEmulatorSweep.ts`, `androidEmulatorUse.ts`, `androidEmulatorImage.ts` | Machine owner file, the sweep, what counts as use, idle stop, pin, image-name checks before a kill. |
| `androidHandedOffEmulators.ts` | Started-emulator state files and the stops that use them. |
| `androidDeviceInventory.ts`, `androidAvds.ts`, `androidHardwareProfiles.ts`, `androidCatalogProfiles.ts`, `apps/desktop/src/shared/androidDeviceCatalog.ts` | Lane AVD list/create/attach/release/delete, the marker, hardware profiles, the brand grid and its `ade_*` profiles. |
| `androidLaneDeviceStore.ts`, `androidLaneRelease.ts`, `androidLaneRows.ts`, `androidLaneExtras.ts`, `androidDevicePromote.ts` | `lane_android_devices` / `lane_android_extra_devices` rows, release on lane end, extras, promote. |
| `androidLaneMaintenance.ts` | The cleanup pass and the "powered off" record. |
| `androidSdk.ts`, `androidSdkSetup.ts`, `androidSdkInstall.ts`, `androidSdkRepository.ts`, `androidZipExtract.ts`, `androidCli.ts`, `androidJdk.ts`, `androidSystemImages.ts` | SDK detection and acceleration, guided install, manifests, safe unzip, Android CLI, JDK lookup, system images. |
| `androidMachinePreferences.ts` | `<ADE home>/android/settings.json` (`sdkPath`, `preferences`). |
| `androidMemoryGuard.ts`, `apps/desktop/src/main/services/machineStats/hostMemorySignals.ts` | The pre-start memory decision; per-OS memory signals. |
| `androidStream.ts`, `androidStreamServer.ts`, `androidLaneStreams.ts`, `scrcpyServer.ts`, `scrcpyVideo.ts`, `scrcpyControl.ts` | Streams, the loopback server, the lane's stream holders, scrcpy session/video/control. |
| `androidActionDomain.ts` | The `android_emulator` action domain. |
| `androidAgentSuite.ts`, `androidUiSnapshot.ts`, `androidUiTree.ts`, `androidInspect.ts`, `androidAppState.ts` | Agent verbs, UI tree and element queries, Inspect's source search, app state. |
| `androidRecordingSession.ts`, `androidRecording.ts`, `androidDemoRecording.ts`, `androidAutoRecord.ts`, `androidProof.ts` | Recording, MP4 writer, demo video, auto-record, proof filing. |
| `androidDeviceSettings.ts`, `androidStoreShots.ts`, `androidWindows.ts`, `androidChromeSetup.ts`, `androidCrashWatch.ts` | Drawer settings, Play Store shots, window layout, Chrome first run, crash reader. |
| `androidPosture.ts`, `androidLaneQueue.ts`, `androidComposePreviews.ts`, `androidInstrumentationTests.ts`, `androidRender.ts` | Fold, per-lane step queue, Compose previews, instrumentation tests, render broker. |
| `apps/desktop/src/main/services/device/deviceMaintenance.ts`, `deviceLease.ts` | Timers shared with Apple; the shared device lease. |
| `apps/desktop/src/main/services/chat/laneAndroidDeviceDirective.ts` | The turn hint for a lane with an emulator. |
| `apps/ade-cli/src/services/runtime/unmanagedBrainIdleExit.ts` | Idle exit of a marked dev/test brain. |
| `apps/desktop/src/renderer/components/android/` | Pane (`AndroidDevicePane.tsx`), stage, rail, status, picker, setup card, licence dialog, system images, catalog grid, 3D body, fold dock, render sheet, inspect, recording, drawer (`drawer/`), mini player, chips, crash pin, tool card. |
| `apps/desktop/src/renderer/components/device/` | Pieces shared with Apple (flat view, rail, status strip, render, inspect overlay, stream recovery and lease, fold body, hinge slider, drawer shell). |
| `apps/desktop/src/renderer/components/settings/AndroidDevicesSection.tsx` | Settings › Android devices. |
| `apps/desktop/src/renderer/components/terminals/workToolPanels.tsx`, `useRemoteDeviceTabs.ts` | Tool targets (This lane, Android · `<machine>`); auto-added remote device tabs. |
| `apps/desktop/src/renderer/webclient/adapter/androidDevice.ts` | The hosted web client's `androidEmulator` namespace. |
| `apps/ade-cli/src/cliAndroid.ts`, `cliAndroidSuite.ts`, `cliAndroidDevice.ts`, `cliAndroidFormat.ts` | `daex android` plans, hints and text output. Help is in `cli.ts`. |
| `apps/ade-cli/src/services/sync/androidRemoteCommands.ts` | `android.*` remote commands. |
| `apps/ios/ADE/Views/Work/AndroidDeviceViewer*.swift`, `apps/ios/ADE/Services/SyncService+AndroidDevice.swift` | Phone viewer; it shares `AppleStreamSession.swift` and `LiveStageChrome.swift` with the simulator viewer. |
| `apps/desktop/resources/android/` | The scrcpy server jar, licence and version-change README. |

## Gotchas / fragile areas

- **DAEX never deletes an AVD it did not make, and never stops an emulator it
  did not start.** Ownership is the `config.ini` marker plus
  `<project>/.ade/android/started-emulators.json`,
  `started-extra-emulators.json` and the machine owner file. An older brain
  never reads the extras file, so it cannot stop a running extra as an orphan.
- **One encode per emulator.** The emulator has only a software encoder.
  `androidLaneStreams.ts` shares one scrcpy stream among the local viewer, a
  recording, the relay and a remote desktop. scrcpy cannot change a running
  encoder's rate, so a rate change restarts the session on the same transport
  (`AndroidStreamHub.recap`, about 0.5–1 s gap).
- **The stream token is secret-bearing.** `startStream`/`stopStream` are
  viewer-only (`ADE_ACTION_SECRET_BEARING`); `getStreamStatus` always returns
  `transport: null`. Agents use `frame` or `screenshot`.
- **adb `unauthorized`.** An adb server started before `~/.android/adbkey`
  changed never re-reads it. DAEX restarts the server only when no other device
  uses it; otherwise the person confirms **Restart adb and start**. Agents
  cannot restart adb (`restartAdb` is refused by policy).
- **The memory guard's refusal is expected**, not a Sentry issue.
- **Windows:** AVD disks stay locked briefly after exit (deletes retry); renames
  retry while antivirus holds a file; kills check `tasklist` image names first.
- **Older brains and `--device`/`--extra`.** An older brain ignores those fields
  and would act on the lane's own device, so the CLI checks for `devicePromote`
  in its action list and refuses first.

## Requirements

The emulator runs on the lane's brain machine. It needs:

- **The Android SDK.** Found on every use, in this order: the machine's SDK
  setting, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the platform default
  (`~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`, `~/Android/Sdk`), then
  on Linux `/opt/android-sdk` and `/usr/lib/android-sdk`.
- **`platform-tools`** and **`emulator`**.
- **`cmdline-tools`** (or Android Studio) to make devices: DAEX reads hardware
  profiles from its `sdklib` jar. Without it, `device-create` fails with
  `ANDROID_TOOL_MISSING`, but existing AVDs boot.
- **A system image for the host ABI** (`arm64-v8a` on Apple Silicon, `x86_64`
  elsewhere).
- **Acceleration** from `emulator -accel-check`: HVF, WHPX/AEHD, or KVM. WSL2 has
  none; a VM needs nested virtualization. The answer is cached per binary for
  10 minutes (30 s for a check that never answered).

`daex android status` and the pane report each part. A missing SDK shows the
setup card; a non-supported OS reports `platformSupported: false`. Windows on
Arm and Linux arm64 have no Google emulator.

### The setup card

When a needed part is missing, the pane (and Settings › Android devices, for the
machine picked there) shows **Set up Android on this machine**: a checklist of
acceleration, SDK, platform tools, command-line tools, emulator, a phone image,
and the optional Android CLI, with sizes, install folder and free space. Every
call goes to the machine the pin names.

- **Review licences & install** shows each needed licence in full with its own
  box. DAEX never accepts a licence by itself; the brain refuses an install that
  does not name each one (`ANDROID_SDK_LICENSE_NOT_ACCEPTED`).
- **Use mine…** points at an existing SDK (`ANDROID_SDK_PATH_INVALID` if it holds
  none of `platform-tools`, `emulator`, `system-images`).
- Progress comes as `android.sdk.install` events, with a 3 s state read only
  while an install runs.

The install (`androidSdkInstall.ts`) reads Google's stable repository manifests
(no `sdkmanager`, no JDK), picks the newest image whose emulator dependency the
planned emulator meets, resumes downloads in `<sdk>/.ade-downloads/`, checks
SHA-1, unpacks atomically per part through `<sdk>/.ade-staging/`, refuses zip
entries or links that escape the folder, writes `<sdk>/licenses/<id>` plus
`<sdk>/.ade/license-consents.json`, holds `<sdk>/.ade-install.lock`
(`ANDROID_SDK_INSTALL_BUSY`; stale after 6 hours), and checks space first
(`ANDROID_SDK_NO_SPACE`). The Android CLI comes from Google with its `.sha256`
into `<sdk>/android-cli/` and always runs with `--no-metrics`. A folder DAEX
would not find by itself becomes the machine's SDK setting.

Installing, cancelling and picking the folder are the person's
(`ANDROID_PERSON_ONLY_ACTIONS`); `daex android sdk install|use|cancel` refuse in
a terminal and DAEX MCP refuses them.

## Desktop surface

**Android Development** is its own tab in the Work tools pane, laid out like
Apple Development (picker, stage, rail, strips).

### The picker

Shown when the lane holds no device, or from **Switch device…**:

1. **This lane**: the lane's AVD and its **Extra devices**, each with state and a
   ⋯ menu (start beside, make lane device, copy AVD name, remove).
2. **On this machine**: other AVDs. A free one attaches and boots on click. Tags:
   Running/Off, **In use** (another app started it), **Taken** (another lane).
   **Delete device…** only for an AVD DAEX made for this project, unheld and off.
3. **New device**: the brand grid from `shared/androidDeviceCatalog.ts`. A click
   makes an AVD with the newest installed image in that colour and boots it;
   **More…** lists every SDK profile. Non-Pixel brands use DAEX `ade_*`
   profiles merged into `~/.android/devices.xml` (others' profiles kept). Tile
   stills come from one shared WebGL renderer, cached in `localStorage`.
4. **Storage**: sizes per AVD; **Clean up** deletes only what the ⋯ menu could.
5. **System images** (below).

### System images

`AndroidSystemImagesSection.tsx` / `androidSystemImages.ts`, read only while
open. Installed images list size and the AVDs that boot from them
(`image.sysdir.1`). Available images are stable Google Play / Google APIs images
for the host ABI. Install shows the image licence and runs on the machine's one
SDK install job. Remove asks first, names AVDs that use the image, and is
refused while one runs (`ANDROID_SYSTEM_IMAGE_IN_USE`). Changes emit
`android.inventory.changed`. `daex android sdk images [--installed]` lists the
same; install and remove are the person's.

### Stage, rail and drawer

- **Stage**: 3D (catalog or procedural body in the AVD's colour, boot ring on
  screen) or flat, kept per project. WebGL failure falls back to flat. Touch maps
  to device pixels; keys go to the device; Esc sends Back.
- **Rail**: Back, Home, Recents; Power and volume; Orientation; Inspect; Save
  screenshot, Render, Record, View; Device tools; Maximize; More (Switch device,
  body colour, Reset view, Play Store screenshots, **Keep running**, Power off).
  Below 360 px most controls move into More.
- **Inspect** reads the UI tree once and boxes every element; touch is off while
  it is on. **Insert into chat** runs `inspectPoint` on the lane's machine, which
  crops the element and searches the lane's Kotlin, Java and XML for its source
  (`androidInspect.ts`, 1.5 s / 4000 files max). The chip is Apple's
  `ios_element` packet with `metadata.contextSurface: "android-emulator"`.
- **Record** is owned by the chat holding the pane; a receipt says "Saved to
  proof". The button follows `android.recording.state` (no poll).
- **Tools drawer** groups: Device (text/display size, animations, taps, layout
  bounds, accessibility, status bar), App (app in front, Build & run, relaunch,
  install, Run tests, Windows, permissions), Capture (recordings), Emulator
  (appearance, location, battery, radios), Logs (logcat, Send to chat), Previews
  (Compose). One group open; closed groups unmounted. Each change is one call to
  the lane's machine (with the pane's `runtimePin`) and shows the value read
  back, never an unread value. Settings come from one `sh -c` read in
  `androidDeviceSettings.ts`.
- **Quick chips** (Location, Battery, Network, dark mode) and the **crash pin**:
  each booted lane emulator gets one `adb logcat -b crash` reader
  (`androidCrashWatch.ts`); a crash of the lane's app emits
  `android.app.crashed` and sets `appCrash` on lane status for every viewer.

### Fold

A foldable AVD (Pixel Fold, Galaxy Z Fold profiles) has a hinge. The pane reads
`getPosture` once, then follows `android.device.posture`. 3D draws the shared
two-panel body (`device/proceduralFoldBody.ts`); below 30° it draws the cover
phone. The dock has the hinge slider (3D) or Closed/Half/Open (flat); pinch also
folds. The brain (`androidPosture.ts`) sends `sensor set hinge-angle0 <angle>`
on the emulator console and waits up to 3 s for Android to settle
(`settled: false` otherwise). A device without a hinge answers
`supported: false`. Fold states: 0–30° closed, 30–150° half, 150–180° open.

### States

Setup card; no-acceleration banner; Starting (loading card); Live (picture, rail,
live line); Video stopped (Reconnect); Off ("{name} is off." with Start); Crashed
(one-line reason, Restart or **Restart adb and start**, Open log; reported to
Sentry under `android_device_boot`); Low memory (**Start anyway**); Unsupported.
On another machine, **Open log** copies the path.

The live line reads e.g. `Live · 52 fps · lane checkout-flow · on windows`. A
still screen sends no frames, so it shows "Reconnecting…" only when 3 s pass
with no frame and the machine reports frames this window missed, or is
unreachable.

### Where a device runs

A DAEX Cloud computer runs no emulator yet. For a cloud chat the tool says
"Android comes to DAEX Cloud later" and offers the person's own machines
(`workToolStartState.tsx`); the
chat's cloud computer shows as "DAEX Cloud". The **Runs on** row lists the chat's
machine, this computer, then the rest by name.

Closing the tab releases the pane's hold on the stream; the last viewer stops the
stream, the emulator keeps running.

### The floating player

One Apple and one Android player can float over the chat at once
(`AndroidDeviceMiniPlayer.tsx`). Same rules as Apple's: More › Float over chat,
closing the tools pane while live (unless the chat's preview is off),
`daex android show --floating`, or an agent driving the emulator while the chat
is in front. × turns the chat's preview off. The stream lease waits 1 s before
the last viewer's stop so pane and player hand over one stream.

## Lanes and devices

A lane holds one Android device and can hold extras; an AVD belongs to at most
one lane. Android and Apple devices are separate. Rows live in local-only
`lane_android_devices` and `lane_android_extra_devices` (never synced).

- **Created**: DAEX made it (`ade_<lane>_<profile>`, marker in `config.ini`).
- **Attached**: it already existed and stays the user's. A lost marker means the
  user's.
- `daex android stop` on an emulator another app started fails with
  `ANDROID_AVD_RUNNING`. Such emulators count against the memory guard.
- An AVD boots once at a time, each on its own even console port in 5554–5682
  (`ANDROID_NO_FREE_PORT`).

Boot is headless and ready at `sys.boot_completed=1`, waited up to 180 s
(`ANDROID_BOOT_TIMEOUT_MS`). Lifecycle CLI calls have a 4-minute timeout.

### Extra devices

`androidLaneExtras.ts`. `daex android device-create --extra --catalog <id>` (or
`--profile`) makes and boots one unless `--no-start`. Limit 2
(`ANDROID_LANE_EXTRA_DEVICE_LIMIT`); `ADE_ANDROID_LANE_EXTRA_DEVICES` raises it to
8 (`ANDROID_EXTRA_DEVICE_LIMIT`). Each running emulator holds 2–5 GB, and each
start goes through the memory guard.

- The lane device streams, records, runs tests and takes every verb with no
  `--device`. An extra has no stream, recording, lease, crash pin or tests.
- `--device <avd>` on `start`, `stop`, `install`, `launch` and `device-detach`
  reaches an extra (`ANDROID_DEVICE_NOT_LANE_OWNED` otherwise). Extras have
  their own queues.
- `device-promote --device <avd>` swaps roles. Refused with
  `ANDROID_LANE_DEVICE_BUSY` while either device starts, stops, records, streams
  to a viewer, runs tests, installs or launches, or another holder has the lease;
  nothing changes on refusal. Installs and launches started during a promote wait
  and then go to the new lane device.
- `device-attach` of an extra is `ANDROID_DEVICE_IS_EXTRA`.
- `device-detach --device <avd> [--keep]` stops and deletes an extra.

### When a lane ends

Archive and delete stop the lane's stream and emulator, then release
(`androidLaneRelease.ts`): a created AVD is deleted; an attached one only loses
the packages DAEX installed (while it runs); another lane's hold on the same AVD
leaves it alone; a still-running created AVD keeps its row for the cleanup.
Extras end the same way. `device-detach` does this for a lane that stays
(`--keep` keeps a created AVD).

### Emulator lifecycle

One idle policy and one orphan policy (`androidEmulatorOwners.ts`,
`androidEmulatorSweep.ts`, `androidEmulatorUse.ts`):

- **Owner records** go in one machine-wide file,
  `~/.ade/android/emulator-owners.json` (under the default home whatever
  `ADE_HOME` says, so installed, dev and test brains all see it): AVD, port,
  qemu pid and start time, owning brain, lane, project, chat, last used, pin.
  Locked writes, rename into place.
- **Use**: every service call naming the lane, except polls, stops, the pin and
  cleanup (`ANDROID_NOT_USE_METHODS`). Held streams, leases and boots also count.
- **Idle stop**: an unpinned emulator DAEX started that nobody used for
  20 minutes (`ANDROID_EMULATOR_IDLE_MS`; `ADE_ANDROID_IDLE_POWER_OFF_MINUTES` or
  `ADE_ANDROID_IDLE_STOP_MINUTES`, `0` disables) is stopped. Just before, the
  device is asked about outside input (`dumpsys power` `mLastUserActivityTime`)
  and other scrcpy viewers; either restarts the clock. `status` shows
  `poweredOff` until the next start.
- **Keep running** (rail More, or `daex android keep-running on|off`,
  `setKeepRunning` on the emulator's machine) pins against idle stop and
  `--power-off-idle`. A stop ends the pin.
- **Hand-off**: when a brain on the installed app's home (`~/.ade`,
  `~/.ade-alpha`) exits, its emulators keep running and the next brain adopts
  them. Dev/test-home brains stop theirs. A project removed from the brain
  (`RuntimeDisposeReason` `"unregister"`) stops its emulators
  (`stopHandedOffAndroidEmulators`).
- **Owner gone**: a crashed brain's emulators are stopped by any brain's sweep
  after a grace (`ANDROID_OWNER_GONE_GRACE_MS` 2 minutes for scratch homes,
  `ANDROID_ADOPTABLE_OWNER_GONE_GRACE_MS` 10 for the installed home). A pinned
  emulator on the installed home waits for adoption. A stop re-reads the record
  first.
- **The sweep** runs 30 s after start and every 5 minutes, stops nothing without
  a record or whose discovery file no longer matches. On Windows a pid counts
  only while its image is `qemu-system-*` or `emulator*`.
- **Stopping**: `adb emu kill`, then SIGTERM/SIGKILL after 20 s (Windows:
  `taskkill /T`, then `/F`, each after a `tasklist` check). Each stop logs
  `android.emulator_stopped` with its reason.
- **Dev/test brains** marked by a launcher exit after 30 minutes idle once their
  parent is gone (`unmanagedBrainIdleExit.ts`). Unmarked brains never idle out.

**Start-up cleanup** releases lanes that ended while no brain ran and stops
DAEX's emulators no lane holds. **The cleanup pass** (`androidLaneMaintenance.ts`)
runs 60 s after start and every 15 minutes: releases ended lanes, stops orphans,
forgets rows whose AVD is gone, and lists unheld DAEX AVDs (never deletes them:
the marker does not name the project). `daex android device-cleanup
[--dry-run] [--power-off-idle]` runs it now; an agent's power-off reaches only
its own lane.

**Chrome's first run** is skipped before the first `open-url` that opens Chrome
or `launch --package com.android.chrome` (`androidChromeSetup.ts`: debug-app
flags file and `POST_NOTIFICATIONS` grant, no root).

### The memory guard

Before every boot, `androidMemoryGuard.ts` refuses with `ANDROID_LOW_MEMORY` when
any one holds:

1. **Pressure**: macOS `kern.memorystatus_vm_pressure_level` warn or worse; Linux
   PSI; Windows commit charge against limit.
2. **Paging**: swap-out at 4 MB/s or more over a 2 s sample at start
   (`ANDROID_PAGING_REFUSE_MB_PER_S`). Nothing polls.
3. **Budget**: running emulators (anyone's), boots in flight and this one would
   pass half of physical memory (`ANDROID_EMULATOR_BUDGET_SHARE`). The first
   emulator is never refused by this rule alone.
4. **Available**: less than 1 GB would remain (`ANDROID_MEMORY_RESERVE_MB`).

Emulator memory is measured as the OS counts it (macOS `phys_footprint`, Linux
RSS + swap, Windows private commit; plain RSS undercounts badly). "This one" is
`hw.ramSize` (default 2 GB) plus a learned overhead per AVD. Boots in flight are
held in memory and in the owner file for other brains. The refusal is one
sentence with the numbers; the pane offers **Start anyway** and the CLI
`daex android start --force` (its hint says to ask the user). A running emulator
is never checked.

## Agents: `daex android`

`daex android` uses `daex apple`'s verb and flag names where the job is the same,
one spelling per job, and refuses unknown flags. Run `daex android --help` for
the full list. Every verb takes `--lane` and `--machine`.

| Area | Verbs |
|---|---|
| Device | `status`, `devices [--profiles]`, `device-create --profile <id>\|--catalog <id> [--color] [--image] [--extra] [--no-start]`, `device-attach --avd`, `device-detach [--keep] [--device]`, `device-promote --device`, `start [--force] [--device]`, `stop`, `keep-running on\|off`, `device-cleanup`, `show [--floating]`, `actions` |
| Input | `tap`, `long-press`, `swipe`, `drag`, `scroll`, `button back\|home\|recents\|power\|volume-up\|volume-down`, `key <name>` (modifiers `ctrl+a` or flags), `type [--submit]`, `rotate <orientation>`, `open-url` |
| Elements | `snapshot [--fresh]`, `find-element`, `tap-element [--hold-ms]`, `fill-element`, `wait-for-element`, `assert-visible`, `inspect x y`, `select x y` (query flags as in `daex apple`) |
| Apps | `apps`, `install --apk <path>\|--gradle [--module] [--variant]`, `launch --package [--activity] [--extra k=v]`, `relaunch`, `terminate`, `uninstall`, `app-state`, `foreground [--wait]` |
| Capture | `screenshot [--out]`, `frame`, `record-start`, `record-stop`, `record-list`, `record-delete`, `auto-record on\|off\|status`, `proof-bundle`, `render`, `play-store-shots` |
| Settings | `settings [--text-size …]`, `location`, `appearance`, `permission`, `accessibility <option> on\|off`, `status-bar [--clear]`, `window …` |
| Other | `log`, `lease`, `fold`/`posture`, `test`, `preview list`/`preview`, `sdk status\|licenses\|images` |

Behavior worth knowing:

- Points are device pixels (same as the screenshot). With a live viewer, input
  goes over the scrcpy control socket; otherwise `adb shell input`, so agents
  need no live view.
- `screenshot` uses `adb exec-out screencap -p`; default folder
  `<project>/.ade/android/screenshots/`. `--out` must be inside the lane worktree
  (`ANDROID_PATH_OUTSIDE_LANE`, checked lexically and after symlinks).
- `terminate`/`uninstall` on an attached AVD only touch DAEX-installed packages
  (`ANDROID_PACKAGE_NOT_ADE_INSTALLED`).
- `rotate` locks the display orientation (auto-rotate off); an app with a fixed
  orientation keeps it. It emits `android.device.orientation`.
- `window` drives split screen and free windows on large screens; the answer
  lists windows and exits 1 when the change did not happen. Android 14 cannot end
  a split by command, so DAEX goes home and reopens full screen.
- `location --clear` moves GPS back to the emulator default (there is no "no
  location").
- **UI tree**: the Android CLI's `layout` when available (retried with
  `--no-idle`), else `uiautomator dump`. Cached 5 s, dropped on input or focus
  change. Refs use the first unique `id:`, `label:` or `text:`, else role + path.
- **Recording**: taps the scrcpy stream and writes H.264 to MP4 with no
  re-encode; a rotation starts a new part, joined at stop. Stops at
  `--max-seconds` (max 300), 2 minutes without change, disk limits, emulator
  stop, lane release or chat end. The stop makes a demo through
  `produceDemoVideo` (150 s budget; falls back to the raw video). Files stay in
  `<project>/.ade/android/recordings/<lane>`.
- **Auto-record**: an agent's input starts one unless `--no-record`, the lane
  switch (KV `android.autoRecord.lane.<lane>`) or the machine preference
  `autoRecordAgentInput` is off. Pane input is `source: "user"`. With
  `--machine`, the turn-end stop does not reach the other machine; the idle stop
  ends it there.
- **Machine preferences** (`getMachinePreferences`, person-only
  `setMachinePreferences`): `tapRings`, `keyBadges`, `autoRecordAgentInput`,
  `recordingsWarnBytes` (5 GiB), `remoteBitrateKbpsCap` (2500 kbit/s).
- **Proof** with `--machine`: the other machine writes files, the caller's
  machine reads them back and files them in the caller's drawer.
- **Turn hint**: `laneAndroidDeviceDirective.ts` names the emulator and says
  never to run `emulator -avd` or `adb kill-server`.

### Instrumentation tests

`daex android test` runs `gradlew :<module>:connected<Variant>AndroidTest`
(default `app`, `debug`) with `ANDROID_SERIAL` set and a 20-minute limit.
`--class`/`--method` filter. Refused when not booted (`ANDROID_NOT_RUNNING`) or
already running (`ANDROID_TESTS_RUNNING`). Results come from this run's JUnit
XML, else Gradle output; a build failure is `ANDROID_BUILD_FAILED`. With
`--machine` the caller's checkout goes to the work copy first. Exits 1 on a
failed test.

### Compose previews

`daex android preview` runs the Android CLI (`android preview list|render`,
always `--no-metrics`) in the lane, with no emulator. `--module` must be a module
folder with a Gradle build file (the root is refused). With no `--fqn` it
renders up to 24 previews. Images go to
`<project>/.ade/android/compose-previews/<lane>/<time>/` and are filed as proof
unless `--no-proof`. One preview run per lane; 10-minute limit per CLI run. The
drawer calls it with `inline: true` so thumbnails work across machines.

### Lane scoping and permissions

The lane is `--lane`, else `ADE_LANE_ID`, else the worktree the call comes from;
a chat-bound agent is pinned to its chat's lane.

- `ANDROID_AGENT_ACTIONS` lists what agents may call; the same list feeds the
  allowlist.
- `ANDROID_USER_ONLY_ACTIONS` are for viewing clients only: `startStream`,
  `stopStream`, `sendTouch`, `deleteDevice`.
- `ANDROID_PERSON_ONLY_ACTIONS` (`ADE_ACTION_USER_ONLY`): `installSdk`,
  `cancelSdkInstall`, `setSdkPath`, `deleteDevice`, `attachRenderProof`.
- `status.capabilities`: `adb`, `stream`, `record`, `uiTree`, `logcat`,
  `gradle`, Android CLI path and version.

### Remote surfaces

`androidRemoteCommands.ts` registers `android.status`, `android.deviceList`,
`android.recordList`, `android.streamTicket` (viewer) and `android.input`,
`android.invoke`, `android.recordStart`, `android.recordStop`,
`android.inspectSnapshot` (controller). `android.invoke` goes through the
`android_emulator` domain, except stream calls and SDK writes.
`android.streamTicket` never boots (`ANDROID_NOT_RUNNING`); it uses the Apple
relay on the same `/apple/stream/<ticket>` path. `android.input` `touch` takes
up to 64 events per call. `android.status` carries `liveView`, `appCrash`,
`recording` and the lease `owner`.

The hosted web client uses these commands (status read every 3 s while the pane
listens and the tab is visible; SDK writes refused). The phone viewer
(`AndroidDeviceViewer.swift`) appears only where the machine advertises
`android.status` and `android.streamTicket`; control needs the controller role.
It shows a recording dot and owner ribbon, hands control back when an agent
takes the lease, mirrors a folding phone's hinge, and supports Live Inspect via
`android.inspectSnapshot`.

## Another machine

The emulator runs where the lane's brain runs. Every renderer call takes the
machine pin, and every action is in the `android_emulator` domain with
`actionPolicy` entries.

- `daex android … --machine <m>` with no `--lane` uses the chat's work copy on
  that machine (a hidden worktree at the chat's commit, which must be on origin;
  lane id `remote-work-<hash>`). `status` and `devices` make no copy.
- **Borrow rule**: the work copy first borrows a free AVD DAEX made for this
  project (stopped before running), attached so it is never deleted. It never
  borrows the user's own AVDs. Only with none free does it make `medium_phone`.
- Every window viewing the chat then shows an **Android · `<machine>`** target
  with no start control or picker. `useRemoteDeviceTabs.ts` adds that tab (and
  the iOS **Simulator · `<machine>`** tab) behind the current one once per use,
  remembered across reloads.

## Live view

The brain pushes a bundled **scrcpy server v5.0.1** (`SCRCPY_SERVER_VERSION`,
SHA-256 checked) and starts it with `app_process`. Access units are wrapped in
DAEX video records (`media/videoRecords.ts`), played by the same WebCodecs
player as the simulator and Mac Desktop. The server refuses other client
versions; version-change steps are in
[apps/desktop/resources/android/README.md](../../../apps/desktop/resources/android/README.md).

Defaults (`ANDROID_STREAM_DEFAULTS`): longest side 1024 px, 4 Mbps, 60 fps max;
one setting for every view. On a 4 vCPU Windows test machine this gave about
39 fps average while moving. A stream that dies restarts on the same transport;
after 3 restarts in 60 s it stays down and `status` says why.

### Remote viewers

A remote viewer (phone or web through the relay, or a pinned desktop passing
`remoteViewer`) reads at the machine's `remoteBitrateKbpsCap`. While a local
viewer or recording holds the stream it runs at full rate and remote viewers get
that stream with frame skipping. With only remote holders, the cap applies and
the relay's pacing (`appleStreamPacing.ts`) lowers it to 60% on stalls (floor
400 kbit/s) and raises it back. A second encode for remote viewers was rejected:
it doubles encoder CPU, too much on a 4 vCPU DAEX Cloud host.
`getStreamStatus` reports `bitrateKbps` and `capKbps`.

## Product analytics

The brain records `ade_feature_used` (`action: "android_device"`) at most once a
day per outcome: SDK installed, app installed, render filed, lease taken,
`image_installed`, `tests_run`, `device_folded`, `previews_rendered`,
`store_screenshots`, `emulator_auto_stopped`, `device_booted`, `boot_failed`,
`adb_restarted`, `extra_device_created`, `device_promoted`. An unexpected boot
failure from an agent's call is one Sentry issue per code
(`["android", "boot_failed", <code>]`); expected codes never are. No path, AVD,
package, lane or image name is sent. Contract: `docs/logging.md`.

## Troubleshooting

| State | What to do |
|---|---|
| `ANDROID_SDK_NOT_FOUND` | Use the setup card, or set `ANDROID_HOME`, then **Check again** / `daex android status --text`. |
| `ANDROID_TOOL_MISSING` | Install the missing part from the setup card. |
| `ANDROID_NO_SYSTEM_IMAGE` | Install an image for the host ABI (picker ▸ System images), or pass `--image`. |
| `ANDROID_NO_ACCELERATION` | Turn on WHPX (Windows) or KVM access (Linux); WSL2 has none. |
| `ANDROID_EMULATOR_EXITED` | Read `<project>/.ade/android/logs/<avd>.log` on the emulator's machine, then **Restart**. |
| `ANDROID_BOOT_TIMEOUT` | Boot took over 180 s. Read the log and start again. |
| `ANDROID_ADB_UNAUTHORIZED` | See Gotchas. The person can run `daex android start --restart-adb`. If it persists after a restart, cold boot or wipe the AVD. |
| `ANDROID_NOT_RUNNING` | `daex android start`, or `device-create`. For a work copy that is gone, run the command again. |
| `ANDROID_LANE_HAS_DEVICE` | Use the lane's AVD, `device-detach` first, or add an extra. |
| `ANDROID_LANE_DEVICE_BUSY` | Finish the recording, live view, tests, install or lease, then promote again. |
| `ANDROID_LOW_MEMORY` | Stop an emulator or close apps; **Start anyway** (`--force`) boots past it. Numbers in `android.start_low_memory`. |
| `ANDROID_LOW_DISK` | A first start needs 1.2 × 6 GB free. On DAEX Cloud the first start grows the disk within the plan, or the pane offers **Grow the disk**. |
| The emulator stopped by itself | Idle stop or owner gone; `android.emulator_stopped` says why. Use **Keep running**. |
| `ANDROID_STREAM_FAILED` | Press **Reconnect**. Input and screenshots do not need the stream. |
