# Android emulator — plan

Status: plan, not built. Lane `ade/android-emulator-suite`. Written 2026-11-02
from four research passes, a probe on the owner's Windows machine, and the
owner's decisions in the same session.

Scope: an **Android Development** tool in the Work tools pane, next to Apple
Development, with the same depth: a per-lane emulator, a live picture in 3D
and flat views, touch and keys, app build/install/launch, logs, UI tree,
screenshots and recordings as proof, and an `ade android` verb set for agents.
The backend is new. The surfaces reuse the Apple device work.

## 1. Locked decisions (owner, 2026-11-02)

- **Emulators only.** No physical phones, now or as a planned phase.
- **SDK: detect, then guided install.** Use an SDK that is already on the
  machine (Android Studio's) first. When there is none, ADE offers to install
  the minimum packages, shows Google's licence, and records consent. ADE never
  accepts a licence silently.
- **Look: real 3D models, as good as possible, plus the flat view.** Licensing
  is not a blocker for now (same position as the bundled iPhone models; a model
  is an easy removal). A procedural body covers any profile with no model.
- **Code shape: a shared device layer plus a new Android domain.** The parts
  iOS and Android share move to a neutral layer. Android gets its own runtime
  domain beside `ios_simulator`. iOS IPC channel names and `apple.*` remote
  commands do not change.

Design round (owner, 2026-11-03):

- **Copy the Apple Development layout.** Moving between the two tools must be
  easy. Same picker position, stage, rail order, drawer groups, status strip,
  tools card and corner menu. The brand grid in the picker is the only
  intended difference.
- **Own tool, tabs only.** "Android Development" is a separate tab next to
  Apple Development. No split view. Both devices stay live, and either one can
  float over the chat.
- **Both platforms at once.** A lane can hold one Apple device and one Android
  device at the same time, and an agent drives both in one turn (`ade apple`
  and `ade android`). There is no "run on both" button.
- **Brand catalog.** The picker offers named phones with real 3D models and
  brand logos. Pixel entries use the SDK's profiles. Non-Pixel entries use a
  hardware profile that ADE writes with the phone's true screen size. The
  software inside is always stock Android, and the picker says so.
- **One-click create** from a brand tile, with the newest installed image.
- **The Android CLI is optional.** ADE uses it when it is installed, always
  with `--no-metrics`.

## 2. How the Android emulator works (facts this plan depends on)

- The Android SDK holds the working parts: `emulator` (QEMU-based VM),
  `platform-tools/adb`, and system images (one Android build per API level and
  ABI). Android Studio is only one way to install it.
- An AVD is a folder (`~/.android/avd/<name>.avd` + `<name>.ini`) with a
  hardware profile, a link to a system image, and its own disk.
- A hardware profile is screen size, pixels, density, RAM, sensors and device
  type. Corner radius and cutout are not profile fields; they come from the
  skin or the system image. The brand look is cosmetic.
- Acceleration: Apple Silicon uses Hypervisor.framework and runs only
  `arm64-v8a` images. Windows uses WHPX (AEHD ends 2026-12-31; HAXM is gone).
  Linux uses KVM (`/dev/kvm`). WSL2 and nested VMs have no acceleration.
  `emulator -accel-check` reports which one works.
- Google's **Android CLI** (`android`, v1.1, October 2026; brew/winget/apt)
  wraps SDK install, `emulator create/start --headless/stop/list`, `layout`
  (UI tree), `input` (selectors), `screen capture --annotate`, `install`
  (delta), `run`, and Compose `preview render`. It sends usage data unless
  `--no-metrics` is passed. Its `device hub` is its own window and cannot feed
  ADE's pane.

## 3. Architecture

### 3.1 Stream and input: scrcpy over adb, in the brain

- The brain pushes a **pinned, bundled scrcpy server** (Apache-2.0, one small
  jar) to the emulator over adb and starts it with `app_process`. The server
  encodes H.264 with the device's MediaCodec and serves a video socket and a
  control socket.
- The brain wraps each access unit in ADE's existing **video records**
  (`apps/desktop/src/main/services/media/videoRecords.ts`: config JSON
  `{codec,width,height,annexB}` + access units). Mac Desktop is already a
  second producer of this format.
- So these pieces carry Android unchanged: the renderer reader and WebCodecs
  player (`iosSimVideoRecords.ts`, `h264StreamPlayer.ts`,
  `H264StreamView.tsx`), the brain relay and pacing (`appleStreamRelay.ts`
  through its `AppleStreamOwningService` seam, `appleStreamPacing.ts`,
  `h264AnnexB.ts`), the sync route and tunnel pipe, the web viewer, and very
  likely the phone viewer (`AppleDeviceStream.swift`).
- Input goes through the scrcpy control socket: touch with phases and
  multi-touch, keys (Back, Home, App switch, Power, Volume), text, clipboard.
- **No native helper.** Everything runs in Node in the brain, so Mac, Windows
  and Linux share one code path. The scrcpy server version and the client code
  are pinned together; a version bump is a tested change.
- Reference implementations to read (do not vendor without a licence check):
  `@yume-chan/adb` + `@yume-chan/adb-scrcpy` (MIT, TypeScript), `ws-scrcpy`
  (MIT), t3code's vendored `serve-emu` (scrcpy mode).

### 3.2 Emulator extras: gRPC

- Start every ADE emulator with `-grpc <port>`. Read the method list from the
  installed emulator's own proto (`<sdk>/emulator/lib/emulator_controller.proto`)
  because the RPC set changes between emulator versions.
- Use gRPC for: rotation / physical model, fold and posture, GPS, battery,
  network, clipboard, `getScreenshot` (proof fallback), clean stop
  (`setVmState`).
- Fallback picture when scrcpy fails: gRPC `streamScreenshot` at a reduced
  width (measured 51–53 fps at 540 px wide on Windows), encoded to H.264 in the
  brain or shown as images. Proof screenshots use gRPC `getScreenshot`
  (37–58 ms).
- Taps over gRPC use `sendMouse`, not a stationary `sendTouch` (measured: the
  stationary touch did not register; moves did).

### 3.3 Lifecycle

- List: `emulator -list-avds` (or `android emulator list`), plus each AVD's
  `config.ini`.
- Create: an empty AVD from a profile and an installed system image, named
  `ADE · <lane>`. `avdmanager` is deprecated; prefer `android emulator create`
  when the Android CLI is present, else write the AVD files the way
  `avdmanager` does. (Decide in P0 after reading both on a real SDK.)
- Boot headless: `emulator -avd <name> -no-window -no-audio -no-boot-anim
  -gpu auto -port <even> -grpc <port>`; ready when `sys.boot_completed` is 1.
  Ports: even pairs 5554–5682 (64 instances); ADE allocates its own and never
  touches an emulator it did not start.
- Stop: gRPC `setVmState` or `adb -s emulator-<port> emu kill`, then confirm
  the qemu process exited (the launcher and qemu have different PIDs; the
  discovery file `avd/running/pid_<qemu pid>.ini` names qemu).
- Snapshots: quick boot is the default for speed; `-no-snapshot-save` for
  runs that must not change the AVD. One AVD can run once at a time unless
  `-read-only`.
- One lane = one AVD by default; the user may attach an existing AVD. Archive
  and delete stop the emulator; delete removes an ADE-made AVD and never a
  user's. Idle power-off applies, as for iOS.
- Ownership marker: a file inside the AVD folder (for example
  `<name>.avd/ade-owner.json`), mirroring `appleDeviceMarker.ts`.

### 3.4 SDK detection and install

- Detect at the time of use, never once at startup (t3code's repeated bug):
  `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then the platform default
  (`~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`, `~/Android/Sdk`).
  Report each tool: `adb`, `emulator`, system images, acceleration.
- Guided install (P3): the minimum set is `platform-tools`, `emulator`, and one
  system image for the host ABI (about 1.2–2.5 GB of downloads). Prefer the
  Android CLI's `android sdk install` (no Java); otherwise download from the
  repository XML (`repository2-3.xml`, `sys-img2-3.xml`) and verify checksums.
  Show the licence text for each licence id, record consent, then write the
  acceptance files. Check free disk first.

### 3.5 Agent surface

- `ade android` mirrors `ade apple` verb names and flags wherever the meaning is
  the same, with one spelling per job and no aliases. Unknown flags are
  refused. `ANDROID_AGENT_ACTIONS` feeds the action allowlist (the
  `APPLE_AGENT_ACTIONS` pattern). A `capabilities` field in `status` is P1
  (P0 has none).
- Verbs (target set; phases in §6): `status`, `devices`, `start`, `stop`,
  `device-create`, `device-attach`, `device-detach`, `device-delete`, `apps`,
  `install`, `launch` (Gradle `installDebug` or a given APK, then `am start`),
  `terminate`, `uninstall`, `open-url`, `tap`, `long-press`, `drag`, `swipe`,
  `scroll`, `type`, `button`, `rotate`, `fold`, `screenshot`, `frame`,
  `stream-start/status/stop`, `snapshot` (UI tree), `find`, `tap-element`,
  `fill`, `wait-for`, `assert`, `record-start/stop/list/delete`, `log` (logcat
  by package), `location`, `appearance`, `permission`, `lease`, `show`,
  `proof-bundle`, `sdk` (status, install).
- UI tree source: `uiautomator dump` first (no install on the device). Read
  `android layout` and Appium UiAutomator2 as references. Element queries use
  the same `ref/identifier/label/text/role/index` shape as `ade apple`.
- The skill `ade-android` tells agents: use `ade android` for UI work and
  proof; use `adb`, Gradle and the Android CLI freely for builds and anything
  `ade android` lacks. A turn-time hint names the lane's device (the
  `laneAppleDeviceDirective.ts` pattern). t3code found 37 of 38 threads used raw
  tools until the instructions said otherwise.

### 3.6 Remote machines

- The emulator runs where the lane's brain runs. Every renderer call takes the
  pin; every action is in the new domain with `actionPolicy` entries and works
  remotely. Remote commands mirror `apple.*` as `android.*` with `laneId`.
- New capability: a Windows or Linux brain can host the emulator, and a Mac
  window bound to it watches and drives it through the relay. iOS cannot do
  this.
- Gate on capability, not on `darwin`: `supported` = SDK found + emulator
  binary + acceleration usable, reported per machine in `status`.
- **A chat drives an emulator on another machine with no new lane** (owner,
  2026-11-03; P0). Same model as `ade apple --machine` since #1999:
  1. `ade android … --machine <m>` with no `--lane` uses the chat's work copy
     on that machine. The copy stands in for a lane in the Android service
     (its `remote-work-<hash>` lane id). Its first device is a free AVD that
     machine already has (only an ADE AVD made for a lane of this project,
     stopped first; never the user's own AVDs), attached so it is never
     deleted. ADE creates a new AVD only when
     none is free. The cleanup gives the device back when the copy goes.
  2. That machine returns the copy's lane id with each Android answer. The
     chat's brain records the use (`usesAndroidEmulator`, `workCopyLaneId` on
     `AgentChatRemoteWorkUse`).
  3. Every window that views the chat sees an "Android · <machine>" target in
     the chat's Android tool (beside "This lane") and opens the stream
     through its own pin to that machine. Example: a MacBook Pro views a
     chat that runs on a Mac Studio; the chat drives the Windows emulator;
     the MacBook Pro shows the Windows emulator live. The tool stays visible
     on a host that cannot run the emulator.
- Phone and web viewers (the `android.*` sync commands, a stream ticket
  issuer) are P2, not P0.

## 4. Shared device layer (move, do not copy)

Move these out of `services/ios` / `components/apple` into a neutral home and
make iOS import them. Behaviour does not change; names lose the Apple prefix
where the code is generic.

**P0 moves only what Android imports in P0** (decided 2026-11-04): the Annex B
parser (to `services/media/`), the video record constants (to a neutral
`shared/types` module), the renderer player and stream view, the flat view
(`components/device/DeviceFlatView.tsx`), and the spinner, danger menu item
and drawer primitives that the picker uses (to `components/ui/`). Each other row in the table moves
in the phase where Android first uses it: the relay, the relay-to-service seam,
pacing, the local viewers and the renderer lease in P2 (viewers); the lease
queue, the lifecycle queue and the recording store in P1 (agent suite); the
mini player store in P2 (two floating players). A module that moves before a
second caller exists only adds churn to the diff.

| Piece | Today |
|---|---|
| Video record framing | `media/videoRecords.ts`, `shared/types/videoRecords.ts` (`VIDEO_RECORD_*`, moved in P0) |
| Stream relay + tickets | `services/ios/appleStreamRelay.ts` (service-agnostic since #2039) |
| Relay-to-service seam | `services/ios/appleStreamRelayForService.ts` (`AppleStreamOwningService`, new in #2039) |
| Pacing + bitrate adapter | `services/ios/appleStreamPacing.ts` |
| Annex B parser | `services/media/h264AnnexB.ts` (moved in P0) |
| Device lease queue | `services/device/deviceLease.ts` (moved in P1) |
| Lifecycle queue | `services/ios/laneDeviceLifecycle.ts` |
| Recording rules + store | `services/ios/recording/*` (helper calls become a port) |
| Local viewers | `services/ios/appleLocalViewers.ts` |
| Renderer stream lease | `components/device/streamLease.ts` (one table per tool; Apple keeps its viewer data in `appleStreamLease.ts`) |
| Renderer player | `components/device/h264StreamPlayer.ts`, `H264StreamView.tsx`, `videoRecordParser.ts` (moved in P0) |
| Mini player store | `components/apple/appleMiniPlayerStore.ts` (generalize the device key) |
| Show requests | `shared/types/workToolShow.ts` (add `android`, `floating-android`) |

After #2039 (merged 2026-11-03, `51c6eabf6`):

- `appleStreamRelay.ts` no longer knows the simulator service. The service
  side is in `appleStreamRelayForService.ts`. The Android service implements
  `AppleStreamOwningService`: the three required calls (`getStreamStatus`,
  `startStream`, `stopStream`) plus the optional viewer and bitrate hooks.
- The optional `getPosture` / `onPostureChanged` hooks carry a foldable's
  hinge into the stream as `{t:"posture"}` notes. An Android foldable
  implements them from the emulator's posture (`adb emu posture`, gRPC
  `setPhysicalModel`), so the phone viewer reads its fold with no new code.
- `appleDuoService.ts` adds a "follow" fold (`setPosture` with `follow: true`),
  and `appleRemoteCommands.ts` allows `setPosture` from a phone. A phone that
  mirrors its own hinge sends a stream of these. The Android `setPosture`
  takes the same shape, so the phone's hinge can fold a Pro Fold or Z Fold
  emulator too.
- The record format and the relay path (`/apple/stream/<ticket>`) do not
  change. Android records go through the same relay.

Lane rows: a sibling local-only table `lane_android_devices` (lane_id PK, avd
name, origin, profile, system image, created_at, ade_installed_packages), added
to the CRR exclusion list in `kvDb.ts`. Not a platform column on
`lane_apple_devices`: the udid and runtime columns mean nothing for an AVD.

## 5. Surfaces

- **Work tools pane:** a new tool, "Android Development", a separate tab with
  the same layout as Apple Development: picker, stage (3D / flat), rail,
  drawer, status strip, tools card with the lane's device and corner menu,
  lane mark in the session list. The header shows the machine name when the
  emulator runs on another machine.
- **Rail:** Back, Home, Recents at the top, a divider, then the tools in the
  Apple order: Power ▾ (Power, Volume up/down), Rotate, Inspect, Screenshot,
  Record, 3D/Flat, Tools, More. Esc sends Back.
- **Quick chips** over the stage: location, battery, network, dark mode. They
  are shortcuts to the same controls in the drawer.
- **Status strip:** live state, fps, the emulator's memory (about 2.9 GB each),
  and the lane.
- **Picker,** top to bottom:
  1. "This lane": the lane's device, with a small model render and a badge.
  2. "On this machine": the other AVDs, with running / off / TAKEN badges and
     a ⋯ menu.
  3. "New device": the brand grid (§7.1). One line says "stock Android on
     every device".
  4. "More…": every other SDK profile, with the procedural body.
  5. "Storage ▸": AVD sizes and Clean up, as in the Apple picker.
- **Brand tile:** a still image rendered once from the GLB and cached, the
  brand logo, the name, the screen size and colour dots. Only the hovered tile
  loads live 3D and turns slowly. A click creates the device with the newest
  installed image and starts it for the lane. If no image is installed, the
  click offers the download first. A ▾ on the tile opens the image and the
  name.
- **Boot on the model:** while the emulator boots, the 3D screen shows the
  boot glow and a progress ring, in place of the loading card.
- **SDK missing or part missing:** a checklist card in the panel:
  acceleration, Android SDK, emulator, phone image, each with its size; the
  install folder with an edit pencil; "Review licences & install"; "Use
  mine…" (pick an existing SDK); the progress in the same card. A checkbox
  offers the Android CLI. Settings > Android devices shows the same card.
- **Error banners** in the panel, each with one action:
  - No acceleration (WSL2, nested VM, WHPX off): says why and links the fix.
  - The emulator crashed or exited: Restart, and "Open log".
  - An attached user AVD: a run can rewrite its snapshot file (§9).
  - RAM guard: a start would push the machine into swap.
- **Drawer groups:** Device, App, Capture, Emulator (location, battery,
  network, appearance, fold), Logs.
- **Logs drawer:** logcat for the lane's app only. A crash shows a red pin on
  the device with the stack and "Send to chat".
- **Floating player:** one Apple and one Android device can float at the same
  time. Today `appleMiniPlayerStore.ts` holds exactly one player; it becomes
  one slot per device kind.
- **Turn hint:** names both devices when the lane holds both.
- **Corner card, web viewer, phone viewer:** reuse; add the Android device
  kind.
- **Phone full-screen view:** the Android picture uses the phone's live stage
  (`apps/ios/ADE/Views/Work/LiveStage.swift`, merged in #2039). The stage is
  one view at the window root that shows a stream full screen or over the
  Duo's tools pane, with no reconnect when it moves or the phone folds. It
  already takes three kinds (`LiveStage.Kind`: `simulator`, `macDesktop`,
  `appControl`), each with a `Seed` and its own viewer. Android adds:
  - a fourth kind and seed (`android`, seeded with the lane's Android device
    status);
  - an Android viewer built on `AppleDeviceStream.swift` (same records) with
    Android Control: touch, Back / Home / Recents, Power and volume;
  - Turn (quarter turn) and the arrangements (`LiveStageArrangement`) as they
    are, keyed per kind by `LiveStageTurns`;
  - fold mirroring for Android foldables through the posture hooks (§4).
  An Android emulator must run full screen on the phone, including the iPhone
  Duo's inner screen, with the same watch / control modes.
- **Settings:** an "Android devices" section: SDK path and status, the guided
  install, auto-record, realistic body.

Composed layout (design round, 2026-11-03):

```
Tabs: Files · Git · Browser · Apple Dev ● · [Android Dev ●]
┌ Android Development ──────── Pixel 10 Pro · API 36 ● windows ⋯ ┐
│  ╭──────────────╮  📍 🔋 📶 ◐  ← quick chips     ◁ Back       │
│  │ 9:41      ▾▴ │                                ○ Home       │
│  │  Checkout    │                                ▢ Recents    │
│  │  [ Pay $12 ] │                                ──────────   │
│  ╰──────────────╯                                ⏻ Power ▾    │
│                                                  ⟳ Rotate     │
│                                                  ⌖ Inspect    │
│                                                  ◉ Record ⋯   │
│ ● Live · 58 fps · 2.9 GB · lane checkout-flow                 │
└───────────────────────────────────────────────────────────────┘

┌ Pick a device ──────────────────────────────────────────── ↻ ┐
│ THIS LANE                                                    │
│  [▯] Pixel 10 Pro · API 36          ● running                │
│ ON THIS MACHINE 5                                            │
│  [▯▯] versic_fold · Pro Fold        ○ off            ⋯       │
│  [▭] versic_tablet · Tablet         TAKEN lane-b             │
│ NEW DEVICE                    stock Android on every device  │
│  ╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮      │
│  │G   ▾   │ │G   ▾   │ │G   ▾   │ │SAMSUNG▾│ │SAMSUNG▾│      │
│  │  ▯     │ │  ▯     │ │  ▯▯    │ │  ▯     │ │  ▯▯    │      │
│  │Pixel 10│ │10 Pro  │ │Pro Fold│ │S25     │ │Z Fold  │      │
│  │● ● ●   │ │● ●     │ │● ●     │ │● ● ●   │ │● ●     │      │
│  ╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯      │
│  More…                                          Storage ▸    │
└──────────────────────────────────────────────────────────────┘

┌ Android Development ─────────────────────────────── windows ┐
│  Set up Android on this machine                              │
│  ✓ Acceleration      WHPX on                                 │
│  ✗ Android SDK       not found                               │
│  ✗ Emulator          ~480 MB                                 │
│  ✗ Phone image       API 36 · ~1.8 GB                        │
│  ☐ Android CLI       optional                                │
│  Installs to  %LOCALAPPDATA%\Android\Sdk  ✎                  │
│  [ Review licences & install ]  Use mine…                    │
│  ▓▓▓▓▓▓▓▓░░░░  Emulator 61% · 2 min left                     │
└──────────────────────────────────────────────────────────────┘
```

## 6. Phases

Each phase is one PR, reviewed and merged before the next.

**Start condition: met.** The full-screen iOS simulator lane merged as #2039
on 2026-11-03 (`51c6eabf6`). This lane is updated to that commit, and §4 and
§5 describe the merged seams.

- **P0 — foundation.** The shared device layer move for the pieces Android
  uses in P0 (§4; iOS unchanged, its tests green). SDK detection + `status` capability on Mac, Windows, Linux. AVD
  list, create from a stock profile, boot, stop, delete; the lane table and
  marker; lane archive/delete teardown. scrcpy stream into the pane, flat view
  only. Touch and the hardware keys (rail in the §5 order). The picker's "This
  lane" and "On this machine" cards. The no-acceleration and crashed banners.
  `ade android status | devices | device-create | device-attach | start |
  stop | device-detach | screenshot | tap | swipe | button | rotate | type |
  show`, each also with `--machine` (the chat's work copy there, §3.6).
  The new domain with policy, IPC, preload, remote reachability. Perf rows
  measured.
- **P1 — agent suite, setup and look.** May split into two PRs (agent + setup,
  then look).
  - Agent: UI tree and element verbs (Android CLI `layout` when present),
    logcat, install/launch (APK and Gradle), open-url, typing, record +
    proof, lease, show, the turn hint for both devices, the `ade-android`
    skill, the full `android.*` remote command set.
  - Setup: the guided SDK install card with licence consent, "Use mine…",
    the optional Android CLI.
  - Look: the brand catalog (§7.1) with ADE-written profiles, tile art, real
    3D models and the procedural fallback, colour choice, boot on the model,
    rotation, the render sheet.
  - Built on 2026-11-05 as one PR (lane `ade/android-suite-p1-p3-1ed6bff1`):
    all of the above, plus Inspect, Record on the rail and the Tools drawer
    (Device, App, Capture, Emulator) with `ade android settings`. No GLB
    model files ship yet: every catalog device uses the procedural body.
- **P2 — viewers and controls.** Web and phone viewers, phone full screen
  (including the iPhone Duo inner screen), cross-machine viewing
  (Windows-hosted emulator on a Mac), two floating players (one per device
  kind), the RAM guard, quick chips, the Logs drawer with the crash pin.
  - Built on 2026-11-05 as one PR (branch `ade/android-suite-p2`): the
    brain's stream relay serves the emulator to the web client and the phone
    (`android.streamTicket`, touch input), the phone viewer on the live stage
    (a fourth `LiveStage` kind), two floating players, the RAM guard with
    "Start anyway" (`--force` in the CLI), quick chips, the Logs group and
    the crash pin with "Send to chat", and the tools card line. Phone fold
    mirroring waits for a host posture API (P3 fold).
- **P3 — extras.** Fold by dragging the hinge (the Duo posture code), Compose
  preview render (Android CLI), a system image manager (like Runtimes),
  instrumentation tests (`connectedAndroidTest`).

## 7. 3D models

- Source, in order: (1) Google's own 3D/AR product files, if the Google Store
  or Google's AR viewer loads GLBs (the store HTML has no direct links; check
  the page's network requests in a browser); (2) Samsung's AR product files,
  same check; (3) paid marketplace packs with GLB (CGTrader lists a Pixel 10
  series pack and a Pixel 9 pack with the 9 Pro Fold); (4) free CC models on
  Sketchfab.
- Target set: a current Pixel phone, a Pro size, the Pro Fold (two panels and a
  hinge, reusing the Duo posture pipeline), a Pixel Tablet, and one non-Pixel
  phone. Record each model's source, licence and checksum in a
  `sources.json`, as the iPhone models do.
- Each model needs a named screen mesh; the loader maps the live frame onto it
  (`appleDeviceScene.ts` pattern). A profile with no model gets the procedural
  body, sized from the profile's screen size, aspect and corner radius.
- Licence risk is accepted for now by the owner. The iPhone GLBs carry the same
  open question (`assets/apple-device-models/sources.json`). Brand logos have
  the same status: record them in `sources.json`; each is an easy removal.

### 7.1 Brand catalog

- **First set:** Pixel 10, Pixel 10 Pro, Pixel 10 Pro Fold, Pixel Tablet,
  Pixel Watch; Galaxy S25, Galaxy S25 Ultra, Galaxy Z Fold; one or two more
  brands (OnePlus or Nothing).
- **Entry:** name, brand, logo, hardware profile ID, model file, colour
  options (body materials), screen size line.
- **Pixel profiles** come from the SDK (`pixel_9_pro_fold` and `pixel_tablet`
  exist on the owner's Windows SDK; read the newest Pixel IDs at runtime and
  fall back to the nearest one).
- **Non-Pixel profiles:** ADE writes a hardware profile (`ade_<model>`) with
  the true screen size, resolution and density from the spec sheet. ADE
  writes it to the user's own device definitions and never edits SDK files.
- **Colour choice:** the body uses the colour picked on the tile. Models need
  a separate body material.

## 8. Closed questions (design round, 2026-11-03)

- The UI, the empty and error states and the guided install flow are in §5.
- Extras in: colour choice, boot on the model, fold by dragging, Logs with a
  crash pin, Compose previews, RAM guard, quick chips. Extras out: unbox
  animation, size compare, quick boot per lane, a "run on both" button.
  Journeys, profiler and Crashlytics signals are out.
- The Android CLI is optional (§1).

## 9. Evidence

- Windows probe, 2026-11-02 (machine `windows`, Ryzen 9 7950X3D, 63 GB; chat
  1f7fe56e, lane "Android emulator probe"; emulator 37.1.11, WHPX usable;
  AVD `vphone4` = medium_phone, API 36 Google Play x86_64, 1080×2400, 2 GB):
  - Boot (cold; the AVD's quick-boot snapshot was incomplete): `wait-for-device`
    15.3 s, `sys.boot_completed` 24.3 s. Stop: `emu kill`, process gone in
    1.6 s.
  - Cost per running phone emulator: 2.9 GB working set, 4.8 GB private; CPU
    0.2% idle, 28.6% of 32 threads while capturing and swiping.
  - Capture: `adb screencap -p` 1,110 ms (unusable live). gRPC
    `getScreenshot` PNG 58 ms / RGBA 37 ms (good for proof screenshots).
    gRPC `streamScreenshot` is change-driven; while swiping: PNG 540 px wide
    51 fps (176 KB/frame), RGBA 540 px 53 fps (2.6 MB/frame), RGBA full res
    25.5 fps (264 MB/s; grpc-js needs `grpc.max_receive_message_length` raised
    above 4 MiB). `screenrecord --output-format=h264` works headless, ~54 fps,
    ~16 Mbps.
  - Input: gRPC `sendMouse` click 0.9 ms and it works; gRPC `sendKey` 0.4 ms;
    gRPC `sendTouch` moves work but a stationary `sendTouch` tap did NOT
    register in four variants (cause unknown); `adb shell input tap` 72 ms,
    `input text` 274 ms.
  - UI tree: `uiautomator dump` 2.5 s + 76 ms pull (29 KB, 75 nodes). Too slow
    for a hover inspector; P1 must find a faster source (an on-device
    accessibility service, `android layout`, or keep a dump cache per screen).
  - `adb emu rotate`, `emu geo fix`, `cmd uimode night` work headless.
  - Discovery file: `%LOCALAPPDATA%\Temp\avd\running\pid_<qemu pid>.ini`; keys
    include `grpc.port`, `port.adb`, `avd.id`, `avd.name`; `grpc.token` only
    when the emulator was started with token auth (Android Studio does this).
    `avd.id` is the AVD name (`emulator -avd <id>`); `avd.name` is its display
    name. Match on `avd.id` (found by the lifecycle agent, 2026-11-03).
  - `-no-snapshot-save` still rewrote the AVD's 11-byte `snapshot.pb` 7 s into
    boot (`ram.img` untouched). ADE must not assume an attached user AVD is
    left byte-identical.
  - The SDK has 95 hardware profiles (`avdmanager list device -c`) and no
    `skins` folder. Android Studio ships device frames in
    `plugins/android/resources/device-art-resources/` (`device-art.xml`).
  - Not measured: scrcpy (needs the server jar; measure first in P0),
    `-share-vid`.
- t3code: Device panel since PR #10677 (2026-09-10) on pinned
  `expo-device-hub` 0.19.1 + `agent-device` 0.21.31; scrcpy mode in
  `serve-emu`; procedural Android bodies; no SDK install. Known bugs to avoid:
  SDK detected once at startup, keyframe/SPS reset loop on Android video, no
  video on plain-HTTP remote origins.
- Sizes (zip): platform-tools 8–16 MB; emulator 354–489 MB; arm64 Google Play
  API 35 image 1.79 GB; arm64 default API 35 image 0.77 GB.
- P0 build checks, 2026-11-03/04 (same Windows machine; branch tip at the
  time):
  - Stream (scrcpy v5.0.1, software encoder in the guest, 4 vCPU), swipe fps
    avg / max: 800 px 58 / 61; 1024 px 39 / 52.5; 1280 px 23–38 / 47–48;
    1600 px 26 / 29.5. Start to first keyframe 0.7–1.5 s; idle 0–6 fps.
    Pixel count sets the rate; bit rate matters less. P0 default:
    1024 px / 4 Mbps / 60 fps for every view (`ANDROID_STREAM_DEFAULTS`).
  - Rotate: `cmd window user-rotation lock` (absolute, 0.43–0.55 s to the
    new stream size); `settings put system user_rotation` for Android 10
    and older; `adb emu rotate` rejected (relative, 2.3 s). The service waits
    until a capture has the new shape (224–582 ms). The launcher stays
    portrait.
  - Real brain from this branch (Phase C, own `ADE_HOME`, `--no-sync`,
    `--role cto`, throwaway project, private `ANDROID_AVD_HOME`): build 82 s;
    `ade android` `device-create` 56.4 s (first boot), warm `start` 23.5 s,
    `tap`/`type`/`button`/`swipe`/`rotate` 1.0–1.7 s each, `screenshot`
    2.0 s, `stop` 2.0 s, `device-detach` 0.9 s; unknown flag refused; lane
    scoping and the viewer-only actions refused for agents.
  - Stream through the brain: cold start 1.0 s (460×1024), first picture
    8 ms after the GET, 47.7 fps while swiping (~3.6 Mbit/s), 1.5 fps idle,
    stop 76 ms.
  - CPU (% of one core, 32 threads): qemu idle ~13%; swipes ~610% without a
    stream, ~880% with one (the encoder adds ~270%); brain ≤ 4% while
    streaming.
  - Hand-off with a real brain process (terminal ended, hard kill, clean
    `shutdown`): the emulator survived each time; the next brain re-adopted
    it in 2.2–2.4 s (same qemu PID). The installed Windows brain runs in a
    job object without kill-on-close (flags 0x0), so emulators survive a
    brain restart, an update or an ended task; only a tree kill or a logoff
    ends them.
  - Work copy, remote side (a local caller with the paired identity
    `remote:<machine>:<chat>`, `remoteWork` args): no copy before a
    lane-bound call; first `start` 22.8 s (copy made, a free ADE AVD
    borrowed as attached, booted); every answer carries `workCopy.laneId`;
    paths outside the copy refused; the screenshot bytes travel back
    (1.38 MB in 11 ms); releasing the copy stops the emulator and keeps the
    AVD.
  - Not yet run across two real machines. Steps for that run: (1) put this
    branch on both machines as the machine brain; (2) pair them; (3) open
    the same repository on both, push the commit; (4) optional: make a kept
    ADE AVD on Windows to see a borrow; (5) from a Mac chat with no `--lane`:
    `ade android status|start|tap|rotate|screenshot|stop --machine windows`
    (the screenshot must reach the chat's proof); (6) check `workCopy.laneId`
    and that the chat records `usesAndroidEmulator`; (7) open the chat's
    Android tool and confirm "Android · windows" streams; (8)
    `ade shell clean --machine windows` stops the emulator and keeps the
    AVD; (9) check a packaged Windows brain finds the scrcpy jar.
