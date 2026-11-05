# Android device

ADE drives a per-lane Android emulator from the Work tab's **Android
Development** tool and from `ade android`. It makes a new AVD for the lane, or
attaches one the user names. It boots the AVD headless, streams the screen into
the pane through a bundled scrcpy server, and sends touch, keys and text to it.

This page describes phases P0, P1 and P2 as built. The plan, with the
decisions and the later phases, is
[docs/plans/android-emulator.md](../../plans/android-emulator.md).

Scope:

- Emulators only. ADE does not drive physical phones, and no phase plans to.
- Stock Android only. Every device runs the system image the SDK installed.
- macOS, Windows and Linux. All of the backend is Node code in the brain, so
  one code path serves the three. There is no native helper.

## Requirements

The emulator runs on the machine that runs the lane's brain. That machine
needs:

- **The Android SDK.** The setup card installs it, and so do Android Studio
  and Google's command-line tools. ADE looks for it on every use, not once at
  start-up, so an SDK installed while ADE runs is seen on the next call. The
  order is the machine's SDK setting ("Use mine…" or the setup card's
  folder), then `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the platform default:
  `~/Library/Android/sdk` (macOS), `%LOCALAPPDATA%\Android\Sdk` (Windows),
  `~/Android/Sdk` (Linux). On Linux it then tries `/opt/android-sdk` and
  `/usr/lib/android-sdk`, so a system-wide install is found even when the
  brain's service has no `ANDROID_HOME`.
- **`platform-tools`** (`adb`) and **`emulator`**.
- **`cmdline-tools`, to make devices.** ADE writes the AVD files itself and
  needs no JDK, but it reads the hardware profiles (`medium_phone`, the
  Pixels) from the Command-line Tools' `sdklib` jar, or from Android
  Studio's. An SDK with neither can boot and attach an existing AVD, but
  cannot make one: `device-create` fails with `ANDROID_TOOL_MISSING`, and
  the picker says so under "New device".
- **One system image for the host ABI.** Apple Silicon runs only `arm64-v8a`
  images; Intel and AMD hosts run `x86_64` images.
- **Hardware acceleration.** macOS uses Hypervisor.framework (HVF), Windows
  uses WHPX (or AEHD), and Linux uses KVM (`/dev/kvm`). ADE reads
  `emulator -accel-check`. WSL2 has no acceleration. A VM has it only when
  its host passes nested virtualization through (`/dev/kvm` in the VM).

`ade android status` and the pane report each part. A host that is not macOS,
Windows or Linux reports `platformSupported: false`. A missing SDK is not
"unsupported": the pane shows the setup card.

### The setup card

When the SDK or a part that a boot needs is missing, the pane shows
**Set up Android on this machine**. Settings › Android devices shows the same
card for the machine in the title picker, so a Mac window can set up a
Windows box. Every call goes to the machine that the pin names.

The card is a checklist. Each row is found or missing, with its size:

| Row | Found | Missing |
|---|---|---|
| Acceleration | `HVF on`, `WHPX on`, `KVM on` | `<kind> off` or `not available`, with the check's sentence and **How to fix**. Before the emulator is installed, the check cannot run: the row shows a dash and `checked after setup`. |
| Android SDK | the SDK folder | `not found` |
| Platform tools, Command-line tools, Emulator | the version | the newest stable version and its download size |
| Phone image | the API level and tag | the newest stable Google Play (else Google APIs) image for the host ABI that the planned emulator runs |
| Android CLI | the version | an optional box, off by default |

Under the list, the card shows the install folder with a pencil, the space
that the install needs against the free space, and the AVD folder with its
free space. Below 10 GB free on the AVD drive, that line turns amber. On this
computer the pencil opens a folder picker. On another machine you type the
path.

The buttons:

- **Review licences & install** opens one dialog with each licence that a
  missing part uses, in full, each with its own box. The install starts only
  when you tick every box. ADE never accepts a licence by itself. The brain
  refuses an install whose request does not name each licence
  (`ANDROID_SDK_LICENSE_NOT_ACCEPTED`).
- **Use mine…** points ADE at an SDK that you already have. The folder must
  hold `platform-tools`, `emulator` or `system-images`
  (`ANDROID_SDK_PATH_INVALID`).
- **Check again** reads the SDK and the plan again.

While the install runs, the card shows a meter, the step (`Downloading
Emulator · 61% · 2 of 4 · 2 min left`) and **Cancel**. Progress comes as
`android.sdk.install` events. A state read every 3 s covers a lost event, and
only while an install runs.

How the install works (`androidSdkInstall.ts`):

- **The source.** Google's SDK repository (`repository2-3.xml` and the
  `sys-img2-3.xml` manifests), stable channel only. ADE reads the manifests
  for each plan and keeps them for 10 minutes. ADE needs no JDK and does not
  run `sdkmanager`.
- **The image and the emulator agree.** ADE picks the newest image whose
  emulator dependency the planned emulator meets. An emulator that is older
  than the image needs is planned as "Update from x".
- **Downloads resume.** Each archive goes to `<sdk>/.ade-downloads/` with
  `Range` requests and up to four attempts. A cancelled or failed install
  keeps the partial file, and the next install continues it. ADE checks the
  SHA-1 from the manifest before it unpacks.
- **Unpack is atomic per part.** ADE unpacks into `<sdk>/.ade-staging/`,
  moves an old copy aside, then renames the new folder into place, and writes
  `package.xml`. On Windows both renames retry while an antivirus holds a
  file; an old copy that stays held (a running emulator or adb) stops the
  install with "Close the emulator and adb first". A zip entry that is
  absolute, has a drive letter or climbs with `..` stops the install, and so
  does a link that lands outside the folder or one that a file would be
  written through (each link is checked from the real folder it goes in).
- **The licence record.** ADE appends the licence hashes to
  `<sdk>/licenses/<id>`, the files that `sdkmanager` and Gradle read. It also
  writes `<sdk>/.ade/license-consents.json` with each licence id, the SHA-1 of
  the text you saw, the time, and where you accepted it (the setup card or
  Settings › Android devices).
- **One install for each SDK folder.** `<sdk>/.ade-install.lock` holds the
  pid. A second ADE process gets `ANDROID_SDK_INSTALL_BUSY` while that pid
  lives. A lock older than 6 hours is stale.
- **Space.** The plan adds the unpacked size of each missing part and the
  largest zip. With less free space, the install stops before it starts
  (`ANDROID_SDK_NO_SPACE`).
- **The Android CLI** (optional) comes from
  `dl.google.com/android/cli/latest/<os>_<arch>/`, checked with its `.sha256`
  file, into `<sdk>/android-cli/`. ADE always runs it with `--no-metrics`.
  Google publishes no build for Windows on Arm, so the row says "Not
  available for this computer" there.
  Its first run unpacks about 150 MB into `~/.android/cli`.
- **Hosts.** macOS (arm64, x64), Windows x64 and Linux x64. Windows on Arm and
  Linux arm64 have no Google emulator: the card says so and installs nothing.

The default install folder is the platform default above. A folder that ADE
would not find by itself becomes the machine's SDK setting when the install
starts, so a partial install is visible too. The setting lives in
`<ADE home>/android/settings.json`, and ADE reads it before `ANDROID_HOME`.

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
3. **New device.** The line "Stock Android on every device", then the brand
   grid: one tile per device in `shared/androidDeviceCatalog.ts` (Pixel,
   Galaxy, OnePlus, Nothing, and others). A tile shows the brand mark, the
   name, a 3D still of the body in the picked colour, and the colour dots. A
   click makes an AVD with the newest installed image for the host ABI, in
   that colour, and boots it. The ▾ button opens the details: the system
   image, the name, and **Create and start**. A tile with no system image
   asks for setup; a tile whose profile is missing says so.
   **More…** lists every profile the SDK has, grouped by form factor. A new
   AVD is deleted with the lane.
4. **Storage.** A toggle that measures each AVD on the disk when it opens
   ("ADE made" or "Yours", in use or running, size). **Clean up** asks again
   ("Delete N — frees X") and deletes only the AVDs that the ⋯ menu could
   delete.

Pixel tiles use the SDK's own hardware profiles. The other brands use ADE
profiles (`ade_*` ids) that ADE merges into `<android user home>/devices.xml`
(`~/.android/devices.xml`) on the first create. The merge keeps every
profile that is not ADE's, writes the file atomically, and uses the density
values the SDK schema allows.

The tile stills come from one shared WebGL renderer. Each still is drawn
once, then kept in memory and in `localStorage` (WebP). Hover turns the body
slowly on the same renderer, one tile at a time; the renderer is freed after
20 s with no use. Reduced motion stops the turn.

### The stage

The stage has a 3D view and a flat view, as on the Apple stage (the rail's
**View** button, kept per project). The 3D view draws the device body (the
catalog body for a catalog device, a procedural body for any other profile)
with the live screen on it. Touch on the 3D screen maps to device pixels as
in the flat view. The body takes the AVD's colour (More › Body colour). While
the emulator boots, the boot ring shows on the model's screen. Rotate turns
the body smoothly to landscape. If WebGL fails, the stage falls back to the
flat view and says why.

The rail's **Render** button opens the Render sheet: angles (front, ¾ left,
¾ right, back, the current view), the background (transparent, studio,
dusk), a shadow, a turntable video and a contact sheet. The renders are
filed to the lane's proof (History). `ade android render` asks the open pane
for the same renders, with the flags of `ade ios-sim render`.

In the flat view the video arrives the right way up,
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
- **Inspect**: boxes over every element of the screen (see
  [Inspect](#inspect)).
- **Save screenshot**, **Render** (the Render sheet), **Record** (red while a
  recording runs; it is also the Stop button), and **View** (3D or flat).
- A divider.
- **Device tools**: opens the [Tools drawer](#the-tools-drawer).
- **Maximize**, where the pane provides it.
- **More** ⋯: the device name and profile, **Switch device…**, the body
  colour, **Reset view**, and **Power off**.

Below 360 px of pane width the rail keeps the navigation keys, Power, Device
tools, Maximize and More. The other controls move into More.

### Inspect

Inspect reads the UI tree once (`getScreenSnapshot`, fresh) and draws a box
for each element, in 3D and in flat. Touch is off while Inspect is on, so a
box cannot go stale under the pointer. Click an element to see its card: ref,
role, identifier, text, what it takes, and bounds. **Insert into chat** puts
one line in the chat's draft, with the `ade android tap-element --ref …`
command. **Copy** copies that command. Inspect goes off when the device stops
being live. The overlay is the shared `device/DeviceInspectOverlay.tsx`, which
the Apple pane also uses.

### Recording from the rail

**Record** starts a recording of the lane's emulator. The chat that holds the
pane owns it, so its proof goes to that chat. While it runs, a pill at the
foot of the picture shows the time and a **Stop** button, in place of the live
line. After the stop, a receipt says "Saved to proof", with the length, the
size and **Open**. A recording that an agent or the CLI starts also turns the
button red: the pane follows the `android.recording.state` event and does not
poll.

### The Tools drawer

**Device tools** opens the drawer. In a pane 700 px wide or more, it docks
beside the picture. In a narrower pane, it covers the picture to the left of
the rail, so the rail stays usable. One group is open at a time. ADE keeps
the open group for each chat. A closed group is unmounted, so only the open
group reads from the device.

| Group | Controls |
|---|---|
| Device | Text size and Display size (Small, Default, Large, Largest or Larger), Animations off, Show taps, Show layout bounds. |
| App | The app in front (read every 2 s while the group is open), **Build & run** (Gradle), **Relaunch**, **Stop**, **Uninstall**, **Start an app**, **Open** a link, **Install** an APK, and Permissions. |
| Capture | The lane's recordings, newest first: **Open in proof**, and a ⋯ menu with Show in Finder (not for another machine's files) and Delete. A running recording shows as one line at the top. |
| Emulator | Appearance, Location (presets or a typed point), Battery level and Charging, Airplane mode, Wi-Fi, Mobile data. |
| Logs | Logcat for the lane's app (P2): the newest package ADE installed for the lane, else the app in front, or **Whole device**. A level filter (All, Info, Warn, Error), a text filter, **Pause**, **Clear**, **Copy** and **Send to chat** (the newest 80 lines into the chat's draft). |

Each change is one call to the lane's machine, and the drawer shows the value
the device reports after the change. It never shows a value it has not read.
A refused change shows an error banner with **Dismiss**. All drawer calls take
the pane's `runtimePin`, so the drawer works the same for an emulator on
another machine.

The settings come from `androidDeviceSettings.ts`, in one `sh -c` read
(about 250-480 ms; the app-in-front read alone is about 80 ms):

- Battery: `adb emu power capacity|ac|status`.
- Radios: `svc wifi`, `svc data`, and `cmd connectivity airplane-mode`.
  `wifi_on` 1 and 2 mean on; 3 means off for airplane mode.
- Layout bounds: `setprop debug.layout`, then a `service call activity` so
  apps draw again.
- Display size: `wm density`, as the physical density times the scale.
- Text size: `font_scale`.
- The app in front: the first `mFocusedApp` line of `dumpsys window`. The
  home app reads as "Home screen".

### Logs, quick chips and the crash pin (P2)

The **Logs** group reads `readLog` (the same bounded read as `ade android
log`) every 2 s with the last line's cursor, so each read carries only new
lines. It reads only while the group is open and the window is in front, and
it keeps the newest 500 lines. The time column shows only where the drawer is
wide; each row's tooltip has the time and the pid.

**Quick chips** sit at the top left of a live picture: Location, Battery,
Network and dark mode. They are shortcuts to the Emulator group's own calls
and settings read, and each menu ends with **More in Tools**. They hide while
the drawer or Inspect is open, and in a pane under 420 px.

**The crash pin.** When the lane's app crashes, a red pin shows under the
chips: "{package} crashed". It opens a card with the exception, the stack,
**Send to chat**, **Copy** and **Open Logs**. × hides that crash in this
window until the next one. The source is the brain, not the pane
(`androidCrashWatch.ts`):

- Each booted lane emulator gets one `adb logcat -b crash` reader. The crash
  buffer holds only crash lines, so the reader is idle until an app crashes.
  The buffer's older crashes are skipped.
- A crash is a Java `FATAL EXCEPTION` block (`AndroidRuntime`) or a native
  crash dump (`DEBUG`). The lines of one crash come from one writer; a quiet
  gap of 250 ms ends it.
- Only the lane's app counts: the packages ADE installed for the lane, or,
  when it installed none, any app outside `android`, `com.android.*` and
  `com.google.android.*`.
- The brain emits `android.app.crashed` and puts the crash on the lane status
  (`appCrash`), so every viewer on every machine sees it. `ade android status`
  prints it with the next `ade android log` command. The pin ends when the
  emulator stops.

### The RAM guard (P2)

Before a boot, the brain compares what the emulator needs with the memory the
machine can give without swapping (`androidMemoryGuard.ts`):

- Need: the AVD's `hw.ramSize` (2 GB when it does not say) plus about 900 MB
  for the emulator process.
- Free: on macOS, `kern.memorystatus_level` (the percent that
  `memory_pressure` prints) times the total. `os.freemem()` leaves out the file
  cache there and reads far too low. On Windows and Linux, `os.freemem()`
  (available memory).
- A start that would leave less than 1 GB free fails with
  `ANDROID_LOW_MEMORY`: "{device} needs about X GB of memory, and this machine
  has Y GB free." The pane shows a warning strip with **Start anyway**, the
  floating player's Start becomes **Start anyway**, and the CLI takes `ade
  android start --force`. An emulator that already runs is never checked.

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
| Low memory | A warning strip with the numbers and **Start anyway** (the RAM guard). |
| Unsupported | "This machine can't run the Android emulator." with the host's reason. |

A failed status read shows an inline banner with **Retry**. When the
emulator runs on another machine, **Open log** copies the log path, because
the file is on that machine.

### The live line

A small line at the foot of the picture says the stream state, the frame rate,
the lane and, for another machine, its name. For example:
`Live · 52 fps · lane checkout-flow · on windows`.

It reads "Reconnecting…" with a grey dot when no frame has arrived for 3 s
and either the emulator's machine reports frames this window did not get, or
that machine cannot be reached (its frame-rate read failed or has hung for
3 s). A still screen may send no frames, so silence alone never counts. The
next frame, or a read that says the screen is still, turns it back to Live.
A tap, key or swipe that fails shows one error toast per stall
("Input didn't reach the device").

### Closing the tab

Closing the tab with ×, or moving to another tool, gives back the pane's hold
on the stream. The last viewer of a lane stops the stream. The emulator keeps
running.

### The floating player (P2)

One Apple device and one Android emulator can float over the chat at the same
time, each in its own player (`AndroidDeviceMiniPlayer.tsx`,
`androidMiniPlayerStore.ts`). The shared floating-player slots keep them from
covering each other. The rules are Apple's:

- **Float over chat** in the rail's More menu opens it. So does closing the
  tools pane (or switching tool) while the picture is live, unless the chat's
  "Show preview when minimized" is off.
- `ade android show --floating` (or `ade ui show floating-android`) asks for
  it. With the Android tool on screen, the answer is "shown" and nothing more
  opens.
- An agent that drives the emulator (tap, key, type, launch, record) floats
  it when the chat is in front, the Android tool is not on screen and the
  chat's preview is on. It never replaces a player that is up.
- × closes it and turns the chat's preview off. **Open in pane** moves it back
  into the Android tool. Closing the Android tab for real floats nothing.
- It shows only over a surface of the same lane on the same machine, and it
  is not offered for another machine's work copy.
- The stream lease waits 1 s before the last viewer's stop, so the pane and the
  player share one stream across the handover.

The tools pane's Android card reads "{device} · Running" (or Starting,
Stopping, Off, Stopped) from one status read and the lane's Android events,
with no poll (`useAndroidLaneDeviceCard.ts`).

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
- **Removal.** A project removed from the brain's project list has no next
  brain to adopt its emulators, so they stop: the runtime's teardown carries
  the reason (`"exit"`, `"close"` or `"unregister"`, `RuntimeDisposeReason`)
  and the service stops instead of handing off on `"unregister"`. A removal
  that arrives during another teardown of the project, or for a project that
  is not loaded or failed to boot, stops what an earlier teardown handed off
  (`stopHandedOffAndroidEmulators`, wired as the project registry's
  `onUnregisterAfterHandOff`). The brain's teardown waits for each step, 3 s
  each and 5 s in all, before its database closes.
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
| `device-create --catalog <id> [--color <id>] [--image <package>] [--name <shown name>] [--no-start]` | Make an AVD of a brand-grid device (`pixel-10-pro`, `galaxy-s25`, …) in that colour, and boot it. |
| `render [--angles <a,b>] [--lighting transparent\|studio\|dusk] [--no-shadow] [--video] [--sheet]` | 3D renders of the lane's live device, drawn by the open Android pane and filed as proof. It fails when no window shows the lane's device. |
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
| `long-press <x> <y> [--duration-ms <ms>]`, `drag <x1> <y1> <x2> <y2> [--duration-ms <ms>]`, `scroll --direction up\|down\|left\|right [--amount <0..1>] [--anchor-x/-y]` | A held press (default 1000 ms), a slow press-move-lift (drag and drop), and a scroll. |
| `apps` | The apps on the emulator, each with its launch activity and whether ADE installed it. |
| `install --apk <path>` or `install --gradle [--module <m>] [--variant <v>]` | Install an APK inside the lane worktree, or build the lane's app with its Gradle wrapper (`install<Variant>`, `ANDROID_SERIAL` set to the lane's emulator). |
| `launch --package <name> [--activity <a>]`, or `launch --gradle` / `--apk <path>` | Open an app; with an install flag, install it first and open the package the build made. |
| `terminate --package <name>`, `uninstall --package <name>` | Stop or remove an app. On an attached AVD, only an app ADE installed (`ANDROID_PACKAGE_NOT_ADE_INSTALLED`). |
| `open-url <url>` | Open a URL or a deep link with `am start -a VIEW`. |
| `snapshot [--fresh]` | The screen's element tree: ref, role, name, center and what each element takes. |
| `find-element`, `tap-element [--hold-ms]`, `fill-element --value <text> [--no-focus]`, `wait-for-element [--timeout-ms] [--gone]`, `assert-visible` | Element verbs. The query is `--ref`, `--identifier`, `--label`, `--text`, `--role`, `--index`, as in `ade apple`. |
| `log [--package] [--level] [--since <cursor>] [--lines <n>]` | Logcat, for one app (by pid, else by uid) or all. |
| `record-start [--label] [--max-seconds]`, `record-stop [--discard]`, `record-list`, `record-delete --id <id>` | Record the screen to MP4, from the stream the live view uses. |
| `settings`, or one of `--text-size`, `--display-size`, `--animations on\|off`, `--show-taps`, `--layout-bounds`, `--battery <0-100>` and `--charging on\|off`, `--wifi`, `--data`, `--airplane` | Read the emulator's settings, or change one. A change answers with a fresh read. |
| `lease [--wait <s>] [--ttl <s>] [--holder <name>]`, `lease renew\|release --token <t>`, `lease status` | Take turns on the lane's emulator (the shared device lease). |
| `location <lat> <lon>`, `appearance light\|dark`, `permission grant\|revoke <permission> --package <name>` | Emulator controls (`adb emu geo fix`, `cmd uimode night`, `pm grant`). |
| `proof-bundle [--out <dir>] [--caption] [--package] [--no-elements]` | A screenshot, the elements, a log tail and a meta file, filed as proof. |
| `sdk status\|licenses` | The guided SDK install's plan and licences ([The setup card](#the-setup-card)). Installing, cancelling and picking the folder are the user's, in the desktop app; `sdk install\|use\|cancel` refuse a terminal. |

Every verb also takes `--lane` and `--machine` (see
[Another machine](#another-machine)).

### The agent suite (P1)

`androidAgentSuite.ts` holds the verbs above that P0 did not have, with the
UI tree in `androidUiSnapshot.ts`, the recordings in
`androidRecordingSession.ts`, and the device controls (location, appearance,
permissions) in `androidDeviceSettings.ts`.

- **UI tree.** The Android CLI's `layout` when the SDK has it (about 1 s),
  else `uiautomator dump` (about 2-3 s). `layout` waits for the app to go
  idle and, when it cannot, ADE asks again with `--no-idle`. A CLI that fails
  in another way is skipped for 10 minutes. A snapshot is kept for 5 s and is
  dropped after each input, and when the focused window changes. Each element
  gets a ref from the first name that no other element on screen shares
  (`id:`, `label:`, `text:`), else its role and tree path.
- **Fill.** `fill-element` taps the field, clears it (move to the end, then
  one delete for each character), types, and reads the field back:
  `typed: verified`, `not-seen` (the keyboard dropped characters) or
  `unknown` (a password field).
- **Recording.** `record-start` taps the scrcpy stream (it starts one when no
  viewer has it open) and writes H.264 into MP4 with no re-encode. Frames
  come only when the screen changes, so the file has a variable frame rate.
  The last frame is held until the stop, so a still screen lasts as long as
  it did. When the screen turns, the size changes and the recording goes on
  in a new part (`<id>-2.mp4`). Each part is filed as proof. A recording
  stops at `--max-seconds` (default and most 300), when the emulator stops,
  when the lane lets the device go, and when its chat ends.
- **Proof.** `screenshot`, `record-stop` and `proof-bundle` file proof to the
  chat (and the lane). With `--machine`, the other machine writes the files
  and the caller's machine reads them back and files them in the caller's
  drawer.
- **Lease.** The shared device lease (`services/device/deviceLease.ts`), one
  per lane. A chat's leases end when the chat ends.
- **Turn hint.** A lane with an emulator gets an `<ade-lane-tools>` hint that
  names it, says to use `ade android`, and says never to run `emulator -avd`
  or `adb kill-server` (`laneAndroidDeviceDirective.ts`). A lane with both an
  Apple device and an emulator gets one hint that names both.
- **Release.** On an attached AVD, the packages ADE installed are uninstalled
  before the lane lets it go.

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
agent may call: the P0 verbs, `requestRender`, the SDK reads
(`getSdkSetupPlan`, `getSdkInstallState`) and every agent-suite action
(`ANDROID_AGENT_SUITE_ACTIONS`). The same list feeds the action allowlist.

`ANDROID_USER_ONLY_ACTIONS` are for a viewing client (the desktop, and later
the web and the phone) and never for a session-bound agent:

- `startStream` and `stopStream`. The stream token is only for the viewer that
  started the stream; `getStreamStatus` always returns `transport: null`.
- `sendTouch`, the live touch stream.
- `deleteDevice`, which deletes an ADE AVD that no lane holds.

`ANDROID_PERSON_ONLY_ACTIONS` are the user's alone, from the desktop app, as
Apple's `APPLE_USER_ONLY_ACTIONS` are (`ADE_ACTION_USER_ONLY`): an agent, an
automation and a terminal are all refused.

- `installSdk`, `cancelSdkInstall` and `setSdkPath`: only the user accepts
  Google's licences and picks the SDK folder, in the setup card or Settings ›
  Android devices. `ade android sdk install|use|cancel` print that hint, and
  ADE MCP refuses them.
- `deleteDevice` and `attachRenderProof`.

`status` has `capabilities`: `adb`, `stream`, `record`, `uiTree` (`android-cli`
or `uiautomator`), `logcat`, `gradle`, and the Android CLI's path and version.
The `ade-android` skill tells agents how to use the verbs.

### Remote surfaces

`androidRemoteCommands.ts` registers `android.status`, `android.deviceList`
and `android.recordList` (viewer-allowed) and `android.input`,
`android.invoke`, `android.recordStart` and `android.recordStop`
(controller-only) on every host that builds the emulator service.
`android.invoke` reaches the action allowlist through the `android_emulator`
action domain (its argument checks too), except the stream calls and the SDK
writes.

P2 adds the remote live view. `android.streamTicket` (viewer-allowed) issues a
ticket on the brain's stream relay (the Apple relay, with a second router for
Android on the same `/apple/stream/<ticket>` path). It never boots the
emulator: an emulator that is not booted answers `ANDROID_NOT_RUNNING`. The
relay starts the stream when the viewer's socket attaches and stops only the
streams it started. A local stop while a remote viewer watches hands the
stream to the relay. `android.input` takes kind `touch` (down, move and up
events in device pixels, at most 64 a call) for the viewer's live finger.
`android.status` carries `liveView` (the brain serves tickets) and `appCrash`.

The hosted web client's `androidEmulator` namespace
(`webclient/adapter/androidDevice.ts`) uses these commands. Reads go through
`android.invoke`; the SDK writes refuse with "Set up Android in the ADE
desktop app on that computer." Its events come from a status read every 3 s,
only while the pane listens and the tab is visible.

The iOS app's viewer (`AndroidDeviceViewer.swift` on the live stage, the
`android` kind of `LiveStage`) uses the same commands and the same video
socket as its Simulator viewer. It shows only where the lane's machine
advertises both `android.status` and `android.streamTicket`. The chat's tool
chips show the emulator while the lane has one, also when it is off, so the
viewer can offer **Start**. Start and input need `android.invoke` and
`android.input` at the controller role; a phone at the viewer role can only
watch. The emulator sends no frames while its screen is still, so the viewer
does not treat a still picture as a dead stream. Fold mirroring waits for a
host posture API (P3).

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

The phone and web viewers (P2) are in **Remote surfaces** above.

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

## Product analytics

The emulator service in the brain records one coarse `ade_feature_used` fact
(`action: "android_device"`) when the guided SDK install puts parts in place,
an app installs, a 3D render files as proof, or an agent takes a new lease.
Each outcome counts at most once a day. No path, AVD, package, lane or image
goes with it. `docs/logging.md` holds the contract.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/androidEmulator.ts` | The contract: SDK, AVD and lane types, error codes, the service API, the action lists (`ANDROID_AGENT_ACTIONS`, `ANDROID_USER_ONLY_ACTIONS`, `ANDROID_PERSON_ONLY_ACTIONS`, `ANDROID_LANE_FREE_ACTIONS`, `ANDROID_CODE_SYNC_ACTIONS`), and the preload API. It re-exports its siblings: `androidEmulatorAgent.ts` (the agent suite, `ANDROID_PERMISSIONS`), `androidEmulatorSetup.ts` (the SDK install), `androidEmulatorLook.ts` (colour and render) and `androidEmulatorDrawer.ts` (the Tools drawer, `ANDROID_TEXT_SIZES`, `ANDROID_DISPLAY_SIZES`). |
| `apps/desktop/src/main/services/android/androidEmulatorService.ts` | The service: lane queue, start, stop, input, screenshot, the work-copy lanes, the start-up cleanup, and the hand-off. |
| `apps/desktop/src/main/services/android/androidDeviceInventory.ts` | The lane's AVD: the device list, create, attach, release, delete and colour, and the work copy's borrow rule. |
| `apps/desktop/src/main/services/android/androidSdk.ts` | SDK detection, tools and acceleration. |
| `apps/desktop/src/main/services/android/androidSdkSetup.ts`, `androidSdkInstall.ts`, `androidSdkRepository.ts`, `androidZipExtract.ts`, `androidCli.ts` | The guided install: the plan, licence checks, the SDK setting, the installer job, Google's repository manifests, the zip reader, and the Android CLI. |
| `apps/desktop/src/main/services/android/androidAvds.ts`, `androidHardwareProfiles.ts` | AVD list, create and delete, ADE's marker, and the hardware profiles. |
| `apps/desktop/src/shared/androidDeviceCatalog.ts`, `apps/desktop/src/main/services/android/androidCatalogProfiles.ts` | The brand grid's devices (names, sizes, colours, bodies, profiles), and the merge of ADE's `ade_*` profiles into `devices.xml`. |
| `apps/desktop/src/main/services/android/androidRender.ts` | The render broker for `ade android render`: the request event, the first window's ack, the filed paths, and the time limit. |
| `apps/desktop/src/main/services/android/androidEmulatorProcess.ts` | Boot, discovery files, boot completed, and stop. |
| `apps/desktop/src/main/services/android/androidLaneDeviceStore.ts`, `androidLaneRelease.ts` | The `lane_android_devices` rows, and the release of a lane's AVD on disk (used by `laneService` with no service). |
| `apps/desktop/src/main/services/android/androidStream.ts`, `androidStreamServer.ts`, `androidLaneStreams.ts` | Streams by adb serial, the defaults, restarts, and the loopback stream server; the lane's side of its stream (a viewer, a recording). |
| `apps/desktop/src/main/services/android/scrcpyServer.ts`, `scrcpyVideo.ts`, `scrcpyControl.ts` | The scrcpy session, video records and control messages. |
| `apps/desktop/src/main/services/android/androidActionDomain.ts` | The `android_emulator` action domain. |
| `apps/desktop/src/main/services/android/androidMemoryGuard.ts`, `androidCrashWatch.ts` | P2: the RAM guard, and the crash-buffer reader behind the crash pin. |
| `apps/desktop/src/main/services/android/androidAgentSuite.ts`, `androidJdk.ts` | The agent verbs (elements, apps, logcat, proof, lease), and the JDK that Gradle runs with. |
| `apps/desktop/src/main/services/android/androidUiSnapshot.ts`, `androidUiTree.ts` | The UI tree (the Android CLI, or uiautomator), its cache, and the element queries. |
| `apps/desktop/src/main/services/android/androidRecordingSession.ts`, `androidRecording.ts` | The lane's recording sessions, and the MP4 writer and store. |
| `apps/desktop/src/main/services/android/androidDeviceSettings.ts` | The Tools drawer's settings read and its changes, the app in front, and location, appearance and permissions. |
| `apps/desktop/src/main/services/android/androidDeviceShell.ts`, `androidProof.ts` | Device shell, adb and emulator console helpers, and the proof filer. |
| `apps/desktop/src/main/services/android/adb.ts`, `androidEmulatorErrors.ts` | The adb runner and the coded errors. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePane.tsx` | The pane: picker, stage, rail, drawer, strips and live line. |
| `apps/desktop/src/renderer/components/android/drawer/` | The Tools drawer: `AndroidToolsDrawer.tsx`, the four group sections, and `androidDrawerState.ts`. The open group, the one serialized change and the settings come from the shared `device/deviceDrawerState.ts`; the frame, the Location rows and the recording rows from `device/DeviceToolsDrawerShell.tsx`, `device/DeviceLocationRows.tsx` and `shared/RecordingRow.tsx`. |
| `apps/desktop/src/renderer/components/android/useAndroidInspect.tsx`, `useAndroidRecording.ts` | Inspect (on the shared `device/useDeviceInspect.ts` and `device/DeviceInspectOverlay.tsx`) and the rail's Record. |
| `apps/desktop/src/renderer/components/android/androidDeviceState.ts` | The pane state, stock profiles, menu rules and error sentences. The 3D-or-flat choice is kept by the shared `device/deviceViewMode.ts`. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePicker.tsx`, `AndroidSetupCard.tsx`, `AndroidLicenseDialog.tsx`, `useAndroidSdkSetup.ts` | The picker, the setup card, the licence dialog and the card's data. |
| `apps/desktop/src/renderer/components/settings/AndroidDevicesSection.tsx` | Settings › Android devices: the setup card for the picked machine. |
| `apps/desktop/src/renderer/components/android/AndroidDeviceStage.tsx`, `AndroidDeviceRail.tsx`, `AndroidDeviceStatus.tsx` | The stage (on the shared `device/DeviceFlatView.tsx`), the rail (on `device/DeviceRail.tsx`), and the strips, cards and live line (on `device/DeviceStatusStrip.tsx` and `device/DeviceLoadingCard.tsx`). |
| `apps/desktop/src/renderer/components/android/AndroidCatalogGrid.tsx`, `androidTileRenderer.ts` | The brand grid tiles and their details, and the one shared WebGL renderer for the tile stills and the hover turn. |
| `apps/desktop/src/renderer/components/android/androidDeviceBody.ts`, `androidDeviceModels.ts`, `useAndroidBootScreen.ts` | The procedural device bodies (and any model file), and the boot screen drawn on the 3D model. |
| `apps/desktop/src/renderer/components/android/AndroidRenderSheet.tsx`, `androidRender.ts`, `useAndroidRenderRequests.ts` | The Render sheet (on the shared `device/DeviceRenderSheet.tsx`), the drawing and filing of renders (on `device/deviceRenderProof.ts` and `device/deviceRenderPass.ts`), and the pane's answer to `ade android render`. |
| `apps/desktop/src/renderer/components/android/useAndroidDeviceStream.ts`, `useAndroidDeviceInput.ts`, `androidStreamLease.ts` | The stream (on the shared `device/useStreamRecovery.ts` and `device/useGracefulStreamLease.ts`), input, and the per-lane stream lease (a `device/streamLease.ts` table of its own). |
| `apps/desktop/src/renderer/components/terminals/workToolPanels.tsx` | The Android tool's targets (This lane, Android · `<machine>`). |
| `apps/desktop/src/renderer/components/android/AndroidDeviceMiniPlayer.tsx`, `androidMiniPlayerStore.ts` | P2: the floating player and which emulator floats. |
| `apps/desktop/src/renderer/components/android/AndroidQuickChips.tsx`, `AndroidCrashPin.tsx`, `drawer/AndroidLogsSection.tsx` | P2: the quick chips, the crash pin and the Logs group. |
| `apps/desktop/src/renderer/components/android/useAndroidLaneDeviceCard.ts` | P2: the tools pane card's line. |
| `apps/desktop/src/renderer/webclient/adapter/androidDevice.ts` | P2: the hosted web client's `androidEmulator` namespace. |
| `apps/ios/ADE/Views/Work/AndroidDeviceViewer.swift`, `AndroidDeviceViewerModel.swift`, `apps/ios/ADE/Services/SyncService+AndroidDevice.swift` | P2: the phone viewer, its stream and control model, and the `android.*` commands it sends. |
| `apps/desktop/src/renderer/components/terminals/useRemoteDeviceTabs.ts` | The tab that joins the open pane for a remote device use (iOS and Android). |
| `apps/ade-cli/src/cliAndroid.ts`, `cliAndroidFormat.ts` | `ade android` plans and error hints, and its text formatters. The help page is in `cli.ts`. |
| `apps/ade-cli/src/services/sync/androidRemoteCommands.ts` | The `android.*` remote commands a phone or a web tab sends. |
| `apps/desktop/resources/android/` | The scrcpy server jar, its licence and its README. |

## Limits and later phases

P0 does not have:

- the 3D view, device models or the brand grid (P1, now built: device bodies
  are procedural; no model files ship yet);
- UI tree and element verbs, logcat, app install and launch, record, lease,
  the turn hint and the `ade-android` skill (P1, above);
- Inspect, Record on the rail and the Tools drawer (P1, now built);
- phone and web viewers, the phone's full-screen view, quick chips, the Logs
  drawer, the RAM guard, and two floating players, one for each device kind
  (P2, now built; see the sections above);
- fold by drag, Compose preview render, a system image manager and
  instrumentation tests (P3).

The full list is in §6 of the [plan](../../plans/android-emulator.md).

## Troubleshooting

| State | What to do |
|---|---|
| `ANDROID_SDK_NOT_FOUND` | Install Android Studio or the command-line tools, or set `ANDROID_HOME`. Then press **Check again** or run `ade android status --text`. |
| `ANDROID_TOOL_MISSING` | Install the missing package (`platform-tools`, `emulator`) with `sdkmanager`. |
| `ANDROID_NO_SYSTEM_IMAGE` | Install a system image for the host ABI, or pass `--image <package>`. `ade android devices --text` lists the installed images. |
| `ANDROID_NO_ACCELERATION` | Turn on acceleration: Windows Hypervisor Platform on Windows, KVM access on Linux. WSL2 has none, and a VM has it only with nested virtualization. The banner's **How to fix** opens Google's guide. |
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
