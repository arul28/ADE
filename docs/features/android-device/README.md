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
   Stopped, Off). A click opens it. Under it, **Extra devices** lists the
   lane's extra devices (see [Extra devices](#extra-devices)), each with its
   state. A click on an extra makes it the lane's device and opens it (one
   that is off boots). Its ⋯ menu has **Start beside the lane's device** (or
   **Stop**), **Make this the lane's device**, **Copy AVD name** and
   **Remove from this lane…**, which asks again and deletes the AVD. The
   extras are not listed again under On this machine.
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
5. **System images** (P3). A toggle that lists the images on the lane's
   machine and the ones to add (see [System images](#system-images-p3)).

Pixel tiles use the SDK's own hardware profiles. The other brands use ADE
profiles (`ade_*` ids) that ADE merges into `<android user home>/devices.xml`
(`~/.android/devices.xml`) on the first create. The merge keeps every
profile that is not ADE's, writes the file atomically, and uses the density
values the SDK schema allows.

The tile stills come from one shared WebGL renderer. Each still is drawn
once, then kept in memory and in `localStorage` (WebP). Hover turns the body
slowly on the same renderer, one tile at a time; the renderer is freed after
20 s with no use. Reduced motion stops the turn.

### System images (P3)

The picker's last section, in the place the Apple picker has **Runtimes**
(`AndroidSystemImagesSection.tsx`, data in `useAndroidSystemImages.ts`, the
service in `androidSystemImages.ts`). It reads only while it is open.

- **Installed.** Each image in `<sdk>/system-images` with its API level, tag
  and ABI, its size on disk, and the AVDs that boot from it. ADE finds an
  AVD's image from `image.sysdir.1` in its `config.ini`, else from its API
  level, tag and ABI. **newest** marks the image a brand tile uses when no
  image is named.
- **Available.** The stable images in Google's `sys-img2-3.xml` manifests for
  the host ABI, with the Google Play or Google APIs tag, at the newest
  revision of each. An installed image with a newer revision shows
  **Update**. An image that needs a newer emulator than the installed one
  shows its need and cannot install.
- **Install.** The licence dialog of the setup card shows the image's licence
  in full; the install starts only when the person ticks it. The install
  runs on the machine's one SDK install job (`androidSdkInstall.ts`): it
  checks the free space (the unpacked size and the zip), checks the SHA-1,
  writes the licence file and the consent record ("ADE device picker ›
  System images"), shows progress, and **Cancel** stops it. An update is
  refused while an AVD on that image runs.
- **Remove.** ADE asks first. When AVDs use the image, the question names
  them: ADE keeps their files, but they cannot start until the image is
  installed again. The service refuses a removal while one of those AVDs
  runs, and refuses one with users that the person did not confirm
  (`ANDROID_SYSTEM_IMAGE_IN_USE`). It moves the folder out of
  `system-images/` first, then deletes it. On Windows, a file that another
  program holds open is refused with the same code.

A finished install or removal sends `android.inventory.changed`, and the
picker reads its list again. The device list reads the images from disk on
each read, so a brand tile uses a new image with no restart.

`ade android sdk images [--installed]` prints the same list. Install and
remove are the person's (`ANDROID_SDK_PERSON_ONLY_ACTIONS`): an agent, a
terminal and ADE MCP are refused, and the CLI says to ask the user.

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

### Fold (P3)

A foldable AVD (a Pixel Fold or a Galaxy Z Fold profile) has a hinge. The
pane reads it once when the emulator boots (`getPosture`), then follows the
brain's `android.device.posture` events, so a fold from an agent or another
viewer shows at once.

- **3D:** the stage draws a two-panel body (`device/proceduralFoldBody.ts`,
  the body the iPhone Duo also uses) at the hinge angle, with the live inner
  screen across both panels. The hinge runs down a book-style inner screen.
  Below 30° Android shows the cover screen, and the stage draws the cover
  phone body instead (one panel, no seam).
- **The dock** under the stage (`AndroidFoldDock.tsx`): in 3D, the hinge
  slider (`device/HingeSlider.tsx`, shared with the Duo) with the detents
  Closed, Half and Open. A drag folds the drawn body only; the release folds
  the emulator. In flat, three buttons: Closed, Half, Open. The readout shows
  what the emulator reports, for example `102° · half open · inner screen`.
- **Pinch** on the 3D body folds it too (120° for each doubling of the pinch),
  and commits 250 ms after the last move.

The brain (`androidPosture.ts`) sets the hinge with the emulator console
(`sensor set hinge-angle0 <angle>`) and waits up to 3 s until Android settles:
the sensor reads the angle, no device state is pending, and the screen
capture has the size of the screen in front. It answers `settled: false` when
Android was still changing. On a device with no hinge, the console answers
`KO: unknown sensor name`, `getPosture` answers `supported: false`, and
`setPosture` refuses. The fold states are Android's: 0–30° closed, 30–150°
half open, 150–180° open.

### The rail

The rail floats on the right edge, in Apple's place and size. The order:

- **Back**, **Home**, **Recents**.
- A divider.
- **Power and volume** ▾: Power, Volume up, Volume down.
- **Orientation** ▾: names the current orientation and lists all four
  (Apple's menu). The home screen of a phone stays portrait; apps that allow
  rotation turn. The 3D body turns with the device, upside down too.
- **Inspect**: boxes over every element of the screen (see
  [Inspect](#inspect)).
- **Save screenshot**, **Render** (the Render sheet), **Record** (red while a
  recording runs; it is also the Stop button), and **View** (3D or flat).
- A divider.
- **Device tools**: opens the [Tools drawer](#the-tools-drawer).
- **Maximize**, where the pane provides it.
- **More** ⋯: the device name and profile, **Switch device…**, the body
  colour, **Reset view**, **Play Store screenshots**, and **Power off**.

Below 360 px of pane width the rail keeps the navigation keys, Power, Device
tools, Maximize and More. The other controls move into More.

### Inspect

Inspect reads the UI tree once (`getScreenSnapshot`, fresh) and draws a box
for each element, in 3D and in flat. Touch is off while Inspect is on, so a
box cannot go stale under the pointer. Click an element to see its card: ref,
role, identifier, text, what it takes, and bounds. **Insert into chat** puts
a context chip in the composer, as Apple's Inspect does: the brain on the
lane's machine (the pin) runs `inspectPoint`, which crops the element and
looks for its source in the lane's Kotlin, Java and XML (`androidInspect.ts`:
an exact match for a test tag, `@+id/…` or `R.id.…`, and candidates for the
shown text; 1.5 s and 4000 files at most). The chip is Apple's
`ios_element` packet with `metadata.contextSurface: "android-emulator"`, so
the composer, the saved crop and the prompt packet are the same code. Where
no chip can go, it puts one line in the draft, with the
`ade android tap-element --ref …` command. **Copy** copies that command. Inspect goes off when the device stops
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
| Device | Text size and Display size (Small, Default, Large, Largest or Larger), Animations off, Show taps, Show layout bounds. **Accessibility**: High contrast text, Bold text, Color inversion, Grayscale, Color correction and TalkBack, each read back from the device ("not on this image" when the image does not have it). **Status bar**: **9:41** (demo mode) and **Clear**. |
| App | The app in front (read every 2 s while the group is open), **Build & run** (Gradle), **Relaunch**, **Stop**, **Uninstall**, **Start an app**, **Open** a link, **Install** an APK, **Run tests** (P3, instrumentation tests), **Windows** (Split, Swap sides, Free window, Full screen, Close; for the typed package or the app in front), and Permissions. |
| Capture | The lane's recordings, newest first: **Open in proof**, and a ⋯ menu with Show in Finder (not for another machine's files) and Delete. A running recording shows as one line at the top. |
| Emulator | Appearance, Location (presets or a typed point, and **Clear**), Battery level and Charging, Airplane mode, Wi-Fi, Mobile data. |
| Logs | Logcat for the lane's app (P2): the newest package ADE installed for the lane, else the app in front, or **Whole device**. A level filter (All, Info, Warn, Error), a text filter, **Pause**, **Clear**, **Copy** and **Send to chat** (the newest 80 lines into the chat's draft). |
| Previews | P3: Compose previews. A module box (`app` by default), **Find previews**, a check box for each `@Preview`, and **Render**. The images show as thumbnails; a click opens the proof row ([Compose previews](#compose-previews-p3)). |

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

### The memory guard (P2)

Before a boot, the brain decides on what the machine has already committed,
not on a free-memory snapshot (`androidMemoryGuard.ts`): a machine already
pushing the emulators into swap still reads as having memory free
(`hostMemorySignals.ts` has the measured case). A start is refused with
`ANDROID_LOW_MEMORY` when any one of these holds:

1. **Pressure.** The OS says memory is under pressure, warn or worse. macOS:
   `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical).
   Linux: PSI `/proc/pressure/memory` (`some avg10` ≥ 10% is warn; `full
   avg10` ≥ 10% or `some` ≥ 40% is critical). Windows: the commit charge
   against the commit limit (≥ 90% warn, ≥ 97% critical).
2. **Paging.** The machine writes to swap at 4 MB/s or more, sampled over
   2 s at the start only (`vm_stat` swap-outs, `/proc/vmstat` `pswpout`, or
   Windows `PagesOutputPersec`). Nothing polls.
3. **Budget.** All running emulators (the user's and other brains' too), the
   boots in flight on the machine, and this one would pass half of physical
   memory. The first emulator is never refused by this rule alone, so a small
   machine can still run one.
4. **Available.** What the OS can hand out (macOS `kern.memorystatus_level`
   times the total, Linux `MemAvailable`, Windows free physical memory), less
   the boots in flight and this one, would leave less than 1 GB.

"Running emulators" is every `qemu-system-*` process and every discovery
file's pid, measured as the OS counts real memory: macOS `phys_footprint`
(`footprint`, which includes compressed and swapped memory; plain RSS read
2.3 GB for an emulator whose footprint was 8.4 GB), Linux RSS + swap, Windows
the private commit. One process listing per start.

"This one" is the AVD's `hw.ramSize` (2 GB when it does not say) plus its
overhead: the overhead last measured for that AVD (from one of ADE's
emulators that ran at least 5 minutes, kept in the owner file), else the
largest one measured on the machine, else as much again as the guest plus
1.5 GB. A 2 GB foldable measured 6.4 GB over its guest after a day of use.

Boots in flight are held in this process (two lanes that start together
cannot both fit) and in the owner file for other brains. The refusal is one
sentence under 140 characters that names the numbers and the way out, for
example "Pixel 9 needs about 5.5 GB; emulators already use 14.0 GB of the
18.0 GB ADE allows. Stop an emulator first." It is an expected answer
(`environment`), so it never reaches Sentry as an issue. The pane shows a
warning strip with **Start anyway**, the floating player's Start becomes
**Start anyway**, and the CLI takes `ade android start --force` (its hint
says to ask the user first). An emulator that already runs is never checked.

### States

| State | What the pane shows |
|---|---|
| Setup | The setup card. |
| No acceleration | A banner over the pane: "No emulator acceleration: …", with **How to fix** (Google's acceleration page). The user can dismiss it. |
| Starting | The loading card while the AVD boots, then while the video connects. |
| Live | The picture, the rail and the live line. |
| Video stopped | The picture dims. The strip says "Video stopped." with **Reconnect**. |
| Off | "{name} is off." with **Start** and **Choose another device**. |
| Crashed | An error strip with one line on why the emulator stopped (often the last error line of its log), one action (**Restart**, or **Restart adb and start** when adb refused the device) and an **Open log** link. The card below says "{name} is off." with **Choose another device**. The strip reports the failure to Sentry under `android_device_boot` with its code. |
| Low memory | A warning strip with the numbers and **Start anyway** (the memory guard). |
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

A lane holds one Android device as its own (the lane device), and can hold
extra devices beside it ([Extra devices](#extra-devices)). An AVD belongs to
at most one lane. The Android device is separate from the Apple device, so a
lane can hold one of each. An agent can drive both in one turn with
`ade apple` and `ade android`.

The lane's row is in the local-only table `lane_android_devices`, and its
extras are in `lane_android_extra_devices`. Neither syncs.

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
  the list survives a restart, and an owner record of each in the machine's
  owner file (see [Emulator lifecycle](#emulator-lifecycle)). `ade android
  stop` on an emulator that another app started fails with
  `ANDROID_AVD_RUNNING`. Emulators that ADE did not start are listed and count
  against the memory guard, and are never stopped.
- An AVD that ADE made for a lane outside this project can be attached, but
  this project never deletes it.
- An AVD boots once at a time. Each emulator gets its own even console port in
  5554–5682.

Boot is headless (no window, no audio, no boot animation). It is ready when
`sys.boot_completed` reads 1. A first boot of a new AVD took 54 s on the
Windows test machine, and a cold boot 24 s. ADE waits up to 180 s.

### Extra devices

As an Apple lane holds extra simulators, an Android lane can hold extra AVDs
beside its own device, for example a tablet beside a phone
(`androidLaneExtras.ts`, `androidEmulatorExtras.ts`).

- **Make one.** `ade android device-create --extra --catalog <id>` (or
  `--profile <id>`). ADE makes the AVD for the lane, with ADE's marker, and
  boots it beside the lane device unless `--no-start`. A lane may hold 2
  extras; `ADE_ANDROID_LANE_EXTRA_DEVICES` in ADE's environment raises the
  limit up to 8. One more is refused with `ANDROID_EXTRA_DEVICE_LIMIT`. A
  boot that fails leaves the extra made, and it still counts.
- **The lane device stays the lane device.** It streams, records, runs the
  tests, and takes every verb that names no device. An extra has no stream,
  recording, lease, crash pin or tests.
- **Reach an extra with `--device <avd>`** on `start`, `stop`, `install`,
  `launch` and `device-detach`. The AVD name or the shown name works. A
  `--device` the lane does not hold is refused with
  `ANDROID_DEVICE_NOT_LANE_OWNED`. An install or a launch on an extra that is
  off boots it first. Each extra starts and stops on its own queue, so its
  boot never holds up the lane device.
- **Memory.** Each running emulator holds 2 to 5 GB. Every start of an extra
  goes through the [RAM guard](#the-ram-guard-p2), the same as the lane
  device; `start --device <avd> --force` boots past it, after the user agrees.
- **Promote.** `ade android device-promote --device <avd>` (or a click on the
  extra in the picker) makes the extra the lane's device. The old device is
  kept: one ADE made becomes an extra in its place, and its emulator keeps
  running; the user's own AVD is released to them (what ADE installed comes
  off, ADE's emulator stops, nothing is deleted). A running extra becomes the
  lane's running device. The promote is refused with
  `ANDROID_LANE_DEVICE_BUSY` while the old device starts or stops, records,
  streams to a viewer (an open pane counts; the picker does not), runs tests,
  installs or launches an app, or another holder has the lane's lease; and
  while the extra itself starts, stops, or takes an install. Nothing changes
  before the refusal.
- **Attach.** `device-attach --avd <name>` naming one of the lane's extras is
  refused with `ANDROID_DEVICE_IS_EXTRA`: promote it instead. No other lane
  can take, stop or delete a lane's extra.
- **Remove.** `ade android device-detach --device <avd>` stops the extra and
  deletes its AVD (`--keep` keeps it on disk as a free AVD). The lane keeps
  its device. `device-detach` with no `--device` releases the lane's device
  and keeps the extras.

The phone and the web viewers show only the lane device, as Apple's do.

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
- The lane's extra devices stop, and each one is deleted the same way (only
  while its `config.ini` carries ADE's marker). A running extra keeps its
  row, and the cleanup pass ends it later.

`ade android device-detach` does the same for a lane that stays. `--keep`
keeps a created AVD on disk.

### Brain restarts and the start-up cleanup

- **Hand-off.** When a brain on the installed app's ADE home (`~/.ade`,
  `~/.ade-alpha`) exits, ADE's emulators keep running and stay in the state
  file. The next brain adopts them again. A brain on any other home (a dev or
  test brain) has no next brain: it stops them. A boot that was in
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

### Emulator lifecycle

An emulator runs only as long as something is going to use it
(`androidEmulatorOwners.ts`, `androidEmulatorSweep.ts`, `androidEmulatorUse.ts`).
There is one idle policy and one orphan policy, and both live here and in
the service, not in the cleanup pass below.

- **Owner records.** Every emulator ADE starts gets a record in one file for
  the whole machine, `~/.ade/android/emulator-owners.json` (under the user's
  default home whatever `ADE_HOME` says, so the installed brain, a dev brain
  and a test brain on a scratch home all see it): the AVD and console port,
  qemu's pid and its start time, the owning brain's pid, start time and ADE
  home, the lane, the project, the chat, the machine id, when it started and
  was last used, and the pin. Writes take a lock file and rename into place.
  Emulators that were already running when a brain first used this file are
  taken in with a fresh idle clock.
- **Last used.** Every service call that names the lane moves its clock (a
  tap, key, text or touch, Inspect, a relaunch, a stream, an install or
  launch, a screenshot, a recording, a log read, a lease, a fold, a test
  run), except the reads a pane or the mini player polls, the stops, the pin
  and the cleanup pass (`ANDROID_NOT_USE_METHODS`), so a new method counts by
  default. While a stream someone holds (a viewer or a recording), a lease, a
  boot or one of those calls is in progress, the emulator is in use.
- **Idle stop.** An emulator ADE started (made or attached AVD alike) that is
  not pinned and that nobody used for 20 minutes is stopped
  (`ADE_ANDROID_IDLE_POWER_OFF_MINUTES`, or its other name
  `ADE_ANDROID_IDLE_STOP_MINUTES`; `0` turns it off). Just before the stop, on
  the lane's queue, the device is asked for use ADE's calls cannot see: input
  from outside ADE (`dumpsys power` `mLastUserActivityTime`, which adb and
  Android Studio move) inside the limit, or a scrcpy viewer that is not this
  brain's (another brain on the project, another tool). Either one restarts
  the clock instead (`android.idle_stop_skipped`). The lane keeps its device;
  `status` shows `poweredOff` (when, and the idle minutes) until the next
  start, and `ade android start` boots it again.
- **Keep running.** The rail's More menu has **Keep running**, and agents have
  `ade android keep-running on|off`. It pins the running emulator against the
  idle stop and `device-cleanup --power-off-idle`, on the emulator's machine (a pinned call through the
  `android_emulator` action domain, `setKeepRunning`). A stop ends the pin.
  `status` shows `keep running: yes`, or `no (ADE stops it after 20 min
  unused)`.
- **Owner gone.** When the owning brain is gone, a live brain on the same ADE
  home adopts the emulator (a restart or an update), as the hand-off above
  does. A brain on a dev or test home does not hand off on exit: it stops its
  emulators, and nothing adopts them. One that crashed is stopped by any
  brain's sweep after a grace: 2 minutes for a scratch home, 10 for the
  installed app's home (its service can take minutes to come back). A pinned
  emulator on the installed app's home is never stopped this way: it waits
  for a brain on that home to adopt it. A stop re-reads the record just
  before it is taken, and is called off when the record changed since the
  sweep looked (pinned, adopted, used).
- **The sweep.** Each brain sweeps 30 s after its first Android service
  starts and then every 5 minutes, on unref'd timers. A sweep reads the owner
  file and the discovery folders, and only when there are records runs one
  `ps` for start times (on Windows, one `tasklist` for image names instead).
  It stops nothing that has no record, and nothing whose discovery file no
  longer names the recorded AVD, port and pid; a record whose emulator is
  gone is dropped. Windows has no start times to compare and keeps a crashed
  emulator's discovery file, so there a pid counts as the emulator only while
  its image is `qemu-system-*` or `emulator*`.
- **Stopping.** `adb -s emulator-<port> emu kill`, then (only if qemu has not
  exited after 20 s, and only after checking the discovery file again) SIGTERM,
  then SIGKILL. On Windows, `taskkill /T`, then `taskkill /T /F`, each only
  after `tasklist` shows the pid is still an emulator's image; a user's stop
  goes through the same checks. Every stop
  logs `android.emulator_stopped` with its reason: `user`, `released`,
  `lane_released`, `idle`, `owner_gone`, `orphan`, `cleanup` or
  `project_closed`.
- **Orphans.** An emulator ADE started for the project that no lane holds
  any more is stopped (`orphan`) by one stop, which the start-up cleanup
  above and the cleanup pass below both use. The pin does not keep one: with
  no lane, nothing could unpin it.
- **Dev and test brains.** A brain a dev or test launcher marked
  (`ADE_DEV_BRAIN=1`, `--dev-test-machine`, the dev launcher's socket
  variable), on a home other than the installed app's, exits after 30
  minutes with no clients, no chat or terminal work and no synced device
  once its parent is gone (`unmanagedBrainIdleExit.ts`), and stops its
  emulators on the way out. A brain nothing marked (`nohup`, cron, a cloud
  box) never idles out.

### The cleanup pass

`androidLaneMaintenance.ts`, as Apple's lane device maintenance, without its
idle timer (the idle stop above is the only one):

- **Extra devices and the idle stop.** Each extra device has its own owner
  record, under the lane that holds it, so the machine sweep stops an idle
  extra by the same rules as the lane's device (an install or a launch on it
  counts as use, and so does its boot). The stop runs on the extra's own
  queue; `status` shows the extra's `poweredOff` until its next start.
- **Cleanup.** 60 s after the service starts, then every 15 min: release the
  device of each ended lane, stop each emulator ADE started that no lane
  holds (the `orphan` stop above, by its process tree, so Windows too),
  forget each lane row whose AVD
  is gone from disk, and list ADE-made AVDs that no lane holds (never deleted:
  the marker does not name the project). `deviceCleanup` (`ade android
  device-cleanup`) runs the same pass now; `--dry-run` reports and changes
  nothing; `--power-off-idle` also powers off now each emulator ADE started
  that nothing uses and nobody pinned (`cleanup`), whatever its idle time. An
  agent's `--power-off-idle` reaches only its own lane (the RPC server sets
  `agentCaller`). The report's `idlePowerOffMinutes` is the idle stop's limit.
- **Chrome's first run.** Before the first `open-url` whose `http(s)` URL
  opens in Chrome (`cmd package resolve-activity`), and before `launch
  --package com.android.chrome`, ADE makes Chrome skip "Welcome to Chrome"
  and the notifications prompt, with no root: `am set-debug-app
  --persistent`, the flags file `/data/local/tmp/chrome-command-line`
  (`--disable-fre --no-default-browser-check --no-first-run`), and `pm grant
  … POST_NOTIFICATIONS`. A first-run screen already up is force-stopped. Once
  per boot per lane, best effort (`androidChromeSetup.ts`).

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
| `start` | Boot the lane's AVD. It waits for boot completed. Refused with `ANDROID_LOW_MEMORY` by the [memory guard](#the-memory-guard-p2); `--force` boots anyway. |
| `stop` | Stop the lane's emulator. The lane keeps its AVD. |
| `keep-running on\|off` | Pin the lane's running emulator against ADE's 20-minute idle stop, or unpin it ([Emulator lifecycle](#emulator-lifecycle)). |
| `device-detach [--keep]` | Stop the emulator and release the AVD (see [When a lane ends](#when-a-lane-ends)). |
| `device-create --extra (--catalog <id> \| --profile <id>) [--no-start]` | Make an extra AVD beside the lane's device and boot it ([Extra devices](#extra-devices)). |
| `start --device <avd>`, `stop --device <avd>` | Boot or stop one of the lane's extras (the RAM guard applies; `--force` boots past it). |
| `install … --device <avd>`, `launch … --device <avd>` | Install or launch on one of the lane's extras; an extra that is off boots first. |
| `device-promote --device <avd>` | Make an extra the lane's device; the old one is kept. Refused with `ANDROID_LANE_DEVICE_BUSY` while it is in use. |
| `device-detach --device <avd> [--keep]` | Stop one extra and delete its AVD (`--keep` keeps it). The lane keeps its device. |
| `screenshot [--out <path>]` | Write a PNG of the screen. |
| `tap <x> <y>` (or `--x`, `--y`) | Tap a point. |
| `swipe <x1> <y1> <x2> <y2> [--duration-ms <ms>]` | Swipe from one point to another (default 300 ms). |
| `button <name>` (or `--name`) | `back`, `home`, `recents`, `power`, `volume-up`, `volume-down`. |
| `rotate portrait\|portrait-upside-down\|landscape-left\|landscape-right` | Lock the display to that orientation (auto-rotate off, `user_rotation` 0 to 3, mapped for a tablet whose natural shape is landscape). `landscape` is `landscape-right`. An app that fixes its own orientation keeps it. Each rotate pushes `android.device.orientation`, so a viewer draws the device turned the right way. |
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
| `record-start [--label] [--max-seconds] [--plain\|--zoom]`, `record-stop [--discard\|--keep]`, `record-list`, `record-delete --id <id>`, `auto-record on\|off\|status` | Record the screen to MP4, from the stream the live view uses, and file it as a demo video. `--no-record` on an input verb starts no automatic recording. |
| `settings`, or one of `--text-size`, `--display-size`, `--animations on\|off`, `--show-taps`, `--layout-bounds`, `--battery <0-100>` and `--charging on\|off`, `--wifi`, `--data`, `--airplane` | Read the emulator's settings, or change one. A change answers with a fresh read. |
| `lease [--wait <s>] [--ttl <s>] [--holder <name>]`, `lease renew\|release --token <t>`, `lease status` | Take turns on the lane's emulator (the shared device lease). |
| `location <lat> <lon>`, `location --clear`, `appearance light\|dark`, `permission grant\|revoke <permission> --package <name>` | Emulator controls (`adb emu geo fix`, `cmd uimode night`, `pm grant`). The emulator has no "no location", so `--clear` moves the GPS back to its default point (37.4219983, -122.084). ADE keeps the last location per lane and boot; `settings` reads it. |
| `accessibility <option> on\|off` | `increase-contrast` (high contrast text), `bold-text` (`font_weight_adjustment`, API 31+), `invert-colors`, `grayscale` and `color-correction` (the daltonizer; one turns the other off), `talkback` (only on an image that has TalkBack; null otherwise). `settings` reads each back from the device. |
| `status-bar [--time] [--data-network] [--wifi-bars] [--cellular-bars] [--battery-level] [--battery-state]`, `status-bar --clear` | SystemUI demo mode: a clean status bar for screenshots (default 9:41, full bars, full battery, no notification icons). `settings` reads `statusBarOverridden`. |
| `play-store-shots [--no-proof]` | Google Play screenshots: each screen padded onto a black 9:16 or 16:9 canvas at Play's sizes (short side 1080 or more, long side 3840 or less). A foldable gives two: the cover screen shut (phone slot) and the inner screen open (large-screen slot), and its hinge goes back after. Filed as proof. |
| `window status\|split\|left\|right\|top\|bottom\|swap\|freeform\|size\|move\|fill\|close [--package] [--with] [--size WxH] [--move X,Y]` | Split screen (WMShell), free windows (`enable_freeform_support`, `am task resize`), full screen and close, on a large screen. Android picks the direction (left and right on a landscape screen and, from Android 15, on any large screen such as a foldable open; top and bottom otherwise), and a side that does not fit is refused. A move ends a split first, because SystemUI restarts when a split task is moved again. Android 14 has no command to end a split, so there ADE goes to the home screen and opens the apps full screen again; it also cannot make an open free window full screen, and says so. Some apps (Chrome) come back in a new task after a mode change. The answer lists the windows; exits 1 when the change did not happen. |
| `proof-bundle [--out <dir>] [--caption] [--package] [--no-elements]` | A screenshot, the elements, a log tail and a meta file, filed as proof. |
| `fold open\|half\|closed\|<angle>` (or `--angle <0-180>`), `posture` | P3: fold a foldable AVD and wait for the screen to swap, or read the hinge ([Fold](#fold-p3)). |
| `preview list [--module <m>] [--all]`, `preview [--module <m>] [--fqn <name>]… [--no-proof]` | P3: list a module's Compose `@Preview` functions, or render them to PNG with no emulator ([Compose previews](#compose-previews-p3)). Exits 1 when a preview has no image. |
| `test [--module <m>] [--variant <v>] [--class <fqcn>] [--method <name>]` | P3: run the lane app's instrumentation tests on the lane's emulator ([Instrumentation tests](#instrumentation-tests-p3)). Exits 1 when a test fails. |
| `sdk images [--installed]` | P3: the installed system images (size, the AVDs that use each) and the ones to add ([System images](#system-images-p3)). `sdk install --image <id>` and `sdk remove --image <id>` are the user's and refuse a terminal. |
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
  it did. When the screen turns, the size changes and the recorder starts a
  new part (`<id>-2.mp4`). The stop joins the parts into one video on a
  canvas that holds each part (system ffmpeg, else the Swift renderer on
  macOS, else ADE's own ffmpeg), and moves the tap points onto it. A
  recording stops at `--max-seconds` (default and most 300), after 2 minutes
  with no change, when the raw file gets too large or the disk too full,
  when the emulator stops, when the lane lets the device go, and when its
  chat ends.
- **Demo.** The stop sends the video through `produceDemoVideo` (demo surface
  `android`, `androidRecordingSession.ts` and `androidDemoRecording.ts`): the
  idle cut, tap rings, typed-text badges, `ade proof step` chapters and
  captions, `--zoom`, and the fit under 10 MB. The engines are Swift on macOS
  and ffmpeg elsewhere (ADE downloads its own; `prepare()` starts the
  download when the recording starts). The render has 150 s. When no engine
  renders, the render fails or the time ends, ADE files the video as it was
  recorded, at any size, and says why. Only the demo file and its sidecar
  stay in `<project>/.ade/android/recordings/<lane>`. `--plain` skips the
  overlays and the idle cut. One recording gives one proof row.
- **Overlays.** Every agent input path notes the demo track: tap,
  long-press, drag, swipe, scroll, tap-element, fill-element, type, key,
  button and open-url (the badge is the URL host). Typed text shows only
  when the field is named and is not a password (the UI node's `password`
  flag, and the name rule of `demoTypedLabelForField`). Text typed into the
  focused field with no element named shows no badge. The machine
  preferences `tapRings` and `keyBadges` are read when the input is noted.
- **Auto-record.** An agent's input starts a recording when none runs (the
  pane stamps its input `source: "user"`, which never starts one). It does
  not start with `--no-record`, with the lane switch off (`auto-record off`,
  KV key `android.autoRecord.lane.<lane>`), or with the machine preference
  `autoRecordAgentInput` off. The input waits at most 5 s for the start. An
  automatic recording stops when the agent's turn ends (the same hook as
  Apple's) and after 2 minutes with no change. `record-start` keeps a running
  automatic one as a manual one. With `--machine`, the turn end does not reach
  the other machine; the idle stop ends it there.
- **Machine preferences.** `getMachinePreferences` (read) answers
  `{preferences, recordingsBytes}`; `setMachinePreferences` (only the person,
  a partial patch) answers the same and emits `android.preferences.changed`.
  The fields are `tapRings`, `keyBadges`, `autoRecordAgentInput` (all on by
  default), `recordingsWarnBytes` (5 GiB, 1–100 GiB) and
  `remoteBitrateKbpsCap` (2500, 100–20000 kbit/s). They are kept in
  `~/.ade/android/settings.json` under `preferences`, beside `sdkPath`.
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

Parity with `ade apple`:

- `key <name>`: one key (`ANDROID_NAMED_KEYCODES`: return, tab, escape,
  delete, arrows, home, end, page keys, f1-f12, a letter or digit) with
  modifiers (`key ctrl+a`, or `--shift --ctrl --alt --meta`). Through scrcpy
  when a stream runs, else `adb shell input keyevent`, or `input
  keycombination` for modifiers (Android 12+). `button` still sends the
  hardware keys.
- `type --submit` presses Enter after the text.
- `launch` and `relaunch` take intent extras (`--extra key=value`, typed as
  bool, int, long, float or string; `--extra-string` keeps a string) and `am
  start` words (`--launch-arg`, or `-- <words>`; `-n` and `--user` are
  refused). `relaunch` force-stops, then starts.
- `app-state <package>`: installed, running, in front, pid and version.
  `foreground [--package] [--wait <s>]`: the app in front (the home screen
  is no app); with `--package` a timeout is `ANDROID_WAIT_TIMEOUT`.
- `frame`: one screencap PNG, never filed as proof, with `streamRunning`.
  The brain has no H.264 decoder, so it is the device's screencap as Apple's
  is the helper's screenshot.
- `inspect <x> <y>` and `select <x> <y>`: the element under a point as the
  composer's chip packet (`select` always crops, and counts as input).
- `device-cleanup` (above).

### Instrumentation tests (P3)

`ade android test` (`androidInstrumentationTests.ts`) runs
`gradlew :<module>:connected<Variant>AndroidTest` in the lane's worktree,
module `app` and variant `debug` by default. It uses the Gradle runner and the
JDK of `install --gradle`, with `ANDROID_SERIAL` set to the lane's emulator,
the same 20-minute limit, and the same stop when the brain shuts down.
`--class <fqcn>` runs one class and `--method <name>` (with `--class`) one
method, through `-Pandroid.testInstrumentationRunnerArguments.class=…`.

- It refuses when the lane's emulator is not booted (`ANDROID_NOT_RUNNING`),
  and while a run for the lane goes on (`ANDROID_TESTS_RUNNING`).
- It reads the JUnit XML files that this run wrote under
  `<module>/build/outputs/androidTest-results/connected/`. With none, it reads
  Gradle's own test lines. The answer has the total, passed, failed and
  skipped counts, each failure (class, test, the first lines of the message),
  the XML files and the HTML report.
- A build that fails before any test runs is `ANDROID_BUILD_FAILED`, with the
  Gradle output, as for an install.
- With `--machine`, the caller's checkout goes to the work copy there first,
  as for `install --gradle`.

The Tools drawer's App group has **Run tests** (with an optional class). The
counts and the first three failures show inline, and a toast says when the
run ends. The run keeps going when the group closes, and the result shows
again when it opens.

### Compose previews (P3)

`ade android preview` (`androidComposePreviews.ts`) runs Google's Android CLI
(`android preview list|render --format json`, always `--no-metrics`) in the
lane's worktree. The CLI builds the module with Gradle and draws each
`@Preview` with layoutlib, so no emulator is needed.

- `--module` is the module's folder in the lane (`app` by default; `:feature:home`
  reads as `feature/home`). It must be a folder inside the lane with a
  `build.gradle` or `build.gradle.kts`. The project's root is refused: the CLI
  takes a module.
- `preview` with no `--fqn` lists the module first, then renders every preview,
  up to 24. `skipped` counts the rest; name them with `--fqn`.
- A `--fqn` must be a dotted name (`com.example.ui.GreetingKt.GreetingPreview`).
  A name the CLI cannot find fails alone: the other images still come back,
  and that preview has its `error`.
- The images go to `<project>/.ade/android/compose-previews/<lane>/<time>/`
  on the lane's machine. Each one is filed as proof in the calling chat,
  unless `--no-proof`. With `--machine`, the images are read back and filed on
  the caller's machine, as screenshots are.
- It needs the Android CLI (`ANDROID_TOOL_MISSING`; install it with the setup
  card's Android CLI part) and a JDK (`ANDROID_BUILD_FAILED`, with where ADE
  looked). A failed build is `ANDROID_BUILD_FAILED` with the CLI's last lines.
- One preview command runs for each lane at a time. Each CLI run has a
  10-minute limit, and it stops when the brain shuts down.

Measured on macOS with a small module: a cold `list` takes about 30 s, and a
render of two previews takes 5–20 s.

The Tools drawer's Previews group calls the same actions with `inline: true`,
so each PNG (up to 1 MB) also comes back as a `data:` URL. That way the
thumbnails show for an emulator's lane on another machine.

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

Apple lets an agent start its stream; Android keeps `startStream` and
`stopStream` for viewers on purpose: `startStream` hands back the loopback
stream token, and it is in `ADE_ACTION_SECRET_BEARING`. An agent reads
`getStreamStatus` (no token) and uses `frame` or `screenshot`.

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
relay starts the stream when the viewer's socket attaches. The relay is one
holder of the lane's stream, beside the local viewer, a recording and a
desktop on another machine; the stream stops when the last holder lets go
(see [Remote viewers](#remote-viewers)). `android.input` takes kind `touch` (down, move and up
events in device pixels, at most 64 a call) for the viewer's live finger.
`android.status` carries `liveView` (the brain serves tickets) and `appCrash`.
While the emulator runs it also carries `recording` (the active recording)
and `owner` (the lease holder, with the chat's title when the host knows the
chat). `android.inspectSnapshot` (controller-only) answers one screenshot
(inline PNG, no proof row) and the UI tree's elements in the shape of
`apple.invoke getScreenSnapshot`, for the phone's Live Inspect.

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
does not treat a still picture as a dead stream.

The phone viewer matches the Simulator viewer:

- **Recording dot and owner ribbon.** The menu header shows a red dot while a
  recording runs, and the ribbon reads "Watching · owned by <chat>" while an
  agent holds the emulator's lease.
- **An agent is driving.** When an agent takes the lease while the phone
  controls, the viewer hands control back ("<chat> is driving the emulator
  now. You're watching.") and refuses Take control until the lease ends. The
  chat the viewer was opened from does not count.
- **Fold.** On a phone that folds, controlling a foldable emulator mirrors the
  phone's hinge with `setPosture` (the inner display holds it open at 70° or
  more; the front screen shuts it). The menu has Open, Half and Closed hinge
  tiles for a foldable emulator.
- **Live Inspect.** Inspect freezes the picture with
  `android.inspectSnapshot`, lets the person pick an element and mark it up,
  and adds the element's packet (ref, resource id, text, class, frame) and the
  picture to the chat's draft.

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

### Remote viewers

A viewer on another machine reads the emulator at the machine's remote cap
(Settings › Android devices, `remoteBitrateKbpsCap` in the machine
preferences, 2500 kbit/s by default). A viewer on the emulator's own machine
is never capped. This is the same rule as Apple's
`apple.remoteBitrateKbpsCap`. Remote viewers are a phone or a web tab through
the stream relay, and a desktop pinned to the machine (it passes
`remoteViewer` on `startStream`, `stopStream` and `getStreamStatus`).

The emulator has only a software encoder, so ADE runs **one encode per
emulator, never two** (`androidLaneStreams.ts`). The lane's stream has
holders: the local viewer, a recording, the relay, and a remote desktop. Its
rate follows them:

- A local viewer or a recording holds it: full rate (4 Mbps). The local
  picture and the recording are never capped.
- Only remote viewers hold it: the remote cap. When a paced viewer stalls, the
  relay's pacing (`appleStreamPacing.ts`) lowers the cap to 60% (at most once
  every 2 s, not below 400 kbit/s). After 15 s with no stall it raises it by a
  quarter every 10 s, back to the cap.

scrcpy cannot change a running encoder's rate. So a rate change ends the scrcpy
session and opens a new one on the same transport (`AndroidStreamHub.recap`).
Each viewer keeps its URL and gets the new run's config and keyframe after a
gap of about 0.5–1 s (we measured 0.5–0.8 s on an idle emulator and 3.7 s on
one with a busy system UI). A local viewer that joins a capped stream gets
full rate before its first frame. A recording that starts on a capped stream
also gets full rate before its first packet. A remote viewer that joins a
stream a local viewer already watches gets that full-rate stream; the relay
still skips frames for a viewer that falls behind.

Why not a second encode for remote viewers: it doubles the encoder's CPU
while both kinds of viewer watch. That is too much on a 4 vCPU Linux host
(Agent 37), where the emulator already shares the CPU with its own software
encoder. A cheaper second encode at a lower size would also need a second
input path and a second keyframe cache. One encode keeps the cost of one
viewer, wherever it is. The trade-off: while someone on the machine watches
or records, remote viewers get the full-rate stream with frame skipping, not
the cap.

The desktop's live line shows the received bit rate for a viewer on another
machine (`● Live · 30 fps · 1.8 Mbit/s · on <machine>`). `getStreamStatus`
answers `bitrateKbps` (sent over the last 2 s) and `capKbps` (the encoder's
setting now).

A stream that ends by itself (the server crashed, the system UI restarted)
starts again on the same transport, so a viewer keeps its URL. After 3
restarts in 60 s it stays down, and `status` says why.

## Product analytics

The emulator service in the brain records one coarse `ade_feature_used` fact
(`action: "android_device"`) when the guided SDK install puts parts in place,
an app installs, a 3D render files as proof, an agent takes a new lease, a
system image installs (`image_installed`), an instrumentation run runs at
least one test (`tests_run`), a fold settles (`device_folded`), or a Compose
preview render writes an image (`previews_rendered`), a Play Store
screenshot set is taken (`store_screenshots`), or ADE stops an emulator by
itself (`emulator_auto_stopped`: idle, or its brain was gone). Boot health has three
outcomes: a start that booted (`device_booted`), one that did not
(`boot_failed`), and an adb server restart that ADE made so a refused
device could boot (`adb_restarted`). Extra devices have two: a lane made an
extra device (`extra_device_created`, Apple's name), and an extra became the
lane's device (`device_promoted`). Each outcome counts at most once a day.
A boot that fails is also one Sentry issue for each error code
(`["android", "boot_failed", <code>]`), with the time it took and the
profile id; the `android.emulator_start_failed` and
`android.adb_server_restarted` log lines carry the rest. No path, AVD, package, lane, image, angle or preview name
goes with it. `docs/logging.md` holds the contract.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/types/androidEmulator.ts` | The contract: SDK, AVD and lane types, error codes, the service API, the action lists (`ANDROID_AGENT_ACTIONS`, `ANDROID_USER_ONLY_ACTIONS`, `ANDROID_PERSON_ONLY_ACTIONS`, `ANDROID_LANE_FREE_ACTIONS`, `ANDROID_CODE_SYNC_ACTIONS`), and the preload API. It re-exports its siblings: `androidEmulatorAgent.ts` (the agent suite, `ANDROID_PERMISSIONS`), `androidEmulatorSetup.ts` (the SDK install), `androidEmulatorLook.ts` (colour and render) and `androidEmulatorDrawer.ts` (the Tools drawer, `ANDROID_TEXT_SIZES`, `ANDROID_DISPLAY_SIZES`). |
| `apps/desktop/src/main/services/android/androidEmulatorService.ts`, `androidEmulatorServiceDeps.ts` | The service: lane queue, start, stop, input, screenshot, the work-copy lanes, the start-up cleanup, and the hand-off. Its inputs and its state for one lane are in `androidEmulatorServiceDeps.ts`. |
| `apps/desktop/src/main/services/android/androidEmulatorLifecycle.ts` | The boot and the stop that run on the lane's queue (`startLocked`, `stopLocked`): the memory guard's reservation, the owner record's launch, boot and forget, the stop reason, the mid-boot abort, and the boot timeout. |
| `apps/desktop/src/main/services/android/androidMachinePreferences.ts`, `apps/desktop/src/shared/types/androidEmulatorRecording.ts` | The machine's Android settings file (`sdkPath` and `preferences`, atomic writes, a broken file refused), the machine preferences, and the recording types. |
| `apps/desktop/src/main/services/android/androidAutoRecord.ts` | Auto-record: an agent's input starts a recording, the end of its turn stops it, and the opt-outs (`--no-record`, the lane switch, the person's own input). |
| `apps/desktop/src/main/services/android/androidHandedOffEmulators.ts` | The state file of the emulators ADE started, and the stops that use it: on dispose, and when a project is removed after a hand-off. |
| `apps/desktop/src/main/services/android/androidDeviceInventory.ts` | The lane's AVD: the device list, create, attach, release, delete and colour, and the work copy's borrow rule. |
| `apps/desktop/src/main/services/android/androidSdk.ts` | SDK detection, tools and acceleration. |
| `apps/desktop/src/main/services/android/androidSdkSetup.ts`, `androidSdkInstall.ts`, `androidSdkRepository.ts`, `androidZipExtract.ts`, `androidCli.ts` | The guided install: the plan, licence checks, the SDK setting, the installer job, Google's repository manifests, the zip reader, and the Android CLI. |
| `apps/desktop/src/main/services/android/androidAvds.ts`, `androidHardwareProfiles.ts` | AVD list, create and delete, ADE's marker, and the hardware profiles. |
| `apps/desktop/src/shared/androidDeviceCatalog.ts`, `apps/desktop/src/main/services/android/androidCatalogProfiles.ts` | The brand grid's devices (names, sizes, colours, bodies, profiles), and the merge of ADE's `ade_*` profiles into `devices.xml`. |
| `apps/desktop/src/main/services/android/androidRender.ts` | The render broker for `ade android render`: the request event, the first window's ack, the filed paths, and the time limit. |
| `apps/desktop/src/main/services/android/androidEmulatorProcess.ts` | Boot, discovery files, boot completed, and stop. |
| `apps/desktop/src/main/services/android/androidLaneDeviceStore.ts`, `androidLaneRelease.ts` | The `lane_android_devices` and `lane_android_extra_devices` rows (a lane's AVD is held when either names it), and the release of a lane's AVD and its extras on disk (used by `laneService` with no service). |
| `apps/desktop/src/main/services/android/androidLaneExtras.ts`, `apps/desktop/src/shared/types/androidEmulatorExtras.ts` | Extra devices: their status, start and stop (on each extra's own queue, through the RAM guard), release, the install and launch target, and their types. The promote is in `androidEmulatorService.ts`, where the lane device's state is. |
| `apps/desktop/src/main/services/android/androidStream.ts`, `androidStreamServer.ts`, `androidLaneStreams.ts` | Streams by adb serial, the defaults, restarts, and the loopback stream server; the lane's side of its stream (a viewer, a recording). |
| `apps/desktop/src/main/services/android/scrcpyServer.ts`, `scrcpyVideo.ts`, `scrcpyControl.ts` | The scrcpy session, video records and control messages. |
| `apps/desktop/src/main/services/android/androidActionDomain.ts` | The `android_emulator` action domain. |
| `apps/desktop/src/main/services/android/androidMemoryGuard.ts`, `androidCrashWatch.ts` | P2: the memory guard (the decision before each start: pressure, paging, the emulators' budget, available memory, and the boots in flight), and the crash-buffer reader behind the crash pin. |
| `apps/desktop/src/main/services/machineStats/hostMemorySignals.ts` | The machine's memory signals per OS (pressure, available, swap, commit, PSI, the paging rate) and the real memory of chosen processes. Shared with the brain's resource-pressure sampling. |
| `apps/desktop/src/main/services/android/androidEmulatorOwners.ts`, `androidEmulatorSweep.ts` | The machine's owner file (`~/.ade/android/emulator-owners.json`) and the sweep's decision for one record; the lifecycle of one brain (owner records, last used, the pin, the guard's cross-brain ledger, the sweep). |
| `apps/desktop/src/main/services/android/androidEmulatorUse.ts` | One service as the lifecycle sees it: the calls that count as use, busy, the idle stop through the lane's queue (with the device's own input and other viewers), the pin, and emulators taken in from before the owner file. |
| `apps/desktop/src/main/services/android/androidEmulatorImage.ts` | Which processes are emulators by image name (memory guard, process groups), and the Windows `tasklist` check before a kill. |
| `apps/desktop/src/main/services/device/deviceMaintenance.ts` | The timers, idle limit and touch throttle that the Apple devices' upkeep and the Android sweep share. |
| `apps/ade-cli/src/services/runtime/unmanagedBrainIdleExit.ts` | The idle exit of a brain a dev or test launcher marked, once its launcher is gone. |
| `apps/desktop/src/shared/types/androidEmulatorControl.ts`, `apps/desktop/src/main/services/android/androidAppState.ts`, `androidInspect.ts`, `androidLaneMaintenance.ts`, `androidChromeSetup.ts` | Parity with `ade apple`: the key names and modifiers, intent extras, app state and the app in front, Inspect's packet and source search, the cleanup pass and the "powered off" record, and Chrome's first run. |
| `apps/desktop/src/main/services/android/androidAgentSuite.ts`, `androidJdk.ts` | The agent verbs (elements, apps, logcat, proof, lease), and the JDK that Gradle runs with. |
| `apps/desktop/src/main/services/android/androidSystemImages.ts`, `apps/desktop/src/shared/types/androidEmulatorImages.ts` | P3: the system image list, install (on the guided install's job) and removal, and their types. |
| `apps/desktop/src/main/services/android/androidInstrumentationTests.ts`, `apps/desktop/src/shared/types/androidEmulatorInstrumentation.ts` | P3: `ade android test`: the Gradle run, the JUnit XML and Gradle-output readers, and their types. |
| `apps/desktop/src/main/services/android/androidPosture.ts`, `apps/desktop/src/shared/types/androidEmulatorPosture.ts` | P3: the hinge read and fold (the emulator console and `dumpsys device_state`), and their types. |
| `apps/desktop/src/main/services/android/androidLaneQueue.ts` | P3: one step at a time per lane, for folds and Compose preview runs. A failed step does not stop the next one. |
| `apps/desktop/src/main/services/android/androidComposePreviews.ts`, `apps/desktop/src/shared/types/androidEmulatorPreviews.ts` | P3: `ade android preview`: the Android CLI runs, the module check, the proof filing, and their types. |
| `apps/desktop/src/main/services/android/androidUiSnapshot.ts`, `androidUiTree.ts` | The UI tree (the Android CLI, or uiautomator), its cache, and the element queries. |
| `apps/desktop/src/main/services/android/androidRecordingSession.ts`, `androidRecording.ts`, `androidDemoRecording.ts` | The lane's recording sessions (the slot is freed before the demo renders), the MP4 writer and store, and the demo video. |
| `apps/desktop/src/main/services/android/androidDeviceSettings.ts` | The Tools drawer's settings read and its changes (accessibility too), the app in front, the orientation, location and Clear location, the status bar (demo mode), appearance and permissions. |
| `apps/desktop/src/main/services/android/androidStoreShots.ts`, `androidWindows.ts`, `apps/desktop/src/shared/types/androidEmulatorDevice.ts`, `apps/ade-cli/src/cliAndroidDevice.ts` | Parity: Play Store screenshots, the window layout, their types, and the CLI verbs for accessibility, status bar, Clear location, Play Store screenshots and windows. |
| `apps/desktop/src/main/services/android/androidDeviceShell.ts`, `androidProof.ts` | Device shell, adb and emulator console helpers, and the proof filer. |
| `apps/desktop/src/main/services/android/adb.ts`, `androidEmulatorErrors.ts` | The adb runner and the coded errors. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePane.tsx` | The pane: picker, stage, rail, drawer, strips and live line. |
| `apps/desktop/src/renderer/components/android/useAndroidPaneFloat.ts`, `useAndroidStorageActions.ts` | The pane's half of the floating player (the cache and "Float over chat"), and the picker's Storage actions. |
| `apps/desktop/src/renderer/components/android/drawer/` | The Tools drawer: `AndroidToolsDrawer.tsx`, the four group sections, and `androidDrawerState.ts`. The open group, the one serialized change and the settings come from the shared `device/deviceDrawerState.ts`; the frame, the Location rows and the recording rows from `device/DeviceToolsDrawerShell.tsx`, `device/DeviceLocationRows.tsx` and `shared/RecordingRow.tsx`. |
| `apps/desktop/src/renderer/components/android/useAndroidInspect.tsx`, `useAndroidRecording.ts` | Inspect (on the shared `device/useDeviceInspect.ts` and `device/DeviceInspectOverlay.tsx`) and the rail's Record. |
| `apps/desktop/src/renderer/components/android/androidDeviceState.ts` | The pane state, stock profiles, menu rules and error sentences. The 3D-or-flat choice is kept by the shared `device/deviceViewMode.ts`. |
| `apps/desktop/src/renderer/components/android/AndroidDevicePicker.tsx`, `AndroidSetupCard.tsx`, `AndroidLicenseDialog.tsx`, `useAndroidSdkSetup.ts` | The picker, the setup card, the licence dialog and the card's data. |
| `apps/desktop/src/renderer/components/android/AndroidSystemImagesSection.tsx`, `useAndroidSystemImages.ts`, `drawer/AndroidInstrumentationTestsRow.tsx` | P3: the picker's System images section and its data, and the App group's Run tests row. |
| `apps/desktop/src/renderer/components/android/useAndroidPosture.ts`, `AndroidFoldDock.tsx`, `apps/desktop/src/renderer/components/device/proceduralFoldBody.ts`, `device/HingeSlider.tsx` | P3: the pane's hinge state, the fold dock, and the two-panel body and hinge slider that the iPhone Duo shares. |
| `apps/desktop/src/renderer/components/android/drawer/AndroidPreviewsSection.tsx` | P3: the Tools drawer's Previews group. |
| `apps/desktop/src/renderer/components/settings/AndroidDevicesSection.tsx`, `deviceSettingsCards.tsx`, `AndroidRecordingsWarning.tsx`, `apps/desktop/src/renderer/components/android/useAndroidMachinePreferences.ts` | Settings › Android devices: the setup card for the picked machine, the cards shared with Apple (Realistic body, recording overlays, Record agent input, the bitrate cap), the recordings storage warning, and the machine preferences read and write. |
| `apps/desktop/src/renderer/components/android/AndroidToolCardMenu.tsx`, `AndroidRecordingReceipts.tsx`, `AndroidShutdownConfirm.tsx`, `LaneAndroidDeviceMarker.tsx`, `useLaneAndroidDevices.ts`, `apps/desktop/src/renderer/components/device/LaneDeviceMarker.tsx`, `device/useLaneDeviceMarks.ts` | Work tab and chat: the tool-card menu, the recording receipts, the confirm when a tab with a running emulator closes, and the lane device mark (shared with Apple). |
| `apps/desktop/src/renderer/components/work/AndroidEmulatorRunningPill.tsx`, `DeviceRunningPill.tsx`, `apps/desktop/src/renderer/lib/askOnceStore.ts`, `useConfirmKeys.ts` | The chat's "Emulator running" pill on one status read per machine, and the ask-once and confirm-key helpers. |
| `apps/desktop/src/renderer/components/android/useAndroidOrientation.ts`, `useAndroidScreenCaptures.ts`, `androidPickerRequests.ts`, `drawer/AndroidWindowsRow.tsx`, `apps/desktop/src/renderer/components/device/OrientationMenuItems.tsx` | The rotation (reverse rotations too), the screen captures, the picker's requests, and the drawer's split screen and free window row. |
| `apps/desktop/src/shared/androidDevicePresentation.ts`, `computerUseAndroid.ts`, `computerUseCommandReaders.ts`, `apps/ios/ADE/Views/Work/WorkComputerUseSummaryAndroid.swift` | The device's readable name, and the chat summaries of `ade android` commands on the desktop and the phone. |
| `apps/desktop/src/renderer/browserMockAndroid.ts`, `browserMockAndroidPreferences.ts`, `browserMockAndroidUtil.ts` | The browser mock's emulator, preferences and helpers. |
| `apps/desktop/src/renderer/components/android/AndroidDeviceStage.tsx`, `AndroidDeviceRail.tsx`, `AndroidDeviceStatus.tsx` | The stage (on the shared `device/DeviceFlatView.tsx`), the rail (on `device/DeviceRail.tsx`), and the strips, cards and live line (on `device/DeviceStatusStrip.tsx` and `device/DeviceLoadingCard.tsx`). |
| `apps/desktop/src/renderer/components/android/AndroidCatalogGrid.tsx`, `androidTileRenderer.ts` | The brand grid tiles and their details, and the one shared WebGL renderer for the tile stills and the hover turn. |
| `apps/desktop/src/renderer/components/android/androidDeviceBody.ts`, `androidDeviceModels.ts`, `useAndroidBootScreen.ts` | The procedural device bodies (and any model file), and the boot screen drawn on the 3D model. |
| `apps/desktop/src/renderer/components/android/AndroidRenderSheet.tsx`, `androidRender.ts`, `useAndroidRenderRequests.ts` | The Render sheet (on the shared `device/DeviceRenderSheet.tsx`), the drawing and filing of renders (on `device/deviceRenderProof.ts` and `device/deviceRenderPass.ts`), and the pane's answer to `ade android render`. |
| `apps/desktop/src/renderer/components/android/useAndroidDeviceStream.ts`, `useAndroidDeviceInput.ts`, `androidStreamLease.ts` | The stream (on the shared `device/useStreamRecovery.ts` and `device/useGracefulStreamLease.ts`), input, and the per-lane stream lease (a `device/streamLease.ts` table of its own). |
| `apps/desktop/src/renderer/components/terminals/workToolPanels.tsx` | The Android tool's targets (This lane, Android · `<machine>`). |
| `apps/desktop/src/renderer/components/android/AndroidDeviceMiniPlayer.tsx`, `androidMiniPlayerStore.ts`, `apps/desktop/src/renderer/components/device/miniPlayerSurface.ts` | P2: the floating player, which emulator floats, and the surface rules it shares with the Apple player. |
| `apps/desktop/src/renderer/components/android/AndroidQuickChips.tsx`, `AndroidCrashPin.tsx`, `drawer/AndroidLogsSection.tsx`, `androidTextDraft.ts` | P2: the quick chips, the crash pin, the Logs group, and the chat draft and copy they share. |
| `apps/desktop/src/renderer/components/android/useAndroidLaneDeviceCard.ts` | P2: the tools pane card's line. |
| `apps/desktop/src/renderer/webclient/adapter/androidDevice.ts`, `streamTicket.ts` | P2: the hosted web client's `androidEmulator` namespace, and the relay ticket helpers it shares with `appleDevice.ts` (one ticket for each stream URL). |
| `apps/ios/ADE/Views/Work/AndroidDeviceViewer.swift`, `AndroidDeviceViewerModel.swift`, `apps/ios/ADE/Services/SyncService+AndroidDevice.swift` | P2: the phone viewer, its control model, and the `android.*` commands it sends. The stream itself is `AppleStreamSession.swift`, and the touch rules are `LiveStageTouch` in `LiveStageChrome.swift`, both shared with the simulator viewer. |
| `apps/desktop/src/renderer/components/terminals/useRemoteDeviceTabs.ts` | The tab that joins the open pane for a remote device use (iOS and Android). |
| `apps/desktop/src/shared/androidFormat.ts` | `formatAndroidBytes`: decimal sizes (`2.8 GB`), shared by the desktop and the `ade android` CLI so a size reads the same in both. |
| `apps/ade-cli/src/cliAndroid.ts`, `cliAndroidSuite.ts`, `cliAndroidFormat.ts` | `ade android` plans and error hints (P0 verbs in `cliAndroid.ts`; the P1 agent, P3 and `sdk` verbs in `cliAndroidSuite.ts`), and its text formatters. The help page is in `cli.ts`. |
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
  instrumentation tests (P3, now built; see the sections above). The phone
  viewer does not fold yet.

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
| `ANDROID_ADB_UNAUTHORIZED` | The emulator runs, but the adb server refuses it as `unauthorized` for 20 s. The server started before `~/.android/adbkey` changed (a new SDK or Android CLI setup can write a new key), and it never reads the key again. When no other device uses the server, ADE restarts it and the boot goes on (`# ADE` lines in the log say so). Otherwise the pane offers **Restart adb and start**, after a confirm, and `ade android start --restart-adb` does the same. |
| `ANDROID_PATH_OUTSIDE_LANE` | `screenshot --out` must be inside the lane worktree. Give a path there, or leave out `--out`. |
| Work copy gone (`ANDROID_NOT_RUNNING`) | "This chat's work copy on this machine is gone, so it has no Android device here." Run the command again to make a new copy. |
| `ANDROID_NOT_RUNNING` | Boot the lane's emulator first (`ade android start`), or make one (`ade android device-create --profile <id>`). |
| `ANDROID_AVD_HELD_BY_OTHER_LANE` | Pick a free AVD (`ade android devices --text`), or make one. |
| `ANDROID_LANE_HAS_DEVICE` | Use the lane's AVD, or run `ade android device-detach` first. To keep it and add another, make an extra: `ade android device-create --extra`. |
| `ANDROID_EXTRA_DEVICE_LIMIT` | The lane holds its limit of extra devices (2 by default). Remove one (`device-detach --device <avd>`), or raise `ADE_ANDROID_LANE_EXTRA_DEVICES` (up to 8). Mind the memory: each running one holds 2 to 5 GB. |
| `ANDROID_DEVICE_IS_EXTRA` | That AVD is one of the lane's extras. Make it the lane's device with `device-promote --device <avd>`. |
| `ANDROID_DEVICE_NOT_LANE_OWNED` | `--device` names an AVD the lane does not hold. `ade android status --text` lists the lane's device and its extras. |
| `ANDROID_LANE_DEVICE_BUSY` | The lane's device (or the extra) is in use: a recording, an open live view, tests, an install or launch, a start or stop, or another holder's lease. Finish that, then promote again. In the pane, open the picker first: it closes the live view. |
| An extra reads Stopped soon after a promote, with a dev app open beside the installed ADE | An older brain on the same project does not know extra rows, so its cleanup pass stops a running extra as an orphan. Start it again (`start --device <avd>`); run one brain per project for long runs. |
| `ANDROID_AVD_RUNNING` | Another app started that AVD. Close it there, or attach another AVD. |
| `ANDROID_SYSTEM_IMAGE_IN_USE` | An AVD uses that system image. Stop its emulator first. To remove an image that AVDs use, confirm it in the picker's System images. |
| `ANDROID_TESTS_RUNNING` | The lane's instrumentation tests already run. Wait for that run to end. |
| "This emulator has no hinge" | Fold works on a foldable AVD only. Make one from a Pixel Fold or Galaxy Z Fold tile. |
| `preview`: "has no build.gradle" | Pass `--module <folder>`: the Gradle module that holds the `@Preview` functions, not the project's root. |
| `ANDROID_NO_FREE_PORT` | All ports 5554–5682 are in use. Stop an emulator you do not need. |
| `ANDROID_LOW_MEMORY` | The [memory guard](#the-memory-guard-p2) refused the start: the sentence says why (pressure, swapping, the emulators' budget, or free memory). Stop an emulator you do not need, or close apps. **Start anyway** (`--force`) boots past it. `android.start_low_memory` in the brain log has the numbers. |
| The emulator stopped by itself | ADE stops an emulator nobody used for 20 minutes, and one whose brain is gone ([Emulator lifecycle](#emulator-lifecycle)). Start it again, or turn on **Keep running** (`ade android keep-running on`). `android.emulator_stopped` in the brain log says why. |
| `ANDROID_STREAM_FAILED` | The live view failed. `tap`, `swipe`, `button`, `type` and `screenshot` do not need it. Press **Reconnect** in the pane. |
