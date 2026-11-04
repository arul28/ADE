# Android device

ADE drives a per-lane Android emulator from the Work tab's **Android
Development** tool and from `ade android`. It makes a new AVD for the lane, or
attaches one the user names. It boots the AVD headless, streams the screen into
the pane through a bundled scrcpy server, and sends touch, keys and text to it.

This page describes phase P0 as built on the `ade/android-emulator-suite`
lane. The plan, with the decisions and the later phases, is
[docs/plans/android-emulator.md](../../plans/android-emulator.md).

Scope:

- Emulators only. ADE does not drive physical phones, and no phase plans to.
- Stock Android only. Every device runs the system image the SDK installed.
- macOS, Windows and Linux. All of the backend is Node code in the brain, so
  one code path serves the three. There is no native helper.

## Requirements

The emulator runs on the machine that runs the lane's brain. That machine
needs:

- **The Android SDK.** Android Studio installs it, and so do Google's
  command-line tools. ADE looks for it on every use, not once at start-up, so
  an SDK installed while ADE runs is seen on the next call. The order is
  `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the platform default:
  `~/Library/Android/sdk` (macOS), `%LOCALAPPDATA%\Android\Sdk` (Windows),
  `~/Android/Sdk` (Linux).
- **`platform-tools`** (`adb`) and **`emulator`**. `cmdline-tools` is
  optional, because ADE writes the AVD files itself.
- **One system image for the host ABI.** Apple Silicon runs only `arm64-v8a`
  images; Intel and AMD hosts run `x86_64` images.
- **Hardware acceleration.** macOS uses Hypervisor.framework (HVF), Windows
  uses WHPX (or AEHD), and Linux uses KVM (`/dev/kvm`). ADE reads
  `emulator -accel-check`. WSL2 and nested VMs have no acceleration.

`ade android status` and the pane report each part. A host that is not macOS,
Windows or Linux reports `platformSupported: false`. A missing SDK is not
"unsupported": the pane shows the setup card.

### The setup card

When the SDK or a part that a boot needs is missing, the pane shows
**Set up Android on this machine**. It is a checklist:

| Row | Found | Missing |
|---|---|---|
| Acceleration | `HVF on`, `WHPX on`, `KVM on` | `<kind> off` or `not available`, with the check's sentence |
| Android SDK | the SDK folder | `not found` |
| Platform tools | the version | ~15 MB |
| Emulator | the version | ~480 MB |
| Phone image | the version | the host ABI and ~1.8 GB |

The card shows the SDK folder, or the default folder that ADE looks in. It
says "Install Android Studio, or set ANDROID_HOME to your SDK folder, then
check again." and has **Check again**.

The card is read-only in P0. ADE installs nothing. The guided install
(licence review, "Use mine…", the optional Android CLI) is P1. P0 has no
Settings section for the SDK path yet, so `ANDROID_HOME` or the default folder
is the way to point ADE at an SDK.

## Desktop surface

The tool is **Android Development**, a separate tab in the Work tools pane next
to Apple Development. Its tools card says "Open an Android device". The layout
copies Apple Development: the same picker position, stage, rail and strips, so
it is easy to move between the two tools.

The web client does not offer the tool yet ("Android Development needs the ADE
desktop app for now.").

### The picker

The picker shows when the lane holds no device, or when the user picks
**Switch device…**. It has three sections, top to bottom:

1. **This lane.** The lane's AVD, with its state (Running, Starting, Stopping,
   Stopped, Off). A click opens it.
2. **On this machine.** Every other AVD. A free AVD is a button that attaches
   it to the lane and boots it. Tags:
   - **Running** or **Off**.
   - **In use**: an app other than ADE started this emulator. Stop it there to
     use it here.
   - **Taken**: another lane holds it. It has no menu and does not respond.

   The ⋯ menu has **Release from this lane** (for the lane's own AVD) and
   **Delete device…** (only for an AVD that ADE made, that no lane holds, that
   is off, and that ADE did not make for a lane outside this project). Delete
   asks again and says how much disk it frees.
3. **New device.** The line "Stock Android on every device", then four stock
   profiles from this SDK: Phone, Small phone, Tablet, Foldable. One click
   makes an AVD with the newest installed image for the host ABI and boots it.
   **More…** lists every profile the SDK has, grouped by form factor. A new
   AVD is deleted with the lane.

The brand grid with 3D tiles (Pixel, Galaxy and others) takes the place of the
stock list in P1.

### The stage

The stage is the flat view only in P0. The video arrives the right way up,
because scrcpy turns it with the display. The screen box fits the pane and
stays centred. While the rail shows, the box moves left (and shrinks if it
must) only when the rail would cover its right edge, as on the Apple stage. So
a landscape screen never sits under the rail.

Touch maps to device pixels. Keys typed while the screen has focus go to the
device. Esc sends Back.

### The rail

The rail floats on the right edge, in Apple's place and size. The order:

- **Back**, **Home**, **Recents**.
- A divider.
- **Power and volume** ▾: Power, Volume up, Volume down.
- **Rotate**: toggles portrait and landscape. The home screen stays portrait;
  apps that allow rotation turn.
- **Save screenshot**.
- A divider.
- **Maximize**, where the pane provides it.
- **More** ⋯: the device name and profile, **Switch device…**, and
  **Power off**.

Below 360 px of pane width the rail keeps the navigation keys, Power, Maximize
and More. Rotate and Save screenshot move into More. P0 has no Inspect, Record, 3D or
Tools drawer. They come in the Apple order when they are built.

### States

| State | What the pane shows |
|---|---|
| Setup | The setup card. |
| No acceleration | A banner over the pane: "No emulator acceleration: …", with **How to fix** (Google's acceleration page). The user can dismiss it. |
| Starting | The loading card while the AVD boots, then while the video connects. |
| Live | The picture, the rail and the live line. |
| Video stopped | The picture dims. The strip says "Video stopped." with **Reconnect**. |
| Off | "{name} is off." with **Start** and **Choose another device**. |
| Crashed | Why the emulator stopped (often the last error line of its log), with **Restart**, **Open log** and **Choose another device**. |
| Unsupported | "This machine can't run the Android emulator." with the host's reason. |

A failed status read shows an inline banner with **Retry**. When the
emulator runs on another machine, **Open log** copies the log path, because
the file is on that machine.

### The live line

A small line at the foot of the picture says the stream state, the frame rate,
the lane and, for another machine, its name. For example:
`Live · 52 fps · lane checkout-flow · on windows`.

### Closing the tab

Closing the tab, or moving to another tool, gives back the pane's hold on the
stream. The last viewer of a lane stops the stream. The emulator keeps
running. P0 has no floating player.

## Lanes and devices

A lane holds at most one Android device, and an AVD belongs to at most one
lane. The Android device is separate from the Apple device, so a lane can hold
one of each. An agent can drive both in one turn with `ade apple` and
`ade android`.

The lane's row is in the local-only table `lane_android_devices`. It does not
sync.

### Created and attached devices

- **Created.** ADE made the AVD for the lane (`device-create`, or a New device
  card). Its name is `ade_<lane>_<profile>`. ADE writes its marker into the
  AVD's `config.ini`.
- **Attached.** The lane uses an AVD that already existed (`device-attach`, or
  a free card under On this machine). It stays the user's.

The rules:

- ADE never deletes an AVD it did not make. An AVD whose `config.ini` lost
  ADE's marker counts as the user's.
- ADE never stops an emulator it did not start. It keeps the list of the
  emulators it started in `<project>/.ade/android/started-emulators.json`, so
  the list survives a restart. `ade android stop` on an emulator that another
  app started fails with `ANDROID_AVD_RUNNING`.
- An AVD that ADE made for a lane outside this project can be attached, but
  this project never deletes it.
- An AVD boots once at a time. Each emulator gets its own even console port in
  5554–5682.

Boot is headless (no window, no audio, no boot animation). It is ready when
`sys.boot_completed` reads 1. A first boot of a new AVD took 54 s on the
Windows test machine, and a cold boot 24 s. ADE waits up to 180 s.

### When a lane ends

Archive and delete both end the lane's hold on its device. The lane service
stops the lane's stream and the emulator ADE started for it, then releases the
AVD (`androidLaneRelease.ts`):

- A created AVD is deleted with its data. On Windows the disks stay locked for
  a moment after the emulator exits, so ADE tries the delete again a few
  times.
- An attached AVD is not deleted. ADE uninstalls only the packages it
  installed (P0 installs none), and only while the AVD runs.
- When another lane holds the same AVD, the ending lane drops its row and
  leaves the AVD.
- A created AVD that still runs keeps its row, so the start-up cleanup can
  finish the job.

`ade android device-detach` does the same for a lane that stays. `--keep`
keeps a created AVD on disk.

### Brain restarts and the start-up cleanup

- **Hand-off.** When the brain exits, ADE's emulators keep running and stay in
  the state file. The next brain adopts them again. A boot that was in
  progress finishes by itself and reads as Starting until it is done. A
  service that the desktop runs in its own process does not hand off: when it
  closes, it stops every emulator that ADE started for the project.
- **Start-up cleanup.** When the service starts, it releases the device of
  each lane that was archived or deleted while no brain ran. Then it stops
  each emulator that ADE started and that no lane holds. Lanes that are still
  active keep their emulators.

A desktop that does not run the project's runtime in its own process does not
build an Android service. So one service owns a project's emulators.

## Agents: `ade android`

`ade android` uses the verb and flag names of `ade apple` where the job is
the same. There is one spelling for each job and no aliases. The CLI refuses
any flag that a verb does not take.

| Verb | What it does |
|---|---|
| `status` | The SDK, acceleration, and the lane's device and state. |
| `devices [--profiles]` | The AVDs on the machine (and the lane holding each), the system images, and with `--profiles` the hardware profiles. |
| `device-create --profile <id> [--image <package>] [--name <shown name>] [--no-start]` | Make an AVD for the lane and boot it. With no `--image`, the image with the newest API level for the host ABI (in one level, a Play Store image first). |
| `device-attach --avd <name> [--no-start]` | Hold an AVD that no other lane holds, and boot it. |
| `start` | Boot the lane's AVD. It waits for boot completed. |
| `stop` | Stop the lane's emulator. The lane keeps its AVD. |
| `device-detach [--keep]` | Stop the emulator and release the AVD (see [When a lane ends](#when-a-lane-ends)). |
| `screenshot [--out <path>]` | Write a PNG of the screen. |
| `tap <x> <y>` (or `--x`, `--y`) | Tap a point. |
| `swipe <x1> <y1> <x2> <y2> [--duration-ms <ms>]` | Swipe from one point to another (default 300 ms). |
| `button <name>` (or `--name`) | `back`, `home`, `recents`, `power`, `volume-up`, `volume-down`. |
| `rotate portrait\|landscape` | Lock the display to that orientation (auto-rotate off). An app that fixes its own orientation keeps it. |
| `type <text>` (or `--value`) | Type into the focused field, exactly as given. |
| `show` | Show the emulator to the user in the tools pane (also `ade ui show android`). |
| `actions` | List the `android_emulator` actions. |

Every verb also takes `--lane` and `--machine` (see
[Another machine](#another-machine)).

Points are device pixels, the same pixels as the screenshot. When a viewer has
the live stream open, `tap`, `swipe`, `button` and `type` go through the
scrcpy control socket. With no viewer, they go through `adb shell input`, so
an agent does not need the live view. `screenshot` uses
`adb exec-out screencap -p`. With no `--out`, the file goes to
`<project>/.ade/android/screenshots/`. An `--out` path must be inside the
lane's worktree (`ANDROID_PATH_OUTSIDE_LANE`). ADE checks it lexically and
again after it resolves symlinks.

`start`, `device-create` and `device-attach` print a progress line while the
AVD boots. These lifecycle calls have a 4-minute timeout.

### Lane scoping

The lane comes from `--lane`, else `ADE_LANE_ID`. With neither, a call made
from inside a lane worktree goes to that lane. A chat-bound agent is pinned to
its chat's lane.

### What only a viewer can do

`ANDROID_AGENT_ACTIONS` in `shared/types/androidEmulator.ts` lists what an
agent may call: `getStatus`, `listDevices`, `createDevice`, `attachDevice`,
`start`, `stop`, `releaseDevice`, `getStreamStatus`, `tap`, `swipe`,
`sendKey`, `sendText`, `rotate`, `screenshot`. The same list feeds the action
allowlist.

`ANDROID_USER_ONLY_ACTIONS` are for a viewing client (the desktop, and later
the web and the phone) and never for a session-bound agent:

- `startStream` and `stopStream`. The stream token is only for the viewer that
  started the stream; `getStreamStatus` always returns `transport: null`.
- `sendTouch`, the live touch stream.
- `deleteDevice`, which deletes an ADE AVD that no lane holds.

P0 has no `capabilities` field in `status`, no turn-time hint and no
`ade-android` skill. Those are P1.

## Another machine

The emulator runs where the lane's brain runs. Every renderer call takes the
machine pin, and every action is in the `android_emulator` domain with
`actionPolicy` entries, so it works from another machine.

A chat can drive an emulator on another machine with no new lane, in the same
way as `ade apple --machine`:

1. `ade android … --machine <m>` with no `--lane` uses the chat's work copy on
   that machine. The work copy is a hidden worktree at the chat's commit, made
   on first use. The commit must be on origin. The copy stands in for a lane
   in the Android service (`remote-work-<hash>`), and that lane lives as long
   as the copy. `status` and `devices` make no copy.
2. `--lane <id>` with `--machine` uses a lane on that machine instead.
3. A screenshot is written on that machine.

**The borrow rule.** The work copy's first device is a free AVD that the
machine already has, because a new one costs gigabytes and a first boot.
"Free" means that no lane on that machine holds it and that no other app
started it. ADE borrows only its own AVDs, and only the ones it made for a
lane of this project. Stopped AVDs come before running ones. ADE never
borrows the user's own AVDs: a lane of another project can hold one without
this project knowing, and a run can rewrite the AVD's snapshot.

The borrowed AVD is attached, so ADE never deletes it. ADE makes a new AVD
(`medium_phone`) only when none is free. When the work copy is deleted, ADE
releases its device.

**What the user sees.** The machine returns the work copy's lane id with each
answer, and the chat records the use. Every window that views the chat then
shows an **Android · `<machine>`** target in the Android tool, beside
**This lane**, and opens the stream through its own pin to that machine. The
tool has no start control and no picker for that target: the agent starts the
device, and the tool shows it. With no device yet, the tool says "No Android
emulator on `<machine>` for this chat right now". The tool stays visible on a
host that cannot run the emulator.

**The tab that joins the open pane.** When a chat starts to use a device on
another machine in the current turn, ADE adds that tool's tab to the open
pane, behind the tab on screen. This is the same for the iOS Simulator
(**Simulator · `<machine>`**) and the Android emulator. It happens once for
each use, and ADE remembers the uses across reloads, so a tab that the user
closes does not come back. ADE does not open a closed pane.

Phone and web viewers (`android.*` sync commands and a stream ticket) are P2.

## Live view

The brain pushes a pinned, bundled **scrcpy server v5.0.1** to the emulator
over adb and starts it with `app_process`. The server encodes H.264 with the
device's encoder and serves a video socket and a control socket. The brain
wraps each access unit in ADE's video records (`media/videoRecords.ts`), so
the renderer plays it with the same reader and WebCodecs player as the iOS
Simulator and Mac Desktop.

The jar is `apps/desktop/resources/android/scrcpy-server`, unchanged from the
upstream release, under the Apache License 2.0 (`scrcpy-LICENSE` beside it).
The brain checks its SHA-256 before it pushes it. The server refuses a client
of another version, so the server and the client code change together. The
steps for a version change are in
[apps/desktop/resources/android/README.md](../../../apps/desktop/resources/android/README.md).

Defaults (`ANDROID_STREAM_DEFAULTS`): the longest side is 1024 px (464×1024
for a 1080×2400 phone), 4 Mbps, 60 fps at most. One setting serves every view,
so a larger view never restarts the encoder.

Measured on the Windows test machine (API 36, 4 vCPUs). The emulator has only
a software H.264 encoder, so the picture size and the bit rate set the frame
rate while the screen moves:

| Size | Bit rate | Frame rate |
|---|---|---|
| 720×1600 | 8 Mbps | 15–27 fps |
| 576×1280 | 4 Mbps | 29–52 fps |
| 464×1024 | 4 Mbps | 35–55 fps |
| 1024 px (scrcpy 5.0.1) | 4 Mbps | 39 fps on average, 52 at most |
| 1280 px (scrcpy 5.0.1) | 4 Mbps | 23–36 fps |

Other numbers from the same machine (plan §9): one running phone emulator uses
about 2.9 GB of working set. After a rotate, the new size reaches the view
with the stream's next config record, about 1 s later.

A stream that ends by itself (the server crashed, the system UI restarted)
starts again on the same transport, so a viewer keeps its URL. After 3
restarts in 60 s it stays down, and `status` says why.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/androidEmulator.ts` | The contract: SDK, AVD and lane types, error codes, the service API, `ANDROID_AGENT_ACTIONS` and `ANDROID_USER_ONLY_ACTIONS`, and the preload API. |
| `apps/desktop/src/main/services/android/androidEmulatorService.ts` | The service: lane queue, create, attach, start, stop, release, input, screenshot, the work-copy lanes and the borrow rule, the start-up cleanup, and the hand-off. |
| `apps/desktop/src/main/services/android/androidSdk.ts` | SDK detection, tools and acceleration. |
| `apps/desktop/src/main/services/android/androidAvds.ts`, `androidHardwareProfiles.ts` | AVD list, create and delete, ADE's marker, and the hardware profiles. |
| `apps/desktop/src/main/services/android/androidEmulatorProcess.ts` | Boot, discovery files, boot completed, and stop. |
| `apps/desktop/src/main/services/android/androidLaneDeviceStore.ts`, `androidLaneRelease.ts` | The `lane_android_devices` rows, and the release of a lane's AVD on disk (used by `laneService` with no service). |
| `apps/desktop/src/main/services/android/androidStream.ts`, `androidStreamServer.ts` | Streams by adb serial, the defaults, restarts, and the loopback stream server. |
| `apps/desktop/src/main/services/android/scrcpyServer.ts`, `scrcpyVideo.ts`, `scrcpyControl.ts` | The scrcpy session, video records and control messages. |
| `apps/desktop/src/main/services/android/androidActionDomain.ts` | The `android_emulator` action domain. |
| `apps/desktop/src/main/services/android/adb.ts`, `androidEmulatorErrors.ts` | The adb runner and the coded errors. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePane.tsx` | The pane: picker, stage, rail, strips and live line. |
| `apps/desktop/src/renderer/components/android/androidDeviceState.ts` | The pane state, stock profiles, menu rules and error sentences. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePicker.tsx`, `AndroidSetupCard.tsx` | The picker and the setup card. |
| `apps/desktop/src/renderer/components/android/AndroidDeviceStage.tsx`, `AndroidDeviceRail.tsx`, `AndroidDeviceStatus.tsx` | The stage (on the shared `device/DeviceFlatView.tsx`), the rail, and the strips, cards and live line. |
| `apps/desktop/src/renderer/components/android/useAndroidDeviceStream.ts`, `useAndroidDeviceInput.ts`, `androidStreamLease.ts` | The stream, input, and the per-lane stream lease. |
| `apps/desktop/src/renderer/components/terminals/workToolPanels.tsx` | The Android tool's targets (This lane, Android · `<machine>`). |
| `apps/desktop/src/renderer/components/terminals/useRemoteDeviceTabs.ts` | The tab that joins the open pane for a remote device use (iOS and Android). |
| `apps/ade-cli/src/cliAndroid.ts` | `ade android` plans, formatters and error hints. The help page is in `cli.ts`. |
| `apps/desktop/resources/android/` | The scrcpy server jar, its licence and its README. |

## Limits and later phases

P0 does not have:

- the 3D view, device models or the brand grid (P1);
- the guided SDK install, licence consent, "Use mine…" and the Android CLI
  option (P1);
- UI tree and element verbs, logcat, app install and launch, record, lease,
  the turn hint and the `ade-android` skill (P1);
- phone and web viewers, the phone's full-screen view, quick chips, the Logs
  drawer, the RAM guard, and two floating players, one for each device kind
  (P2);
- fold by drag, Compose preview render, a system image manager and
  instrumentation tests (P3).

The full list is in §6 of the [plan](../../plans/android-emulator.md).

## Troubleshooting

| State | What to do |
|---|---|
| `ANDROID_SDK_NOT_FOUND` | Install Android Studio or the command-line tools, or set `ANDROID_HOME`. Then press **Check again** or run `ade android status --text`. |
| `ANDROID_TOOL_MISSING` | Install the missing package (`platform-tools`, `emulator`) with `sdkmanager`. |
| `ANDROID_NO_SYSTEM_IMAGE` | Install a system image for the host ABI, or pass `--image <package>`. `ade android devices --text` lists the installed images. |
| `ANDROID_NO_ACCELERATION` | Turn on acceleration: Windows Hypervisor Platform on Windows, KVM access on Linux. WSL2 and nested VMs have none. The banner's **How to fix** opens Google's guide. |
| `ANDROID_EMULATOR_EXITED` | The emulator exited. Read its log, `<project>/.ade/android/logs/<avd>.log` on the emulator's machine (**Open log**, or the path in `ade android status --text`). Then **Restart**. |
| `ANDROID_BOOT_TIMEOUT` | The boot took more than 180 s. Read the log, then run `ade android start` again. |
| `ANDROID_PATH_OUTSIDE_LANE` | `screenshot --out` must be inside the lane worktree. Give a path there, or leave out `--out`. |
| Work copy gone (`ANDROID_NOT_RUNNING`) | "This chat's work copy on this machine is gone, so it has no Android device here." Run the command again to make a new copy. |
| `ANDROID_NOT_RUNNING` | Boot the lane's emulator first (`ade android start`), or make one (`ade android device-create --profile <id>`). |
| `ANDROID_AVD_HELD_BY_OTHER_LANE` | Pick a free AVD (`ade android devices --text`), or make one. |
| `ANDROID_LANE_HAS_DEVICE` | Use the lane's AVD, or run `ade android device-detach` first. |
| `ANDROID_AVD_RUNNING` | Another app started that AVD. Close it there, or attach another AVD. |
| `ANDROID_NO_FREE_PORT` | All ports 5554–5682 are in use. Stop an emulator you do not need. |
| `ANDROID_STREAM_FAILED` | The live view failed. `tap`, `swipe`, `button`, `type` and `screenshot` do not need it. Press **Reconnect** in the pane. |
